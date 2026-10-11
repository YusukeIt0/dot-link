import Foundation
import Security

// The app itself owns this item, including when invoked as a bounded helper.
// No trusted-app wildcard or weakened ACL is installed.
final class STTCredentials {
    let keychain: SecKeychain?
    let service: String
    init(keychain: SecKeychain? = nil, service: String = "app.tripsurf.dotlink.stt") {
        self.keychain = keychain; self.service = service
    }
    func perform(_ operation: String, key: String = "", interactive: Bool = false) -> [String: String] {
        guard ["read", "authorize", "save", "delete", "metadata"].contains(operation) else { return ["status": "invalid"] }
        if operation == "save" && (key.isEmpty || key.utf8.count > 4096 || key.unicodeScalars.contains(where: { !CharacterSet(charactersIn: "!#$%&'*+.^_`|~0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-").contains($0) })) { return ["status": "invalid"] }
        var selected = keychain
        if selected == nil {
            let status = SecKeychainCopyDefault(&selected)
            guard status == errSecSuccess else { return result(status) }
        }
        guard let selected else { return ["status": "unavailable"] }
        SecKeychainSetUserInteractionAllowed(interactive)
        if !interactive {
            var state: SecKeychainStatus = 0
            let status = SecKeychainGetStatus(selected, &state)
            guard status == errSecSuccess else { return result(status) }
            guard state & UInt32(kSecUnlockStateStatus) != 0 else { return ["status": "locked"] }
        }
        if operation == "metadata" {
            // Attributes only: never read the secret or trigger a permission prompt.
            let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
                kSecAttrService as String: service, kSecAttrAccount as String: "soniox",
                kSecMatchSearchList as String: [selected], kSecMatchLimit as String: kSecMatchLimitOne,
                kSecReturnAttributes as String: true, kSecReturnData as String: false]
            var attributes: CFTypeRef?
            let status = SecItemCopyMatching(query as CFDictionary, &attributes)
            if status == errSecItemNotFound { return ["status": "ok", "count": "0"] }
            guard status == errSecSuccess, let values = attributes as? [String: Any] else { return result(status) }
            var metadata = ["status": "ok", "count": "1"]
            if let date = values[kSecAttrModificationDate as String] as? Date {
                metadata["savedAt"] = ISO8601DateFormatter().string(from: date)
            }
            return metadata
        }
        let account = "soniox"
        var item: SecKeychainItem?
        var length: UInt32 = 0
        var bytes: UnsafeMutableRawPointer?
        let needsContent = operation == "read" || operation == "authorize"
        let status = service.withCString { svc in account.withCString { acct in
            if needsContent { return SecKeychainFindGenericPassword(selected, UInt32(service.utf8.count), svc, UInt32(account.utf8.count), acct, &length, &bytes, &item) }
            return SecKeychainFindGenericPassword(selected, UInt32(service.utf8.count), svc, UInt32(account.utf8.count), acct, nil, nil, &item)
        }}
        defer { if let bytes { SecKeychainItemFreeContent(nil, bytes) } }
        if operation == "delete" {
            if status == errSecItemNotFound { return ["status": "ok"] }
            guard status == errSecSuccess, let item else { return result(status) }
            return result(SecKeychainItemDelete(item))
        }
        if operation == "save" {
            let data = Data(key.utf8)
            if status == errSecItemNotFound {
                return data.withUnsafeBytes { raw in
                    service.withCString { svc in account.withCString { acct in
                        result(SecKeychainAddGenericPassword(selected, UInt32(service.utf8.count), svc, UInt32(account.utf8.count), acct, UInt32(data.count), raw.baseAddress!, nil))
                    }}
                }
            }
            guard status == errSecSuccess, let item else { return result(status) }
            return data.withUnsafeBytes { result(SecKeychainItemModifyAttributesAndData(item, nil, UInt32(data.count), $0.baseAddress)) }
        }
        guard status == errSecSuccess else { return result(status) }
        guard let bytes, length > 0, length <= 4096, let value = String(data: Data(bytes: bytes, count: Int(length)), encoding: .utf8) else { return ["status": "invalid"] }
        return operation == "read" ? ["status": "ok", "key": value] : ["status": "ok"]
    }
    private func result(_ status: OSStatus) -> [String: String] {
        switch status {
        case errSecSuccess: return ["status": "ok"]
        case errSecItemNotFound: return ["status": "missing"]
        case errSecUserCanceled: return ["status": "cancelled"]
        case errSecAuthFailed, errSecInteractionNotAllowed: return ["status": "permission"]
        default: return ["status": "unavailable"]
        }
    }
}

func runSTTCredentialHelper() -> Never {
    let operation = CommandLine.arguments.count == 3 ? CommandLine.arguments[2] : "invalid"
    var key = ""
    if operation == "save" {
        // A fixed bound avoids blocking or allocating unbounded stdin data.
        let data = FileHandle.standardInput.readData(ofLength: 8193)
        if data.count <= 8192, let input = try? JSONSerialization.jsonObject(with: data) as? [String: String] { key = input["key"] ?? "" }
    }
    let result = STTCredentials().perform(operation, key: key, interactive: ["save", "authorize", "delete"].contains(operation))
    key = ""
    if let data = try? JSONSerialization.data(withJSONObject: result) { FileHandle.standardOutput.write(data) }
    exit(0)
}
