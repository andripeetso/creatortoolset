import XCTest
@testable import CreatorToolset

/// The shared base every screen stands on: where a server path leads, which server is asked, what the account and the
/// server have, and the text pieces.
final class CoreTests: XCTestCase {
    func testAPathOfTheWebsiteLeadsToItsScreen() {
        XCTAssertEqual(AppRoute.from(path: "/editor/abc123"), .edit("abc123"))
        XCTAssertEqual(AppRoute.from(path: "/review/r9?v=2"), .review("r9", version: 2))
        XCTAssertEqual(AppRoute.from(path: "/review/r9"), .review("r9", version: nil))
        XCTAssertEqual(AppRoute.from(path: "/workshop/sessions/s1"), .session("s1"))
        XCTAssertEqual(AppRoute.from(path: "/library"), .finals)
        XCTAssertEqual(AppRoute.from(path: "/assistant"), .assistant)
        // a page with no screen of its own stays a page, with its query
        XCTAssertEqual(AppRoute.from(path: "/settings/automations?task=t1"), .page("/settings/automations?task=t1"))
        // another site's address is not a route: the phone opens it itself
        XCTAssertNil(AppRoute.from(path: "https://example.com/r/token"))
        XCTAssertNil(AppRoute.from(path: "review/r9"))
    }

    func testOnlyTheSignedInServerIsEverAsked() {
        let server = URL(string: "https://studio.example.test/")!
        let api = API(server: server, cookie: "c", username: "sam")
        XCTAssertEqual(api.url("/api/review/assets/r1/v/1/play?c=2").absoluteString, "https://studio.example.test/api/review/assets/r1/v/1/play?c=2")
        // another site's address never gets a request, and so never the sign-in that rides on it
        XCTAssertEqual(api.url("https://elsewhere.example.test/x?stolen=text"), server)
        XCTAssertEqual(api.url("//elsewhere.example.test/x"), URL(string: "https://studio.example.test/elsewhere.example.test/x"))
        XCTAssertEqual(api.url("http://studio.example.test/api/x"), server)   // the same name without its lock is another place
        // a reply's picture is never fetched at all: it stays text
        XCTAssertFalse(MarkdownTests.words(Markdown.blocks("Look ![shot](https://elsewhere.example.test/p.png?x=secret) here")).contains("elsewhere"))
    }

    /// A request that went with an old sign-in and comes back refused signs out nothing newer.
    @MainActor func testARefusalOfAnOldSignInKeepsTheNewOne() {
        let server = Server(url: URL(string: "https://stale.example.test/")!, username: "sam")
        Servers.shared.add(server, cookie: "new")
        defer { Servers.shared.remove(server.id) }
        Servers.shared.sessionExpired("old")
        XCTAssertEqual(Keychain.get(server.id), "new")
        XCTAssertFalse(Servers.shared.signedOut)
        Servers.shared.sessionExpired("new")
        XCTAssertNil(Keychain.get(server.id))
        XCTAssertTrue(Servers.shared.signedOut)
    }

    func testWhatIsKeptOnDiskIsKeptPerServerAndAccount() {
        XCTAssertEqual(API(server: URL(string: "https://studio.example.test/")!, cookie: nil, username: "sam").cacheKey, "studio.example.test-sam")
        XCTAssertEqual(API(server: URL(string: "http://192.0.2.20:43127/")!, cookie: nil).cacheKey, "192.0.2.20-43127-local")
    }

    /// Shared screens read a failure by its status: 0 no answer, 401 signed out.
    func testAFailureSaysItsStatus() {
        XCTAssertEqual(APIError.offline.status, 0)
        XCTAssertEqual(APIError.signedOut.status, 401)
        let failure = ToolsetAPI.Failure(status: 404, message: "Not found")
        XCTAssertEqual(failure, .server(404, "Not found"))
        XCTAssertEqual(failure.status, 404)
        XCTAssertEqual(failure.message, "Not found")
    }

