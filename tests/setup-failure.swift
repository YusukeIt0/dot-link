import Foundation
@main enum SetupFailureTests {
    static func main() throws {
        let catalogURL = URL(fileURLWithPath: "scripts/lib/setup-errors.json")
        let raw: [String: Any] = ["version": 1, "code": "TAILSCALE_HTTPS_FAILED", "stage": "https", "exitCode": 7, "signal": "SIGTERM", "stdout": "sk-private", "message": "sk-private", "origin": "https://private.ts.net"]
        let details = SetupFailureDetails(value: raw, catalogURL: catalogURL)!
        precondition(details.message(language: "en").contains("HTTPS Certificates"))
        precondition(details.message(language: "ja").contains("再試行"))
        precondition(details.message(language: "de") == details.message(language: "en"))
        let copy = details.copyText(appVersion: "0.4.7", build: "75")!
        precondition(!copy.contains("private"))
        let json = try JSONSerialization.jsonObject(with: Data(copy.utf8)) as! [String: Any]
        precondition(Set(json.keys) == Set(["version", "code", "stage", "exitCode", "signal", "appVersion", "build"]))
        precondition(json["exitCode"] as? Int == 7)
        precondition(json["appVersion"] as? String == "0.4.7")
        precondition(!details.copyText(appVersion: "sk-private", build: "sk-private")!.contains("private"))
        // The user can refresh repeatedly and still copy the original failure.
        var presentation = SetupFailurePresentation(details: details, copied: true)
        for _ in 0..<3 {
            presentation.begin("inspect")
            precondition(presentation.copied)
            precondition(presentation.details?.message(language: "ja") == details.message(language: "ja"))
            precondition(presentation.details?.message(language: "en") == details.message(language: "en"))
            precondition(presentation.details?.copyText(appVersion: "0.4.7", build: "75") == copy)
        }
        // Starting a retry or changing setup invalidates the previous failure,
        // so a successful completion cannot leave stale diagnostics visible.
        for action in ["activate", "save-tunnel", "pause", "resume", "shutdown", "uninstall"] {
            presentation = SetupFailurePresentation(details: details, copied: true)
            presentation.begin(action)
            precondition(presentation.details == nil && !presentation.copied)
        }
        var invalid = raw; invalid["code"] = "SK_PRIVATE"
        precondition(SetupFailureDetails(value: invalid, catalogURL: catalogURL) == nil)
        invalid = raw; invalid["stage"] = "sk-private"
        precondition(SetupFailureDetails(value: invalid, catalogURL: catalogURL) == nil)
        precondition(SetupFailureDetails(value: raw, catalogURL: URL(fileURLWithPath: "/missing/catalog.json")) == nil)
        let catalog = try JSONSerialization.jsonObject(with: Data(contentsOf: catalogURL)) as! [String: [String: Any]]
        for code in catalog["codes"]!.keys {
            var value = raw; value["code"] = code
            let detail = SetupFailureDetails(value: value, catalogURL: catalogURL)!
            precondition(!detail.message(language: "ja").isEmpty)
            precondition(detail.message(language: "en").contains(code))
        }
        print("Setup failure presentation, localization and safe copying passed")
    }
}
