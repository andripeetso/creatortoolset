import XCTest
@testable import CreatorToolset

/// Where the connection system and the workspaces meet: the app's own pick of computer, pairing links that never
/// connect by themselves, one change line per server, and media tickets for what can't sign each request.
@MainActor
final class PhoneIntegrateTests: XCTestCase {
    private func computer(_ id: String, _ status: AccountComputer.Status, linkedAt: Double? = nil) -> AccountComputer {
        AccountComputer(id: id, name: id, endpoint: URL(string: "https://\(id).connect.example/"), status: status, linkedAt: linkedAt)
    }

    // MARK: the app picks the computer

    func testOfflineDropOutAndTheOnlyOneLeftIsPicked() {
        let list = [computer("a", .offline, linkedAt: 9), computer("b", .online, linkedAt: 1)]
        XCTAssertEqual(AccountServers.pick(list, answersHere: ["a"], lastUsed: "a"), "b")
        XCTAssertNil(AccountServers.pick([computer("a", .offline)], answersHere: [], lastUsed: nil))
        XCTAssertNil(AccountServers.pick([], answersHere: [], lastUsed: nil))
    }

    func testTheOneOnThisNetworkThenTheLastUsedThenTheNewest() {
        let list = [computer("a", .online, linkedAt: 1), computer("b", .online, linkedAt: 3), computer("c", .online, linkedAt: 2)]
        XCTAssertEqual(AccountServers.pick(list, answersHere: ["c"], lastUsed: "a"), "c")
        // two answer here: that doesn't tell, the last used does
        XCTAssertEqual(AccountServers.pick(list, answersHere: ["a", "c"], lastUsed: "a"), "a")
        XCTAssertEqual(AccountServers.pick(list, answersHere: [], lastUsed: "a"), "a")
        // the last used is offline or unknown: the newest link
        XCTAssertEqual(AccountServers.pick(list, answersHere: [], lastUsed: "gone"), "b")
        XCTAssertEqual(AccountServers.pick(list, answersHere: [], lastUsed: nil), "b")
    }

    func testAListOnlyWhenItTrulyCantTell() {
        // linked at the same moment, or no dates: no guess
        XCTAssertNil(AccountServers.pick([computer("a", .online, linkedAt: 5), computer("b", .online, linkedAt: 5)], answersHere: [], lastUsed: nil))
        XCTAssertNil(AccountServers.pick([computer("a", .online), computer("b", .online, linkedAt: 5)], answersHere: [], lastUsed: nil))
    }

    // MARK: pairing links

    func testPairingLinksAreReadFromEveryShape() throws {
        let web = try XCTUnwrap(PairingLinks.target(URL(string: "https://mac-1.connect.example/#token=abcdefghjkmn")!))
        XCTAssertEqual(web.origin.absoluteString, "https://mac-1.connect.example/")
        XCTAssertEqual(web.code, "ABCDEFGHJKMN")
        let encoded = "https%3A%2F%2Fmac-1.connect.example%2F%23token%3DABCDEFGHJKMN"
        let app = try XCTUnwrap(PairingLinks.target(URL(string: "creatortoolset://pair?pairingUrl=\(encoded)")!))
        XCTAssertEqual(app, web)
        XCTAssertEqual(PairingLinks.target(URL(string: "https://example.test/?token=ABCDEFGHJKMN")!)?.code, "ABCDEFGHJKMN")
        // not pairing links: the account's own sign-in callbacks, a page, a link with no code
        XCTAssertNil(PairingLinks.target(URL(string: "creatortoolset://account?code=x")!))
        XCTAssertNil(PairingLinks.target(URL(string: "https://creatortoolset.com/pricing")!))
        XCTAssertNil(PairingLinks.target(URL(string: "https://creatortoolset.com/#token=")!))
    }

    func testALinkOpensAddFilledInAndConnectsNothing() {
        let links = PairingLinks.shared
        let before = Connections.shared.servers
        StubServer.reset()
        XCTAssertTrue(links.open(URL(string: "https://evil.example/#token=ABCDEFGHJKMN")!))
        XCTAssertEqual(links.pending?.origin.host(), "evil.example")
        XCTAssertEqual(links.pending?.code, "ABCDEFGHJKMN")
        // nothing saved and nothing asked: the person confirms on the Add screen
        XCTAssertEqual(Connections.shared.servers, before)
        XCTAssertTrue(StubServer.asked.isEmpty)
        XCTAssertFalse(links.open(URL(string: "https://creatortoolset.com/docs")!))
        links.pending = nil
    }

    // MARK: one change line per server

