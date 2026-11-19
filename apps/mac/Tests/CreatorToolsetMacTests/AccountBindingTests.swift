import CryptoKit
import Foundation
import XCTest
@testable import CreatorToolsetMac

/// The Mac app's account token is bound to its own key, the way the phone's is: bound at sign-in, then sent as DPoP
/// with that key's proof on every use; a plain token from an app before binding binds itself once.
final class AccountBindingTests: XCTestCase {
    private let mac = DPoPKey.software(P256.Signing.PrivateKey())

    private var client: AccountClient {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [StubServer.self]
        return AccountClient(server: URL(string: "https://accounts.example.com")!, session: URLSession(configuration: config), key: mac)
    }

    override func setUp() {
        StubServer.routes = [:]
        StubServer.seen = []
    }

    private func unb64(_ s: String) -> Data {
        var t = s.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        while t.count % 4 != 0 { t += "=" }
        return Data(base64Encoded: t)!
    }

    /// The proof on the last request, checked against this Mac's key; its claims.
    private func proofClaims(_ request: URLRequest) throws -> [String: Any] {
        let parts = try XCTUnwrap(request.value(forHTTPHeaderField: "DPoP")).split(separator: ".").map(String.init)
        XCTAssertEqual(parts.count, 3)
        let header = try JSONSerialization.jsonObject(with: unb64(parts[0])) as! [String: Any]
        XCTAssertEqual(header["typ"] as? String, "dpop+jwt")
        XCTAssertEqual(header["jwk"] as? [String: String], mac.jwk)
        let sig = try P256.Signing.ECDSASignature(rawRepresentation: unb64(parts[2]))
        XCTAssertTrue(mac.publicKey.isValidSignature(sig, for: Data("\(parts[0]).\(parts[1])".utf8)))
        return try JSONSerialization.jsonObject(with: unb64(parts[1])) as! [String: Any]
    }

