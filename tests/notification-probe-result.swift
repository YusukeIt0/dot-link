import Foundation

@main struct NotificationProbeResultTests {
    static func main() throws {
        let accepted = try JSONEncoder().encode(NotificationProbeResult.relayAccepted)
        assert(String(data: accepted, encoding: .utf8) == "\"relay_accepted\"")
        for result in NotificationProbeResult.allCases {
            let decoded = try JSONDecoder().decode(NotificationProbeResult.self, from: JSONEncoder().encode(result))
            assert(decoded == result)
            assert(result.needsAttention == [.sendUnconfirmed, .missingCredentials].contains(result))
        }
        for shareAll in [false, true] {
            assert(NotificationProbeResult.usesDirectProbe(shareAll: shareAll, validating: true, marker: "current", migrationProbe: "current"))
            assert(NotificationProbeResult.usesDirectProbe(shareAll: shareAll, validating: false, marker: "current", migrationProbe: "current") == !shareAll)
            assert(NotificationProbeResult.usesDirectProbe(shareAll: shareAll, validating: true, marker: "other", migrationProbe: "current") == !shareAll)
        }
        print("Notification probe wire values and routing passed")
    }
}
