import AVFoundation
import XCTest
@testable import CreatorToolset

/// The phone's own workspace: every request names it, every cache is kept per workspace, the switcher lists every
/// server's, and each thing sits on its tab.
final class WorkspaceTests: XCTestCase {
    private let one = Server(url: URL(string: "https://one.example.test/")!, username: "tiny")
    private let two = Server(url: URL(string: "https://two.example.test/")!, username: "tiny", label: "Studio Mac")

    override func tearDown() {
        for server in [one, two] { WorkspacePick.set(nil, server: server.id, username: "tiny") }
        for server in [one, two] { WorkspacePick.set(nil, server: server.id, username: server.username) }
        WorkspacePick.set(nil, server: one.id, username: "other")
    }

    func testEveryRequestSaysItsWorkspace() throws {
        let api = API(server: one.url, cookie: "c", username: "tiny", workspace: "ws-b")
        XCTAssertEqual(api.request("/api/library").value(forHTTPHeaderField: "X-CT-Workspace"), "ws-b")
        XCTAssertEqual(api.request("/api/editor", method: "POST", json: ["a": 1]).value(forHTTPHeaderField: "X-CT-Workspace"), "ws-b")
        XCTAssertEqual(api.request("/api/library").value(forHTTPHeaderField: "Cookie"), "cap_auth=c")
        // thumbnails and downloads are built by request(); the players' range requests carry it as a header option
        XCTAssertEqual(api.headers(url: api.url("/x"))["X-CT-Workspace"], "ws-b")
        let fields = try XCTUnwrap(api.playerOptions()["AVURLAssetHTTPHeaderFieldsKey"] as? [String: String])
        XCTAssertEqual(fields, ["X-CT-Workspace": "ws-b"])   // the cookie stays scoped to the host, never in a header option
        XCTAssertNotNil(api.playerOptions()[AVURLAssetHTTPCookiesKey])
        // none picked yet: no header, the server's own rule
        let none = API(server: one.url, cookie: "c")
        XCTAssertNil(none.request("/api/library").value(forHTTPHeaderField: "X-CT-Workspace"))
        XCTAssertNil(none.playerOptions()["AVURLAssetHTTPHeaderFieldsKey"])
        // the Share extension's calls
        let share = ShareLink(server: one.url, workspace: "ws-a")
        XCTAssertEqual(share.request("/api/instagram/share", json: ["text": "x"]).value(forHTTPHeaderField: "X-CT-Workspace"), "ws-a")
        XCTAssertEqual(share.request("/api/workshop/workspace", method: "GET").url?.absoluteString, "https://one.example.test/api/workshop/workspace")
        XCTAssertNil(ShareLink(server: one.url).request("/x").value(forHTTPHeaderField: "X-CT-Workspace"))
    }

    /// The merge seam: a saved server's client signs with its route's credential AND names the phone's workspace there,
    /// on every kind of request (JSON calls, pictures, players, the Share extension, background uploads).
    func testEveryRequestKindCarriesTheRoutesSignInAndTheWorkspace() async throws {
        let paired = ServerEntry(serverId: "srv-paired", label: "Studio", routes: [.paired(one.url)], username: "tiny", home: one.url)
        let account = ServerEntry(serverId: "srv-account", label: "Mac", routes: [.account(two.url)], username: "tiny", home: two.url)
        ServerRegistry.setCredential(paired.serverId, routeId: paired.routes[0].id, Credential(kind: .bearer, token: "cts_paired"))
        ServerRegistry.setCredential(account.serverId, routeId: Route.accountId, Credential(kind: .dpop, token: "cts_account"))
        defer {
            ServerRegistry.forgetCredentials(paired)
            ServerRegistry.forgetCredentials(account)
        }
        WorkspacePick.set("ws-a", server: paired.key, username: "tiny")
        WorkspacePick.set("ws-b", server: account.key, username: "tiny")

        let bearer = API.connected(paired)
        XCTAssertEqual(bearer.workspace, "ws-a")
        for method in ["GET", "POST", "PATCH", "DELETE"] {
            let r = bearer.request("/api/review", method: method)
            XCTAssertEqual(r.value(forHTTPHeaderField: "Authorization"), "Bearer cts_paired")
            XCTAssertEqual(r.value(forHTTPHeaderField: "X-CT-Workspace"), "ws-a")
            XCTAssertNil(r.value(forHTTPHeaderField: "Cookie"))
        }
        // a Bearer player never carries its token in a header option (it follows a redirect to any host): a ticket
        // in a cookie scoped to the server's host, as a DPoP one
        XCTAssertEqual(bearer.playerOptions()["AVURLAssetHTTPHeaderFieldsKey"] as? [String: String], ["X-CT-Workspace": "ws-a"])
        XCTAssertTrue(bearer.player("/api/library/media/v1/play") is TicketPlayer)
        XCTAssertFalse(bearer.needsTicket)
        XCTAssertTrue(bearer.webNeedsTicket)

        let dpop = API.connected(account)
        XCTAssertEqual(dpop.workspace, "ws-b")
        let r = dpop.request("/api/library", method: "POST", json: ["a": 1])
        XCTAssertEqual(r.value(forHTTPHeaderField: "Authorization"), "DPoP cts_account")
        XCTAssertNotNil(r.value(forHTTPHeaderField: "DPoP"))
        XCTAssertEqual(r.value(forHTTPHeaderField: "X-CT-Workspace"), "ws-b")
        // each request its own proof
        XCTAssertNotEqual(dpop.request("/api/library").value(forHTTPHeaderField: "DPoP"), dpop.request("/api/library").value(forHTTPHeaderField: "DPoP"))
        // a DPoP player never carries a proof in its header option (it would be stale): a ticket in a cookie instead
        XCTAssertEqual(dpop.playerOptions()["AVURLAssetHTTPHeaderFieldsKey"] as? [String: String], ["X-CT-Workspace": "ws-b"])
        XCTAssertTrue(dpop.needsTicket)

        // the Share extension: the route's credential and the phone's pick
        let share = try XCTUnwrap(ShareLink.saved((one.url, paired, ServerRegistry.credential(paired.serverId, route: paired.routes[0]))))
        let sr = share.request("/api/instagram/share", json: ["text": "x"])
        XCTAssertEqual(sr.value(forHTTPHeaderField: "Authorization"), "Bearer cts_paired")
        XCTAssertEqual(sr.value(forHTTPHeaderField: "X-CT-Workspace"), "ws-a")
    }

