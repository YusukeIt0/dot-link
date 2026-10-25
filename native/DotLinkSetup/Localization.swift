import Foundation

struct LocalizedMessage {
    let key: String
    var parameters: [String: String] = [:]
    var suffix = ""
    init(_ key: String, _ parameters: [String: String] = [:], suffix: String = "") {
        self.key = key; self.parameters = parameters; self.suffix = suffix
    }
}

// The same resources serve the WebView and native application. Language choices
// affect app-owned presentation only, never conversation or notification data.
final class Localization {
    struct LocaleInfo: Decodable {
        let name: String
        let speechLocale: String
        let dateLocale: String
        let order: Int
        let legacyPrefix: Bool?
        let matchLocales: [String]?
        let dateFormat: String?
    }
    static let shared = Localization(directory: Bundle.main.resourceURL!.appendingPathComponent("payload/localization"))
    let metadata: [String: LocaleInfo]
    let catalogs: [String: [String: String]]
    var languages: [String] { metadata.keys.sorted { metadata[$0]!.order < metadata[$1]!.order } }
    init(directory: URL) {
        let decoder = JSONDecoder()
        metadata = (try? decoder.decode([String: LocaleInfo].self, from: Data(contentsOf: directory.appendingPathComponent("locales.json")))) ?? [:]
        catalogs = Dictionary(uniqueKeysWithValues: metadata.keys.map { locale in
            (locale, (try? decoder.decode([String: String].self, from: Data(contentsOf: directory.appendingPathComponent(locale + ".json")))) ?? [:])
        })
    }
    func choose(preferred: String, saved: String? = nil) -> String {
        if let saved, metadata[saved] != nil { return saved }
        let value = preferred.lowercased().replacingOccurrences(of: "_", with: "-")
        let matches = languages.flatMap { locale in
            ([locale] + (metadata[locale]?.matchLocales ?? [])).map { (locale: locale, tag: $0.lowercased()) }
        }.sorted { $0.tag.count > $1.tag.count }
        return matches.first { match in
            value == match.tag || value.hasPrefix(match.tag + "-") ||
            (metadata[match.locale]?.legacyPrefix == true && value.hasPrefix(match.tag))
        }?.locale ?? "en"
    }
    func text(_ key: String, language: String, _ parameters: [String: String] = [:]) -> String {
        let template = catalogs[language]?[key] ?? catalogs["en"]?[key] ?? key
        let pattern = try! NSRegularExpression(pattern: "\\{([a-zA-Z][a-zA-Z0-9_]*)\\}")
        let source = template as NSString
        var result = "", end = 0
        for match in pattern.matches(in: template, range: NSRange(location: 0, length: source.length)) {
            result += source.substring(with: NSRange(location: end, length: match.range.location - end))
            result += parameters[source.substring(with: match.range(at: 1))] ?? source.substring(with: match.range)
            end = match.range.location + match.range.length
        }
        return result + source.substring(from: end)
    }
    func text(_ message: LocalizedMessage, language: String) -> String {
        text(message.key, language: language, message.parameters) + message.suffix
    }
}
