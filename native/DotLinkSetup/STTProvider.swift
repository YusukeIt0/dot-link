import Foundation

struct STTProviderInfo: Decodable {
    let name: String
    let model: String
    let pricing: String
    let privacy: String
    var label: String { name + " " + model }
    static let order = ["whisper", "soniox", "elevenlabs", "microsoft", "openai", "assemblyai"]
    static let catalog: [String: STTProviderInfo] = {
        guard let resources = Bundle.main.resourceURL,
              let data = try? Data(contentsOf: resources.appendingPathComponent("payload/src/stt-providers.json")),
              let result = try? JSONDecoder().decode([String: STTProviderInfo].self, from: data),
              order.allSatisfy({ result[$0] != nil }) else { return [:] }
        return result
    }()
}