    func testTheScreensReadTheSupervisorsLineOfTheServerInUse() async {
        let mac = ServerEntry(serverId: "mac", label: "Mac", routes: [.paired(URL(string: "https://mac.example/")!)],
                              home: URL(string: "https://mac.example/")!)
        let box = ServerEntry(serverId: "box", label: "Box", routes: [.paired(URL(string: "https://box.example/")!)],
                              home: URL(string: "https://box.example/")!)
        let connections = Connections(saved: ServerRegistry.Saved(servers: [mac, box], currentKey: mac.key), live: false)
        var reader = connections.events().makeAsyncIterator()
        XCTAssertEqual(connections.listenerCount, 1)
        connections.deliver("box", ServerEvents.Event(name: "change", data: "{\"topic\":\"chats\"}"))   // not in use: not told
        connections.deliver("mac", ServerEvents.Event(name: "change", data: "{\"topic\":\"review\"}"))
        let first = await reader.next()
        XCTAssertEqual(first?.field("topic"), "review")
        // another server in use: every reader reads again
        connections.use(key: box.key)
        let second = await reader.next()
        XCTAssertEqual(second?.name, "hello")
        connections.deliver("box", ServerEvents.Event(name: "change", data: "{\"topic\":\"chats\"}"))
        let third = await reader.next()
        XCTAssertEqual(third?.field("topic"), "chats")
    }

    func testTheAppsSyncReadersOpenNoLineOfTheirOwn() {
        guard Connections.shared.live else { return }
        let before = Connections.shared.listenerCount
        var stream: AsyncStream<ServerEvents.Event>? = ServerEvents.stream("/api/sync/events")
        XCTAssertEqual(Connections.shared.listenerCount, before + 1)
        XCTAssertNotNil(stream)
        stream = nil
    }

    // MARK: media tickets

    func testADPoPSessionsBackgroundUploadCarriesAWriteTicketNotAProof() async throws {
        StubServer.reset()
        StubServer.answers["/api/auth/media-ticket"] = (200, #"{"ticket":"ctm_abc","path":"/api/library/uploads/u1","write":true,"expiresAt":"x"}"#)
        var api = API(server: URL(string: "https://mac.example/")!, cookie: nil, workspace: "ws-a")
        api.credential = Credential(kind: .dpop, token: "cts_t")
        let request = api.request("/api/library/uploads/u1", method: "PATCH")
        XCTAssertNotNil(request.value(forHTTPHeaderField: "DPoP"))
        let later = try await api.background(request, prefix: "/api/library/uploads/u1", session: StubServer.session)
        XCTAssertEqual(later.url?.absoluteString, "https://mac.example/api/library/uploads/u1?ct_ticket=ctm_abc")
        XCTAssertNil(later.value(forHTTPHeaderField: "DPoP"))
        XCTAssertNil(later.value(forHTTPHeaderField: "Authorization"))
        XCTAssertEqual(later.value(forHTTPHeaderField: "X-CT-Workspace"), "ws-a")
        XCTAssertEqual(later.httpMethod, "PATCH")
        // the ticket was asked for that path, for writing, with the session's own signed request
        let asked = try XCTUnwrap(StubServer.bodies["/api/auth/media-ticket"])
        let body = try JSONSerialization.jsonObject(with: Data(asked.utf8)) as? [String: Any]
        XCTAssertEqual(body?["write"] as? Bool, true)
        XCTAssertEqual(body?["path"] as? String, "/api/library/uploads/u1")

        // a Bearer session's request goes as it is (its token holds for days)
        api.credential = Credential(kind: .bearer, token: "cts_b")
        let bearer = api.request("/api/library/uploads/u1", method: "PATCH")
        StubServer.reset()
        let same = try await api.background(bearer, prefix: "/api/library/uploads/u1", session: StubServer.session)
        XCTAssertEqual(same, bearer)
        XCTAssertTrue(StubServer.asked.isEmpty)
    }

    func testAWebViewsTicketCookieStaysOnItsHost() throws {
        let https = try XCTUnwrap(MediaTicket.cookie("ctm_x", for: URL(string: "https://mac.example/")!))
        XCTAssertEqual(https.name, "ct_ticket")
        XCTAssertEqual(https.domain, "mac.example")
        XCTAssertTrue(https.isSecure)
        XCTAssertEqual(https.sameSitePolicy, .sameSiteStrict)
        // a computer on the LAN is plain http: a secure cookie would never be sent there
        XCTAssertFalse(try XCTUnwrap(MediaTicket.cookie("ctm_x", for: URL(string: "http://10.0.0.20:43190/")!)).isSecure)
        XCTAssertEqual(MediaTicket.add("t", to: URL(string: "https://mac.example/api/x?v=2")!).absoluteString,
                       "https://mac.example/api/x?v=2&ct_ticket=t")
    }
}
