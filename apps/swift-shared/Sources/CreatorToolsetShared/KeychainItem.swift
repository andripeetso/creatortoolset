import Foundation
import Security

/// One generic-password Keychain item, the shape every vault in the Mac and iPhone apps shares (the Mac's device tokens,
/// plug-in record and DPoP key; the iPhone's server sign-ins). Each keeps its own service, account and accessibility, so
/// the items it wrote before are still found. `dataProtection` puts a Mac's item in the data-protection Keychain (an
/// iPhone's always is).
public enum KeychainItem {
    public static func query(service: String, account: String, dataProtection: Bool) -> [String: Any] {
        var q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account]
        if dataProtection { q[kSecUseDataProtectionKeychain as String] = true }
        return q
    }

    /// The value, or nil when none is kept.
    public static func read(service: String, account: String, dataProtection: Bool = false) -> Data? {
        var q = query(service: service, account: account, dataProtection: dataProtection)
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        guard SecItemCopyMatching(q as CFDictionary, &item) == errSecSuccess else { return nil }
        return item as? Data
    }

    /// Replaces the value, or adds the item with `accessible` when none is kept. The Keychain's status.
    @discardableResult
    public static func write(_ data: Data, service: String, account: String, accessible: CFString, dataProtection: Bool = false) -> OSStatus {
        let q = query(service: service, account: account, dataProtection: dataProtection)
        let updated = SecItemUpdate(q as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        guard updated == errSecItemNotFound else { return updated }
        var item = q
        item[kSecValueData as String] = data
        item[kSecAttrAccessible as String] = accessible
        return SecItemAdd(item as CFDictionary, nil)
    }

    public static func delete(service: String, account: String, dataProtection: Bool = false) {
        SecItemDelete(query(service: service, account: account, dataProtection: dataProtection) as CFDictionary)
    }

    /// Whether this build can use the data-protection Keychain: only a write or delete there says no (errSecMissingEntitlement),
    /// so the question is asked with a delete of an item that is never made.
    public static func dataProtectionAvailable(service: String) -> Bool {
        SecItemDelete(query(service: service, account: "probe", dataProtection: true) as CFDictionary) != errSecMissingEntitlement
    }
}