    func testCachesAreKeptPerServerAccountAndWorkspace() {
        var api = API(server: one.url, cookie: "c", username: "tiny", workspace: "ws-a")
        let inA = api.cacheKey
        api.workspace = "ws-b"
        XCTAssertNotEqual(api.cacheKey, inA)
        // the assistant's outbox and the change stream are the account's, whatever workspace
        XCTAssertEqual(api.accountKey, API(server: one.url, cookie: "c", username: "tiny").accountKey)
        XCTAssertEqual(API(server: one.url, cookie: "c", username: "tiny").cacheKey, api.accountKey)
        XCTAssertNotEqual(API(server: one.url, cookie: "c", username: "lee", workspace: "ws-b").cacheKey, api.cacheKey)
        XCTAssertNotEqual(API(server: two.url, cookie: "c", username: "tiny", workspace: "ws-b").cacheKey, api.cacheKey)
    }

    func testThePickIsThePhonesOwnPerServerAndAccount() {
        WorkspacePick.set("ws-b", server: one.id, username: "tiny")
        XCTAssertEqual(WorkspacePick.get(server: one.id, username: "tiny"), "ws-b")
        XCTAssertNil(WorkspacePick.get(server: one.id, username: "other"))
        XCTAssertNil(WorkspacePick.get(server: two.id, username: "tiny"))
        // kept while the account has it; gone: the first; nothing kept yet: where the computer is
        let ids = ["first", "second"]
        XCTAssertEqual(WorkspacePick.resolve(kept: "second", ids: ids, current: "first"), "second")
        XCTAssertEqual(WorkspacePick.resolve(kept: "gone", ids: ids, current: "second"), "first")
        XCTAssertEqual(WorkspacePick.resolve(kept: nil, ids: ids, current: "second"), "second")
        XCTAssertEqual(WorkspacePick.resolve(kept: nil, ids: ids, current: "gone"), "first")
        XCTAssertNil(WorkspacePick.resolve(kept: "gone", ids: [], current: nil))
    }

