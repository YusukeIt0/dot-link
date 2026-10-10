import Foundation
@main enum NotificationStructureProbeTests {
static func main() {
func check(_ condition: Bool) { precondition(condition) }
let expected = ["通知テスト123", "ぼくモップ"]
check(NotificationStructureProbe.matches("通知テスト１２３", expected: expected) == ["test-1-exact"])
check(NotificationStructureProbe.matches("ぼくモップ", expected: expected) == ["test-2-exact"])
check(NotificationStructureProbe.matches("Sender: ぼくモップ", expected: expected) == ["test-2-embedded"])
check(NotificationStructureProbe.matches("private message", expected: expected).isEmpty)
check(NotificationStructureProbe.matches("ぼくモップ").isEmpty)
check(NotificationStructureProbe.matches("anything", expected: [""]).isEmpty)
check(NotificationStructureProbe.matches("LINE") == ["line-label"])
check(NotificationStructureProbe.safeRole("Private sender") == "other")
check(!NotificationStructureProbe.enabled(until: 100, now: 100))
check(!NotificationStructureProbe.enabled(until: 1001, now: 100))
check(NotificationStructureProbe.enabled(until: 1000, now: 100))
check(!NotificationStructureProbe.enabled(until: .infinity, now: 100))
let node = NotificationStructureProbe.Node(path: "w0.1", role: "AXStaticText", fields: ["AXValue"], matches: NotificationStructureProbe.matches("Private sender: ぼくモップ", expected: expected))
let encoded = String(data: try! JSONEncoder().encode(node), encoding: .utf8)!
check(!encoded.contains("Private sender") && !encoded.contains("ぼくモップ"))
print("13 notification structure/privacy checks passed")
}
}
