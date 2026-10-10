import Foundation
@main enum NotificationReaderTests {
static func main() throws {
var count = 0
func check(_ condition: @autoclosure () -> Bool) { precondition(condition()); count += 1 }
func fixture(_ id: String = "notification-1", _ body: String = "same body", _ source: String = NotificationReader.lineBundleID) -> NotificationAXNode {
    .init(role: "AXGroup", subrole: "AXNotificationCenterBanner", identifier: id, stackingIdentifier: source,
        children: [.init(role: "AXStaticText", value: "Fixture sender"), .init(role: "AXStaticText", value: body)])
}
let a = NotificationReader.extract(fixture())[0]
check(a.reason == "extracted"); check(a.notification?.title == "Fixture sender"); check(a.notification?.body == "same body")
check(NotificationReader.extract(fixture("notification-2"))[0].identity != a.identity)
check(NotificationReader.extract(fixture())[0].identity == a.identity)
check(NotificationReader.extract(fixture("1", "LINE", "com.other.app"))[0].notification?.sourceApp == "com.other.app")
check(NotificationReader.extract(fixture("1", "body", "jp.naver.line.mac.spoof"))[0].notification?.sourceApp != "LINE")
check(NotificationReader.extract(fixture("1", "body", "jp.naver.line.mac;group"))[0].sourceMatched)
check(NotificationReader.extract(fixture(""))[0].reason == "notification_id_missing")
var empty = fixture(); empty.children[1].value = ""
check(NotificationReader.extract(empty)[0].reason == "incomplete_text")
var three = fixture(); three.children.insert(.init(role: "AXStaticText", value: "Group sender"), at: 1)
check(NotificationReader.extract(three)[0].notification?.title == "Fixture sender / Group sender")
var four = three; four.children.append(.init(role: "AXStaticText", value: "another"))
check(NotificationReader.extract(four)[0].reason == "unsupported_text_layout")
var mixed = fixture(); mixed.children.append(fixture("other"))
check(NotificationReader.extract(mixed)[0].reason == "mixed_layout")
var historical = fixture(); historical.subrole = ""
check(NotificationReader.extract(historical)[0].reason == "not_live_banner")
let root = NotificationAXNode(role: "AXWindow", children: [fixture("a"), fixture("b"), fixture("c", "private other", "other")])
let values = NotificationReader.extract(root)
check(values.count == 3); check(values.filter { $0.notification != nil }.count == 3)
check(Set(values.compactMap(\.identity)).count == 3)
let inherited = NotificationAXNode(role: "AXWindow", subrole: "AXNotificationCenterBanner", identifier: "window-id", stackingIdentifier: NotificationReader.lineBundleID,
 children: [.init(role: "AXGroup", children: fixture().children)])
check(NotificationReader.extract(inherited)[0].notification != nil)
var siblings = inherited; siblings.children.append(siblings.children[0])
check(NotificationReader.extract(siblings).allSatisfy { $0.reason == "notification_id_missing" })
let unknown = NotificationReader.extract(fixture("unknown", "visible only…", ""))[0]
check(unknown.notification?.sourceApp == "Mac notification (source unknown)")
check(unknown.notification?.body == "visible only…")
check(!unknown.sourceMatched)
var one = fixture("one"); one.children.removeLast()
check(NotificationReader.extract(one)[0].notification?.title == "Fixture sender")
check(NotificationReader.extract(one)[0].notification?.body == "")
one.children[0].value = String(repeating: "x", count: 1001)
check(NotificationReader.extract(one)[0].reason == "text_too_long")
check(NotificationReader.extract(fixture("invalid-source", "body", "private sender"))[0].notification?.sourceApp == "Mac notification (source unknown)")
let dir = FileManager.default.temporaryDirectory.appendingPathComponent("dot-link-notification-test-\(UUID().uuidString)")
try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
defer { try? FileManager.default.removeItem(at: dir) }
let url = dir.appendingPathComponent("ledger.json")
let ledger = NotificationDeliveryLedger(url: url)
let first = ledger.reserve(identity: a.identity!, at: 1)!
check(ledger.reserve(identity: a.identity!, at: 2) == nil)
let second = ledger.reserve(identity: NotificationReader.opaqueIdentity("distinct"), at: 2)!
check(first.id != second.id)
check(ledger.update(identity: a.identity!, stage: "posting", attempts: 1))
let restored = NotificationDeliveryLedger(url: url)
check(restored.healthy); check(restored.entry(a.identity!)?.stage == "send_unconfirmed")
check(restored.reserve(identity: a.identity!, at: 3) == nil)
let saved = try String(contentsOf: url, encoding: .utf8)
check(!saved.contains("Fixture sender")); check(!saved.contains("same body"))
let permissions = try FileManager.default.attributesOfItem(atPath: url.path)[.posixPermissions] as! NSNumber
check(permissions.intValue & 0o777 == 0o600)
try Data("invalid".utf8).write(to: url)
let corrupt = NotificationDeliveryLedger(url: url)
check(!corrupt.healthy); check(corrupt.reserve(identity: a.identity!, at: 4) == nil)
print("\(count) notification extraction/idempotency checks passed")
}
}
