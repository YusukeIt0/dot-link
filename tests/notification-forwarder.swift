import Foundation

final class FixtureProtocol: URLProtocol {
    static let lock = NSLock()
    private static var recordedPosts: [[String: Any]] = []
    private static var failFirst = false
    static var posts: [[String: Any]] {
        lock.lock(); defer { lock.unlock() }; return recordedPosts
    }
    static func failNextPost() {
        lock.lock(); defer { lock.unlock() }; failFirst = true
    }
    override class func canInit(with request: URLRequest) -> Bool { request.url?.host == "127.0.0.1" }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        var body = request.httpBody ?? Data()
        if let stream = request.httpBodyStream {
            stream.open(); defer { stream.close() }
            var bytes = [UInt8](repeating: 0, count: 4096)
            while stream.hasBytesAvailable { let n = stream.read(&bytes, maxLength: bytes.count); if n <= 0 { break }; body.append(contentsOf: bytes.prefix(n)) }
        }
        let value = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any] ?? [:]
        let data: Data
        if request.url!.path == "/api/notifications" {
            Self.lock.lock(); Self.recordedPosts.append(value); let shouldFail = Self.failFirst; Self.failFirst = false; Self.lock.unlock()
            if shouldFail { client?.urlProtocol(self, didFailWithError: URLError(.timedOut)); return }
            data = try! JSONSerialization.data(withJSONObject: ["notification_id": value["id"]!, "status": "accepted"])
        } else {
            data = try! JSONSerialization.data(withJSONObject: ["notificationSubscribed": true, "notifications": []])
        }
        client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: ["Content-Type":"application/json"])!, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: data); client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}
@main enum NotificationForwarderTests {
static func main() throws {
var count = 0
func check(_ condition: @autoclosure () -> Bool, file: StaticString = #fileID, line: UInt = #line) { precondition(condition(), "Check \(count + 1) failed", file: file, line: line); count += 1 }
func wait(file: StaticString = #fileID, line: UInt = #line, _ condition: () -> Bool) {
    let until = Date().addingTimeInterval(3)
    while !condition() && Date() < until { RunLoop.main.run(until: Date().addingTimeInterval(0.01)) }
    check(condition(), file: file, line: line)
}
func fixture(_ id: String, source: String = NotificationReader.lineBundleID) -> [NotificationExtraction] {
    NotificationReader.extract(.init(role: "AXGroup", subrole: "AXNotificationCenterBanner", identifier: id,
        stackingIdentifier: source,
        children: [.init(role: "AXStaticText", value: "Fixture sender"), .init(role: "AXStaticText", value: "same body")]))
}
let root = FileManager.default.temporaryDirectory.appendingPathComponent("dot-link-forwarder-\(UUID().uuidString)")
try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
defer { try? FileManager.default.removeItem(at: root) }
try Data(String(repeating: "x", count: 64).utf8).write(to: root.appendingPathComponent("notification-key"))
let config = URLSessionConfiguration.ephemeral; config.protocolClasses = [FixtureProtocol.self]
let session = URLSession(configuration: config)
defer { session.invalidateAndCancel() }
var allowed = true
var onChange: () -> Void = {}
let forwarder = NotificationForwarder(runtime: root, session: session, retryDelay: 0.04, allowed: { allowed }, changed: { onChange() })
forwarder.observe(fixture("excluded"), selected: false)
check(FixtureProtocol.posts.isEmpty)
forwarder.observe(fixture("excluded"), selected: true)
check(FixtureProtocol.posts.isEmpty)
allowed = false; forwarder.observe(fixture("paused"), selected: true)
check(FixtureProtocol.posts.isEmpty)
allowed = true
forwarder.baseline(fixture("baseline")); forwarder.observe(fixture("baseline"), selected: true)
check(FixtureProtocol.posts.isEmpty)
FixtureProtocol.failNextPost()
forwarder.observe(fixture("first", source: ""), selected: true)
wait { forwarder.ledger.entries.first { $0.identity == NotificationReader.opaqueIdentity("first") }?.stage == "dot_notified" }
check(FixtureProtocol.posts.count == 2)
check(FixtureProtocol.posts[0]["source_app"] as? String == "Mac notification (source unknown)")
check(FixtureProtocol.posts[0]["title"] as? String == "Fixture sender")
check(FixtureProtocol.posts[0]["id"] as? String == FixtureProtocol.posts[1]["id"] as? String)
forwarder.observe(fixture("first", source: ""), selected: true)
forwarder.observe(fixture("second"), selected: true)
wait { forwarder.ledger.entries.first { $0.identity == NotificationReader.opaqueIdentity("second") }?.stage == "dot_notified" }
check(FixtureProtocol.posts.count == 3)
check(FixtureProtocol.posts[1]["body"] as? String == FixtureProtocol.posts[2]["body"] as? String)
check(FixtureProtocol.posts[1]["id"] as? String != FixtureProtocol.posts[2]["id"] as? String)
// Cancel from the failure callback itself. Polling the transient failure stage
// raced the 40 ms retry on a busy CI runner and could miss that stage entirely.
var cancelledAtFailure = false
onChange = {
    guard !cancelledAtFailure,
          forwarder.ledger.entry(NotificationReader.opaqueIdentity("cancelled"))?.stage == "send_unconfirmed" else { return }
    cancelledAtFailure = true
    allowed = false; forwarder.cancel()
}
FixtureProtocol.failNextPost()
forwarder.observe(fixture("cancelled"), selected: true)
wait { cancelledAtFailure }
RunLoop.main.run(until: Date().addingTimeInterval(0.15))
check(FixtureProtocol.posts.count == 4)
let encoded = try JSONEncoder().encode(forwarder.ledger.entries)
let text = String(data: encoded, encoding: .utf8)!
check(!text.contains("Fixture sender") && !text.contains("same body"))
print("\(count) notification selection/retry/cancellation checks passed")
}
}
