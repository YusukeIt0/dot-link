import Foundation
import CryptoKit

// In-memory AX data. Never encode this object into diagnostics or logs.
struct NotificationAXNode {
    var role: String
    var subrole: String = ""
    var identifier: String = ""
    var stackingIdentifier: String = ""
    var value: String = ""
    var children: [NotificationAXNode] = []
}

struct ObservedMacNotification {
    let identity: String
    let sourceApp: String
    let title: String
    let body: String
}

struct NotificationExtraction {
    let identity: String?
    let reason: String
    let notification: ObservedMacNotification?
    let textCount: Int
    let sourceMatched: Bool
    let identifierPresent: Bool
    let bannerMatched: Bool
}

// Isolate one OS notification before reading its text; never flatten an entire
// window into one message. Unknown layouts/sources remain diagnostics-only.
enum NotificationReader {
    static let lineBundleID = "jp.naver.line.mac"
    static let notificationSubroles: Set<String> = ["AXNotificationCenterBanner", "AXNotificationCenterAlert"]
    static func isLine(_ stacking: String) -> Bool {
        stacking == lineBundleID || stacking.hasPrefix(lineBundleID + ";")
    }
    static func opaqueIdentity(_ value: String) -> String {
        SHA256.hash(data: Data(("mac-notification-v1" + "\u{1f}" + value).utf8)).map { String(format: "%02x", $0) }.joined()
    }
    static func extract(_ root: NotificationAXNode) -> [NotificationExtraction] {
        var output: [NotificationExtraction] = []
        func visit(_ node: NotificationAXNode, inheritedSource: String, inheritedBanner: Bool, inheritedID: String) {
            let source = node.stackingIdentifier.isEmpty ? inheritedSource : node.stackingIdentifier
            let banner = inheritedBanner || notificationSubroles.contains(node.subrole)
            let identifier = node.identifier.isEmpty ? inheritedID : node.identifier
            let directTexts = node.children.filter { $0.role == "AXStaticText" }
            if !directTexts.isEmpty {
                let sourceID = String(source.split(separator: ";", maxSplits: 1).first ?? "")
                let ownSource = sourceID.count <= 200 && sourceID.range(of: "^[A-Za-z0-9-]+(?:\\.[A-Za-z0-9-]+)+$", options: .regularExpression) != nil
                let sourceApp = isLine(source) ? "LINE" : ownSource ? sourceID : "Mac notification (source unknown)"
                // A non-leaf content group would merge different notifications.
                let nestedContent = node.children.contains { child in
                    child.role != "AXStaticText" && containsText(child)
                }
                let texts = directTexts.map { $0.value.trimmingCharacters(in: .whitespacesAndNewlines) }
                let title = texts.count == 1 ? texts[0] : texts.dropLast().joined(separator: " / ")
                let body = texts.count == 1 ? "" : texts.last ?? ""
                let id = identifier.isEmpty ? nil : opaqueIdentity(identifier)
                let reason: String
                if !banner { reason = "not_live_banner" }
                else if identifier.isEmpty { reason = "notification_id_missing" }
                else if nestedContent { reason = "mixed_layout" }
                else if !(1...3).contains(texts.count) { reason = "unsupported_text_layout" }
                else if texts.contains(where: { $0.isEmpty }) { reason = "incomplete_text" }
                else if title.count > 1000 || body.count > 4000 { reason = "text_too_long" }
                else { reason = "extracted" }
                let notification = reason == "extracted" ? ObservedMacNotification(identity: id!, sourceApp: sourceApp,
                    title: title, body: body) : nil
                output.append(.init(identity: banner ? id : nil, reason: reason,
                    notification: notification, textCount: texts.count, sourceMatched: ownSource,
                    identifierPresent: !identifier.isEmpty, bannerMatched: banner))
                // Do not interpret nested children twice, even if this layout was rejected.
                return
            }
            // An ancestor ID may only identify one content group. Sharing it across
            // siblings would collapse distinct notifications, so require local IDs.
            let contentBranches = node.children.filter(containsText).count
            for child in node.children {
                visit(child, inheritedSource: source, inheritedBanner: banner,
                    inheritedID: contentBranches <= 1 ? identifier : "")
            }
        }
        visit(root, inheritedSource: "", inheritedBanner: false, inheritedID: "")
        return output
    }
    static func containsText(_ node: NotificationAXNode) -> Bool {
        node.role == "AXStaticText" || node.children.contains(where: containsText)
    }
}

