import Foundation

@main enum MacLocalizationTests {
    static func main() throws {
        let localization = Localization(directory: URL(fileURLWithPath: "localization"))
        precondition(localization.languages == ["ja", "en", "ko"])
        for (preferred, saved, expected) in [("ko-KR", nil, "ko"), ("KO_kr", nil, "ko"), ("kok-IN", nil, "en"), ("ja-JP", nil, "ja"), ("de-DE", nil, "en"), ("ja-JP", "ko", "ko"), ("ko-KR", "invalid", "ko")] {
            precondition(localization.choose(preferred: preferred, saved: saved) == expected)
        }
        let status = LocalizedMessage("mac.downloading_update_p", ["p": "42"])
        precondition(localization.text(status, language: "en") == "Downloading update… 42%")
        precondition(localization.text(status, language: "ja") == "更新をダウンロード中… 42%")
        precondition(localization.text(status, language: "ko") == "업데이트 다운로드 중… 42%")
        precondition(localization.text(status, language: "unknown") == localization.text(status, language: "en"))
        let denied = LocalizedMessage("mac.notification_test_denied_help")
        precondition(localization.text(denied, language: "ja").contains("システム設定"))
        precondition(localization.text(denied, language: "ko").contains("시스템 설정"))
        let value = "{name} $& \\ 🐈"
        precondition(localization.text("mac.delete_provider_key", language: "ko", ["name": value]) == value + " 키를 삭제할까요?")
        // The fallback is loaded from English even if a registered language file
        // is absent; device contents never become translation lookup keys.
        let temp = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: temp, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: temp) }
        for name in ["locales.json", "en.json"] {
            try FileManager.default.copyItem(at: URL(fileURLWithPath: "localization/" + name), to: temp.appendingPathComponent(name))
        }
        let fallback = Localization(directory: temp)
        precondition(fallback.text(status, language: "ko") == localization.text(status, language: "en"))
        precondition(localization.metadata["ko"]?.dateLocale == "ko_KR")
        print("Mac language resolution, retained status, placeholders and English fallback passed")
    }
}
