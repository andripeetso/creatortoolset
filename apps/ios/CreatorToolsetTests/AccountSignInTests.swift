import XCTest
@testable import CreatorToolset

/// Sign in with Apple or Google: everything that needs no server and no sign-in sheet. The JSON is what the servers
/// send: the token and relay-token answers are the ones in the Mac app's tests (AccountTests.swift), the computers
/// list and the ticket follow the connect service's code (apps/relay/src/server.ts and link.ts, status words from
/// cloudflare.ts), and `/api/account/me`, `/api/auth/app` and `/api/auth/ticket` follow the servers' own tests.
@MainActor
final class AccountSignInTests: XCTestCase {
    private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
        try JSONDecoder().decode(type, from: Data(json.utf8))
    }

    private let sam = "0123456789abcdef0123456789abcdef"
    private let office = "fedcba9876543210fedcba9876543210"

    /// GET /v1/computers: a healthy computer, one whose link is down, and one the service has dropped.
    private func added() throws -> [AddedComputers.One] {
        try decode(AddedComputers.self, #"""
        {"computers":[
          {"id":"0123456789abcdef0123456789abcdef","name":"Sam's Mac","hostname":"0123456789abcdef0123456789abcdef.tunnels.example.com","status":"healthy","created_at":1794400000},
          {"id":"fedcba9876543210fedcba9876543210","name":"Office Mac","hostname":"fedcba9876543210fedcba9876543210.tunnels.example.com","status":"inactive","created_at":1794400100},
          {"id":"00000000000000000000000000000000","name":"Old Mac","hostname":"00000000000000000000000000000000.tunnels.example.com","status":"gone","created_at":1794300000}
        ]}
        """#).computers
    }

    func testPkce() {
        // RFC 7636, appendix B
        XCTAssertEqual(Pkce(verifier: "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk").challenge, "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM")
        // base64url, no padding
        XCTAssertEqual(Pkce.base64url(Data([0xfb, 0xff, 0xfe])), "-__-")
        XCTAssertEqual(Pkce.base64url(Data([0xff])), "_w")
        // what the servers accept: 43 characters each, and a new pair for every sign-in
        let made = Pkce.make()
        XCTAssertNotNil(made.verifier.wholeMatch(of: #/[A-Za-z0-9_-]{43}/#))
        XCTAssertNotNil(made.challenge.wholeMatch(of: #/[A-Za-z0-9_-]{43}/#))
        XCTAssertEqual(Pkce(verifier: made.verifier).challenge, made.challenge)
        XCTAssertNotEqual(Pkce.make().verifier, made.verifier)
    }

    func testSignInAddresses() {
        XCTAssertEqual(Account.loginURL(Account.site, "apple", challenge: "C").absoluteString,
                       "https://creatortoolset.com/api/account/login/apple?app=1&challenge=C")
        XCTAssertEqual(Account.loginURL(URL(string: "https://studio.example.test/")!, "google", challenge: "C", forSite: true).absoluteString,
                       "https://studio.example.test/api/account/login/google?for=site&app=1&challenge=C")
    }

    func testWhereASheetEnds() {
        XCTAssertEqual(SheetEnd(URL(string: "creatortoolset://account?code=AbC-123_x")!, "account"), .code("AbC-123_x"))
        XCTAssertEqual(SheetEnd(URL(string: "creatortoolset://account?error=Sign-in%20was%20cancelled")!, "account"), .error("Sign-in was cancelled"))
        XCTAssertEqual(SheetEnd(URL(string: "creatortoolset://signin?code=AbC-123_x")!, "signin"), .code("AbC-123_x"))
        // the words the server's login screen would show, as it writes them into the link
        XCTAssertEqual(SheetEnd(URL(string: "creatortoolset://signin?error=There%20is%20no%20account%20here%20for%20that%20sign-in.%20This%20server%20takes%20new%20people%20by%20invitation")!, "signin"),
                       .error("There is no account here for that sign-in. This server takes new people by invitation"))
        // the account's code is not a server's, and the other way round
        XCTAssertNil(SheetEnd(URL(string: "creatortoolset://account?code=x")!, "signin"))
        XCTAssertNil(SheetEnd(URL(string: "creatortoolset://signin?code=x")!, "account"))
        XCTAssertNil(SheetEnd(URL(string: "https://creatortoolset.com/account?code=x")!, "account"))
        XCTAssertNil(SheetEnd(URL(string: "creatortoolset://signin?code=")!, "signin"))
        XCTAssertNil(SheetEnd(URL(string: "creatortoolset://signin")!, "signin"))
    }

    func testAccountAnswers() throws {
        let token = try decode(AccountToken.self, #"{"token":"tok-1","name":"Sam Tiny","email":"sam@tinyacrobatics.com"}"#)
        XCTAssertEqual([token.token, token.name, token.email], ["tok-1", "Sam Tiny", "sam@tinyacrobatics.com"])
        XCTAssertNil(try decode(AccountToken.self, #"{"token":"tok-2","name":"Jo Tiny","email":null}"#).email)
        XCTAssertEqual(try decode(RelayToken.self, #"{"token":"relay-1","expiresIn":3600}"#).token, "relay-1")
        XCTAssertEqual(try decode(ComputerTicket.self, #"{"ticket":"eyJ.abc.def","hostname":"0123456789abcdef0123456789abcdef.tunnels.example.com","expires_in":120}"#).ticket, "eyJ.abc.def")
        XCTAssertEqual(API.message(Data(#"{"error":"Connect is not set up on this site"}"#.utf8), status: 503), "Connect is not set up on this site")
    }

    func testMeWithAndWithoutServers() throws {
        // an account server from before the list
        let before = try decode(AccountMe.self, #"{"name":"Sam Tiny","email":"sam@tinyacrobatics.com"}"#)
        XCTAssertEqual(before.name, "Sam Tiny")
        XCTAssertNil(before.servers)
        XCTAssertEqual(try decode(AccountMe.self, #"{"name":"ana","email":"ana@example.test","servers":[]}"#).servers?.count, 0)
        let me = try decode(AccountMe.self, #"{"name":"ana","email":"ana@example.test","servers":[{"host":"studio.example.test","at":1794400000000}]}"#)
        XCTAssertEqual(me.servers?.map(\.host), ["studio.example.test"])
    }

    func testOneListOfComputers() throws {
        let list = Computer.list(hosted: ["studio.example.test"], added: try added())
        XCTAssertEqual(list.map(\.name), ["studio.example.test", "Sam's Mac", "Office Mac"])
        XCTAssertEqual(list.map(\.offline), [false, false, true])
        XCTAssertEqual(list.map(\.addedId), [nil, sam, office])
        XCTAssertEqual(list.map(\.url.absoluteString), ["https://studio.example.test/", "https://\(sam).tunnels.example.com/", "https://\(office).tunnels.example.com/"])
        // the same id a server typed by its address gets, so one computer is never on the phone twice
        XCTAssertEqual(list[0].id, Server(url: SignIn.parse("studio.example.test")!.origin).id)
        XCTAssertEqual(Computer.list(hosted: ["studio.example.test:8443"], added: []).first?.url.absoluteString, "https://studio.example.test:8443/")
    }

    func testOnlyPlainNamesGetACodeOrAPassword() {
        let odd = ["evil.example.test/path", "sam@evil.example.test", "Studio.Example.Test", "", "a b", "studio.example.test?x=1",
                   "studio.example.test#x", "http://studio.example.test", "-studio.example.test", "studio.example.test:"]
        XCTAssertTrue(Computer.list(hosted: odd, added: []).isEmpty)
        let one = { (id: String, hostname: String) in AddedComputers.One(id: id, name: "Mac", hostname: hostname, status: "healthy") }
        XCTAssertTrue(Computer.list(hosted: [], added: [one("../ticket", "\(sam).tunnels.example.com"), one(sam, "evil.example.test/x"),
                                                         one(sam.uppercased(), "\(sam).tunnels.example.com")]).isEmpty)
        // a computer with no name shows its address
        XCTAssertEqual(Computer.list(hosted: [], added: [.init(id: sam, name: "", hostname: "\(sam).tunnels.example.com", status: "unknown")]).first?.name,
                       "\(sam).tunnels.example.com")
    }

    func testExactlyOneConnectsStraightAway() throws {
        let list = Computer.list(hosted: ["studio.example.test"], added: try added())
        let (studio, mac, down) = (list[0], list[1], list[2])
        XCTAssertEqual(Computer.only([studio], here: []), studio)
        XCTAssertEqual(Computer.only([mac], here: []), mac)
        XCTAssertNil(Computer.only([], here: []))
        XCTAssertNil(Computer.only([studio, mac], here: []))
        // offline, or already on this phone: the list shows instead
        XCTAssertNil(Computer.only([down], here: []))
        XCTAssertNil(Computer.only([studio], here: [Server(url: studio.url, username: "sam")]))
        XCTAssertEqual(Computer.only([studio], here: [Server(url: mac.url)]), studio)
    }

    func testCookieFromAnAppSignIn() {
        // 200 with the cookie a browser's sign-in gets, Secure over https
        let ok = HTTPURLResponse(url: URL(string: "https://studio.example.test/api/auth/app")!, statusCode: 200, httpVersion: nil,
                                 headerFields: ["Set-Cookie": "cap_auth=tinyacrobatics.abc123; HttpOnly; Path=/; Max-Age=15552000; SameSite=Lax; Secure",
                                                "Cache-Control": "no-store"])!
        XCTAssertEqual(SignIn.cookie(from: ok), "tinyacrobatics.abc123")
        // a refusal carries none, and says why in the server's words
        let refused = HTTPURLResponse(url: URL(string: "https://studio.example.test/api/auth/app")!, statusCode: 400, httpVersion: nil,
                                      headerFields: ["Content-Type": "application/json"])!
        XCTAssertNil(SignIn.cookie(from: refused))
        XCTAssertEqual(API.message(Data(#"{"error":"That sign-in code is used or expired"}"#.utf8), status: 400), "That sign-in code is used or expired")
        XCTAssertEqual(API.message(Data(#"{"error":"Wrong password"}"#.utf8), status: 401), "Wrong password")
    }

    func testWhoTheAccountRowNames() {
        XCTAssertEqual(Account.Profile(name: "Sam Tiny", email: "sam@tinyacrobatics.com", provider: "apple").title, "Sam Tiny")
        XCTAssertEqual(Account.Profile(name: "", email: "sam@tinyacrobatics.com", provider: "google").title, "sam@tinyacrobatics.com")
        XCTAssertEqual(Account.Profile(name: "", email: "", provider: "apple").title, "Apple account")
    }

    func testAComputerKeepsItsNameOnThePhone() throws {
        // a list saved before computers had names still loads
        let saved = try decode([Server].self, #"[{"url":"https://studio.example.test/","username":"sam"}]"#)
        XCTAssertEqual(saved[0].name, "studio.example.test")
        let mac = Server(url: URL(string: "https://\(sam).tunnels.example.com/")!, username: "admin", label: "Sam's Mac")
        XCTAssertEqual(try JSONDecoder().decode(Server.self, from: JSONEncoder().encode(mac)).name, "Sam's Mac")
        // signed in again by its address, it is still "Sam's Mac", and it is on the phone once
        let again = Servers.adding(Server(url: mac.url, username: "sam"), to: saved + [mac])
        XCTAssertEqual(again.map(\.name), ["studio.example.test", "Sam's Mac"])
        XCTAssertEqual(again.last?.username, "sam")
    }

    func testWhatGoesWrongInPlainWords() {
        XCTAssertEqual(AccountError.unreachable("creatortoolset.com").localizedDescription, "Can't reach creatortoolset.com. Check the connection and try again.")
        XCTAssertEqual(AccountError.refused("There is no account here for that sign-in").localizedDescription, "There is no account here for that sign-in")
    }
}