// Durable, bounded idempotency ledger: only opaque identities, generated UUIDs,
// timestamps and enumerated delivery states are persisted. No notification text.
final class NotificationDeliveryLedger {
    struct Entry: Codable {
        let identity: String
        let id: String
        let observedAt: Double
        var stage: String
        var attempts: Int
    }
    private(set) var entries: [Entry]
    private(set) var healthy = true
    private let url: URL?
    init(url: URL? = nil) {
        self.url = url
        if let url, FileManager.default.fileExists(atPath: url.path) {
            do {
                let data = try Data(contentsOf: url)
                guard data.count <= 2_000_000 else { throw CocoaError(.fileReadCorruptFile) }
                entries = try JSONDecoder().decode([Entry].self, from: data)
                let allowed: Set<String> = ["queued", "posting", "relay_received", "dot_notified", "dot_delivery_failed", "dot_read", "announced", "client_response_sent", "send_unconfirmed", "stopped", "excluded", "baseline", "not_subscribed", "dot_deferred", "dot_silent"]
                guard entries.count <= 4096, Set(entries.map(\.identity)).count == entries.count,
                      entries.allSatisfy({ $0.identity.count == 64 && $0.identity.allSatisfy(\.isHexDigit) && UUID(uuidString: $0.id) != nil && $0.observedAt.isFinite && $0.attempts >= 0 && $0.attempts <= 3 && allowed.contains($0.stage) })
                else { throw CocoaError(.fileReadCorruptFile) }
                for i in entries.indices where ["queued", "posting"].contains(entries[i].stage) { entries[i].stage = "send_unconfirmed" }
            } catch { entries = []; healthy = false }
        } else { entries = [] }
    }
    private func save() -> Bool {
        guard healthy else { return false }
        guard let url else { return true }
        do {
            try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
            // Write privately before rename; avoid an atomic writer's default umask.
            let temporary = url.deletingLastPathComponent().appendingPathComponent("ledger-\(UUID().uuidString).tmp")
            let data = try JSONEncoder().encode(entries)
            guard FileManager.default.createFile(atPath: temporary.path, contents: data, attributes: [.posixPermissions: 0o600]) else { throw CocoaError(.fileWriteUnknown) }
            defer { try? FileManager.default.removeItem(at: temporary) }
            if FileManager.default.fileExists(atPath: url.path) { _ = try FileManager.default.replaceItemAt(url, withItemAt: temporary) }
            else { try FileManager.default.moveItem(at: temporary, to: url) }
            return true
        } catch { healthy = false; return false }
    }
    func entry(_ identity: String) -> Entry? { entries.first { $0.identity == identity } }
    func reserve(identity: String, at: Double, stage: String = "queued") -> Entry? {
        guard healthy, entry(identity) == nil else { return nil }
        guard entries.count < 4096 else { healthy = false; return nil }
        let entry = Entry(identity: identity, id: UUID().uuidString.lowercased(), observedAt: at, stage: stage, attempts: 0)
        entries.append(entry)
        return save() ? entry : nil
    }
    @discardableResult func update(identity: String, stage: String, attempts: Int? = nil) -> Bool {
        guard let index = entries.firstIndex(where: { $0.identity == identity }), healthy else { return false }
        entries[index].stage = stage
        if let attempts { entries[index].attempts = attempts }
        return save()
    }
}
