import Foundation
import Security

// Compiled into the app and the Share extension: both read the servers and their sign-ins from the Keychain.

/// A Creator Toolset server this phone talks to: the one on the person's own computer, their own server, or a hosted
/// one. The sign-in cookie (`cap_auth`) is kept in the Keychain, never in the list.
struct Server: Codable, Identifiable, Hashable {
    let url: URL
    var username: String?
    /// The computer's own name, for one reached through the account (its address is a row of letters and digits).
    var label: String?
    var id: String { url.absoluteString }
    var name: String { label ?? (url.host(percentEncoded: false) ?? url.absoluteString) + (url.port.map { ":\($0)" } ?? "") }
}

/// The servers and the one in use, as the app last saved them. The app keeps its own copy in its settings; this one
/// is in the Keychain so the Share extension, which can't read the app's settings, knows them too.
struct SavedServers: Codable, Equatable {
    var list: [Server]
    var currentId: String?

    static let account = "servers"

    static func read() -> SavedServers? {
        Keychain.get(account).flatMap { try? JSONDecoder().decode(SavedServers.self, from: Data($0.utf8)) }
    }

    func write() {
        Keychain.set(Self.account, (try? JSONEncoder().encode(self)).flatMap { String(data: $0, encoding: .utf8) })
    }

    /// The server in use and its sign-in cookie (nil cookie: a server without sign-in, or signed out).
    var current: (server: Server, cookie: String?)? {
        list.first { $0.id == currentId }.map { ($0, Keychain.get($0.id)) }
    }
}

/// One generic-password item per server, readable after the first unlock (background uploads need it). The app and
/// the Share extension share a keychain group, the first one in their entitlements, which is where new items go.
enum Keychain {
    private static let service = "creator-toolset.server"

    private static func query(_ account: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: service,
         kSecAttrAccount as String: account]
    }

    static func get(_ account: String) -> String? {
        var q = query(account)
        q[kSecReturnData as String] = true
        var out: AnyObject?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let data = out as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    /// Saves (nil deletes). False when the Keychain refused it.
    @discardableResult
    static func set(_ account: String, _ value: String?) -> Bool {
        SecItemDelete(query(account) as CFDictionary)
        guard let value else { return true }
        var q = query(account)
        q[kSecValueData as String] = Data(value.utf8)
        q[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        return SecItemAdd(q as CFDictionary, nil) == errSecSuccess
    }

    /// Items saved before the shared group existed sit in the app's own group, where the Share extension can't read
    /// them: each is saved again, once, so it lands in the shared group. Locked phone: tried again next launch.
    static func moveToSharedGroup(defaults: UserDefaults = .standard) {
        let done = "keychainShared"
        guard !defaults.bool(forKey: done) else { return }
        var q: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
                                kSecAttrService as String: service,
                                kSecMatchLimit as String: kSecMatchLimitAll,
                                kSecReturnAttributes as String: true,
                                kSecReturnData as String: true]
        var out: AnyObject?
        let status = SecItemCopyMatching(q as CFDictionary, &out)
        guard status == errSecSuccess || status == errSecItemNotFound else { return }
        for item in (out as? [[String: Any]]) ?? [] {
            guard let account = item[kSecAttrAccount as String] as? String, let data = item[kSecValueData as String] as? Data,
                  let value = String(data: data, encoding: .utf8) else { continue }
            set(account, value)
        }
        defaults.set(true, forKey: done)
    }
}
