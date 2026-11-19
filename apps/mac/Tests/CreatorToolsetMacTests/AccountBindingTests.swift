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
}