    func testTheTabsFollowTheAccount() {
        let admin = ToolsetAccess.Me(username: "sam", role: "admin", off: ["finals"])
        let helper = ToolsetAccess.Me(username: "kim", role: "user", off: ["finals", "media"])
        XCTAssertTrue(ToolsetAccess.shows(.finals, me: admin))
        XCTAssertFalse(ToolsetAccess.shows(.finals, me: helper))
        XCTAssertTrue(ToolsetAccess.shows(.scripts, me: helper))
        XCTAssertFalse(ToolsetAccess.allows("media", me: helper))
        XCTAssertFalse(ToolsetAccess.allows(nil, me: helper))   // admins only
        // before the account is known: no Finals or Scripts tab, and the tools ask for the sign-in themselves
        XCTAssertFalse(ToolsetAccess.shows(.finals, me: nil))
        XCTAssertTrue(ToolsetAccess.shows(.upload, me: nil))
        XCTAssertTrue(ToolsetAccess.allows("stories", me: nil))
        // the server's own answer reads
        let check = #"{"username":"local","name":"local","role":"admin","cloud":true,"off":[],"logins":null,"picture":null}"#
        XCTAssertEqual(try JSONDecoder().decode(ToolsetAccess.Me.self, from: Data(check.utf8)).role, "admin")
    }

    /// Answers of `GET /api/plugins` and `GET /api/library/:id/sources` (a server without plug-ins, and the shape of
    /// one with the studio plug-in, its words made neutral).
    func testWhatTheServerHas() throws {
        let none = try JSONDecoder().decode(ServerPlugins.PluginList.self, from: Data(#"{"plugins":[]}"#.utf8))
        XCTAssertEqual(ServerPlugins.known(none, sources: nil), ServerPlugins.Known())

        let studio = """
        {"plugins":[{"id":"\(Studio.plugin)","name":"Tiny Acrobatics","about":"Footage catalog and Finals",
          "adds":[{"text":"Media Library source","to":"/library"},{"text":"Finals hook","to":"/finals"}]}]}
        """
        let list = try JSONDecoder().decode(ServerPlugins.PluginList.self, from: Data(studio.utf8))
        let sources = try JSONDecoder().decode(ServerPlugins.Sources.self, from: Data(
            #"{"sources":[{"id":"other","label":"Old drive"},{"id":"catalog","label":"Footage catalog","main":true}]}"#.utf8))
        let known = ServerPlugins.known(list, sources: sources)
        XCTAssertEqual(known.plugins, [Studio.plugin])
        XCTAssertEqual(known.mainSource, ServerPlugins.Source(id: "catalog", label: "Footage catalog"))
        // a plug-in without a Media Library of its own
        let noMain = try JSONDecoder().decode(ServerPlugins.Sources.self, from: Data(#"{"sources":[]}"#.utf8))
        XCTAssertNil(ServerPlugins.known(list, sources: noMain).mainSource)
        XCTAssertEqual(Studio.path("/push/register"), "/api/x/\(Studio.plugin)/push/register")
    }

    func testTimesReadShort() {
        let now = Date(timeIntervalSince1970: 1_000_000)
        XCTAssertEqual(shortAgo(now.addingTimeInterval(-30), now: now), "<1m")
        XCTAssertEqual(shortAgo(now.addingTimeInterval(-12 * 60), now: now), "12m")
        XCTAssertEqual(shortAgo(now.addingTimeInterval(-3 * 3600), now: now), "3h")
        XCTAssertEqual(shortAgo(now.addingTimeInterval(-2 * 86_400), now: now), "2d")
        XCTAssertEqual(runningFor(58), "58s")
        XCTAssertEqual(runningFor(252), "4m 12s")
        XCTAssertEqual(runningFor(3780), "1h 03m")
        XCTAssertEqual(clock(12), "0:12")
        XCTAssertEqual(clock(3849), "1:04:09")
    }

    func testListsAreKeptOnDisk() {
        let name = "test-\(UUID().uuidString)"
        DiskCache.write(name, ["Tiny Acrobatics"])
        XCTAssertEqual(DiskCache.read(name, as: [String].self), ["Tiny Acrobatics"])
        XCTAssertNil(DiskCache.read("missing-\(UUID().uuidString)", as: [String].self))
    }

    func testAWorkshopStatusTheAppDoesNotKnowStillReads() throws {
        XCTAssertEqual(try JSONDecoder().decode(WorkshopStatus.self, from: Data(#""toPost""#.utf8)), .toPost)
        XCTAssertEqual(try JSONDecoder().decode(WorkshopStatus.self, from: Data(#""archived""#.utf8)), .unknown)
    }
}
