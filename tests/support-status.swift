import Foundation

@main enum SupportStatusTests {
    static func main() throws {
        let catalog = Localization(directory: URL(fileURLWithPath: "localization"))
        let ready: [String: Any] = ["installed":true, "dependencies":true, "lifecycleStopped":false, "step":"pair", "savedTunnel":true,
            "evenPairingKnown":true, "evenPaired":true, "bridgeCheck":"responded", "subscriptionCheck":"active",
            "directory":"private fixture", "pairingCode":"private fixture", "sttMicrosoftEndpoint":"private fixture"]
        func report(_ changes: [String: Any] = [:], language: String = "en", source: SupportStatus.Source = .window,
                    busy: Bool = false) throws -> [String: Any] {
            let state = ready.merging(changes) { _, new in new }
            let json = SupportStatus.report(state: state, source: source, language: language, catalog: catalog, busy: busy)
            precondition(!json.contains("private fixture"))
            return try JSONSerialization.jsonObject(with: Data(json.utf8)) as! [String: Any]
        }
        func expect(_ changes: [String: Any], _ next: String) throws {
            let result = try report(changes)
            precondition(result["next"] as? String == next)
            precondition(result["dotG2Exchange"] as? String == "requires-device-observation")
        }
        try expect([:], "test-message-on-existing-g2")
        try expect(["evenPaired":false], "pair-with-owner")
        try expect(["evenPairingKnown":false], "recheck-saved-pairing")
        try expect(["lifecycleStopped":true, "step":"network"], "confirm-before-resuming")
        try expect(["step":"updateRecovery"], "review-update-in-app")
        try expect(["step":"subscribe", "subscriptionCheck":"inactive", "previouslySubscribed":true], "reconnect-existing-dot")
        try expect(["step":"subscribe", "subscriptionCheck":"unknown"], "recheck-in-app")
        try expect(["step":"network", "networkCheck":"TAILSCALE_STATUS_FAILED"], "recheck-network")
        try expect(["step":"dot", "savedTunnel":NSNull()], "recheck-in-app")
        let saved = try report(source:.saved)
        precondition(saved["dotSubscription"] as? String == "unknown" && saved["next"] as? String == "check-in-mac-window")
        precondition(saved["installation"] as? String == "detected" && saved["savedEvenPairing"] as? String == "saved")
        let partial = try report(["dependencies":false, "step":"install"])
        precondition(partial["installation"] as? String == "incomplete" && partial["savedEvenPairing"] as? String == "saved")
        precondition(partial["next"] as? String == "review-mac-preparation" && partial["macControl"] as? String == catalog.text("mac.prepare_this_mac_172", language:"en"))
        let verified = try report()
        precondition(verified["installation"] as? String == "prepared")
        let unchecked = try report(["dependencies":NSNull()])
        precondition(unchecked["installation"] as? String == "detected")
        let fresh = try report(["installed":false], source:.saved)
        precondition(fresh["installation"] as? String == "unprepared" && fresh["next"] as? String == "prepare-mac")
        let waiting = try report(busy:true)
        precondition(waiting["next"] as? String == "wait-for-current-operation" && waiting["macControl"] == nil)
        for language in catalog.languages {
            let absent = try report(["evenPaired":false], language:language)
            precondition(absent["macControl"] as? String == catalog.text("mac.connect_even", language:language))
            let unreadable = try report(["evenPairingKnown":false], language:language)
            precondition(unreadable["macControl"] as? String == catalog.text("mac.refresh_status", language:language))
        }
        print("Mac setup support state, consent, evidence boundaries and seven interface languages passed")
    }
}
