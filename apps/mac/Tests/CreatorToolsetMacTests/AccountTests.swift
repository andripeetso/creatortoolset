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
        XCTAssertNil(accountCode(from: URL(string: "https://creatortoolset.com/account?code=abc123")!))
    }

    func testAccountServerSetting() {
        XCTAssertEqual(accountServerURL(nil), productionSite)   // never set
        XCTAssertNil(accountServerURL(""))                       // empty: no account step
        XCTAssertNil(accountServerURL("  "))
        XCTAssertEqual(accountServerURL("https://accounts.example.com/x")?.absoluteString, "https://accounts.example.com")
        XCTAssertNil(accountServerURL("http://accounts.example.com"))   // http only for this Mac
    }

    func testCodeExchange() async throws {
        StubServer.routes["/api/account/token"] = (200, #"{"token":"tok-1","name":"Sam Tiny","email":"sam@tinyacrobatics.com"}"#)
        let (token, profile) = try await client.exchange("abc123")
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
        XCTAssertEqual(try JSONDecoder().decode([String: String].self, from: body!), ["code": "abc123"])
    }

    func testUsedAndExpiredCodesAreRejectedWithTheServersWords() async {
        for (code, why) in [(400, "code already used"), (410, "code expired")] {
            StubServer.routes["/api/account/token"] = (code, #"{"error":"\#(why)"}"#)
            do {
                _ = try await client.exchange("abc123")
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
        StubServer.routes["/api/account/login/apple"] = (302, "")
        let on = try await client.isSetUp("apple")
        XCTAssertTrue(on)
        XCTAssertFalse(StubServer.seen.contains { $0.url?.host == "appleid.example.com" })
        XCTAssertEqual(client.loginURL("google").absoluteString, "https://accounts.example.com/api/account/login/google?app=1")
        // past the sign-in page a 404 is a code it doesn't know: never a way around the account
        StubServer.routes["/api/account/token"] = (404, "")
        do {
            _ = try await client.exchange("abc123")
            XCTFail("404 should fail")
        } catch {
            XCTAssertEqual(error as? AccountError, .codeRejected("the server answered 404"))
        }
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