    func testTheSwitcherListsEveryServersWorkspaces() throws {
        let lists = [one.id: [Workspace(id: "tiny", name: "Tiny Acrobatics"), Workspace(id: "gym", name: "Northside Gym")]]
        let entries = Workspaces.entries(servers: [one, two], lists: lists)
        // each workspace with its server; a server that listed none is reachable under its own name
        XCTAssertEqual(entries.map(\.name), ["Tiny Acrobatics", "Northside Gym", "Studio Mac"])
        XCTAssertEqual(entries.map(\.server.id), [one.id, one.id, two.id])
        XCTAssertNil(entries[2].workspace)
        XCTAssertEqual(Set(entries.map(\.id)).count, 3)
        XCTAssertEqual(Workspace.initials("Tiny Acrobatics"), "TA")
        XCTAssertEqual(Workspace.initials("bakery"), "BA")
        // what waits there: Review videos that wait for a review, chats that ask, never totals
        let videos = try JSONDecoder().decode([ReviewListItem].self, from: Data(#"""
            [{"id":"r1","approval":{"status":"needs_review"}},{"id":"r2","approval":{"status":"needs_review"}},
             {"id":"r3","approval":{"status":"approved"}},{"id":"r4"}]
            """#.utf8))
        let chats = [ChatSummary(id: "c1", workspace: "gym", asks: true), ChatSummary(id: "c2", workspace: "gym", asks: false),
                     ChatSummary(id: "c3", workspace: "tiny", asks: true)]
        let gym = Workspaces.waiting(videos: videos, chats: chats, in: "gym")
        XCTAssertEqual(gym, WorkspaceWaiting(reviews: 2, chats: 1))
        XCTAssertEqual(gym.line, "2 cuts to review · 1 chat waiting")
        XCTAssertEqual(gym.total, 3)
        XCTAssertEqual(WorkspaceWaiting(reviews: 1).line, "1 cut to review")
        XCTAssertNil(WorkspaceWaiting().line)
        // a link that names a workspace
        XCTAssertEqual(Workspaces.asked(in: "/review/r1?v=2&ws=gym"), "gym")
        XCTAssertNil(Workspaces.asked(in: "/review/r1?v=2"))
        XCTAssertNil(Workspaces.asked(in: "/review/r1?ws="))
        // a notification the phone posts carries its server and workspace
        XCTAssertEqual(AppNotifications.userInfo(path: "/review/r1", server: one.id, workspace: "gym"),
                       ["path": "/review/r1", "server": one.id, "workspace": "gym"])
        XCTAssertEqual(AppNotifications.userInfo(path: "/x", server: nil, workspace: nil), ["path": "/x"])
    }

    func testChatsListThisWorkspacesChats() throws {
        let spaces = ChatList.spaces([ChatSummary(id: "c1", workspace: "tiny"), ChatSummary(id: "c2", workspace: "gym"),
                                      ChatSummary(id: "c3")])
        XCTAssertEqual(spaces, ["c1": "tiny", "c2": "gym"])
        let open = try JSONDecoder().decode(AssistantView.self, from: Data(#"{"id":"c4","workspace":"gym","messages":[],"past":[]}"#.utf8))
        let rows = ["c1", "c2", "c3", "c4"].map { id in
            ChatRow(id: "/?chat=\(id)", route: .chat(id), title: id, detail: "", status: .none, at: .distantPast)
        }
        // another workspace's chats are left out; one whose workspace isn't known shows; the open chat says its own
        XCTAssertEqual(ChatList.inWorkspace(rows, "tiny", of: spaces, open: open).map(\.title), ["c1", "c3"])
        XCTAssertEqual(ChatList.inWorkspace(rows, "gym", of: spaces, open: open).map(\.title), ["c2", "c3", "c4"])
        XCTAssertEqual(ChatList.inWorkspace(rows, nil, of: spaces, open: open).count, 4)
    }

    func testEachStageSitsOnItsTab() {
        let tabs = [WorkshopStatus.draft, .writing, .ready, .production, .editing, .toPost, .published, .shelved].map(\.tab)
        XCTAssertEqual(tabs, [.plan, .plan, .plan, .make, .make, .distribute, .distribute, .plan])
        func session(_ id: String, _ status: WorkshopStatus, at: Double) -> WorkshopSession {
            WorkshopSession(id: id, title: id, status: status, kinds: ["reel"], projectName: nil, updatedAt: at, posted: nil)
        }
        let all = [session("idea", .draft, at: 1), session("ready", .ready, at: 3), session("filming", .production, at: 2),
                   session("editing", .editing, at: 4), session("post", .toPost, at: 5), session("away", .shelved, at: 6)]
        // Plan: its stages, newest first (Shelved folds at the bottom of the screen)
        XCTAssertEqual(PlanView.cards(all).map(\.id), ["away", "ready", "idea"])
        // Make: the pieces being filmed or edited, as rows that open their script
        let rows = ChatList.sessions(all)
        XCTAssertEqual(rows.map(\.title), ["filming", "editing"])
        XCTAssertEqual(rows.first?.route, .session("filming"))
        XCTAssertEqual(rows.first?.detail, "In Production · Reel")
        XCTAssertFalse(rows.contains { $0.status.waitsOnYou })
        // a piece whose edit has a row is told once, by the edit
        let edit = ChatRow(id: "/editor/e1", route: .edit("e1"), title: "Editing", detail: "", status: .working(since: nil), at: .distantPast)
        XCTAssertEqual(ChatList.sessions(all, besides: [edit]).map(\.title), ["filming"])
    }

    func testEditsSortWhatWaitsThenWhatWorksThenWhatIsDone() {
        let now = Date()
        func row(_ title: String, _ status: RowStatus, minutesAgo: Double, shelf: ChatRow.Shelf = .active) -> ChatRow {
            ChatRow(id: "/editor/\(title)", route: .edit(title), title: title, detail: "", status: status,
                    at: now.addingTimeInterval(-minutesAgo * 60), shelf: shelf)
        }
        let rows = [
            row("done", .time(now), minutesAgo: 1, shelf: .done),
            row("working", .working(since: now), minutesAgo: 2, shelf: .working),
            row("filming", .time(now), minutesAgo: 3),
            row("review", .review, minutesAgo: 30),
            row("go", .yourGo, minutesAgo: 10),
            row("failed", .failed, minutesAgo: 20),
        ]
        // what waits on you (newest first), then the rest in play, then Working, then Done
        XCTAssertEqual(ChatList.arrange(rows: rows).map(\.title), ["go", "failed", "review", "filming", "working", "done"])
        // the badge counts only what waits
        XCTAssertEqual(ChatList.waiting(rows, chats: false), 3)
    }
}
