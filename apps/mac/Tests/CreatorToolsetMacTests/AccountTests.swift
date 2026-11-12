import Foundation
import XCTest
@testable import CreatorToolsetMac

/// The account server, stubbed: each request is answered from `routes` by its path, and remembered.
final class StubServer: URLProtocol {
    nonisolated(unsafe) static var routes: [String: (Int, String)] = [:]
    nonisolated(unsafe) static var seen: [URLRequest] = []

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        Self.seen.append(request)
        let (code, body) = Self.routes[request.url?.path ?? ""] ?? (404, "")
        var headers = ["Content-Type": "application/json"]
        if code == 302 { headers["Location"] = "https://appleid.example.com/auth" }
        let response = HTTPURLResponse(url: request.url!, statusCode: code, httpVersion: "HTTP/1.1", headerFields: headers)!
        if code == 302 {
            // the client's no-redirect delegate turns this down, so the 302 itself comes back
            client?.urlProtocol(self, wasRedirectedTo: URLRequest(url: URL(string: headers["Location"]!)!), redirectResponse: response)
        }
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

final class AccountTests: XCTestCase {
    private var client: AccountClient {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [StubServer.self]
        return AccountClient(server: URL(string: "https://accounts.example.com")!, session: URLSession(configuration: config))
    }

    override func setUp() {
        StubServer.routes = [:]
        StubServer.seen = []
    }

    func testAccountCodeComesOnlyFromTheAccountLink() {
        XCTAssertEqual(accountCode(from: URL(string: "creatortoolset://account?code=abc123")!), "abc123")
        XCTAssertEqual(accountCode(from: URL(string: "CreatorToolset://Account?state=x&code=a%2Fb")!), "a/b")
        XCTAssertNil(accountCode(from: URL(string: "creatortoolset://account")!))
        XCTAssertNil(accountCode(from: URL(string: "creatortoolset://account?code=")!))
        XCTAssertNil(accountCode(from: URL(string: "creatortoolset://review/abc?code=abc123")!))
        XCTAssertNil(accountCode(from: URL(string: "https://accounts.example.com/account?code=abc123")!))
        XCTAssertTrue(isConnectDone(URL(string: "creatortoolset://connect")!))
        XCTAssertFalse(isConnectDone(URL(string: "creatortoolset://review/connect")!))
        XCTAssertFalse(isConnectDone(URL(string: "https://creatortoolset.com/connect")!))
    }

    func testAccountServerSetting() {
        XCTAssertEqual(accountServerURL(nil), defaultAccountServer)   // never set
        XCTAssertNil(accountServerURL(""))                       // empty: no account step
        XCTAssertNil(accountServerURL("  "))
        XCTAssertEqual(accountServerURL("https://accounts.example.com/x")?.absoluteString, "https://accounts.example.com")
        XCTAssertNil(accountServerURL("http://accounts.example.com"))   // http only for this Mac
    }

