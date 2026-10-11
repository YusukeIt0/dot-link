import Foundation
import Security

@main struct KeychainTest {
    static func main() throws {
        if CommandLine.arguments[1] == "--probe" {
            SecKeychainSetUserInteractionAllowed(false)
            var item: SecKeychain?
            guard SecKeychainOpen(CommandLine.arguments[2], &item) == errSecSuccess, let item else { fatalError("isolated keychain open failed") }
            let store = STTCredentials(keychain: item, service: "dot-link-isolated-stt-test")
            let metadata = store.perform("metadata")
            assert(metadata["count"] == "1" && metadata["savedAt"] != nil && metadata["key"] == nil)
            let result = store.perform("read")
            #if STT_UPDATED
            print("updated:" + (result["status"] ?? "unknown"))
            #else
            print("original:" + (result["status"] ?? "unknown"))
            #endif
            return
        }
        let directory = CommandLine.arguments[1]
        let path = directory + "/isolated.keychain-db"
        let password = "isolated-test-only"
        var keychain: SecKeychain?
        SecKeychainSetUserInteractionAllowed(false)
        let created = password.withCString { SecKeychainCreate(path, UInt32(password.utf8.count), $0, false, nil, &keychain) }
        guard created == errSecSuccess, let keychain else { fatalError("isolated keychain create failed: \(created)") }
        defer { SecKeychainDelete(keychain) }
        let store = STTCredentials(keychain: keychain, service: "dot-link-isolated-stt-test")
        assert(store.perform("read")["status"] == "missing")
        assert(store.perform("metadata") == ["status": "ok", "count": "0"])
        assert(store.perform("save", key: "dummy-stt-test-key")["status"] == "ok")
        assert(store.perform("read")["key"] == "dummy-stt-test-key")
        let metadata = store.perform("metadata")
        assert(metadata["status"] == "ok" && metadata["count"] == "1" && metadata["key"] == nil)
        assert(ISO8601DateFormatter().date(from: metadata["savedAt"] ?? "") != nil)
        Thread.sleep(forTimeInterval: 1.1)
        assert(store.perform("save", key: "dummy-stt-replaced-key")["status"] == "ok")
        assert(store.perform("read")["key"] == "dummy-stt-replaced-key")
        let replaced = store.perform("metadata")
        assert(replaced["count"] == "1" && replaced["savedAt"] != metadata["savedAt"])
        func probe(_ executable: String) throws -> String {
            let child = Process(); child.executableURL = URL(fileURLWithPath: executable); child.arguments = ["--probe", path]
            let output = Pipe(); child.standardOutput = output; child.standardError = FileHandle.nullDevice
            try child.run(); let data = output.fileHandleForReading.readDataToEndOfFile(); child.waitUntilExit()
            assert(child.terminationStatus == 0)
            return String(decoding: data, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
        }
        let restarted = try probe(CommandLine.arguments[0]); assert(restarted == "original:ok")
        let updated = try probe(CommandLine.arguments[2]); assert(updated == "updated:permission")
        assert(store.perform("authorize") == ["status": "ok"])
        assert(store.perform("metadata") == replaced)
        assert(store.perform("save", key: "invalid key")["status"] == "invalid")
        assert(store.perform("read")["key"] == "dummy-stt-replaced-key")
        assert(SecKeychainLock(keychain) == errSecSuccess)
        assert(store.perform("read")["status"] == "locked")
        assert(store.perform("metadata")["status"] == "locked")
        assert(store.perform("delete")["status"] == "locked")
        assert(password.withCString { SecKeychainUnlock(keychain, UInt32(password.utf8.count), $0, true) } == errSecSuccess)
        assert(store.perform("read")["key"] == "dummy-stt-replaced-key")
        assert(store.perform("delete")["status"] == "ok")
        assert(store.perform("read")["status"] == "missing")
        assert(store.perform("metadata") == ["status": "ok", "count": "0"])
        assert(store.perform("delete")["status"] == "ok")
        print("PASS isolated STT Keychain: save, replace, invalid, read, authorize, restart, changed signature denied, metadata without secret access, timestamps, lock, unlock, delete")
    }
}
