import Foundation

// Status refreshes cannot resolve an activation failure. Keep its diagnostics
// until the user starts another setup/lifecycle operation (or retries).
struct SetupFailurePresentation {
    var details: SetupFailureDetails?
    var copied = false

    mutating func begin(_ action: String) {
        guard action != "inspect" && action != "uninstall-plan" else { return }
        details = nil
        copied = false
    }
}

// Only the shared, bundled catalog defines displayable codes and stage names.
// Never display/copy a helper's free-form messages, stdout or stderr.
struct SetupFailureDetails {
    let code: String
    let stage: String
    private let codes: [String: [String: String]]
    private let stages: [String: [String: String]]
    private let diagnostic: [String: Any]

    init?(value: [String: Any], catalogURL: URL) {
        guard let data = try? Data(contentsOf: catalogURL),
              let catalog = try? JSONSerialization.jsonObject(with: data) as? [String: [String: [String: String]]],
              let codes = catalog["codes"], let stages = catalog["stages"],
              value["version"] as? Int == 1,
              let code = value["code"] as? String, codes[code]?["en"] != nil,
              let stage = value["stage"] as? String, stages[stage]?["en"] != nil else { return nil }
        self.code = code; self.stage = stage; self.codes = codes; self.stages = stages
        var safe: [String: Any] = ["version": 1, "code": code, "stage": stage]
        if let exitCode = value["exitCode"] as? Int, (0...255).contains(exitCode) { safe["exitCode"] = exitCode }
        if let signal = value["signal"] as? String, ["SIGTERM", "SIGKILL", "SIGABRT", "SIGINT", "SIGSEGV"].contains(signal) { safe["signal"] = signal }
        diagnostic = safe
    }

    func message(language: String) -> String {
        let locale = language == "ja" ? "ja" : "en"
        let title = stages[stage]?[locale] ?? stages[stage]!["en"]!
        let guidance = codes[code]?[locale] ?? codes[code]!["en"]!
        return "\(title): \(guidance) (\(code))"
    }

    func copyText(appVersion: String?, build: String?) -> String? {
        var safe = diagnostic
        for (key, value) in [("appVersion", appVersion), ("build", build)] {
            if let value, value.range(of: "^[0-9]+(?:\\.[0-9]+)*$", options: .regularExpression) != nil { safe[key] = value }
        }
        guard let data = try? JSONSerialization.data(withJSONObject: safe, options: [.prettyPrinted, .sortedKeys]) else { return nil }
        return String(data: data, encoding: .utf8)
    }
}