    func testSignInBindsTheTokenAndEveryUseCarriesTheProof() async throws {
        let token = "cta_\(UUID().uuidString)"
        StubServer.routes["/api/account/token"] = (200, #"{"token":"\#(token)","name":"Sam","email":"sam@tinyacrobatics.com","bound":true}"#)
        _ = try await client.exchange("abc", verifier: "v")
        let signIn = try proofClaims(StubServer.seen.last!)
        XCTAssertEqual(signIn["htu"] as? String, "https://accounts.example.com/api/account/token")
        XCTAssertEqual(signIn["htm"] as? String, "POST")
        XCTAssertNil(signIn["ath"])
        let body = try JSONDecoder().decode([String: String].self, from: StubServer.seen.last!.httpBodyStream.map { stream in
            stream.open(); defer { stream.close() }
            var data = Data(), buffer = [UInt8](repeating: 0, count: 1024)
            while stream.hasBytesAvailable { let n = stream.read(&buffer, maxLength: 1024); if n <= 0 { break }; data.append(buffer, count: n) }
            return data
        } ?? StubServer.seen.last!.httpBody!)
        XCTAssertEqual(body["app"], "mac")   // signing the phones out leaves this binding

        StubServer.routes["/api/account/relay-token"] = (200, #"{"token":"relay-1"}"#)
        _ = try await client.relayToken(token)
        let sent = StubServer.seen.last!
        XCTAssertEqual(sent.value(forHTTPHeaderField: "Authorization"), "DPoP \(token)")
        let use = try proofClaims(sent)
        XCTAssertEqual(use["htu"] as? String, "https://accounts.example.com/api/account/relay-token")
        XCTAssertEqual(use["ath"] as? String, DPoP.b64(Data(SHA256.hash(data: Data(token.utf8)))))
    }

    func testAServerThatDidNotBindKeepsThePlainToken() async throws {
        let token = "cta_\(UUID().uuidString)"
        StubServer.routes["/api/account/token"] = (200, #"{"token":"\#(token)","name":"Sam","email":"sam@tinyacrobatics.com"}"#)
        _ = try await client.exchange("abc", verifier: "v")
        StubServer.routes["/api/account/relay-token"] = (200, #"{"token":"relay-1"}"#)
        _ = try await client.relayToken(token)
        XCTAssertEqual(StubServer.seen.last!.value(forHTTPHeaderField: "Authorization"), "Bearer \(token)")
        XCTAssertNil(StubServer.seen.last!.value(forHTTPHeaderField: "DPoP"))
    }

    func testAPlainTokenBindsItselfOnceOrAsksForASignIn() async throws {
        let token = "cta_\(UUID().uuidString)"
        StubServer.routes["/api/account/bind"] = (404, "")   // an older server: stays plain, tried again later
        let later = await client.bind(token)
        XCTAssertEqual(later, .later)
        StubServer.routes["/api/account/bind"] = (403, #"{"error":"Sign in again"}"#)
        let refused = await client.bind(token)
        XCTAssertEqual(refused, .refused)
        StubServer.routes["/api/account/bind"] = (401, #"{"error":"Unauthorized"}"#)   // ended, or bound by someone else first
        let unknown = await client.bind(token)
        XCTAssertEqual(unknown, .refused)
        XCTAssertFalse(BoundTokens.contains(token))

        StubServer.routes["/api/account/bind"] = (200, #"{"bound":true}"#)
        let bound = await client.bind(token)
        XCTAssertEqual(bound, .bound)
        let bind = StubServer.seen.last!
        XCTAssertEqual(bind.value(forHTTPHeaderField: "Authorization"), "Bearer \(token)")   // the last plain use
        XCTAssertEqual(try proofClaims(bind)["ath"] as? String, DPoP.b64(Data(SHA256.hash(data: Data(token.utf8)))))
        StubServer.routes["/api/account/me"] = (200, #"{"name":"Sam","email":"sam@tinyacrobatics.com"}"#)
        _ = try await client.me(token)
        XCTAssertEqual(StubServer.seen.last!.value(forHTTPHeaderField: "Authorization"), "DPoP \(token)")
    }

    func testTheBrokerGetsThisMacsProofWithTheRelayToken() async throws {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [StubServer.self]
        let broker = BrokerClient(base: URL(string: "https://connect.example.com")!, session: URLSession(configuration: config), key: mac)
        StubServer.routes["/v1/computers"] = (200, #"{"computers":[]}"#)
        _ = try await broker.computers(token: "relay-1")
        let sent = StubServer.seen.last!
        XCTAssertEqual(sent.value(forHTTPHeaderField: "Authorization"), "Bearer relay-1")
        let claims = try proofClaims(sent)
        XCTAssertEqual(claims["htu"] as? String, "https://connect.example.com/v1/computers")
        XCTAssertEqual(claims["htm"] as? String, "GET")
        XCTAssertEqual(claims["ath"] as? String, DPoP.b64(Data(SHA256.hash(data: Data("relay-1".utf8)))))
    }

    /// The account server ending the token (a copy used elsewhere, or signed out from another app) is said, not hidden.
    @MainActor func testAnEndedSignInAsksToSignInAgain() async {
        let host = "ended.example.com"
        let saved = UserDefaults.standard.string(forKey: "accountServer")
        URLProtocol.registerClass(StubServer.self)
        defer {
            URLProtocol.unregisterClass(StubServer.self)
            UserDefaults.standard.set(saved, forKey: "accountServer")
            DeviceVault.remove(for: host, service: Account.vault)
        }
        let account = Account()
        account.setServer("https://\(host)")
        let token = "cta_\(UUID().uuidString)"
        XCTAssertTrue(DeviceVault.save(token, for: host, service: Account.vault))
        BoundTokens.add(token)
        StubServer.routes["/api/account/me"] = (401, #"{"error":"Unauthorized"}"#)
        for p in accountProviders { StubServer.routes["/api/account/login/\(p)"] = (302, "") }
        let reply = await account.status()
        XCTAssertEqual(reply["state"], "error")
        XCTAssertEqual(reply["message"], "Your sign-in ended. Sign in again.")
        XCTAssertEqual(reply["providers"], accountProviders.joined(separator: ","))
        XCTAssertNil(DeviceVault.token(for: host, service: Account.vault))
        // said until the person signs in again, or signs out here
        let again = await account.status()
        XCTAssertEqual(again["state"], "error")
        let out = await account.signOut()
        XCTAssertEqual(out["state"], "signedOut")
    }

    func testTheKeyItemStaysOnThisMac() {
        for dp in [true, false] {
            let item = KeyItem.adding("sw:x", dataProtection: dp)
            XCTAssertEqual(item[kSecAttrAccessible as String] as! CFString, kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly)
            XCTAssertEqual(item[kSecUseDataProtectionKeychain as String] as? Bool, dp ? true : nil)
            XCTAssertEqual(item[kSecAttrAccount as String] as? String, "dpop-key")
        }
    }
}
