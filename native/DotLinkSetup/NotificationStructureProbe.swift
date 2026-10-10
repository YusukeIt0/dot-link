import Foundation

// Opt-in, short-lived developer diagnostics. Never serializes notification text,
// sender names, AX identifiers or fingerprints. Marker matches are not source proof.
struct NotificationStructureProbe {
    struct Node: Codable {
        let path: String
        let role: String
        let fields: [String]
        let matches: [String]
        var subrole: String = "other"
        var identifierPresent: Bool = false
        var stackingPresent: Bool = false
        var lineStackingMatch: Bool = false
        var ownStackingMatch: Bool = false
        var supportedAttributes: [String] = []
    }
    struct Snapshot: Codable {
        let observedAt: Double
        let window: Int
        let nodes: [Node]
        let truncated: Bool
    }
    static func enabled(until: Double, now: Double) -> Bool {
        until.isFinite && until > now && until <= now + 15 * 60
    }
    static func matches(_ text: String, expected: [String] = []) -> [String] {
        let normalized = text.precomposedStringWithCompatibilityMapping
            .trimmingCharacters(in: .whitespacesAndNewlines)
        var result = normalized == "LINE" ? ["line-label"] : []
        // Only numbered match labels leave memory, never the configured text.
        for (index, candidate) in expected.prefix(5).enumerated() {
            let target = candidate.precomposedStringWithCompatibilityMapping
                .trimmingCharacters(in: .whitespacesAndNewlines)
            guard !target.isEmpty, target.count <= 200 else { continue }
            if normalized == target { result.append("test-\(index + 1)-exact") }
            else if normalized.contains(target) { result.append("test-\(index + 1)-embedded") }
        }
        return result
    }
    static func safeRole(_ role: String?) -> String {
        let allowed: Set<String> = ["AXApplication", "AXWindow", "AXGroup", "AXScrollArea",
            "AXStaticText", "AXButton", "AXImage", "AXTextField", "AXList", "AXUnknown",
            "AXCheckBox", "AXLink", "AXLayoutArea", "AXLayoutItem"]
        return role.flatMap { allowed.contains($0) ? $0 : nil } ?? "other"
    }
}
