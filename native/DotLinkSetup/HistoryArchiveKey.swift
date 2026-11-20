import CryptoKit
import Foundation
import LocalAuthentication
import Security

private enum ArchiveKeyError: Error { case unavailable }

// Only this envelope may be persisted by the caller. The Secure Enclave
// representation can be reopened on the originating Mac after first unlock.
private struct ArchiveKeyEnvelope: Codable {
    let version: Int
    let deviceKey: Data
    let ephemeralPublicKey: Data
    let sealedKey: Data
}

private enum HistoryArchiveKey {
    private static let domain = Data("app.tripsurf.dotlink:history-archive-key:v1".utf8)
    private static let maxInputBytes = 16 * 1024

    private static func wrappingKey(
        deviceKey: SecureEnclave.P256.KeyAgreement.PrivateKey,
        ephemeralPublicKey: P256.KeyAgreement.PublicKey
    ) throws -> SymmetricKey {
        let secret = try deviceKey.sharedSecretFromKeyAgreement(with: ephemeralPublicKey)
        return secret.hkdfDerivedSymmetricKey(
            using: SHA256.self, salt: domain,
            sharedInfo: deviceKey.publicKey.x963Representation + ephemeralPublicKey.x963Representation,
            outputByteCount: 32
        )
    }

    private static func create(context: LAContext) throws -> [String: String] {
        guard let access = SecAccessControlCreateWithFlags(
            nil, kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly, .privateKeyUsage, nil
        ) else { throw ArchiveKeyError.unavailable }
        let deviceKey = try SecureEnclave.P256.KeyAgreement.PrivateKey(accessControl: access, authenticationContext: context)
        let peer = P256.KeyAgreement.PrivateKey().publicKey
        let wrapping = try wrappingKey(deviceKey: deviceKey, ephemeralPublicKey: peer)
        let dataKey = SymmetricKey(size: .bits256).withUnsafeBytes { Data($0) }
        guard let sealedKey = try AES.GCM.seal(dataKey, using: wrapping, authenticating: domain).combined
        else { throw ArchiveKeyError.unavailable }
        let envelope = ArchiveKeyEnvelope(
            version: 1, deviceKey: deviceKey.dataRepresentation,
            ephemeralPublicKey: peer.x963Representation, sealedKey: sealedKey
        )
        let wrapped = try JSONEncoder().encode(envelope).base64EncodedString()
        return ["key": dataKey.base64EncodedString(), "wrapped": wrapped]
    }

    private static func open(_ wrapped: String, context: LAContext) throws -> [String: String] {
        guard let encoded = Data(base64Encoded: wrapped) else { throw ArchiveKeyError.unavailable }
        let envelope = try JSONDecoder().decode(ArchiveKeyEnvelope.self, from: encoded)
        guard envelope.version == 1, !envelope.deviceKey.isEmpty, envelope.ephemeralPublicKey.count == 65,
              envelope.sealedKey.count == 12 + 32 + 16 else { throw ArchiveKeyError.unavailable }
        let peer = try P256.KeyAgreement.PublicKey(x963Representation: envelope.ephemeralPublicKey)
        let deviceKey = try SecureEnclave.P256.KeyAgreement.PrivateKey(
            dataRepresentation: envelope.deviceKey, authenticationContext: context
        )
        let wrapping = try wrappingKey(deviceKey: deviceKey, ephemeralPublicKey: peer)
        let box = try AES.GCM.SealedBox(combined: envelope.sealedKey)
        let dataKey = try AES.GCM.open(box, using: wrapping, authenticating: domain)
        return ["key": dataKey.base64EncodedString()]
    }

    static func run(_ arguments: [String]) throws -> [String: String] {
        guard arguments.count == 3, arguments[1] == "--history-archive-key",
              ["create", "open"].contains(arguments[2]), SecureEnclave.isAvailable else { throw ArchiveKeyError.unavailable }
        var data = Data()
        while let chunk = try FileHandle.standardInput.read(upToCount: maxInputBytes + 1 - data.count), !chunk.isEmpty {
            data.append(chunk)
            guard data.count <= maxInputBytes else { throw ArchiveKeyError.unavailable }
        }
        guard let input = try JSONSerialization.jsonObject(with: data) as? [String: String]
        else { throw ArchiveKeyError.unavailable }
        let context = LAContext()
        context.interactionNotAllowed = true
        switch arguments[2] {
        case "create" where input.isEmpty:
            return try create(context: context)
        case "open":
            guard input.count == 1, let wrapped = input["wrapped"] else { throw ArchiveKeyError.unavailable }
            return try open(wrapped, context: context)
        default:
            throw ArchiveKeyError.unavailable
        }
    }
}

func runHistoryArchiveKeyHelper() -> Never {
    do {
        let result = try HistoryArchiveKey.run(CommandLine.arguments)
        try FileHandle.standardOutput.write(contentsOf: JSONEncoder().encode(result))
        exit(0)
    } catch {
        FileHandle.standardOutput.write(Data(#"{"error":"HISTORY_ARCHIVE_KEY_UNAVAILABLE"}"#.utf8))
        exit(1)
    }
}
