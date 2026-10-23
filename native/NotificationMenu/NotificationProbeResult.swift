// Stable wire values shared by both notification diagnostic producers.
// Human-readable `forwarding` text is informational and must never gate migration.
enum NotificationProbeResult: String, Codable, CaseIterable {
    case pending
    case sending
    case relayAccepted = "relay_accepted"
    case sendUnconfirmed = "send_unconfirmed"
    case missingCredentials = "missing_credentials"
    case ledgerManaged = "ledger_managed"

    var needsAttention: Bool { self == .sendUnconfirmed || self == .missingCredentials }

    static func usesDirectProbe(shareAll: Bool, validating: Bool, marker: String, migrationProbe: String?) -> Bool {
        !shareAll || (validating && marker == migrationProbe)
    }
}
