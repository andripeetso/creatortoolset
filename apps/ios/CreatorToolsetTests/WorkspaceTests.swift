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

    func testChatsListEveryWorkspacesChatsEachInItsOwn() throws {
        let spaces = ChatList.spaces([ChatSummary(id: "c1", workspace: "tiny"), ChatSummary(id: "c2", workspace: "gym"),
                                      ChatSummary(id: "c3")])
        XCTAssertEqual(spaces, ["c1": "tiny", "c2": "gym"])
        let open = try JSONDecoder().decode(AssistantView.self, from: Data(#"{"id":"c4","workspace":"gym","messages":[],"past":[]}"#.utf8))
        let rows = ["c1", "c2", "c3", "c4"].map { id in
            ChatRow(id: "/?chat=\(id)", route: .chat(id), title: id, detail: "", status: .none, at: .distantPast)
        }
        let edit = ChatRow(id: "/editor/e1", route: .edit("e1"), title: "e1", detail: "", status: .none, at: .distantPast, workspace: "tiny")
        // none is left out, whatever workspace the app is in; each says its own (the open chat its own, one not known none)
        let placed = ChatList.placed(rows + [edit], spaces: spaces, open: open)
        XCTAssertEqual(placed.map(\.title), ["c1", "c2", "c3", "c4", "e1"])
        XCTAssertEqual(placed.map(\.workspace), ["tiny", "gym", nil, "gym", "tiny"])
    }

    func testChatsSettledOrSnoozedOnTheDesktopFoldAwayOnThePhone() throws {
        let json = #"""
        {"chats":[{"id":"c1","settled":true},{"id":"c2","snoozed":1900000000000},{"id":"c3","title":"Named","pinned":5,"unread":true},
                  {"id":"c4","asks":true},{"id":"c5","snoozed":1000}]}
        """#
        let list = try JSONDecoder().decode(ChatSummary.List.self, from: Data(json.utf8)).chats.items
        let chats = Dictionary(uniqueKeysWithValues: list.map { ($0.id, $0) })
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        let rows = ["c1", "c2", "c3", "c4", "c5"].map { id in
            ChatRow(id: "/?chat=\(id)", route: .chat(id), title: id, detail: "", status: .time(.distantPast), at: .distantPast)
        }
        let placed = ChatList.placed(rows, spaces: [:], chats: chats, open: nil, now: now)
        // a snooze whose time has gone is back in the list
        XCTAssertEqual(placed.map(\.fold), [.settled, .snoozed, nil, nil, nil])
        XCTAssertEqual(placed[1].snoozedUntil, Date(timeIntervalSince1970: 1_900_000_000))
        // its name, its pin and its unread mark come from the list of chats
        XCTAssertEqual(placed[2].title, "Named")
        XCTAssertEqual(placed[2].pinned, 5)
        XCTAssertEqual(placed[2].status, .done)
        // one that asks since that list was read is in play again
        var asks = rows[0]
        asks.status = .approval
        XCTAssertNil(ChatList.placed([asks], spaces: [:], chats: chats, open: nil, now: now)[0].fold)
    }

    func testSnoozeChoicesAreTheDesktopsInOrderWithoutPastOnes() throws {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = try XCTUnwrap(TimeZone(identifier: "UTC"))
        // Monday 2026-11-23 at 17:30 UTC: "This evening" (18:00) comes first; next week is the Monday after
        let now = Date(timeIntervalSince1970: 1_795_455_000)
        let choices = SnoozeChoice.all(now: now, calendar: calendar)
        XCTAssertEqual(choices.map(\.label), ["This evening", "In 1 hour", "In 3 hours", "Tomorrow", "Next week"])
        XCTAssertEqual(choices[4].until, Date(timeIntervalSince1970: 1_795_455_000 + 6 * 86400 + 15.5 * 3600))
        XCTAssertEqual(calendar.component(.hour, from: choices[4].until), 9)
        // at 19:00 this evening has gone
        XCTAssertFalse(SnoozeChoice.all(now: now.addingTimeInterval(5400), calendar: calendar).map(\.label).contains("This evening"))
    }

    func testProjectsAreGroupedLikeTheWorkshop() {
        let groups = [WorkshopStatus.draft, .writing, .ready, .production, .editing, .toPost, .published, .shelved, .unknown].map(\.group)
        XCTAssertEqual(groups, [.ideas, .ideas, .making, .making, .making, .making, .published, .shelved, .ideas])
        func session(_ id: String, _ status: WorkshopStatus, _ kind: String, at: Double) -> WorkshopSession {
            WorkshopSession(id: id, title: id, status: status, kinds: [kind], projectName: "Tiny Acrobatics", updatedAt: at, posted: nil)
        }
        let all = [session("idea", .draft, "reel", at: 1), session("ready", .ready, "carousel", at: 3),
                   session("filming", .production, "reel", at: 2), session("editing", .editing, "reel", at: 4),
                   session("post", .toPost, "carousel", at: 5), session("away", .shelved, "reel", at: 6),
                   session("writing", .writing, "carousel", at: 7), session("posted", .published, "reel", at: 8)]
        // every status shows, in the Workshop's groups and order, newest first in each; Shelved last
        let grouped = WorkshopSession.grouped(all)
        XCTAssertEqual(grouped.map(\.group), [.ideas, .making, .published, .shelved])
        XCTAssertEqual(grouped.map(\.group.title), ["Ideas & writing", "Ready & in production", "Published", "Shelved"])
        XCTAssertEqual(grouped.map { $0.sessions.map(\.id) }, [["writing", "idea"], ["post", "editing", "ready", "filming"], ["posted"], ["away"]])
        XCTAssertEqual(grouped.map(\.sessions.count), [2, 4, 1, 1])
        // the type filter and search
        let reels = all.filter { $0.shows(kind: "reel", words: "") }
        XCTAssertEqual(WorkshopSession.grouped(reels).map(\.sessions.count), [1, 2, 1, 1])
        XCTAssertEqual(all.filter { $0.shows(kind: "carousel", words: "") }.map(\.id), ["ready", "post", "writing"])
        XCTAssertEqual(all.filter { $0.shows(kind: nil, words: "edit") }.map(\.id), ["editing"])
        XCTAssertEqual(all.filter { $0.shows(kind: nil, words: "tiny") }.count, all.count)   // its workspace's name
        // an empty group is left out
        XCTAssertEqual(WorkshopSession.grouped([all[0]]).map(\.group), [.ideas])
    }

    func testAnEditIsTheProjectsItIsNamedAfter() {
        let project = WorkshopSession(id: "s6", title: "Handstand basics", status: .production, kinds: ["reel"], projectName: nil,
                                      updatedAt: nil, posted: nil)
        func row(_ title: String, _ route: AppRoute) -> ChatRow {
            ChatRow(id: ChatList.path(route), route: route, title: title, detail: "", status: .review, at: .distantPast)
        }
        let edit = row("Handstand Basics", .edit("e1"))
        let cut = row("Handstand basics, cut 2", .review("r1", version: nil))
        let other = row("Warm-up reel", .edit("e2"))
        let chat = row("Handstand basics", .chat("c1"))
        XCTAssertTrue(ChatList.belongs(edit, to: project))
        XCTAssertTrue(ChatList.belongs(cut, to: project))
        XCTAssertFalse(ChatList.belongs(other, to: project))
        XCTAssertFalse(ChatList.belongs(chat, to: project))   // a chat is no project's edit
        // the edits of no project are Other edits; chats are never there
        XCTAssertEqual(ChatList.others([edit, cut, other, chat], sessions: [project]).map(\.title), ["Warm-up reel"])
        XCTAssertEqual(ChatList.others([edit, other], sessions: []).count, 2)
    }

    func testEachThingThatWaitsBadgesItsOwnTab() {
        func row(_ route: AppRoute, _ status: RowStatus) -> ChatRow {
            ChatRow(id: ChatList.path(route), route: route, title: "x", detail: "", status: status, at: .distantPast)
        }
        let rows = [row(.chat("c1"), .approval), row(.chat("c2"), .time(.distantPast)), row(.edit("e1"), .yourGo),
                    row(.edit("e2"), .failed), row(.review("r1", version: nil), .review), row(.edit("e3"), .working(since: nil))]
        let sessions = [WorkshopStatus.toPost, .toPost, .published, .editing].enumerated().map { n, status in
            WorkshopSession(id: "s\(n)", title: "s\(n)", status: status, kinds: ["reel"], projectName: nil, updatedAt: nil, posted: nil)
        }
        let badges = AppTab.badges(rows: rows, failedUploads: 3, sessions: sessions)
        // a chat that asks on Chats; Review, a go and a failed edit on Projects; failed uploads on Media; to post on Publish
        XCTAssertEqual(badges[.chats], 1)
        XCTAssertEqual(badges[.projects], 3)
        XCTAssertEqual(badges[.media], 3)
        XCTAssertEqual(badges[.publish], 2)
        XCTAssertNil(badges[.tools])
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
