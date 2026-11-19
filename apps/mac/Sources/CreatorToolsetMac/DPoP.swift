import CryptoKit
import Foundation
import Security

/// This Mac's proof-of-possession key (RFC 9449) for its account token: a P-256 key in the Secure Enclave (a software
/// key where there is none), made once and kept in the Keychain. The account token is bound to it at sign-in and goes
/// out only as `Authorization: DPoP` with this key's proof, so a copy of the token is useless on another machine.
struct DPoPKey {
    let publicKey: P256.Signing.PublicKey
    let sign: (Data) throws -> P256.Signing.ECDSASignature

    /// This Mac's key, made on first use. Nil only when the Keychain won't keep it (the token then stays as it is).
    static let shared: DPoPKey? = load() ?? make()

    private static func load() -> DPoPKey? {
        guard let stored = KeyItem.read(),
              let data = Data(base64Encoded: String(stored.dropFirst(3))) else { return nil }
        if stored.hasPrefix("se:"), let key = try? SecureEnclave.P256.Signing.PrivateKey(dataRepresentation: data) {
            return DPoPKey(publicKey: key.publicKey, sign: { try key.signature(for: $0) })
        }
        if stored.hasPrefix("sw:"), let key = try? P256.Signing.PrivateKey(rawRepresentation: data) { return software(key) }
        return nil
    }

    private static func make() -> DPoPKey? {
        if SecureEnclave.isAvailable, let key = try? SecureEnclave.P256.Signing.PrivateKey() {
            guard KeyItem.save("se:" + key.dataRepresentation.base64EncodedString()) else { return nil }
            return DPoPKey(publicKey: key.publicKey, sign: { try key.signature(for: $0) })
        }
        let key = P256.Signing.PrivateKey()
        guard KeyItem.save("sw:" + key.rawRepresentation.base64EncodedString()) else { return nil }
        return software(key)
    }

    static func software(_ key: P256.Signing.PrivateKey) -> DPoPKey {
        DPoPKey(publicKey: key.publicKey, sign: { try key.signature(for: $0) })
    }

    /// The public key as a JWK: x and y, 32 bytes each.
    var jwk: [String: String] {
        let raw = publicKey.rawRepresentation   // x || y
        return ["kty": "EC", "crv": "P-256", "x": DPoP.b64(raw.prefix(32)), "y": DPoP.b64(raw.suffix(32))]
    }

    /// RFC 7638: SHA-256 of the required members in lexical order, no spaces.
    var thumbprint: String {
        let j = jwk
        let canonical = #"{"crv":"P-256","kty":"EC","x":"\#(j["x"]!)","y":"\#(j["y"]!)"}"#
        return DPoP.b64(Data(SHA256.hash(data: Data(canonical.utf8))))
    }
}

/// The key's Keychain item: this device only, so a software key never goes into a backup or onto another Mac (a Secure
/// Enclave key's blob is of no use elsewhere anyway). In the data-protection Keychain when the build may use it; a build
/// without its entitlement keeps it in the file-based Keychain (the same question Plugins.swift asks).
enum KeyItem {
    static let service = Account.vault, account = "dpop-key"

    static func query(dataProtection: Bool) -> [String: Any] {
        var q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account]
        if dataProtection { q[kSecUseDataProtectionKeychain as String] = true }
        return q
    }

    /// Whether the data-protection Keychain can be used: only a write or delete there says no (errSecMissingEntitlement).
    static var protected: Bool {
        var q = query(dataProtection: true)
        q[kSecAttrAccount as String] = "probe"
        return SecItemDelete(q as CFDictionary) != errSecMissingEntitlement
    }

    static func read() -> String? {
        var q = query(dataProtection: protected)
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        guard SecItemCopyMatching(q as CFDictionary, &item) == errSecSuccess, let data = item as? Data else { return nil }
        return String(decoding: data, as: UTF8.self)
    }

    /// The new item: readable after the first unlock, on this device only.
    static func adding(_ value: String, dataProtection: Bool) -> [String: Any] {
        var q = query(dataProtection: dataProtection)
        q[kSecValueData as String] = Data(value.utf8)
        q[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        return q
    }

    static func save(_ value: String) -> Bool {
        let dp = protected
        SecItemDelete(query(dataProtection: dp) as CFDictionary)
        return SecItemAdd(adding(value, dataProtection: dp) as CFDictionary, nil) == errSecSuccess
    }

}

enum DPoP {
    /// A proof for one request: `typ dpop+jwt`, ES256, the public key in the header; `htm`, `htu` (the URL without
    /// query or fragment), `iat`, a fresh `jti`, and `ath` (the token's hash) when a token rides with it.
    static func proof(method: String, url: URL, accessToken: String? = nil, key: DPoPKey,
                      now: Date = Date(), jti: String = UUID().uuidString) throws -> String {
        let header: [String: Any] = ["typ": "dpop+jwt", "alg": "ES256", "jwk": key.jwk]
        var claims: [String: Any] = ["jti": jti, "htm": method.uppercased(), "htu": htu(url), "iat": Int(now.timeIntervalSince1970)]
        if let accessToken { claims["ath"] = b64(Data(SHA256.hash(data: Data(accessToken.utf8)))) }
        let input = try b64(json(header)) + "." + b64(json(claims))
        // CryptoKit's raw signature is r || s, 64 bytes: the JWS form of ES256
        return input + "." + b64(try key.sign(Data(input.utf8)).rawRepresentation)
    }

    static func htu(_ url: URL) -> String {
        var parts = URLComponents(url: url, resolvingAgainstBaseURL: true) ?? URLComponents()
        parts.query = nil
        parts.fragment = nil
        parts.scheme = parts.scheme?.lowercased()
        parts.host = parts.host?.lowercased()
        if parts.path.isEmpty { parts.path = "/" }
        return parts.url?.absoluteString ?? url.absoluteString
    }

    private static func json(_ object: [String: Any]) throws -> Data {
        try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys, .withoutEscapingSlashes])
    }

    static func b64<D: DataProtocol>(_ data: D) -> String {
        Data(data).base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}

/// Which account tokens this Mac bound to its key: their SHA-256, the last few (a sign-in to another account keeps
/// the old token for a moment, to leave it). A token not listed is a plain one from an app before binding.
enum BoundTokens {
    private static let key = "accountBoundTokens"
    private static func hash(_ token: String) -> String { SHA256.hash(data: Data(token.utf8)).map { String(format: "%02x", $0) }.joined() }
    static func contains(_ token: String) -> Bool { (UserDefaults.standard.stringArray(forKey: key) ?? []).contains(hash(token)) }
    static func add(_ token: String) {
        let list = (UserDefaults.standard.stringArray(forKey: key) ?? []).filter { $0 != hash(token) } + [hash(token)]
        UserDefaults.standard.set(Array(list.suffix(8)), forKey: key)
    }
}
