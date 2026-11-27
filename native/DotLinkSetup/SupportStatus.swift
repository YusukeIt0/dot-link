import Foundation

// Both entry points project only these product observations. Never serialize
// the setup helper's dictionary, which also serves credential and pairing UI.
enum SupportStatus {
    enum Source: String { case saved = "saved-on-mac", window = "mac-window" }

    static func report(state: [String: Any], source: Source, language: String, catalog: Localization,
                       busy: Bool = false, checked: Date? = nil, failure: SetupFailureDetails? = nil,
                       startupTimeout: Bool = false) -> String {
        let step = state["step"] as? String
        let live = source == .window && !busy
        let blocked = ["conflict", "unknown", "updateRecovery", "appLocation", "startupCheck"].contains(step ?? "")
        let facts = busy || blocked ? [:] : state
        func flag(_ key: String, _ yes: String, _ no: String) -> String {
            guard let value = facts[key] as? Bool else { return "unknown" }
            return value ? yes : no
        }
        func observation(_ key: String, _ allowed: [String]) -> String {
            guard live, let value = facts[key] as? String, allowed.contains(value) else { return "unknown" }
            return value
        }
        let installed = facts["installed"] as? Bool
        let installation: String
        if installed == true, live, let componentsReady = facts["dependencies"] as? Bool {
            installation = componentsReady ? "prepared" : "incomplete"
        } else {
            // The install record is written before the speech model download finishes.
            installation = flag("installed", "detected", "unprepared")
        }
        let paused = flag("lifecycleStopped", "paused", "not-paused")
        let pairing = installed == true && facts["evenPairingKnown"] as? Bool == true
            ? flag("evenPaired", "saved", "absent") : "unknown"
        let tunnel = flag("savedTunnel", "present", "absent")
        let subscription = observation("subscriptionCheck", ["active", "inactive"])
        let network = observation("networkCheck", ["ready", "missing", "conflict", "public", "TAILSCALE_NOT_INSTALLED",
            "TAILSCALE_LOGIN_REQUIRED", "TAILSCALE_APPROVAL_REQUIRED", "TAILSCALE_STOPPED", "TAILSCALE_NOT_READY",
            "TAILSCALE_DNS_UNAVAILABLE", "TAILSCALE_SERVE_STATUS_FAILED", "TAILSCALE_STATUS_FAILED"])
        let next: String
        var control: String?
        if busy {
            next = "wait-for-current-operation"
        } else if step == "updateRecovery" {
            next = "review-update-in-app"; if live { control = "mac.retry_recovery" }
        } else if blocked {
            next = "review-in-app"; if live && step != "unknown" { control = "mac.check_again" }
        } else if paused == "paused" {
            next = "confirm-before-resuming"; if live && step == "start" { control = "mac.resume" }
        } else if installed == false {
            next = "prepare-mac"; control = "mac.prepare_this_mac_172"
        } else if !live || installed != true {
            next = "check-in-mac-window"
        } else {
            switch step {
            case "install":
                next = "review-mac-preparation"; control = "mac.prepare_this_mac_172"
            case "network":
                switch network {
                case "TAILSCALE_NOT_INSTALLED": next = "install-tailscale"; control = "mac.install_tailscale"
                case "TAILSCALE_LOGIN_REQUIRED", "TAILSCALE_APPROVAL_REQUIRED", "TAILSCALE_STOPPED", "TAILSCALE_NOT_READY":
                    next = "review-tailscale"; control = "mac.open_tailscale"
                default: next = "recheck-network"; control = "mac.connected_continue"
                }
            case "networkConflict": next = "review-existing-network"; control = "mac.check_again"
            case "dot" where tunnel == "absent": next = "configure-tunnel-with-owner"; control = "mac.open_openai_connection_settings"
            case "start" where paused == "not-paused": next = "review-start-relay"; control = "mac.start_relay"
            case "reconnecting": next = "recheck-existing-relay"; control = "mac.refresh_status"
            case "subscribe" where subscription == "inactive":
                next = facts["previouslySubscribed"] as? Bool == true ? "reconnect-existing-dot" : "check-existing-dot-setup"
                control = "mac.check_connection_to_dot"
            case "pair" where subscription == "active":
                switch pairing {
                case "saved": next = "test-message-on-existing-g2"
                case "absent": next = "pair-with-owner"; control = "mac.connect_even"
                default: next = "recheck-saved-pairing"; control = "mac.refresh_status"
                }
            default: next = "recheck-in-app"; control = "mac.refresh_status"
            }
        }
        var result: [String: Any] = [
            "schema": 1, "source": source.rawValue, "macLanguage": language, "next": next,
            "supportMenu": catalog.text("mac.setup_support_status", language: language),
            "installation": installation, "relayIntent": paused, "savedTunnel": tunnel, "savedEvenPairing": pairing,
            "tailscale": network, "localRelay": observation("bridgeCheck", ["responded", "failed", "unreachable"]),
            "macToPrivateRoute": observation("deviceCheck", ["responded", "failed", "unreachable"]),
            "localTunnel": observation("tunnelCheck", ["responded", "failed", "unreachable"]),
            "dotSubscription": subscription, "dotG2Exchange": "requires-device-observation",
        ]
        if let control { result["macControl"] = catalog.text(control, language: language) }
        if live, let checked, !blocked { result["observedAt"] = ISO8601DateFormatter().string(from: checked) }
        if live, let failure { result["lastSetupFailure"] = ["stage": failure.stage, "code": failure.code] }
        if startupTimeout { result["startupCode"] = StartupDiscoveryReport.code }
        for (field, key) in [("version", "CFBundleShortVersionString"), ("build", "CFBundleVersion")] {
            if let value = Bundle.main.object(forInfoDictionaryKey: key) as? String,
               value.range(of: #"\A[0-9]+(?:\.[0-9]+)*\z"#, options: .regularExpression) != nil { result[field] = value }
        }
        let data = try! JSONSerialization.data(withJSONObject: result, options: [.prettyPrinted, .sortedKeys])
        return String(decoding: data, as: UTF8.self)
    }

    // Entry runs before AppKit, location handoff, updates and automatic resume.
    static func runSavedCommand() -> Never {
        guard Array(CommandLine.arguments.dropFirst()) == ["--support-status"] else { exit(64) }
        let catalog = Localization.shared
        let language = catalog.choose(preferred: Locale.preferredLanguages.first ?? "en", saved: UserDefaults.standard.string(forKey: "setupLanguage"))
        var state: [String: Any] = ["step":"unknown"]
        if let payload = Bundle.main.resourceURL?.appendingPathComponent("payload") {
            let task = Process(), output = Pipe()
            task.executableURL = payload.appendingPathComponent(".runtime/bin/node")
            task.arguments = [payload.appendingPathComponent("scripts/support-status.mjs").path]
            task.currentDirectoryURL = payload
            task.environment = ["PATH":"/usr/bin:/bin:/usr/sbin:/sbin"]
            task.standardInput = FileHandle.nullDevice; task.standardError = FileHandle.nullDevice; task.standardOutput = output
            do {
                try task.run()
                let data = output.fileHandleForReading.readDataToEndOfFile()
                task.waitUntilExit()
                if task.terminationStatus == 0, let facts = try? JSONSerialization.jsonObject(with: data) as? [String: Any] { state = facts }
            } catch { /* An unavailable helper gives a bounded unknown report. */ }
        }
        print(report(state: state, source: .saved, language: language, catalog: catalog))
        exit(0)
    }
}
