import XCTest
@testable import CreatorToolset

/// The studio plug-in's AI Editor (its cards on Edits, an edit's thread), push and Share → Creator Toolset, from what
/// the studio's test server really answered (`fixtures/` of the chat-first build, trimmed of the footage's own words
/// and takes, and of a video's share link).
final class NativeToolsTests: XCTestCase {
    /// `GET /api/editor/todo`
    private static let todo = Data(#"""
    {"worker":{"online":true,"host":"scratch-mac"},"review":[{"key":"r:ef173602-861d-44e0-8529-894f2a06243e:1794418804622","asset":"ef173602-861d-44e0-8529-894f2a06243e",
    "name":"V1A-1","project":"Tummy time: 3 mistakes","at":1794418804622,"ai":{"edit":"3215990a-fd60-4077-8306-9a2762ab6b67","name":"Tummy time: 3 mistakes",
    "variant":"V1A"}}],"changes":[{"key":"c:9f3d4416-935a-4045-9880-cfc5e24614c4:2","edit":"840e7e5e-48c6-4e14-ae4d-8924aa0a3267","name":"Sleep routine reel",
    "variant":"V1A","draft":"V1A-2","asset":"9f3d4416-935a-4045-9880-cfc5e24614c4"}],"running":[{"key":"j:00862de2-6a2b-4311-b87f-b53cf13da55c:64ac9f17-c85d-4869-9005-dd0849e85965",
    "edit":"00862de2-6a2b-4311-b87f-b53cf13da55c","name":"Rolling cues","kind":"script","target":"","status":"running","progress":0.5,"message":"Picking the best takes (14 of 27 lines)",
    "at":1794417383365}],"queued":[{"key":"j:00862de2-6a2b-4311-b87f-b53cf13da55c:e1b63210-9317-4f2f-9f71-c0b011f7d420","edit":"00862de2-6a2b-4311-b87f-b53cf13da55c",
    "name":"Rolling cues","kind":"script","target":"","status":"queued","progress":0,"at":1794417383369},{"key":"j:6d98665b-4da2-4399-86c1-b36af2a3efab:8a6221a7-5bba-4cfe-a1fc-b86a75ee20b8",
    "edit":"6d98665b-4da2-4399-86c1-b36af2a3efab","name":"Hanging basics","kind":"music","target":"V1A-1","status":"queued","progress":0,"at":1794417383258}],
    "sheets":[{"key":"j:3215990a-fd60-4077-8306-9a2762ab6b67:7f98003b-584c-4854-81e9-f3608bfd9161","edit":"3215990a-fd60-4077-8306-9a2762ab6b67","name":"Tummy time: 3 mistakes",
    "kind":"broll","target":"V1A-1","status":"waiting","progress":0,"at":1794417379389,"hold":true},{"key":"j:6d98665b-4da2-4399-86c1-b36af2a3efab:a7c3e74f-b080-450e-8edd-71008b413928",
    "edit":"6d98665b-4da2-4399-86c1-b36af2a3efab","name":"Hanging basics","kind":"graphics","target":"V1A-1","status":"waiting","progress":0,"message":"The look sheet waits for your go",
    "at":1794417383318}],"failed":[{"key":"j:6dbc7127-98b7-401a-8f21-e2f99650fde0:27ba86a5-c5b9-4acb-b217-fb77a50a6c9e","edit":"6dbc7127-98b7-401a-8f21-e2f99650fde0",
    "name":"Crawling myths reshoot","kind":"analyze","target":"","status":"error","progress":0.2,"message":"Syncing the mic to the camera","error":"No voice recording in the folder: the mic file is missing. Add it and run Sort again.",
    "at":1794417383378}]}
    """#.utf8)

    /// `GET /api/editor`
    private static let edits = Data(#"""
    [{"id":"00862de2-6a2b-4311-b87f-b53cf13da55c","name":"Rolling cues","cam":"/Volumes/Shoots/tiny-acrobatics/rolling","updatedAt":1794419218956,"drafts":0,
    "busy":true,"stage":"editing","waiting":0,"usage":{"calls":1,"input":18400,"output":2150,"cache_read":96000,"cache_write":4200,"thinking":3100,"cost_usd":0.39,
    "ms":41000}},{"id":"3215990a-fd60-4077-8306-9a2762ab6b67","name":"Tummy time: 3 mistakes","cam":"/Volumes/Shoots/tiny-acrobatics/tummy-time","updatedAt":1794418615106,
    "session":"19202779-569d-4f33-ab8f-dc35b5ab9bde","drafts":1,"busy":false,"stage":"editing","waiting":1,"usage":{"calls":3,"input":55200,"output":6450,
    "cache_read":288000,"cache_write":12600,"thinking":9300,"cost_usd":3.22,"ms":123000}},{"id":"6dbc7127-98b7-401a-8f21-e2f99650fde0","name":"Crawling myths reshoot",
    "cam":"/Volumes/Shoots/tiny-acrobatics/crawling-reshoot","updatedAt":1794417383379,"drafts":0,"busy":false,"stage":"editing","waiting":0,"usage":{"calls":1,
    "input":18400,"output":2150,"cache_read":96000,"cache_write":4200,"thinking":3100,"cost_usd":0.05,"ms":41000}},{"id":"6d98665b-4da2-4399-86c1-b36af2a3efab",
    "name":"Hanging basics","cam":"/Volumes/Shoots/tiny-acrobatics/hanging","updatedAt":1794417383353,"drafts":1,"busy":true,"stage":"editing","waiting":0,
    "usage":{"calls":5,"input":92000,"output":10750,"cache_read":480000,"cache_write":21000,"thinking":15500,"cost_usd":4.46,"ms":205000}},{"id":"840e7e5e-48c6-4e14-ae4d-8924aa0a3267",
    "name":"Sleep routine reel","cam":"/Volumes/Shoots/tiny-acrobatics/sleep-routine","updatedAt":1794417381964,"session":"40acbd0a-786f-4f8e-92be-1977e142f310",
    "drafts":2,"busy":false,"stage":"toPost","waiting":0,"usage":{"calls":4,"input":73600,"output":8600,"cache_read":384000,"cache_write":16800,"thinking":12400,
    "cost_usd":4.34,"ms":164000}}]
    """#.utf8)

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

    /// `GET /api/editor/:id, an edit whose B-roll pass waits for the go`
    private static let held = Data(#"""
    {"id":"3215990a-fd60-4077-8306-9a2762ab6b67","owner":"local","name":"Tummy time: 3 mistakes","session":"19202779-569d-4f33-ab8f-dc35b5ab9bde","folder":"/Volumes/Shoots/tiny-acrobatics/tummy-time",
    "script":"Hook on the mistake, three beats, keyword CTA.","reference":"Most parents make these three tummy time mistakes without knowing it.\nMistake one: starting on a full stomach, right after a feed.\nMistake two: a flat floor from day one, when your chest works better.\nComment TUMMY and I will send you the full guide.",
    "plan":{"scope":"full","broll":true,"graphics":true,"sfx":true,"music":true,"review":true,"versions":1,"passes":true},"jobs":[{"id":"cf414553-fa8a-416f-9b16-38b0fe51c0e8",
    "kind":"analyze","status":"done","progress":1,"createdAt":1794417379296,"seenAt":1794417379332,"startedAt":1794417379306,"host":"scratch-mac","message":"Sorted 14 clips, 1 recording",
    "usage":{"calls":1,"input":18400,"output":2150,"cache_read":96000,"cache_write":4200,"thinking":3100,"cost_usd":0.42,"ms":41000},"finishedAt":1794417379334},
    {"id":"9a856827-c00a-4a38-b625-51536d380a1e","kind":"script","status":"done","progress":1,"createdAt":1794417379334,"seenAt":1794417379345,"startedAt":1794417379341,
    "host":"scratch-mac","message":"1 version from the best takes","usage":{"calls":1,"input":18400,"output":2150,"cache_read":96000,"cache_write":4200,"thinking":3100,
    "cost_usd":1.87,"ms":41000},"finishedAt":1794417379347},{"id":"177e244d-35c0-47d0-9c28-0ed9b104eba4","kind":"draft","status":"done","progress":1,"createdAt":1794417379347,
    "variant":"V1A","look":false,"seenAt":1794417379379,"startedAt":1794417379352,"host":"scratch-mac","message":"V1A-1 is cut \u00b7 in Review as v1 (Needs review)",
    "draft":"V1A-1","usage":{"calls":1,"input":18400,"output":2150,"cache_read":96000,"cache_write":4200,"thinking":3100,"cost_usd":0.93,"ms":41000},"finishedAt":1794417379389},
    {"id":"7f98003b-584c-4854-81e9-f3608bfd9161","kind":"broll","status":"waiting","progress":0,"createdAt":1794417379389,"draft":"V1A-1","layer":true,"round":"de28c3d9",
    "hold":true}],"drafts":[{"name":"V1A-1","variant":"V1A","n":1,"createdAt":1794417379387,"pass":true,"durationS":10,"failed":[],"warnings":["No TEAM sounds on this Mac: the stock pops were used"],
    "path":"/Volumes/Shoots/tiny-acrobatics/drafts/V1A-1.otio","made":"draft","preview":true,"review":{"asset":"ef173602-861d-44e0-8529-894f2a06243e","n":1}}],
    "createdAt":1794417379296,"updatedAt":1794418615106,"vo":"/Volumes/Shoots/tiny-acrobatics/vo-synced.wav","passStep":0,"rounds":{"de28c3d9":{"base":"V1A-1",
    "review":true,"kinds":["broll"]}},"reviews":{"V1A":"ef173602-861d-44e0-8529-894f2a06243e"},"reviewsFiled":true,"inReview":[{"variant":"V1A","draft":"V1A-1",
    "asset":"ef173602-861d-44e0-8529-894f2a06243e","n":1,"status":"needs_review"}],"flags":{"children":true}}
    """#.utf8)

    /// `GET /api/editor/:id, an edit revised from a note, two cuts in Review`
    private static let revised = Data(#"""
    {"id":"840e7e5e-48c6-4e14-ae4d-8924aa0a3267","owner":"local","name":"Sleep routine reel","session":"40acbd0a-786f-4f8e-92be-1977e142f310","folder":"/Volumes/Shoots/tiny-acrobatics/sleep-routine",
    "plan":{"scope":"clean","broll":true,"graphics":true,"sfx":true,"music":true,"review":true,"versions":1},"jobs":[{"id":"469308ef-9846-4ca3-ac84-94bad027d609",
    "kind":"analyze","status":"done","progress":1,"createdAt":1794417380423,"seenAt":1794417380450,"startedAt":1794417380434,"host":"scratch-mac","message":"Sorted 14 clips, 1 recording",
    "usage":{"calls":1,"input":18400,"output":2150,"cache_read":96000,"cache_write":4200,"thinking":3100,"cost_usd":0.42,"ms":41000},"finishedAt":1794417380450},
    {"id":"50f4242a-6d0b-4767-a17c-985b95deda54","kind":"script","status":"done","progress":1,"createdAt":1794417380450,"seenAt":1794417380471,"startedAt":1794417380462,
    "host":"scratch-mac","message":"1 version from the best takes","usage":{"calls":1,"input":18400,"output":2150,"cache_read":96000,"cache_write":4200,"thinking":3100,
    "cost_usd":1.87,"ms":41000},"finishedAt":1794417380475},{"id":"5962ea93-ed65-4538-8c4d-23c074e4c37d","kind":"takes","status":"done","progress":1,"createdAt":1794417380472,
    "gen":"V1","seenAt":1794417380504,"startedAt":1794417380484,"host":"scratch-mac","message":"8 takes cut to watch","finishedAt":1794417380506},{"id":"1892a859-0f1c-4a10-815b-55c04ee1e728",
    "kind":"draft","status":"done","progress":1,"createdAt":1794417380475,"variant":"V1A","seenAt":1794417380582,"startedAt":1794417380514,"host":"scratch-mac",
    "message":"V1A-1 is cut \u00b7 in Review as v1 (Needs review)","draft":"V1A-1","usage":{"calls":1,"input":18400,"output":2150,"cache_read":96000,"cache_write":4200,
    "thinking":3100,"cost_usd":0.93,"ms":41000},"finishedAt":1794417380593},{"id":"1de14e8c-5166-45ea-9f38-559a41f1ae29","kind":"revise","draft":"V1A-2","status":"done",
    "progress":1,"createdAt":1794417381722,"seenAt":1794417381750,"startedAt":1794417381727,"host":"scratch-mac","movedOn":["9f3d4416-935a-4045-9880-cfc5e24614c4"],
    "message":"V1A-2 answers 2 of 3 notes \u00b7 1 comment resolved in Review \u00b7 in Review as v2 (Needs review)","usage":{"calls":1,"input":18400,"output":2150,
    "cache_read":96000,"cache_write":4200,"thinking":3100,"cost_usd":1.12,"ms":41000},"finishedAt":1794417381759}],"drafts":[{"name":"V1A-1","variant":"V1A",
    "n":1,"createdAt":1794417380589,"pass":false,"durationS":10,"failed":["flash_frames"],"path":"/Volumes/Shoots/tiny-acrobatics/drafts/V1A-1.otio","made":"draft",
    "preview":true,"review":{"asset":"9f3d4416-935a-4045-9880-cfc5e24614c4","n":1}},{"name":"V1A-2","variant":"V1A","n":2,"createdAt":1794417381754,"pass":true,
    "durationS":8,"failed":[],"path":"/Volumes/Shoots/tiny-acrobatics/drafts/V1A-2.otio","parent":"V1A-1","made":"revise","preview":true,"review":{"asset":"9f3d4416-935a-4045-9880-cfc5e24614c4",
    "n":2}}],"createdAt":1794417380423,"updatedAt":1794417381964,"vo":"/Volumes/Shoots/tiny-acrobatics/vo-synced.wav","reviews":{"V1A":"9f3d4416-935a-4045-9880-cfc5e24614c4"},
    "reviewsFiled":true,"feedback":[{"id":"note-e28b220d-5171-4dd8-8cc2-c756dfb5c98a","at":1794417381723,"by":"local","text":"Make the hook faster.","draft":"V1A-1",
    "job":"1de14e8c-5166-45ea-9f38-559a41f1ae29","reply":"Changed in V1A-2: Took 0.4 s off the front of the hook."}],"inReview":[{"variant":"V1A","draft":"V1A-2",
    "asset":"9f3d4416-935a-4045-9880-cfc5e24614c4","n":2,"status":"changes"}],"flags":{"children":false}}
    """#.utf8)

    /// `GET /api/editor/:id, an edit whose first job failed`
    private static let failed = Data(#"""
    {"id":"6dbc7127-98b7-401a-8f21-e2f99650fde0","owner":"local","name":"Crawling myths reshoot","folder":"/Volumes/Shoots/tiny-acrobatics/crawling-reshoot",
    "plan":{"scope":"clean","broll":true,"graphics":true,"sfx":true,"music":true,"review":true},"jobs":[{"id":"27ba86a5-c5b9-4acb-b217-fb77a50a6c9e",
    "kind":"analyze","status":"error","progress":0.2,"createdAt":1794417383372,"seenAt":1794417383378,"startedAt":1794417383374,"host":"scratch-mac","message":"Syncing the mic to the camera",
    "error":"No voice recording in the folder: the mic file is missing. Add it and run Sort again.","usage":{"calls":1,"input":18400,"output":2150,"cache_read":96000,
    "cache_write":4200,"thinking":3100,"cost_usd":0.05,"ms":41000},"finishedAt":1794417383378}],"drafts":[],"createdAt":1794417383372,"updatedAt":1794417383379,
    "inReview":[],"flags":{"children":false}}
    """#.utf8)

    /// `GET /api/editor/chat?edit=<the held edit>`
    private static let talk = Data(#"""
    {"messages":[{"id":"30f0be9b-bcdc-4076-a11f-107b6da6ef21","role":"user","text":"Is the first cut too long?","at":1794418160407,"edit":"3215990a-fd60-4077-8306-9a2762ab6b67"},
    {"id":"47456afa-bbae-4a5f-b87a-15579adc04f0","role":"assistant","text":"It runs 10 seconds, and nothing in it repeats. The B-roll pass will not change the length.",
    "at":1794418160421,"steps":["editor_get \u00b7 Tummy time: 3 mistakes"],"usage":{"calls":1,"input":18400,"output":2150,"cache_read":96000,"cache_write":4200,
    "thinking":3100,"cost_usd":0.18,"ms":41000},"edit":"3215990a-fd60-4077-8306-9a2762ab6b67"},{"id":"f6ce4699-252b-486f-b748-efc540fc27b5","role":"user",
    "text":"Then carry on with the B-roll.","at":1794418160433,"edit":"3215990a-fd60-4077-8306-9a2762ab6b67"},{"id":"9ef2e4a9-579b-4491-831c-7c7973a68464",
    "role":"assistant","text":"It waits for your go: press **Looks good, carry on**.","at":1794418160437,"steps":["editor_get \u00b7 Tummy time: 3 mistakes"],
    "usage":{"calls":1,"input":18400,"output":2150,"cache_read":96000,"cache_write":4200,"thinking":3100,"cost_usd":0.18,"ms":41000},"edit":"3215990a-fd60-4077-8306-9a2762ab6b67"}],
    "turn":null}
    """#.utf8)

    /// `the same for an edit whose own message is being answered`
    private static let turn = Data(#"""
    {"messages":[{"id":"981c93ae-9a0c-4685-b48b-bc28a1cf4cf5","role":"user","text":"Make the cards bigger.","at":1794418160423,"edit":"6d98665b-4da2-4399-86c1-b36af2a3efab"}],
    "turn":{"at":1794418160423,"claimed":false,"steps":[]}}
    """#.utf8)

    /// `the same while another edit's message is being answered`
    private static let busy = Data(#"""
    {"messages":[{"id":"30f0be9b-bcdc-4076-a11f-107b6da6ef21","role":"user","text":"Is the first cut too long?","at":1794418160407,"edit":"3215990a-fd60-4077-8306-9a2762ab6b67"},
    {"id":"47456afa-bbae-4a5f-b87a-15579adc04f0","role":"assistant","text":"It runs 10 seconds, and nothing in it repeats. The B-roll pass will not change the length.",
    "at":1794418160421,"steps":["editor_get \u00b7 Tummy time: 3 mistakes"],"usage":{"calls":1,"input":18400,"output":2150,"cache_read":96000,"cache_write":4200,
    "thinking":3100,"cost_usd":0.18,"ms":41000},"edit":"3215990a-fd60-4077-8306-9a2762ab6b67"}],"turn":null,"busy":true}
    """#.utf8)

    private let tummy = "3215990a-fd60-4077-8306-9a2762ab6b67"

    private func decode<T: Decodable>(_ data: Data, as type: T.Type = T.self) throws -> T {
        try JSONDecoder().decode(T.self, from: data)
    }

    /// Chats as the screen orders it, from the three lists.
    private func chats(todo: Data = NativeToolsTests.todo, held: Set<String> = []) throws -> [ChatRow] {
        let edits = EditorChats.rows(edits: try decode(Self.edits), todo: try decode(todo), held: held)
        return ChatList.arrange(rows: ChatList.merge(videos: try decode(Self.reviews), others: edits))
    }

    func testTheListsDecode() throws {
        let todo: EditorTodo = try decode(Self.todo)
        XCTAssertEqual(todo.worker, EditorTodo.Worker(online: true, host: "scratch-mac"))
        XCTAssertEqual([todo.review.count, todo.changes.count, todo.running.count, todo.queued.count, todo.sheets.count, todo.failed.count], [1, 1, 1, 2, 2, 1])
        // a held pass says so; a look sheet does not
        XCTAssertEqual(todo.sheets.map(\.hold), [true, nil])
        XCTAssertEqual(todo.sheets[0].job, "7f98003b-584c-4854-81e9-f3608bfd9161")
        XCTAssertEqual(todo.review[0].ai?.edit, tummy)
        let edits: [EditorSummary] = try decode(Self.edits)
        XCTAssertEqual(edits.map(\.stage), ["editing", "editing", "editing", "editing", "toPost"])
        let videos: [ReviewListItem] = try decode(Self.reviews)
        XCTAssertEqual(videos.map(\.status), ["needs_review", "approved", "changes"])
        XCTAssertEqual(videos.map(\.versions), [1, 2, 2])
        XCTAssertEqual(videos.map { $0.source.flatMap(AppRoute.from(path:)) }, [.edit(tummy), nil, .edit("840e7e5e-48c6-4e14-ae4d-8924aa0a3267")])
        // a to-do with a list missing or of another shape still reads
        let odd: EditorTodo = try decode(Data(#"{"worker":{"online":false},"sheets":"soon"}"#.utf8))
        XCTAssertEqual(odd.worker?.online, false)
        XCTAssertTrue(odd.sheets.isEmpty)
    }

    func testChatsRowsTheirOrderShelvesAndBadges() throws {
        let rows = try chats()
        XCTAssertEqual(rows.map(\.title), ["Tummy time: 3 mistakes", "Crawling myths reshoot", "Hanging basics",
                                           "Sleep routine reel", "Rolling cues", "Hanging basics teaser v2"])
        XCTAssertEqual(rows.map(\.shelf), [.active, .active, .active, .active, .working, .done])
        // an edit whose pass waits and whose cut is in Review is one row, and the go comes first
        XCTAssertEqual(rows[0].status, .yourGo)
        XCTAssertEqual(rows[0].detail, "First cut is ready · next: B-roll")
        XCTAssertEqual(rows[0].route, .edit(tummy))
        XCTAssertEqual(rows[0].keys.count, 2)
        XCTAssertEqual(rows[1].status, .failed)
        XCTAssertTrue(rows[1].detailIsError)
        XCTAssertEqual(rows[1].detail, "No voice recording in the folder: the mic file is missing. Add it and run Sort again.")
        // a look sheet waits although music is queued behind it
        XCTAssertEqual(rows[2].status, .yourGo)
        XCTAssertEqual(rows[2].detail, "Look sheet is ready")
        // changes he asked for: no word at the edge, and not under Done although its script is ready to post
        XCTAssertEqual(rows[3].detail, "Changes requested on V1A-2")
        XCTAssertFalse(rows[3].status.waitsOnYou)
        XCTAssertEqual(rows[4].detail, "Script 50%")
        XCTAssertEqual(rows[4].status, .working(since: Date(timeIntervalSince1970: 1_794_417_383.365)))
        // the two cuts in Review belong to their edits' rows; the video uploaded by hand has its own, approved
        XCTAssertEqual(rows[5].route, .review("ca5463a2-36d1-46dc-9f41-3ae5c54a4d2f", version: nil))
        XCTAssertEqual(rows.filter(\.status.waitsOnYou).count, 3)
        // every one of them is on Edits
        XCTAssertFalse(rows.contains(where: ChatList.onChats))
    }

    func testEachCardShowsItsNewestCut() throws {
        let rows = try chats()
        func picture(_ title: String) -> String? { rows.first { $0.title == title }?.picture }
        // an edit shows the cut it filed in Review; the newest version that is ready, by the address Review's own screen uses
        XCTAssertEqual(picture("Tummy time: 3 mistakes"), "/api/review/assets/ef173602-861d-44e0-8529-894f2a06243e/v/1/thumb?c=1794417379392")
        XCTAssertEqual(picture("Sleep routine reel"), "/api/review/assets/9f3d4416-935a-4045-9880-cfc5e24614c4/v/2/thumb?c=1794417381761")
        XCTAssertEqual(picture("Hanging basics teaser v2"), "/api/review/assets/ca5463a2-36d1-46dc-9f41-3ae5c54a4d2f/v/2/thumb?c=1794417378215")
        // nothing in Review yet: the quiet film tile
        XCTAssertNil(picture("Rolling cues"))
    }

    func testChatsHoldTheAssistantsChatsAndEditsTheRest() throws {
        // the assistant asks for an approval in the open chat; an earlier chat is done
        let view = try JSONDecoder().decode(AssistantView.self, from: Data(#"""
        {"id":"c-open","provider":"claude","messages":[
          {"id":"m1","role":"user","text":"Clear out the old renders","at":3000000},
          {"id":"m2","role":"assistant","text":"Deleting them needs your OK:","at":3000500,"status":"done",
           "approvals":[{"id":"a1","tool":"Bash","summary":"Delete three renders","detail":"rm","at":3000500,"status":"waiting"}]}],
         "past":[{"id":"c-old","title":"Monday numbers","at":1000000,"count":3}]}
        """#.utf8))
        let edits = EditorChats.rows(edits: try decode(Self.edits), todo: try decode(Self.todo))
        let rows = ChatList.arrange(rows: ChatList.merge(videos: try decode(Self.reviews), others: edits) + ChatList.chats(view))
        XCTAssertEqual(rows.filter(ChatList.onChats).map(\.route), [.chat("c-open"), .chat("c-old")])
        XCTAssertEqual(rows.filter { !ChatList.onChats($0) }.count, 6)
        // Chats' badge: the chat that asks; Edits' badge: the go, the failed job, the look sheet
        XCTAssertEqual(ChatList.waiting(rows, chats: true), 1)
        XCTAssertEqual(ChatList.waiting(rows, chats: false), 3)
    }

    func testAnOlderServerThatDoesNotSayWhichJobIsHeld() throws {
        let old = Data(String(decoding: Self.todo, as: UTF8.self).replacingOccurrences(of: #","hold":true"#, with: "").utf8)
        XCTAssertEqual(try decode(old, as: EditorTodo.self).sheets.map(\.hold), [nil, nil])
        XCTAssertEqual(try chats(todo: old)[0].detail, "Look sheet is ready")
        // the phone read the edit and found the pass held
        let key = "j:\(tummy):7f98003b-584c-4854-81e9-f3608bfd9161"
        XCTAssertEqual(try chats(todo: old, held: [key])[0].detail, "First cut is ready · next: B-roll")
    }

    func testAnEditThatAsksTheLanguageSaysTheQuestion() throws {
        let asking = Data(String(decoding: Self.todo, as: UTF8.self).replacingOccurrences(
            of: #","hold":true"#, with: #","ask":"language","message":"I heard no speech in these clips. What language do you speak in them?""#).utf8)
        let row = try chats(todo: asking)[0]
        XCTAssertEqual(row.detail, "I heard no speech in these clips. What language do you speak in them?")
        XCTAssertEqual(row.status, .yourGo)
    }

    func testWhatIsNewToTell() throws {
        let rows = try chats()
        let first = AppNotifications.fresh(rows, shown: [])
        XCTAssertEqual(first.notes.map(\.title), ["Tummy time: 3 mistakes", "Crawling myths reshoot", "Hanging basics"])
        XCTAssertEqual(first.notes.map(\.body), [
            "First cut is ready. Next: B-roll",
            "Failed: No voice recording in the folder: the mic file is missing. Add it and run Sort again.",
            "Look sheet is ready",
        ])
        XCTAssertEqual(first.notes.map(\.path).map(AppRoute.from(path:)), [.edit(tummy), .edit("6dbc7127-98b7-401a-8f21-e2f99650fde0"), .edit("6d98665b-4da2-4399-86c1-b36af2a3efab")])
        // told once
        XCTAssertTrue(AppNotifications.fresh(rows, shown: first.shown).notes.isEmpty)
        // he pressed go: the row now says Review, for a cut he was shown already
        var todo: EditorTodo = try decode(Self.todo)
        todo.sheets.removeFirst()
        let after = ChatList.arrange(rows: EditorChats.rows(edits: try decode(Self.edits), todo: todo))
        XCTAssertEqual(after[0].status, .review)
        let then = AppNotifications.fresh(after, shown: first.shown)
        XCTAssertTrue(then.notes.isEmpty)
        // the pass he started waits again later under the same name: it is news again, because it left in between
        XCTAssertEqual(AppNotifications.fresh(rows, shown: then.shown).notes.map(\.title), ["Tummy time: 3 mistakes"])
        // a video in Review with no edit behind it
        let video: ReviewListItem = try decode(Data(#"{"id":"r1","name":"Teaser","approval":{"status":"needs_review"},"versions":[{"n":1}]}"#.utf8))
        XCTAssertEqual(AppNotifications.notes([ChatList.row(video)]), [AppNotifications.Note(key: "r1:v1", title: "Teaser", body: "Needs your review", path: "/review/r1")])
    }

    func testAnEditsThreadInOrder() throws {
        let held: EditorProject = try decode(Self.held)
        let talk: EditorChat = try decode(Self.talk)
        XCTAssertEqual(talk.messages.map(\.edit), [tummy, tummy, tummy, tummy])
        let feed = EditFeed.items(held, chat: talk.messages)
        // the cut sits under the job that made it, although the server stamped it 2 ms earlier; the pass that waits is not in the feed
        XCTAssertEqual(feed.map(\.id), [
            "job-cf414553-fa8a-416f-9b16-38b0fe51c0e8", "job-9a856827-c00a-4a38-b625-51536d380a1e", "job-177e244d-35c0-47d0-9c28-0ed9b104eba4",
            "cut-V1A-1",
            "said-30f0be9b-bcdc-4076-a11f-107b6da6ef21", "reply-47456afa-bbae-4a5f-b87a-15579adc04f0",
            "said-f6ce4699-252b-486f-b748-efc540fc27b5", "reply-9ef2e4a9-579b-4491-831c-7c7973a68464",
        ])
        XCTAssertEqual(held.jobs.filter { $0.status == "waiting" }.map(\.hold), [true])
        XCTAssertEqual(EditFeed.line(held.jobs[0]), "Sorted the footage")   // the seeded jobs took 28 ms

        // his note, the job it started, the cut that job made, then the editor's answer
        let revised: EditorProject = try decode(Self.revised)
        let kinds = EditFeed.items(revised, chat: []).map { item -> String in
            switch item {
            case .done(let job): job.kind
            case .failed(let job, _): "failed \(job.kind)"
            case .cut(let draft): draft.name
            case .said(_, let text): "he: \(text)"
            case .reply(_, let text, _, _): "editor: \(text)"
            }
        }
        XCTAssertEqual(kinds, ["analyze", "script", "takes", "draft", "V1A-1", "he: Make the hook faster.", "revise", "V1A-2",
                               "editor: Changed in V1A-2: Took 0.4 s off the front of the hook."])
        XCTAssertEqual(revised.drafts.map { $0.failed ?? [] }, [["flash_frames"], []])
        XCTAssertEqual(revised.drafts.map(\.review?.n), [1, 2])

        let failed: EditorProject = try decode(Self.failed)
        guard case .failed(let job, let canRetry)? = EditFeed.items(failed, chat: []).first else { return XCTFail("the failed job is in the feed") }
        XCTAssertTrue(canRetry)
        XCTAssertEqual(job.error, "No voice recording in the folder: the mic file is missing. Add it and run Sort again.")
    }

    func testHowLongAJobTook() throws {
        func took(_ ms: Int) throws -> String {
            let json = String(decoding: Self.held, as: UTF8.self).replacingOccurrences(of: #""finishedAt":1794417379334"#, with: #""finishedAt":\#(1_794_417_379_306 + ms)"#)
            return EditFeed.line(try decode(Data(json.utf8), as: EditorProject.self).jobs[0])
        }
        XCTAssertEqual(try took(42_000), "Sorted the footage · 42s")
        XCTAssertEqual(try took(185_000), "Sorted the footage · 3m")
        XCTAssertEqual(try took(3_900_000), "Sorted the footage · 1h 5m")
        XCTAssertEqual(EditorWords.did("something_new"), "Something new")
    }

    func testTheChatOfAnEditWhileItIsAnsweredOrBusy() throws {
        let own: EditorChat = try decode(Self.turn)
        XCTAssertEqual(own.turn?.claimed, false)
        XCTAssertNil(own.busy)
        let other: EditorChat = try decode(Self.busy)
        XCTAssertNil(other.turn)
        XCTAssertEqual(other.busy, true)
    }

    /// `GET /api/editor` and `GET /api/editor/:id` with the fields the phone does not read (an older capture).
    func testEditorAndChatDecode() throws {
        let editor = Data(#"[{"id":"e1","name":"Tiny Acrobatics hook","cam":"/Volumes/Shoots/tiny-acrobatics/hook","updatedAt":1790629792848,"drafts":2,"busy":true,"usage":{"calls":6,"input":51000,"output":9000,"cache_read":120000,"cache_write":20000,"thinking":4000,"cost_usd":3.35,"ms":90000}}]"#.utf8)
        let edit = Data(#"{"id":"e1","name":"Tiny Acrobatics hook","owner":"local","folder":"/Volumes/Shoots/tiny-acrobatics/hook","variants":{},"createdAt":1790543392848,"updatedAt":1790629792848,"jobs":[{"id":"j1","kind":"broll","draft":"Hook_V1A_D2","status":"running","progress":0.42,"message":"Picking B-roll for line 4","createdAt":1790629732848,"startedAt":1790629742848,"seenAt":1790629792848},{"id":"j2","kind":"draft","variant":"V1B","status":"queued","progress":0,"createdAt":1790629762848}],"drafts":[{"name":"Hook_V1A_D1","variant":"V1A","n":1,"createdAt":1790622592848,"pass":false,"durationS":48.2,"failed":["loudness"]},{"name":"Hook_V1A_D2","variant":"V1A","n":2,"createdAt":1790626192848,"pass":true,"durationS":46.9,"failed":[],"preview":true,"review":{"asset":"r1","n":1}}]}"#.utf8)
        let chat = Data(#"{"messages":[{"id":"m1","role":"user","text":"Draft V1A","at":1},{"id":"m2","role":"assistant","text":"Started **V1A**.","at":2,"steps":["editor_run \u00b7 hook \u00b7 draft \u00b7 V1A"]}],"turn":{"at":3,"claimed":true,"steps":["editor_status"]}}"#.utf8)
        XCTAssertEqual(try decode(editor, as: [EditorSummary].self).first?.usage?.costUsd, 3.35)
        let project = try decode(edit, as: EditorProject.self)
        XCTAssertEqual(project.drafts.map(\.name), ["Hook_V1A_D1", "Hook_V1A_D2"])
        XCTAssertEqual(project.jobs.first?.status, "running")
        let talk = try decode(chat, as: EditorChat.self)
        XCTAssertEqual(talk.messages.last?.steps, ["editor_run · hook · draft · V1A"])
        XCTAssertEqual(talk.turn?.claimed, true)
    }

    // MARK: Push

    func testThePushTokenIsHexAndAPushOpensItsPage() {
        XCTAssertEqual(Push.hex(Data([0x00, 0x0f, 0xa1, 0xff])), "000fa1ff")
        XCTAssertEqual(Push.hex(Data(repeating: 0xab, count: 32)).count, 64)
        // what the plug-in sends (its `apnsPayload`): an edit, a Review video, or an assistant chat
        XCTAssertEqual(AppRoute.from(path: "/editor/\(tummy)"), .edit(tummy))
        XCTAssertEqual(AppRoute.from(path: "/review/r9?v=2"), .review("r9", version: 2))
        XCTAssertEqual(AppRoute.from(path: "/?chat=c-41"), .chat("c-41"))
        XCTAssertEqual(AppRoute.from(path: "/?chat="), .page("/?chat="))
        XCTAssertEqual(AppRoute.from(path: "/review/r9?chat=c-41"), .review("r9", version: nil))
        XCTAssertNil(AppRoute.from(path: "https://example.com/?chat=c-41"))
    }

    // MARK: Share → Creator Toolset

    func testTheShareSheetReadsTheServersAnswers() throws {
        // the own-post answer: not linked yet, and the sessions it could be
        let own = try decode(Data(#"{"own":true,"projectId":"p2","handle":"tinyacrobatics","url":"https://www.instagram.com/p/ABC/","caption":"Line one\nline two","linked":null,"candidates":[{"id":"s1","title":"Rolling cues","status":"toPost","score":0.4,"updatedAt":1}]}"#.utf8), as: ShareLink.OwnPost.self)
        XCTAssertTrue(own.own)
        XCTAssertNil(own.linked)
        XCTAssertEqual(own.candidates?.first?.title, "Rolling cues")
        XCTAssertEqual(own.candidates.map { $0.map { ShareLink.statusLabel($0.status) } }, ["Ready to post"])
        XCTAssertEqual(ShareLink.statusLabel("somethingNew"), "somethingNew")
        let linked = try decode(Data(#"{"own":true,"linked":{"id":"s1","title":"Rolling cues"}}"#.utf8), as: ShareLink.OwnPost.self)
        XCTAssertEqual(linked.linked?.title, "Rolling cues")
        XCTAssertFalse(try decode(Data(#"{"own":false}"#.utf8), as: ShareLink.OwnPost.self).own)

        let ws = try decode(Data(#"{"currentProjectId":"p1","projects":[{"id":"p1","name":"Tiny Acrobatics","color":"violet","audience":"x"},{"id":"p2","name":"Client cuts"}]}"#.utf8), as: ShareLink.Workspace.self)
        XCTAssertEqual(ws.projects.map(\.name), ["Tiny Acrobatics", "Client cuts"])
        XCTAssertNil(ws.projects[1].color)

        // Content and Format are what it's kept for; Know-how is its own flag
        let content = ShareLink.shareBody("https://www.instagram.com/p/X/", keep: .content, projectId: "p1")
        XCTAssertEqual(content as NSDictionary, ["text": "https://www.instagram.com/p/X/", "savedFor": "content", "projectId": "p1"])
        XCTAssertEqual(ShareLink.shareBody("t", keep: .knowhow, projectId: nil) as NSDictionary, ["text": "t", "knowhow": true])
    }

    func testTheShareSheetUsesTheServerTheAppHasInUse() {
        let a = Server(url: URL(string: "http://127.0.0.1:43190")!, username: "local")
        let b = Server(url: URL(string: "https://studio.example.com")!)
        XCTAssertNil(ShareLink.saved(nil))
        XCTAssertNil(ShareLink.saved(SavedServers(list: [a, b], currentId: nil)))
        XCTAssertEqual(ShareLink.saved(SavedServers(list: [a, b], currentId: b.id))?.server, b.url)
    }
}
