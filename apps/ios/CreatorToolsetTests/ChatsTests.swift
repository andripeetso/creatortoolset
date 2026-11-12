import XCTest
@testable import CreatorToolset

/// Chats without the AI Editor: Review videos, the assistant, the phone's New edits, what is told in a notification, and
/// the server's change line. Fixtures from a scratch server's answers.
@MainActor
final class ChatsTests: XCTestCase {
    /// `GET /api/review`
    private static let reviews = Data(#"""
    [{"id":"ef173602-861d-44e0-8529-894f2a06243e","name":"V1A-1","approval":{"status":"needs_review","by":"local","at":1794418804622},"versions":[{"n":1,"name":"V1A-1.mp4",
    "duration":10,"fps":30,"width":1080,"height":1920,"status":"ready","progress":1,"captioned":false,"timeline":true,"timelineFile":"V1A-1.view.json","edit":{"project":"3215990a-fd60-4077-8306-9a2762ab6b67",
    "draft":"V1A-1"},"source":{"kind":"ai-edit","id":"3215990a-fd60-4077-8306-9a2762ab6b67","label":"Tummy time: 3 mistakes, V1A-1","href":"/editor/3215990a-fd60-4077-8306-9a2762ab6b67/V1A-1"},
    "bytes":2233381,"removed":false,"createdAt":1794417379392}],"download":true,"owner":"local","share":null,"projectId":"78731bcb-c11c-427a-b0d1-109f8f674486",
    "done":null,"createdAt":1794417379392,"comments":1,"newComments":0,"updatedAt":1794419034872},{"id":"ca5463a2-36d1-46dc-9f41-3ae5c54a4d2f","name":"Hanging basics teaser v2",
    "approval":{"status":"approved","by":"local","at":1794417464101},"versions":[{"n":1,"name":"Hanging basics teaser.mp4","duration":10,"fps":30,"width":1080,
    "height":1920,"status":"ready","progress":1,"captioned":false,"timeline":false,"bytes":2233381,"removed":false,"createdAt":1794417377106},{"n":2,"name":"Hanging basics teaser v2.mp4",
    "duration":8,"fps":30,"width":1080,"height":1920,"status":"ready","progress":1,"captioned":false,"timeline":false,"bytes":1845404,"removed":false,"createdAt":1794417378215}],
    "download":true,"owner":"local","share":null,"projectId":"eadcd7d2-bf51-4e16-a69b-87b5c69d1e0c",
    "done":null,"createdAt":1794417377106,"comments":2,"newComments":0,"updatedAt":1794417464101},{"id":"9f3d4416-935a-4045-9880-cfc5e24614c4","name":"V1A-2",
    "approval":{"status":"changes","by":"local","at":1794417383224},"versions":[{"n":1,"name":"V1A-1.mp4","duration":10,"fps":30,"width":1080,"height":1920,
    "status":"ready","progress":1,"captioned":false,"timeline":true,"timelineFile":"V1A-1.view.json","edit":{"project":"840e7e5e-48c6-4e14-ae4d-8924aa0a3267",
    "draft":"V1A-1"},"source":{"kind":"ai-edit","id":"840e7e5e-48c6-4e14-ae4d-8924aa0a3267","label":"Sleep routine reel, V1A-1","href":"/editor/840e7e5e-48c6-4e14-ae4d-8924aa0a3267/V1A-1"},
    "bytes":2233381,"removed":false,"createdAt":1794417380599},{"n":2,"name":"V1A-2.mp4","duration":8,"fps":30,"width":1080,"height":1920,"status":"ready",
    "progress":1,"captioned":false,"timeline":true,"timelineFile":"V1A-2.view.json","edit":{"project":"840e7e5e-48c6-4e14-ae4d-8924aa0a3267","draft":"V1A-2"},
    "source":{"kind":"ai-edit","id":"840e7e5e-48c6-4e14-ae4d-8924aa0a3267","label":"Sleep routine reel, V1A-2","href":"/editor/840e7e5e-48c6-4e14-ae4d-8924aa0a3267/V1A-2"},
    "bytes":1845404,"removed":false,"createdAt":1794417381761}],"download":true,"owner":"local","share":null,"projectId":"ded05e8b-467a-4047-b89f-29f19e1b3973",
    "done":null,"createdAt":1794417380599,"comments":1,"newComments":0,"updatedAt":1794417388718}]
    """#.utf8)

    private func decode<T: Decodable>(_ data: Data, as type: T.Type = T.self) throws -> T {
        try JSONDecoder().decode(T.self, from: data)
    }

    func testReviewRowsWithoutTheEditor() throws {
        // a server with no AI Editor rows: every Review video is its own row
        let rows = ChatList.arrange(rows: ChatList.merge(videos: try decode(Self.reviews), others: []))
        XCTAssertEqual(rows.map(\.title), ["V1A-1", "V1A-2", "Hanging basics teaser v2"])
        XCTAssertEqual(rows[0].status, .review)
        XCTAssertEqual(rows[0].detail, "V1")
        XCTAssertEqual(rows[1].detail, "Changes requested")
        XCTAssertFalse(rows[1].status.waitsOnYou)
        XCTAssertEqual(rows[2].shelf, .done)
        var video: ReviewListItem = try decode(Data(#"{"id":"r1","name":"Teaser","approval":{"status":"needs_review"},"versions":[{"n":1},{"n":2}],"newComments":2,"createdAt":5000}"#.utf8))
        XCTAssertEqual(ChatList.row(video).detail, "V2 · 2 new comments")
        XCTAssertEqual(ChatList.row(video).at, Date(timeIntervalSince1970: 5))
        video.newComments = 1
        XCTAssertEqual(ChatList.row(video).detail, "V2 · 1 new comment")
    }

    func testAFinishedRowSaysDoneUntilItIsOpened() {
        let ended = Date(timeIntervalSince1970: 2000)
        let row = ChatRow(id: "/editor/e1", route: .edit("e1"), title: "Edit", detail: "2 cuts", status: .time(ended), at: ended, finished: ended)
        func status(opened: [String: Date] = [:], since: Date) -> RowStatus {
            ChatList.arrange(rows: [row], opened: opened, since: since)[0].status
        }
        XCTAssertEqual(status(since: Date(timeIntervalSince1970: 1000)), .done)
        // finished before this phone ever showed Chats: not news
        XCTAssertEqual(status(since: Date(timeIntervalSince1970: 3000)), .time(ended))
        XCTAssertEqual(status(opened: ["/editor/e1": Date(timeIntervalSince1970: 2500)], since: Date(timeIntervalSince1970: 1000)), .time(ended))
        XCTAssertEqual(status(opened: ["/editor/e1": Date(timeIntervalSince1970: 1500)], since: Date(timeIntervalSince1970: 1000)), .done)
    }

    func testADismissedRowStepsBackUntilItChanges() {
        let then = Date(timeIntervalSince1970: 1_000)
        let waiting = ChatRow(id: "/review/r1", route: .review("r1", version: nil), title: "Cut", detail: "V1",
                              status: .review, at: then)
        // dismissed at its own time: under Done, no badge
        let quiet = ChatList.settle([waiting], dismissed: ["/review/r1": 1_000])
        XCTAssertEqual(quiet[0].shelf, .done)
        XCTAssertEqual(quiet[0].status, .time(then))
        // something happened to it since: it is back, asking
        var newer = waiting
        newer = ChatRow(id: newer.id, route: newer.route, title: newer.title, detail: "V2", status: .review,
                        at: Date(timeIntervalSince1970: 1_500))
        XCTAssertEqual(ChatList.settle([newer], dismissed: ["/review/r1": 1_000])[0].shelf, .active)
        // a row never dismissed is left alone, and a job at work is never hidden
        XCTAssertEqual(ChatList.settle([waiting], dismissed: [:])[0].status, .review)
        var working = waiting
        working.shelf = .working
        XCTAssertEqual(ChatList.settle([working], dismissed: ["/review/r1": 2_000])[0].shelf, .working)
        // only a Review video can be deleted from the list; the assistant can be neither dismissed nor deleted
        XCTAssertTrue(ChatsModel.canDelete(waiting))
        let assistant = ChatRow(id: "/assistant", route: .assistant, title: "Assistant", detail: "", status: .none, at: then)
        XCTAssertFalse(ChatsModel.canDismiss(assistant))
        XCTAssertFalse(ChatsModel.canDelete(assistant))
        XCTAssertFalse(ChatsModel.canDelete(ChatRow(id: "/editor/e1", route: .edit("e1"), title: "Edit", detail: "", status: .yourGo, at: then)))
    }

    func testTheChangeLineIsReadEventByEvent() {
        var parser = ServerEvents.Parser()
        XCTAssertNil(parser.take("event: change"))
        let change = parser.take(#"data: {"seq":4,"topic":"assistant","origin":"x"}"#)
        XCTAssertEqual(change?.name, "change")
        XCTAssertEqual(change?.field("topic"), "assistant")
        // the name does not carry over to the next event
        XCTAssertEqual(parser.take("data: ping")?.name, "message")
        XCTAssertNil(parser.take(": a comment line"))
        // the AI Editor's line sends an edit's id as plain data
        XCTAssertNil(parser.take("event: changed"))
        XCTAssertEqual(parser.take("data: edit-7"), ServerEvents.Event(name: "changed", data: "edit-7"))
    }

    func testTheAssistantsConversationReadsWithFieldsMissingOrNew() throws {
        let json = #"""
        {"id":"c1","provider":"claude","aiName":"Claude Code","tools":true,"pending":null,"navigate":"/review/r9",
         "messages":[
           {"id":"m1","role":"user","text":"What waits?","at":1731340000000,"images":[{"id":"i1","name":"shot.jpg"}]},
           {"id":"m2","role":"assistant","text":"Three things","at":1731340001000,"status":"thinking","steps":["Looking through Review"],
            "work":[{"id":"w1","kind":"edit","title":"Tummy time","href":"/editor/e1","status":"running","somethingNew":1}],
            "approvals":[{"id":"a1","tool":"Bash","summary":"Run a command","detail":"ls","at":1731340002000,"status":"waiting"}],
            "media":[{"id":"v1","kind":"video","title":"Cut","src":"/api/review/assets/r9/v/1/play","href":"/review/r9?v=1"}]}],
         "past":[{"id":"p1","title":"Earlier","at":1731300000000,"count":4}]}
        """#
        let view = try JSONDecoder().decode(AssistantView.self, from: Data(json.utf8))
        XCTAssertTrue(view.connected)
        XCTAssertEqual(view.thinking?.id, "m2")
        XCTAssertEqual(view.messages[1].work?.first?.href, "/editor/e1")
        XCTAssertEqual(view.messages[1].approvals?.first?.status, "waiting")
        XCTAssertEqual(view.navigate, "/review/r9")
        // an answer with almost nothing in it still reads: no AI connected
        let bare = try JSONDecoder().decode(AssistantView.self, from: Data(#"{"provider":"none"}"#.utf8))
        XCTAssertFalse(bare.connected)
        XCTAssertTrue(bare.messages.isEmpty)
    }

    func testWhatIsNewToTell() throws {
        let rows = ChatList.arrange(rows: ChatList.merge(videos: try decode(Self.reviews), others: []))
        let first = AppNotifications.fresh(rows, shown: [])
        XCTAssertEqual(first.notes, [AppNotifications.Note(key: "ef173602-861d-44e0-8529-894f2a06243e:v1", title: "V1A-1",
                                                           body: "Needs your review", path: "/review/ef173602-861d-44e0-8529-894f2a06243e")])
        // told once
        XCTAssertTrue(AppNotifications.fresh(rows, shown: first.shown).notes.isEmpty)
        // it left the list and came back: news again
        let gone = AppNotifications.fresh([], shown: first.shown)
        XCTAssertEqual(AppNotifications.fresh(rows, shown: gone.shown).notes.map(\.title), ["V1A-1"])
        let video: ReviewListItem = try decode(Data(#"{"id":"r1","name":"Teaser","approval":{"status":"needs_review"},"versions":[{"n":1}]}"#.utf8))
        XCTAssertEqual(AppNotifications.notes([ChatList.row(video)]), [AppNotifications.Note(key: "r1:v1", title: "Teaser", body: "Needs your review", path: "/review/r1")])
    }

    func testANotificationOpensOnlyAPageOfTheApp() {
        XCTAssertEqual(AppNotifications.path(in: ["path": "/editor/e1"]).flatMap(AppRoute.from(path:)), .edit("e1"))
        XCTAssertEqual(AppNotifications.path(in: ["path": "/review/r9?v=2"]).flatMap(AppRoute.from(path:)), .review("r9", version: 2))
        XCTAssertNil(AppNotifications.path(in: ["path": "https://example.com/x"]))
        XCTAssertNil(AppNotifications.path(in: ["path": "phone-edit:1"]))
        XCTAssertNil(AppNotifications.path(in: ["aps": ["badge": 1]]))
    }

    /// The security rule: a reply never makes the app open or load an address it names. Only the server's own pages
    /// open by themselves; pictures and videos come only from the signed-in server.
    func testTheAssistantOpensOnlyTheServersOwnPages() {
        XCTAssertEqual(AssistantChatView.opensByItself("/review/r9?v=1"), .review("r9", version: 1))
        XCTAssertEqual(AssistantChatView.opensByItself("/settings"), .page("/settings"))
        XCTAssertNil(AssistantChatView.opensByItself("https://elsewhere.example.test/x"))
        XCTAssertNil(AssistantChatView.opensByItself("//elsewhere.example.test/x"))
        XCTAssertNil(AssistantChatView.opensByItself("javascript:alert(1)"))
        let api = API(server: URL(string: "https://studio.example.test")!, cookie: "c", username: "sam")
        // a video's or a picture's address in a reply's card is clamped to the server
        XCTAssertEqual(api.url("https://elsewhere.example.test/p.png").host(), "studio.example.test")
        XCTAssertEqual(api.url("/api/assistant/images/i1").absoluteString, "https://studio.example.test/api/assistant/images/i1")
    }

    func testTheNewEditsOfThePhoneInChats() throws {
        let made = Date(timeIntervalSince1970: 3_000)
        var edit = PhoneEdit(id: UUID(), server: "s", name: "Phone edit", clips: [], made: made)
        // Start stopped before the server had the edit: the phone's own row, which a tap asks about (Try again, Remove)
        let stopped = ChatList.row(edit, .failed("Not started"))
        XCTAssertEqual(stopped.status, .failed)
        XCTAssertTrue(stopped.detailIsError)
        XCTAssertEqual(stopped.phoneEdit, edit.id)
        XCTAssertEqual(stopped.id, "phone-edit:\(edit.id)")
        XCTAssertEqual(stopped.at, made)
        XCTAssertEqual(AppNotifications.notes([stopped]).map(\.body), ["Failed: Not started"])
        XCTAssertTrue(ChatFilter.edits.has(stopped))
        XCTAssertEqual(ChatList.phone([(edit, .starting)], over: [], opened: []).map(\.detail), ["Starting…"])

        edit.editId = "e1"
        let server = ChatRow(id: "/editor/e1", route: .edit("e1"), title: "From the server", detail: "Sorting",
                             status: .working(since: nil), at: made, shelf: .working)
        // its clips going up: the phone's row, over a row the server gives for the edit
        let uploading = ChatList.phone([(edit, .uploading(done: 1, of: 2))], over: [server], opened: [])
        XCTAssertEqual(uploading.map(\.detail), ["1 of 2 clips uploaded"])
        XCTAssertEqual(uploading[0].route, .edit("e1"))
        // the server has it: a row of the server's says more; without one the phone's sits under Working
        XCTAssertEqual(ChatList.phone([(edit, .editing)], over: [server], opened: []).map(\.title), ["From the server"])
        XCTAssertEqual(ChatList.phone([(edit, .editing)], over: [], opened: []).map(\.shelf), [.working])

        // ready: in place of its Review video's own row (which says nothing yet), until that is opened
        let video: ReviewListItem = try decode(Data(#"{"id":"r9","name":"Phone edit V1A","approval":{"status":"none"},"versions":[{"n":1}]}"#.utf8))
        let review = ChatList.row(video)
        let ready = ChatList.phone([(edit, .ready(path: "/review/r9?v=1"))], over: [review], opened: [])
        XCTAssertEqual(ready.map(\.detail), ["Ready to review"])
        XCTAssertEqual(ready[0].status, .review)
        XCTAssertEqual(ready[0].route, .review("r9", version: 1))
        XCTAssertEqual(ready[0].keys, ["r9:v1"])
        XCTAssertEqual(ChatList.phone([(edit, .ready(path: "/review/r9?v=1"))], over: [review], opened: ["/review/r9"]), [review])
        // a server with its own rows for edits: the edit's row has the video already, so the phone adds none
        XCTAssertEqual(ChatList.phone([(edit, .ready(path: "/review/r9?v=1"))], over: [server], opened: []), [server])
        // a swipe removes it from the phone: it is neither dismissed nor deleted from Review
        XCTAssertFalse(ChatsModel.canDismiss(ready[0]))
        XCTAssertFalse(ChatsModel.canDelete(ready[0]))
        // a New edit saved before its start time was kept still reads
        let old = try decode(Data(#"[{"id":"\#(UUID())","server":"s","name":"Old","clips":[]}]"#.utf8), as: [PhoneEdit].self)
        XCTAssertNil(old[0].made)
    }

    private func assistant(_ json: String) throws -> AssistantView {
        try JSONDecoder().decode(AssistantView.self, from: Data(json.utf8))
    }

    func testEachAssistantChatIsItsOwnRow() throws {
        let view = try assistant(#"""
        {"id":"c-open","provider":"claude","messages":[
          {"id":"m1","role":"user","text":"Write three hooks\nfor   the Rolling cues reel","at":3000000},
          {"id":"m2","role":"assistant","text":"Here are three:\n- one","at":3000500,"status":"done"}],
         "past":[{"id":"c-old","title":"Monday numbers","at":1000000,"count":3},
                 {"id":"c-busy","title":"Caption these clips","at":2000000,"count":2,"working":true}]}
        """#)
        let rows = ChatList.chats(view)
        XCTAssertEqual(rows.map(\.title), ["Write three hooks for the Rolling cues reel", "Monday numbers", "Caption these clips"])
        XCTAssertEqual(rows.map(\.route), [.chat("c-open"), .chat("c-old"), .chat("c-busy")])
        XCTAssertEqual(rows.map(\.shelf), [.active, .done, .working])
        XCTAssertEqual(rows[0].detail, "Here are three:")
        // the row's id is the path a notification about that chat carries
        XCTAssertEqual(rows.map(\.id), ["/?chat=c-open", "/?chat=c-old", "/?chat=c-busy"])
        XCTAssertEqual(rows.map { AppRoute.from(path: $0.id) }, rows.map(\.route))
        // a new chat with nothing in it has no row; no conversation read yet, no rows
        let fresh = try assistant(#"{"id":"c-new","provider":"claude","messages":[],"past":[{"id":"c-old","title":"Monday numbers","at":1000000,"count":3}]}"#)
        XCTAssertEqual(ChatList.chats(fresh).map(\.route), [.chat("c-old")])
        XCTAssertTrue(ChatList.chats(nil).isEmpty)
        // the Assistant chip finds every chat, and only chats
        XCTAssertEqual(rows.filter(ChatFilter.assistant.has).count, 3)
        XCTAssertFalse(ChatFilter.assistant.has(ChatRow(id: "/editor/e1", route: .edit("e1"), title: "Edit", detail: "", status: .none, at: .distantPast)))
        // the open chat sits among the others by its time; no row is pinned above them
        let edit = ChatRow(id: "/editor/e1", route: .edit("e1"), title: "Edit", detail: "", status: .time(Date(timeIntervalSince1970: 4000)), at: Date(timeIntervalSince1970: 4000))
        XCTAssertEqual(ChatList.arrange(rows: [edit] + rows).map(\.id), ["/editor/e1", "/?chat=c-open", "/?chat=c-busy", "/?chat=c-old"])
    }

    func testAChatNameIsItsFirstMessageAsTheServerWritesIt() throws {
        let long = String(repeating: "word ", count: 30)
        let view = try assistant(#"{"id":"c","messages":[{"id":"m","role":"user","text":"\#(long)","at":1}]}"#)
        XCTAssertEqual(ChatList.title(view.messages).count, 70)
        XCTAssertTrue(ChatList.title(view.messages).hasSuffix("…"))
        XCTAssertEqual(ChatList.title([]), "Conversation")
        // a reply being written: the open chat goes under Working with its clock
        let busy = try assistant(#"{"id":"c","messages":[{"id":"m","role":"user","text":"Hi","at":1000},{"id":"r","role":"assistant","text":"","at":2000,"status":"thinking"}]}"#)
        XCTAssertEqual(ChatList.chats(busy).first?.shelf, .working)
    }

    func testAChatOpensFromItsLinkOrItsNotification() {
        XCTAssertEqual(AppRoute.from(path: "/?chat=c9"), .chat("c9"))
        XCTAssertEqual(AppRoute.from(path: "/assistant?chat=c9"), .chat("c9"))
        XCTAssertEqual(AppRoute.from(path: "/assistant"), .assistant)
        XCTAssertTrue(AppRoute.chat("c9").isAssistant)
        XCTAssertTrue(AppRoute.assistant.isAssistant)
        XCTAssertFalse(AppRoute.edit("e1").isAssistant)
        // the assistant's chats tell no notes of their own from Chats: the server pushes about its replies
        let asks = ChatRow(id: "/?chat=c9", route: .chat("c9"), title: "Clean up", detail: "", status: .approval, at: .distantPast)
        XCTAssertTrue(AppNotifications.notes([asks]).isEmpty)
    }
}
