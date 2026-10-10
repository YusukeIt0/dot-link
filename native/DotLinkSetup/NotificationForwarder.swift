import Foundation

final class NotificationForwarder {
    struct ExtractionEvent: Codable {
        let at: Double
        let reason: String
        let sourceMatched: Bool
        let identifierPresent: Bool
        let bannerMatched: Bool
        let textCount: Int
        let disposition: String
        let notificationID: String?
    }
    private struct Payload {
        let identity: String
        let id: String
        let sourceApp: String
        let title: String
        let body: String
        let observedAt: Double
    }
    let ledger: NotificationDeliveryLedger
    private let runtime: URL
    private let allowed: () -> Bool
    private let changed: () -> Void
    private let session: URLSession
    private let retryDelay: Double
    private var payloads: [String: Payload] = [:]
    private var tasks: [String: URLSessionDataTask] = [:]
    private var generation = 0
    private var statusTask: URLSessionDataTask?
    private(set) var extractionEvents: [ExtractionEvent] = []
    private(set) var subscriptionReady: Bool?
    private(set) var statusAvailable = false
    private(set) var lastStatusAt: Double?
    init(runtime: URL, session: URLSession = .shared, retryDelay: Double = 5, allowed: @escaping () -> Bool, changed: @escaping () -> Void) {
        self.session = session; self.retryDelay = retryDelay
        self.runtime = runtime; self.allowed = allowed; self.changed = changed
        ledger = NotificationDeliveryLedger(url: runtime.appendingPathComponent("notification-menu-unified/delivery-ledger.json"))
    }
    func baseline(_ extractions: [NotificationExtraction]) {
        for value in extractions {
            if let identity = value.identity { _ = ledger.reserve(identity: identity, at: Date().timeIntervalSince1970, stage: "baseline") }
        }
    }
    func observe(_ extractions: [NotificationExtraction], selected: Bool) {
        for value in extractions {
            var disposition = "held"
            var notificationID: String?
            defer {
                extractionEvents.append(.init(at: Date().timeIntervalSince1970, reason: value.reason,
                    sourceMatched: value.sourceMatched, identifierPresent: value.identifierPresent,
                    bannerMatched: value.bannerMatched, textCount: value.textCount,
                    disposition: disposition, notificationID: notificationID))
                extractionEvents = Array(extractionEvents.suffix(100))
            }
            guard let identity = value.identity else { continue }
            if !selected {
                let entry = ledger.reserve(identity: identity, at: Date().timeIntervalSince1970, stage: "excluded") ?? ledger.entry(identity)
                notificationID = entry?.id; disposition = "excluded"
                continue
            }
            guard allowed() else { disposition = "paused"; continue }
            guard let notification = value.notification else { continue }
            if let existing = ledger.entry(identity) {
                disposition = "duplicate"; notificationID = existing.id; continue
            }
            guard payloads.count < 100 else { disposition = "queue_full"; continue }
            guard let entry = ledger.reserve(identity: identity, at: Date().timeIntervalSince1970) else { disposition = "ledger_unavailable"; continue }
            disposition = "reserved"; notificationID = entry.id
            let payload = Payload(identity: identity, id: entry.id, sourceApp: notification.sourceApp, title: notification.title,
                body: notification.body, observedAt: entry.observedAt)
            payloads[identity] = payload
            post(payload, attempt: 1, generation: generation)
        }
    }
    func cancel() {
        generation += 1
        for payload in payloads.values {
            let stage = ledger.entry(payload.identity)?.stage
            _ = ledger.update(identity: payload.identity, stage: stage == "posting" || stage == "send_unconfirmed" ? "send_unconfirmed" : "stopped")
        }
        for task in tasks.values { task.cancel() }
        tasks.removeAll(); payloads.removeAll()
    }
    private func request(path: String, object: [String: Any]) throws -> URLRequest {
        let key = try String(contentsOf: runtime.appendingPathComponent("notification-key"), encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines)
        guard !key.isEmpty else { throw CocoaError(.fileReadCorruptFile) }
        var request = URLRequest(url: URL(string: "http://127.0.0.1:3460" + path)!)
        request.httpMethod = "POST"; request.timeoutInterval = 20
        request.setValue("Bearer \(key)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: object)
        return request
    }
    private func post(_ payload: Payload, attempt: Int, generation current: Int) {
        guard generation == current, allowed(), ledger.healthy, payloads[payload.identity] != nil else { return }
        do {
            let req = try request(path: "/api/notifications", object: ["id": payload.id,
                "source_app": payload.sourceApp, "title": payload.title, "body": payload.body,
                "observed_at": ISO8601DateFormatter().string(from: Date(timeIntervalSince1970: payload.observedAt)),
                "source_verification": "accessibility"])
            guard ledger.update(identity: payload.identity, stage: "posting", attempts: attempt) else { return }
            let task = session.dataTask(with: req) { [weak self] data, response, error in
                DispatchQueue.main.async {
                    guard let self, self.generation == current else { return }
                    self.tasks.removeValue(forKey: payload.identity)
                    let http = (response as? HTTPURLResponse)?.statusCode ?? 0
                    let object = data.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
                    if error == nil, (200..<300).contains(http), object?["notification_id"] as? String == payload.id {
                        let stage = Self.stage(object?["status"] as? String)
                        _ = self.ledger.update(identity: payload.identity, stage: stage)
                        self.payloads.removeValue(forKey: payload.identity)
                    } else {
                        _ = self.ledger.update(identity: payload.identity, stage: "send_unconfirmed")
                        if attempt < 3, self.allowed() {
                            DispatchQueue.main.asyncAfter(deadline: .now() + self.retryDelay) { [weak self] in
                                self?.post(payload, attempt: attempt + 1, generation: current)
                            }
                        } else { self.payloads.removeValue(forKey: payload.identity) }
                    }
                    self.changed()
                    self.refreshStatus()
                }
            }
            tasks[payload.identity] = task; task.resume()
        } catch {
            _ = ledger.update(identity: payload.identity, stage: "send_unconfirmed")
            payloads.removeValue(forKey: payload.identity); changed()
        }
    }
    private static func stage(_ status: String?) -> String {
        switch status {
        case "announced": return "announced"
        case "accepted": return "dot_notified"
        case "failed": return "dot_delivery_failed"
        default: return "relay_received"
        }
    }
    func refreshStatus() {
        guard statusTask == nil else { return }
        let entries = Array(ledger.entries.filter { !["baseline", "excluded", "stopped"].contains($0.stage) }.suffix(100))
        do {
            let req = try request(path: "/api/notifications/status", object: ["ids": entries.map(\.id)])
            statusTask = session.dataTask(with: req) { [weak self] data, response, error in
                DispatchQueue.main.async {
                    guard let self else { return }; self.statusTask = nil
                    let http = (response as? HTTPURLResponse)?.statusCode ?? 0
                    guard error == nil, http == 200, let data,
                          let value = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                          let subscribed = value["notificationSubscribed"] as? Bool,
                          let records = value["notifications"] as? [[String: Any]] else {
                        self.statusAvailable = false; self.changed(); return
                    }
                    self.statusAvailable = true; self.subscriptionReady = subscribed
                    self.lastStatusAt = Date().timeIntervalSince1970
                    for record in records {
                        guard let id = record["id"] as? String, let entry = entries.first(where: { $0.id == id }),
                              let status = record["status"] as? String, status != "unknown" else { continue }
                        var stage = Self.stage(status)
                        if record["dot_read_at"] is String, stage != "announced" { stage = "dot_read" }
                        if record["disposition"] as? String == "later" { stage = "dot_deferred" }
                        if record["disposition"] as? String == "silent" { stage = "dot_silent" }
                        if record["client_response_at"] is String { stage = "client_response_sent" }
                        if self.ledger.entry(entry.identity)?.stage != stage { _ = self.ledger.update(identity: entry.identity, stage: stage) }
                    }
                    self.changed()
                }
            }
            statusTask?.resume()
        } catch { statusAvailable = false }
    }
}