    func testRelayTokenIsMintedFromTheSignIn() async throws {
        StubServer.routes["/api/account/relay-token"] = (200, #"{"token":"relay-1","expiresIn":3600}"#)
        let token = try await client.relayToken("cta_tok")
        XCTAssertEqual(token, "relay-1")
        let sent = StubServer.seen.last!
        XCTAssertEqual(sent.httpMethod, "POST")
        XCTAssertEqual(sent.value(forHTTPHeaderField: "Authorization"), "Bearer cta_tok")
        StubServer.routes["/api/account/relay-token"] = (503, #"{"error":"Connect is not set up on this site"}"#)
        do { _ = try await client.relayToken("cta_tok"); XCTFail("a site without Connect gives no token") } catch {}
    }

    func testCodeExchange() async throws {
        StubServer.routes["/api/account/token"] = (200, #"{"token":"tok-1","name":"Sam Tiny","email":"sam@tinyacrobatics.com"}"#)
        let (token, profile) = try await client.exchange("abc123", verifier: "v-123")
        XCTAssertEqual(token, "tok-1")
        XCTAssertEqual(profile, AccountProfile(name: "Sam Tiny", email: "sam@tinyacrobatics.com"))
        let sent = StubServer.seen.last!
        XCTAssertEqual(sent.httpMethod, "POST")
        let body = sent.httpBody ?? sent.httpBodyStream.map { stream in
            stream.open(); defer { stream.close() }
            var data = Data(), buffer = [UInt8](repeating: 0, count: 1024)
            while stream.hasBytesAvailable { let n = stream.read(&buffer, maxLength: 1024); if n <= 0 { break }; data.append(buffer, count: n) }
            return data
        }
        XCTAssertEqual(try JSONDecoder().decode([String: String].self, from: body!), ["code": "abc123", "verifier": "v-123"])
    }

    func testPkcePair() {
        // challenge = base64url(SHA-256(verifier)) without padding; the expected value was computed independently
        // (Python hashlib + urlsafe_b64encode)
        let known = Pkce(verifier: "dBjftJeZ4CVP-mJ92K27uhbUJU1p1r_wW1gFWFOEjXk")
        XCTAssertEqual(known.challenge, "ngF5GsXcbwljx6u133FFr3Xht9xooA_DuaX_3QwODtc")
        let fresh = Pkce.make()
        XCTAssertEqual(fresh.verifier.count, 43)
        XCTAssertNil(fresh.verifier.rangeOfCharacter(from: CharacterSet(charactersIn: "+/=")))
        XCTAssertNotEqual(fresh.verifier, Pkce.make().verifier)
    }

    func testNoVerifiedEmailIsAnEmptyEmail() async throws {
        StubServer.routes["/api/account/token"] = (200, #"{"token":"tok-2","name":"Jo Tiny","email":null}"#)
        let (_, profile) = try await client.exchange("abc123", verifier: "v-123")
        XCTAssertEqual(profile, AccountProfile(name: "Jo Tiny", email: ""))
        XCTAssertEqual(try JSONDecoder().decode(AccountProfile.self, from: Data(#"{"name":"Jo Tiny","email":null}"#.utf8)).email, "")
    }

    func testUsedAndExpiredCodesAreRejectedWithTheServersWords() async {
        for (code, why) in [(400, "code already used"), (410, "code expired")] {
            StubServer.routes["/api/account/token"] = (code, #"{"error":"\#(why)"}"#)
            do {
                _ = try await client.exchange("abc123", verifier: "v-123")
                XCTFail("\(code) should fail")
            } catch {
                XCTAssertEqual(error as? AccountError, .codeRejected(why))
            }
        }
    }

    func testNotSetUp() async throws {
        // the sign-in page: 404 or 501 = not set up; its redirect to Apple = set up (not followed)
        for code in [404, 501] {
            StubServer.routes["/api/account/login/apple"] = (code, "")
            let off = try await client.isSetUp("apple")
            XCTAssertFalse(off)
        }
        // only the redirect to Apple or Google means sign-in is there: a site login's 401, a fork's app page (200) or an
        // error would show sign-in buttons that lead nowhere, with no way past the step
        for code in [200, 401, 403, 500] {
            StubServer.routes["/api/account/login/apple"] = (code, "")
            let no = try await client.isSetUp("apple")
            XCTAssertFalse(no, "\(code)")
        }
        StubServer.routes["/api/account/login/apple"] = (302, "")
        let on = try await client.isSetUp("apple")
        XCTAssertTrue(on)
        XCTAssertFalse(StubServer.seen.contains { $0.url?.host == "appleid.example.com" })
        XCTAssertEqual(client.loginURL("google", challenge: "c1").absoluteString, "https://accounts.example.com/api/account/login/google?app=1&challenge=c1")
        XCTAssertEqual(client.loginURL("github", challenge: "c1").absoluteString, "https://accounts.example.com/api/account/login/github?app=1&challenge=c1")
        // the probe also carries a challenge (the server refuses an app sign-in start without one)
        XCTAssertTrue(StubServer.seen.contains { ($0.url?.query ?? "").contains("challenge=") })
        // past the sign-in page a 404 is a code it doesn't know: never a way around the account
        StubServer.routes["/api/account/token"] = (404, "")
        do {
            _ = try await client.exchange("abc123", verifier: "v-123")
            XCTFail("404 should fail")
        } catch {
            XCTAssertEqual(error as? AccountError, .codeRejected("the server answered 404"))
        }
    }

    /// A creatortoolset://account link with no sign-in started in this app is someone else's code: never swapped.
    @MainActor func testAccountLinkNeedsASignInInFlight() async {
        let saved = UserDefaults.standard.string(forKey: "accountServer")
        UserDefaults.standard.set("https://accounts.example.com", forKey: "accountServer")
        defer { UserDefaults.standard.set(saved, forKey: "accountServer") }
        let reply = await Account().link(code: "someone-elses-code")
        XCTAssertEqual(reply["state"], "error")
        XCTAssertTrue(reply["message"]?.contains("didn't come from this app") == true)
    }

    func testOfferedProvidersAreOnlyTheOnesWithKeys() async throws {
        // a provider the server has no keys for answers 404 or 501: no button for it
        StubServer.routes["/api/account/login/apple"] = (501, "")
        StubServer.routes["/api/account/login/google"] = (302, "")
        StubServer.routes["/api/account/login/github"] = (302, "")
        let up = try await client.offeredProviders()
        XCTAssertEqual(up, ["google", "github"])
        StubServer.routes["/api/account/login/google"] = (404, "")
        StubServer.routes["/api/account/login/github"] = (404, "")
        let none = try await client.offeredProviders()
        XCTAssertEqual(none, [])
    }

    /// Signed out on the default account server: the answer comes from the app's own list of proven sign-ins, with no
    /// call to that server (a call there would hang or fail in this test: nothing answers a request here). An empty list
    /// means no sign-in is offered, which setup reads as "no account screen".
    @MainActor func testASignedOutStatusAsksTheDefaultAccountServerNothing() async {
        XCTAssertTrue(Set(accountLive).isSubset(of: Set(accountProviders)))
        let account = Account()
        guard account.server?.absoluteString == defaultAccountServer.absoluteString, account.profile == nil else { return }   // this Mac's own setting, or a kept sign-in
        let started = Date()
        let reply = await account.status()
        XCTAssertLessThan(Date().timeIntervalSince(started), 1)
        if accountLive.isEmpty {
            XCTAssertEqual(reply["state"], "notSetUp")
        } else {
            XCTAssertEqual(reply, ["state": "signedOut", "providers": accountLive.joined(separator: ",")])
        }
        // signing out with nothing signed in is the same answer, and still no call
        let out = await account.signOut()
        XCTAssertEqual(out, reply)
    }

    func testAccountMessagesOnlyFromTheWindowsOwnPage() {
        XCTAssertEqual(accountAsk("status", mainFrame: true), "status")
        XCTAssertEqual(accountAsk("signout", mainFrame: true), "signout")
        XCTAssertEqual(accountAsk("offered", mainFrame: true), "offered")
        XCTAssertNil(accountAsk("signout", mainFrame: false))
        XCTAssertEqual(accountAsk("google", mainFrame: true), "google")
        XCTAssertEqual(accountAsk("github", mainFrame: true), "github")
        XCTAssertNil(accountAsk("microsoft", mainFrame: true))   // not a provider here
        XCTAssertNil(accountAsk("github", mainFrame: false))
        XCTAssertNil(accountAsk("status", mainFrame: false))   // an embed inside the page
        XCTAssertNil(accountAsk("apple", mainFrame: false))
        XCTAssertNil(accountAsk("delete", mainFrame: true))
        XCTAssertNil(accountAsk(["status"], mainFrame: true))
    }

    func testMeSendsTheTokenAndSaysWhenItNoLongerWorks() async throws {
        StubServer.routes["/api/account/me"] = (200, #"{"name":"Sam Tiny","email":"sam@tinyacrobatics.com"}"#)
        let me = try await client.me("tok-1")
        XCTAssertEqual(me.email, "sam@tinyacrobatics.com")
        XCTAssertEqual(StubServer.seen.last?.value(forHTTPHeaderField: "Authorization"), "Bearer tok-1")
        StubServer.routes["/api/account/me"] = (401, "")
        do {
            _ = try await client.me("tok-1")
            XCTFail("401 should fail")
        } catch {
            XCTAssertEqual(error as? AccountError, .signedOut)
        }
    }

    func testKeychainKeepsAndForgetsTheToken() {
        let service = "com.creatortoolset.mac.account.tests"
        defer { DeviceVault.remove(for: "accounts.example.com", service: service) }
        XCTAssertTrue(DeviceVault.save("tok-1", for: "accounts.example.com", service: service))
        XCTAssertTrue(DeviceVault.save("tok-2", for: "accounts.example.com", service: service))   // replaces
        XCTAssertEqual(DeviceVault.token(for: "accounts.example.com", service: service), "tok-2")
        XCTAssertNil(DeviceVault.token(for: "other.example.com", service: service))
        DeviceVault.remove(for: "accounts.example.com", service: service)
        XCTAssertNil(DeviceVault.token(for: "accounts.example.com", service: service))
    }
}
