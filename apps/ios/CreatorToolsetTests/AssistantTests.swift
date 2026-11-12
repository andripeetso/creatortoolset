import XCTest
@testable import CreatorToolset

/// The assistant's conversation on the phone: what the server sends, the messages that wait to
/// go, and what a message carries (pictures as JPEG, a video in parts).
@MainActor
final class AssistantTests: XCTestCase {
    // GET /api/assistant on the test server, as it came (fixtures/assistant.json)
    static let seeded = #"""
    {"id":"3441cbd5-c2c7-4ca9-b10f-1cddb2cad321","provider":"claude","aiName":"Claude Code","tools":true,"messages":[{"id":"bb056e37-c4f1-48a8-8e3a-6c9fcd13a9d5","role":"user","text":"What is waiting on me today?","at":1794417177718},{"id":"7b6b90b7-eb4d-4cc4-8983-7266f4d54c39","role":"assistant","text":"Three things:\n\n1. [Tummy time: 3 mistakes](/editor/3215990a-fd60-4077-8306-9a2762ab6b67): the first cut is in [Review](/review/ef173602-861d-44e0-8529-894f2a06243e?v=1), and the B-roll pass starts when you say go.\n2. [Hanging basics](/editor/6d98665b-4da2-4399-86c1-b36af2a3efab): the look sheet for the graphics is ready.\n3. [Sleep routine reel](/review/9f3d4416-935a-4045-9880-cfc5e24614c4?v=2): you asked for changes on version 2.\n\nThe script for [Rolling cues](/workshop/sessions/ebf45a58-9c10-4998-afd9-9352446def64) is ready to film. Here is the first cut:","at":1794417237719,"status":"done","steps":["Looking at the AI Editor's edits","Opening the edit","Looking through Review","Looking through the Workshop","Showing the video"],"work":[{"id":"edit:3215990a-fd60-4077-8306-9a2762ab6b67:broll","kind":"edit","title":"Tummy time: 3 mistakes","href":"/editor/3215990a-fd60-4077-8306-9a2762ab6b67","status":"running","detail":"Waiting for your go: B-roll"},{"id":"workshop:ebf45a58-9c10-4998-afd9-9352446def64","kind":"workshop","title":"Rolling cues","href":"/workshop/sessions/ebf45a58-9c10-4998-afd9-9352446def64","status":"done","detail":"The writer is done"},{"id":"edit:6dbc7127-98b7-401a-8f21-e2f99650fde0:analyze","kind":"edit","title":"Crawling myths reshoot","href":"/editor/6dbc7127-98b7-401a-8f21-e2f99650fde0","status":"failed","detail":"No voice recording in the folder"}],"media":[{"id":"review:ef173602-861d-44e0-8529-894f2a06243e:1","kind":"video","title":"V1A-1","src":"/api/review/assets/ef173602-861d-44e0-8529-894f2a06243e/v/1/play","poster":"/api/review/assets/ef173602-861d-44e0-8529-894f2a06243e/v/1/thumb","href":"/review/ef173602-861d-44e0-8529-894f2a06243e?v=1","duration":10}],"choices":["Looks good, carry on","Show me the look sheet"]},{"id":"c236d892-7d47-4c5e-85a9-b53f64024320","role":"note","text":"Deepgram key saved (…4f2a)","at":1794418017720},{"id":"e3fcb729-9c81-47f4-873d-faf3c9b101d2","role":"user","text":"Here is today's shoot, a clip from my phone and the look I want.","at":1794418317721,"images":[{"id":"d6731db3-dda7-474c-992f-53cdc5d1b033","name":"Look reference.png"}],"files":[{"id":"64dc61bf-cc06-4836-b252-79001234b711","name":"Phone clip.mp4"}],"folders":["/Users/tiny/Movies/Shoot 12 crawling"]},{"id":"ad072428-4c86-4584-84a8-2bb3046f6605","role":"assistant","text":"Got all three. The folder has 14 clips and one recording. Say the word and I start the edit with your usual setup.","at":1794418377722,"status":"done","steps":["Reading files","Looking at the AI Editor's edits"],"choices":["Start with my usual setup","Change the setup"]},{"id":"91d0a035-2631-40a4-8693-813c972c776c","role":"user","text":"Sum up yesterday's comments: what do people ask most?","at":1794418617723,"task":{"id":"task-daily-comments","name":"Daily comments"}},{"id":"db45300d-d902-40db-8bb7-0c623e52f696","role":"assistant","text":"Most asked yesterday: **when to start tummy time** (11 comments) and **how long per day** (7).","at":1794418677724,"status":"done","steps":["Reading the comments"]},{"id":"b0d5a7e6-4e8a-44aa-83aa-be476d33d1fc","role":"user","text":"Clear out the old renders on my Mac, keep this week's.","at":1794418857725,"quote":"Exports: 41 GB","pasted":["render-list.txt"]},{"id":"e5d113b3-8af3-4578-88b0-17d6038ef0c0","role":"assistant","text":"I listed the folder. Three renders are older than a week (11.2 GB). Deleting them needs your OK:","at":1794418917727,"status":"done","steps":["Reading files","Running a command"],"approvals":[{"id":"49c96110-9d2f-4f67-9e3e-fef7e77d48a1","tool":"Bash","summary":"Run a command: List the exports folder","detail":"ls -la ~/Movies/Exports","at":1794418917726,"status":"allowed"},{"id":"cdbac339-d47a-425e-8ed7-baed97c011de","tool":"Bash","summary":"Run a command: Delete three renders older than a week","detail":"rm ~/Movies/Exports/tummy-v1.mov ~/Movies/Exports/tummy-v2.mov ~/Movies/Exports/hanging-test.mov","at":1794419217718,"status":"waiting"}]}],"past":[{"id":"541e87e9-a17c-4521-a0e6-c598dd85bc72","title":"Write three hooks for a reel about carrying positions.","at":1794325677729,"count":2},{"id":"ea83ec28-66dc-4ad0-9792-e8bb687a5cf9","title":"Monday numbers","at":1794160137732,"count":3}],"pending":null,"navigate":null}
    """#

    // the same with no AI connected (fixtures/assistant-none.json, its messages cut to the first)
    static let none = #"""
    {"id":"3441cbd5-c2c7-4ca9-b10f-1cddb2cad321","provider":"none","aiName":"","tools":false,"messages":[{"id":"bb056e37-c4f1-48a8-8e3a-6c9fcd13a9d5","role":"user","text":"What is waiting on me today?","at":1794417177718}],"past":[{"id":"541e87e9-a17c-4521-a0e6-c598dd85bc72","title":"Write three hooks for a reel about carrying positions.","at":1794325677729,"count":2},{"id":"ea83ec28-66dc-4ad0-9792-e8bb687a5cf9","title":"Monday numbers","at":1794160137732,"count":3}],"pending":null,"navigate":null}
    """#

    private func view(_ json: String) throws -> AssistantView {
        try JSONDecoder().decode(AssistantView.self, from: Data(json.utf8))
    }

    func testTheServersConversationReads() throws {
        let view = try view(Self.seeded)
        XCTAssertTrue(view.connected)
        XCTAssertNil(view.thinking)
        XCTAssertNil(view.navigate)
        XCTAssertEqual(view.messages.map(\.role), ["user", "assistant", "note", "user", "assistant", "user", "assistant", "user", "assistant"])
        XCTAssertEqual(view.past.map(\.count), [2, 3])

        let reply = view.messages[1]
        XCTAssertEqual(reply.status, "done")
        XCTAssertEqual(reply.steps?.count, 5)
        XCTAssertEqual(reply.work?.map(\.status), ["running", "done", "failed"])
        XCTAssertEqual(reply.work?.first?.detail, "Waiting for your go: B-roll")
        XCTAssertEqual(reply.media?.first?.src.hasSuffix("/v/1/play"), true)
        XCTAssertEqual(reply.media?.first?.duration, 10)
        XCTAssertEqual(reply.choices, ["Looks good, carry on", "Show me the look sheet"])

        // what a message of his can carry: a picture, a video, a folder on the Mac
        let shoot = view.messages[3]
        XCTAssertEqual(shoot.images?.map(\.name), ["Look reference.png"])
        XCTAssertEqual(shoot.files?.map(\.name), ["Phone clip.mp4"])
        XCTAssertEqual(shoot.folders, ["/Users/tiny/Movies/Shoot 12 crawling"])
        XCTAssertNil(shoot.status)
        // a scheduled task's run
        XCTAssertEqual(view.messages[5].task?.name, "Daily comments")

        let asked = view.messages[7]
        XCTAssertEqual(asked.quote, "Exports: 41 GB")
        XCTAssertEqual(asked.pasted, ["render-list.txt"])
        XCTAssertEqual(view.messages[8].approvals?.map(\.status), ["allowed", "waiting"])
        XCTAssertEqual(view.messages[8].approvals?.last?.detail.hasPrefix("rm ~/Movies/Exports/"), true)
    }

    func testAYesNoQuestionReads() throws {
        // HAND-MADE to the contract on the server's branch (contracts/assistant.ts, AssistantConfirm): no server
        // answer with `confirms` is captured yet. The last one is cut short on purpose.
        let view = try view(#"""
        {"id":"c1","provider":"claude","aiName":"Claude Code","tools":true,"pending":null,"navigate":null,"past":[],
         "messages":[{"id":"m2","role":"assistant","text":"Two of them never run any more:","at":1794158378251,"status":"done",
          "confirms":[
           {"id":"q1","question":"Delete the scheduled task “Monday comments”?","at":1794158378300,"status":"waiting"},
           {"id":"q2","question":"Send the reel to the client?","at":1794158378400,"status":"failed","result":"The share link is switched off for this video."},
           {"id":"q3","status":"later-word"}]}]}
        """#)
        let confirms = try XCTUnwrap(view.messages.first?.confirms)
        XCTAssertEqual(confirms.map(\.status), ["waiting", "failed", "later-word"])
        XCTAssertEqual(confirms[0].question, "Delete the scheduled task “Monday comments”?")
        XCTAssertNil(confirms[0].result)
        XCTAssertEqual(confirms[1].result, "The share link is switched off for this video.")
        // a question with fields missing does not take the conversation with it
        XCTAssertEqual(confirms[2].question, "")
        XCTAssertEqual(view.messages.count, 1)
        // an older server sends none
        XCTAssertNil(try self.view(Self.seeded).messages[8].confirms)
    }

    func testNoAIConnectedReads() throws {
        let view = try view(Self.none)
        XCTAssertFalse(view.connected)
        XCTAssertEqual(view.aiName, "")
        XCTAssertEqual(view.messages.first?.text, "What is waiting on me today?")
    }

    // MARK: The queue

    private func scratch() -> URL {
        FileManager.default.temporaryDirectory.appendingPathComponent("outbox-\(UUID().uuidString).json")
    }

    func testQueuedMessagesGoOldestFirstAndLeaveWhenSent() async {
        let outbox = AssistantOutbox()
        outbox.open(scratch())
        ["one", "two", "three"].forEach { outbox.add(QueuedMessage(text: $0)) }
        var sent: [String] = []
        for _ in 0..<5 {
            await outbox.drain { message in
                sent.append(message.text)
                return .sent
            }
        }
        XCTAssertEqual(sent, ["one", "two", "three"])
        XCTAssertTrue(outbox.items.isEmpty)
        XCTAssertFalse(outbox.waiting)
    }

    func testTheQueueSurvivesTheAppClosing() async {
        let file = scratch()
        let before = AssistantOutbox()
        before.open(file)
        before.add(QueuedMessage(text: "one", images: [.init(name: "Photo 1.jpg", jpeg: Data([0xFF, 0xD8, 0xFF]))]))
        before.add(QueuedMessage(text: "two", files: [.init(id: "f1", name: "Clip.mov")], quote: "a line"))

        let after = AssistantOutbox()
        after.open(file)
        XCTAssertEqual(after.items, before.items)
        XCTAssertEqual(after.items.first?.images.first?.jpeg, Data([0xFF, 0xD8, 0xFF]))
        XCTAssertEqual(after.items.last?.files.first?.name, "Clip.mov")

        // sent: gone from the disk too
        await after.drain { _ in .sent }
        let again = AssistantOutbox()
        again.open(file)
        XCTAssertEqual(again.items.map(\.text), ["two"])
        // no account: nothing is queued
        again.open(nil)
        XCTAssertTrue(again.items.isEmpty)
    }

    func testOneMessageGoesAtATime() async {
        final class Seen {
            var sent: [String] = []
            var release: CheckedContinuation<Void, Never>?
        }
        let seen = Seen()
        let outbox = AssistantOutbox()
        outbox.add(QueuedMessage(text: "one"))
        outbox.add(QueuedMessage(text: "two"))
        let first = Task { @MainActor in
            await outbox.drain { message in
                seen.sent.append(message.text)
                await withCheckedContinuation { seen.release = $0 }
                return .sent
            }
        }
        while seen.release == nil { await Task.yield() }
        XCTAssertEqual(outbox.sending, outbox.items.first?.id)
        // the first is still on its way: a second try sends nothing
        await outbox.drain { message in
            seen.sent.append(message.text)
            return .sent
        }
        XCTAssertEqual(seen.sent, ["one"])
        seen.release?.resume()
        _ = await first.value
        XCTAssertNil(outbox.sending)
        XCTAssertEqual(outbox.items.map(\.text), ["two"])
    }

    func testAMessageThatCantGoYetStaysAndARefusedOneIsMarked() async {
        let outbox = AssistantOutbox()
        outbox.add(QueuedMessage(text: "one"))
        outbox.add(QueuedMessage(text: "two"))
        // no connection, or a reply still being written
        await outbox.drain { _ in .later }
        XCTAssertEqual(outbox.items.map(\.text), ["one", "two"])
        XCTAssertTrue(outbox.waiting)
        // the server will never take it: it stays, marked, and the next one goes
        await outbox.drain { _ in .refused("Photo 1.jpg is too big: send pictures under 8 MB.") }
        XCTAssertEqual(outbox.items.first?.failed, "Photo 1.jpg is too big: send pictures under 8 MB.")
        var sent: [String] = []
        await outbox.drain { message in
            sent.append(message.text)
            return .sent
        }
        XCTAssertEqual(sent, ["two"])
        XCTAssertFalse(outbox.waiting)
        // Try again puts it back in line
        outbox.retry(outbox.items[0].id)
        XCTAssertTrue(outbox.waiting)
    }

    func testAMessageTakenBackKeepsWhatIsInTheBox() {
        let draft = AssistantDraft()
        draft.putBack(QueuedMessage(text: "one", images: [.init(name: "Photo 1.jpg", jpeg: Data([1]))], files: [.init(id: "f1", name: "Clip.mov")]))
        XCTAssertEqual(draft.text, "one")
        draft.putBack(QueuedMessage(text: "two"))
        XCTAssertEqual(draft.text, "one\n\ntwo")
        // what it carried is ready to go again, the video without uploading twice
        let again = draft.take()
        XCTAssertEqual(again?.images.count, 1)
        XCTAssertEqual(again?.files, [.init(id: "f1", name: "Clip.mov")])
        XCTAssertTrue(draft.isEmpty)
    }

    func testALostAnswerIsNotSentTwice() throws {
        let messages = try view(Self.seeded).messages
        let hello = QueuedMessage(text: "Clear out the old renders on my Mac, keep this week's.")
        // tried when the note was the last message: the conversation now holds it after that
        XCTAssertTrue(AssistantModel.landed(hello, after: messages[2].id, in: messages))
        // tried after the last reply: it is not there yet
        XCTAssertFalse(AssistantModel.landed(hello, after: messages[8].id, in: messages))
        // the same words with a picture are another message
        let shoot = QueuedMessage(text: messages[3].text)
        XCTAssertFalse(AssistantModel.landed(shoot, after: messages[2].id, in: messages))
        // another chat is open by now
        XCTAssertFalse(AssistantModel.landed(hello, after: "gone", in: messages))
    }

    func testWhatAMessageSends() {
        let message = QueuedMessage(text: "Caption this", images: [.init(name: "Photo 1.jpg", jpeg: Data([0xFF, 0xD8, 0xFF, 0xE0]))],
                                    files: [.init(id: "f1", name: "Clip.mov")], quote: "a line")
        let body = AssistantModel.body(message, timezone: "Europe/Tallinn")
        XCTAssertEqual(body["text"] as? String, "Caption this")
        XCTAssertEqual(body["files"] as? [String], ["f1"])
        let image = (body["images"] as? [[String: String]])?.first
        XCTAssertEqual(image?["type"], "image/jpeg")
        XCTAssertEqual(image?["data"], "/9j/4A==")
        let context = body["context"] as? [String: String]
        XCTAssertEqual(context, ["path": "/m", "title": "iPhone app", "timezone": "Europe/Tallinn", "selection": "a line"])
        // words only: no empty lists
        let plain = AssistantModel.body(QueuedMessage(text: "Hello"), timezone: "Europe/Tallinn")
        XCTAssertNil(plain["images"])
        XCTAssertNil(plain["files"])
        XCTAssertTrue(JSONSerialization.isValidJSONObject(body))
    }

    // MARK: Videos that go up while the message waits

    /// What the stand-in post saw, in order: each message's words and the file ids its body names.
    private final class Posted {
        var texts: [String] = []
        var files: [[String]] = []

        func post(_ message: QueuedMessage) -> AssistantOutbox.Outcome {
            texts.append(message.text)
            files.append(AssistantModel.body(message, timezone: "UTC")["files"] as? [String] ?? [])
            return .sent
        }
    }

    private final class Gate {
        var waiting: CheckedContinuation<Void, Never>?
        func pass() async { await withCheckedContinuation { waiting = $0 } }
        func open() {
            waiting?.resume()
            waiting = nil
        }
    }

    private func up(_ name: String, _ copy: String) -> QueuedMessage.Video { .init(name: name, copy: copy) }

    func testAMessageWaitsForItsVideoAndTheNextWaitsBehindIt() async {
        let gate = Gate()
        let posted = Posted()
        let file = scratch()
        let outbox = AssistantOutbox()
        outbox.open(file)
        outbox.serverWaits = false   // a server that takes a message only once its videos are up
        outbox.add(QueuedMessage(text: "Put this clip in Review", videos: [up("Clip.mov", "c1")]))
        outbox.add(QueuedMessage(text: "and write its post description"))
        // its video is not up: nothing goes, the plain one behind it included
        let tried = await outbox.drain { posted.post($0) }
        XCTAssertNil(tried)
        var moved = 0
        outbox.upload(.init(begin: { _ in "f1" }, send: { video, _, progress in
            XCTAssertEqual(video.file, "f1")
            progress(0.42)
            await gate.pass()
            return "f1"
        }), moved: { moved += 1 })
        while gate.waiting == nil { await Task.yield() }
        // the server's id is kept on disk from the moment it is given; how far it got is not
        let reread = AssistantOutbox()
        reread.open(file)
        XCTAssertEqual(reread.items.first?.videos?.first?.file, "f1")
        while outbox.progress.isEmpty { await Task.yield() }
        XCTAssertEqual(outbox.progress.values.first, 0.42)
        let held = await outbox.drain { posted.post($0) }
        XCTAssertNil(held)
        // a second call while it goes up starts nothing new
        outbox.upload(.init(begin: { _ in XCTFail("begun twice"); return "" }, send: { _, _, _ in XCTFail("two at once"); return "" }),
                      moved: {})
        gate.open()
        await outbox.settled()
        XCTAssertEqual(moved, 2)   // its id, then the video up
        XCTAssertEqual(outbox.items[0].files, [.init(id: "f1", name: "Clip.mov")])
        XCTAssertNil(outbox.items[0].videos)
        XCTAssertTrue(outbox.progress.isEmpty)
        await outbox.drain { posted.post($0) }
        await outbox.drain { posted.post($0) }
        XCTAssertEqual(posted.texts, ["Put this clip in Review", "and write its post description"])
        XCTAssertEqual(posted.files, [["f1"], []])
    }

    func testVideosGoUpInTheOrderTheMessagesWereSent() async {
        let outbox = AssistantOutbox()
        outbox.add(QueuedMessage(text: "one", videos: [up("A.mov", "a"), up("B.mov", "b")]))
        outbox.add(QueuedMessage(text: "two"))
        outbox.add(QueuedMessage(text: "three", videos: [up("C.mov", "c")]))
        var begun: [String] = []
        var sent: [String] = []
        outbox.upload(.init(begin: { video in
            begun.append(video.name)
            return "id-" + video.copy
        }, send: { video, _, _ in
            sent.append(video.name)
            return video.file ?? ""
        }), moved: {})
        await outbox.settled()
        XCTAssertEqual(begun, ["A.mov", "B.mov", "C.mov"])
        XCTAssertEqual(sent, ["A.mov", "B.mov", "C.mov"])
        XCTAssertEqual(outbox.items.map { $0.files.map(\.id) }, [["id-a", "id-b"], [], ["id-c"]])
    }

    func testNoConnectionKeepsTheMessageWaiting() async {
        let posted = Posted()
        let outbox = AssistantOutbox()
        outbox.serverWaits = false
        outbox.add(QueuedMessage(text: "one", videos: [up("Clip.mov", "c1")]))
        outbox.add(QueuedMessage(text: "two"))
        let offline = { (status: Int) in ToolsetAPI.Failure(status: status, message: "No connection to Creator Toolset") }
        // no answer to its first call, a server restarting, then a connection that drops while the parts go
        outbox.upload(.init(begin: { _ in throw offline(0) }, send: { _, _, _ in "" }), moved: {})
        await outbox.settled()
        outbox.upload(.init(begin: { _ in throw offline(503) }, send: { _, _, _ in "" }), moved: {})
        await outbox.settled()
        outbox.upload(.init(begin: { _ in "f1" }, send: { _, _, _ in throw offline(0) }), moved: {})
        await outbox.settled()
        // nothing said, nothing overtakes it: the next read of the chat starts it again, from its upload
        XCTAssertNil(outbox.items[0].failed)
        XCTAssertEqual(outbox.items[0].videos?.first?.file, "f1")
        let tried = await outbox.drain { posted.post($0) }
        XCTAssertNil(tried)
        XCTAssertEqual(outbox.items.count, 2)
    }

    func testAFailedUploadIsMarkedAndTheMessagesBehindItGo() async {
        let posted = Posted()
        let outbox = AssistantOutbox()
        outbox.open(scratch())
        outbox.serverWaits = false
        outbox.add(QueuedMessage(text: "one", videos: [up("Clip.mov", "c1")]))
        outbox.add(QueuedMessage(text: "two"))
        var moved = 0
        outbox.upload(.init(begin: { _ in "f1" }, send: { _, _, _ in throw ToolsetAPI.Failure(status: 408, message: "No answer from the server") }),
                      moved: { moved += 1 })
        await outbox.settled()
        // marked Not sent, with the reason, and out of the way
        XCTAssertEqual(outbox.items[0].failed, "No answer from the server")
        XCTAssertEqual(moved, 2)
        XCTAssertEqual(outbox.shown.map(\.text), ["one", "two"])
        await outbox.drain { posted.post($0) }
        XCTAssertEqual(posted.texts, ["two"])
        // a Not sent message's videos wait for Try again
        outbox.upload(.init(begin: { _ in XCTFail("without Try again"); return "" }, send: { _, _, _ in XCTFail("without Try again"); return "" }),
                      moved: {})
        await outbox.settled()
        // Try again: back in line, the video carries on from its upload and the message goes with it
        outbox.retry(outbox.items[0].id)
        outbox.upload(.init(begin: { _ in XCTFail("begun again"); return "" }, send: { video, _, _ in video.file ?? "" }), moved: {})
        await outbox.settled()
        await outbox.drain { posted.post($0) }
        XCTAssertEqual(posted.texts, ["two", "one"])
        XCTAssertEqual(posted.files.last, ["f1"])
    }

    func testAServerThatKeepsFailingThePartsDoesNotHoldTheLineForEver() async {
        let posted = Posted()
        let outbox = AssistantOutbox()
        outbox.add(QueuedMessage(text: "one", videos: [up("Clip.mov", "c1")]))
        outbox.add(QueuedMessage(text: "two"))
        let full = ToolsetAPI.Failure(status: 500, message: "ENOSPC: no space left on device")
        // a server error while the video gets further each time: it keeps waiting
        for step in 1...6 {
            outbox.upload(.init(begin: { _ in "f1" }, send: { _, _, progress in
                progress(Double(step) / 10)
                try await Task.sleep(for: .milliseconds(20))
                throw full
            }), moved: {})
            await outbox.settled()
        }
        XCTAssertNil(outbox.items[0].failed)
        // no further, a few times in a row: Not sent, with the server's words, and the next one goes
        for _ in 1..<AssistantOutbox.maxStalls {
            outbox.upload(.init(begin: { _ in "f1" }, send: { _, _, _ in throw full }), moved: {})
            await outbox.settled()
        }
        XCTAssertEqual(outbox.items[0].failed, "ENOSPC: no space left on device")
        await outbox.drain { posted.post($0) }
        XCTAssertEqual(posted.texts, ["two"])
        // no answer at all is never counted: that is no connection
        let offline = AssistantOutbox()
        offline.add(QueuedMessage(text: "one", videos: [up("Clip.mov", "c1")]))
        for _ in 1...(2 * AssistantOutbox.maxStalls) {
            offline.upload(.init(begin: { _ in throw ToolsetAPI.Failure(status: 0, message: "No connection") }, send: { _, _, _ in "" }),
                           moved: {})
            await offline.settled()
        }
        XCTAssertNil(offline.items[0].failed)
    }

    func testWhatWaitsAndWhatFails() throws {
        XCTAssertTrue(AssistantUpload.waits(ToolsetAPI.Failure(status: 0, message: "No connection to Creator Toolset")))
        XCTAssertTrue(AssistantUpload.waits(ToolsetAPI.Failure(status: 502, message: "HTTP 502")))
        // a part that never gets an answer (an older server), a refusal, a copy that is gone: Not sent
        XCTAssertFalse(AssistantUpload.waits(ToolsetAPI.Failure(status: 408, message: "No answer from the server")))
        XCTAssertFalse(AssistantUpload.waits(ToolsetAPI.Failure(status: 401, message: "Sign in again")))
        XCTAssertFalse(AssistantUpload.waits(AssistantUpload.Unreadable(name: "Clip.mov")))
        XCTAssertFalse(AssistantUpload.waits(CocoaError(.fileReadNoSuchFile)))
    }

    func testAVideoThatCanNoLongerBeReadIsNotSentAndAsksNothingOfTheServer() async throws {
        // a server nobody answers at: a request would come back as "no connection", which waits
        let api = API(server: URL(string: "http://127.0.0.1:9")!, cookie: nil, username: "tiny")
        let gone = up("Clip.mov", "gone-\(UUID().uuidString)")
        XCTAssertFalse(gone.readable)
        do {
            _ = try await AssistantUpload.send(gone.url, name: gone.name, resuming: "f1", api: api, begun: { _ in }, progress: { _ in })
            XCTFail("sent")
        } catch {
            XCTAssertTrue(error is AssistantUpload.Unreadable)
            XCTAssertEqual(error.localizedDescription, "Clip.mov can no longer be read: take it back and add it again")
        }
    }

    func testAQueueReadFromDiskCarriesOnWhereItStopped() async {
        let file = scratch()
        let before = AssistantOutbox()
        before.open(file)
        before.add(QueuedMessage(text: "one", videos: [up("Clip.mov", "c1")]))
        before.add(QueuedMessage(text: "two"))
        // the server gave the upload its id, then the connection dropped and the app was closed
        before.upload(.init(begin: { _ in "f9" }, send: { _, _, _ in throw ToolsetAPI.Failure(status: 0, message: "The upload stopped") }),
                      moved: {})
        await before.settled()

        let after = AssistantOutbox()
        after.open(file)
        after.serverWaits = false
        XCTAssertEqual(after.items.map(\.text), ["one", "two"])
        var resumed: String?
        after.upload(.init(begin: { _ in XCTFail("started again"); return "" }, send: { video, _, _ in
            resumed = video.file
            return "f9"
        }), moved: {})
        await after.settled()
        // it carries on with the same upload, not from the start
        XCTAssertEqual(resumed, "f9")
        let posted = Posted()
        await after.drain { posted.post($0) }
        await after.drain { posted.post($0) }
        XCTAssertEqual(posted.texts, ["one", "two"])
        XCTAssertEqual(posted.files, [["f9"], []])
    }

    func testAQueueSavedByTheOlderAppStillReads() throws {
        // what the app wrote before videos could wait (JSONEncoder of the old QueuedMessage)
        let file = scratch()
        try Data(#"[{"id":"q1","text":"two","images":[],"files":[{"id":"f1","name":"Clip.mov"}],"quote":"a line"}]"#.utf8).write(to: file)
        let outbox = AssistantOutbox()
        outbox.open(file)
        XCTAssertEqual(outbox.items.map(\.text), ["two"])
        XCTAssertEqual(outbox.items.first?.files, [.init(id: "f1", name: "Clip.mov")])
        XCTAssertNil(outbox.items.first?.videos)
        XCTAssertTrue(AssistantOutbox.ready(outbox.items[0], serverWaits: false))
        XCTAssertTrue(AssistantOutbox.ready(outbox.items[0], serverWaits: true))
    }

    func testATakenBackMessageStopsItsUploadAndTheBoxKeepsItsVideo() async throws {
        // a real copy, as Photos leaves it, and one iOS has cleared away
        let kept = up("Clip.mov", "test-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: kept.url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data([1, 2, 3]).write(to: kept.url)
        defer { kept.discard() }
        let gone = up("Old.mov", "gone-\(UUID().uuidString)")

        let outbox = AssistantOutbox()
        outbox.add(QueuedMessage(text: "Put this in Review", videos: [kept, gone]))
        var started = false
        outbox.upload(.init(begin: { $0.name == "Clip.mov" ? "f1" : "f2" }, send: { _, _, _ in
            started = true
            try await Task.sleep(for: .seconds(60))
            return "f1"
        }), moved: {})
        while !started { await Task.yield() }
        let message = outbox.items[0]
        outbox.remove(message.id)
        // no box holds it here: at the next look its upload stops
        outbox.upload(.init(begin: { _ in "" }, send: { _, _, _ in "" }), moved: {})
        await outbox.settled()
        XCTAssertTrue(outbox.items.isEmpty)
        XCTAssertTrue(kept.readable)   // the box takes it back: its copy stays

        let draft = AssistantDraft()
        draft.putBack(message)
        XCTAssertEqual(draft.text, "Put this in Review")
        // the video carries on from its upload when it goes again; the one that can't be read is left out, and said
        XCTAssertEqual(draft.videos.map(\.name), ["Clip.mov"])
        XCTAssertEqual(draft.videos.first?.file, "f1")
        XCTAssertEqual(draft.notice, "A video could not be read")
        let again = try XCTUnwrap(draft.take())
        XCTAssertEqual(again.videos?.map(\.file), ["f1"])
        XCTAssertFalse(AssistantOutbox.ready(again, serverWaits: false))
        XCTAssertTrue(AssistantOutbox.ready(again, serverWaits: true))
    }

    func testSendEmptiesTheBoxWhileItsVideosHaveYetToGoUp() {
        let draft = AssistantDraft()
        draft.pretend(pictures: [], videos: [up("IMG_2041.MOV", "c1")])
        draft.text = "Caption this"
        let message = draft.take()
        XCTAssertEqual(message?.videos?.map(\.name), ["IMG_2041.MOV"])
        XCTAssertEqual(message?.files, [])
        XCTAssertTrue(draft.isEmpty)
        XCTAssertTrue(draft.videos.isEmpty)
    }

    // MARK: A server that waits for the videos itself (SEND-NOW.md)

    func testAServerThatWaitsTakesTheMessageOnceItsVideoHasAnIdAndTheNextAtOnce() async {
        let named = Gate()
        let parts = Gate()
        let posted = Posted()
        let outbox = AssistantOutbox()
        outbox.open(scratch())
        XCTAssertFalse(outbox.serverWaits)   // not known until the server says so
        outbox.serverWaits = true
        outbox.add(QueuedMessage(text: "Put this clip in Review", videos: [up("Clip.mov", "c1")]))
        outbox.add(QueuedMessage(text: "and write its post description"))
        // the server takes the message when it is answered as if it came from it
        let send = { (message: QueuedMessage) -> AssistantOutbox.Outcome in
            if !AssistantOutbox.ready(message, serverWaits: false) { outbox.carry(message.id, reply: "r1") }
            return posted.post(message)
        }
        outbox.upload(.init(begin: { _ in
            await named.pass()
            return "f1"
        }, send: { _, _, progress in
            progress(0.5)
            await parts.pass()
            return "f1"
        }), moved: {})
        while named.waiting == nil { await Task.yield() }
        // no id for its video yet: it holds the line
        let early = await outbox.drain(send: send)
        XCTAssertNil(early)
        named.open()
        while parts.waiting == nil { await Task.yield() }
        // it goes with the id while its video goes up, and the next one goes straight after it
        await outbox.drain(send: send)
        await outbox.drain(send: send)
        XCTAssertEqual(posted.texts, ["Put this clip in Review", "and write its post description"])
        XCTAssertEqual(posted.files, [["f1"], []])
        // it stays only for its video, out of the feed: the conversation shows it
        XCTAssertEqual(outbox.items.map(\.reply), ["r1"])
        XCTAssertTrue(outbox.shown.isEmpty)
        while outbox.carried["f1"] != 0.5 { await Task.yield() }
        XCTAssertTrue(outbox.waiting)   // the chat is read again meanwhile: a stopped upload starts again on it
        let more = await outbox.drain(send: send)
        XCTAssertNil(more)
        // its last video up: nothing is left of it here
        parts.open()
        await outbox.settled()
        XCTAssertTrue(outbox.items.isEmpty)
    }

    func testAFailedVideoOfAMessageTheServerTookComesBackAsNotSent() async throws {
        let outbox = AssistantOutbox()
        outbox.add(QueuedMessage(text: "one", videos: [up("Clip.mov", "c1")], reply: "r1"))
        outbox.add(QueuedMessage(text: "two", videos: [up("Other.mov", "c2")], reply: "r2"))
        XCTAssertTrue(outbox.shown.isEmpty)
        outbox.upload(.init(begin: { _ in "f" }, send: { video, _, _ in
            if video.name == "Clip.mov" { throw AssistantUpload.Unreadable(name: "Clip.mov") }
            return "f"
        }), moved: {})
        await outbox.settled()
        // its reply is still held on the server: it shows, Not sent, until the phone has stopped that reply
        XCTAssertEqual(outbox.shown.map(\.text), ["one"])
        XCTAssertEqual(outbox.items[0].failed, "Clip.mov can no longer be read: take it back and add it again")
        outbox.detach(outbox.items[0].id)
        XCTAssertNil(outbox.items[0].reply)
        // the one after it went on and is done here
        XCTAssertEqual(outbox.items.map(\.text), ["one"])
        // a reply he stopped himself: the video goes up no more
        outbox.add(QueuedMessage(text: "three", videos: [up("Third.mov", "c3")], reply: "r3"))
        outbox.drop(outbox.items[1].id)
        XCTAssertEqual(outbox.items.map(\.text), ["one"])
    }

    func testAWaitingReplyAndItsVideosRead() throws {
        // GET /api/assistant on the test server while the phone's video went up and two more messages had been
        // sent (its earlier messages and earlier chats cut): the video's message, its held reply, the two behind it
        let view = try view(#"""
        {"id":"3441cbd5-c2c7-4ca9-b10f-1cddb2cad321","provider":"claude","aiName":"Claude Code","tools":true,"messages":[{"id":"1c67357d-ad25-499d-80d1-650730470e78","role":"user","text":"One with a clip","at":1794448591618,"files":[{"id":"46a70c3e-cc07-4ee9-86f1-0d6321e4f373","name":"Tiny clip A.mp4","uploading":true}]},{"id":"294c7820-b888-4028-a7ba-c511b911c298","role":"assistant","text":"","at":1794448591619,"status":"thinking","wait":{"for":"videos","videos":1,"text":"Waiting for a video to upload"}},{"id":"70254445-cad4-45a8-9455-852a22777529","role":"user","text":"Two","at":1794448591807},{"id":"9c402a25-2a27-44e6-810b-5bf0b20ea024","role":"assistant","text":"","at":1794448591808,"status":"thinking","wait":{"for":"reply","text":"Waiting for the reply before it"}},{"id":"1270f08a-cc76-44af-b01e-ff0ecd8a5fe3","role":"user","text":"Three","at":1794448591993},{"id":"299c8ee6-c18f-446c-b7d8-81bb704f8a1f","role":"assistant","text":"","at":1794448591994,"status":"thinking","wait":{"for":"reply","text":"Waiting for the reply before it"}}],"past":[],"pending":null,"navigate":null,"sendNow":true}
        """#)
        XCTAssertEqual(view.messages[0].files?.map(\.uploading), [true])
        XCTAssertEqual(view.messages.compactMap(\.wait?.text),
                       ["Waiting for a video to upload", "Waiting for the reply before it", "Waiting for the reply before it"])
        // none is being written: the working line is about the first that waits, and counts nothing
        XCTAssertEqual(view.thinking?.id, "294c7820-b888-4028-a7ba-c511b911c298")
        XCTAssertEqual(view.asked(view.messages[3]), 1794448591807)
        XCTAssertTrue(view.sendNow)
        // an older server sends none of it: the phone holds a message until its videos are up
        let older = try self.view(Self.seeded)
        XCTAssertFalse(older.sendNow)
        XCTAssertNil(older.messages[3].files?.first?.uploading)
        XCTAssertNil(older.messages[1].wait)
        // a video still going up is named by the id the server gave it
        let body = AssistantModel.body(QueuedMessage(text: "Caption this", files: [.init(id: "f2", name: "Pier.mov")],
                                                     videos: [.init(name: "Beach.mov", copy: "c1", file: "f1")]))
        XCTAssertEqual(body["files"] as? [String], ["f2", "f1"])
        // its videos go on up after the reply: a server that knows it starts the reply at once
        XCTAssertEqual(body["later"] as? Bool, true)
        XCTAssertNil(AssistantModel.body(QueuedMessage(text: "Done", files: [.init(id: "f2", name: "Pier.mov")]))["later"])
        XCTAssertFalse(older.videosLater)
    }

    // MARK: The model against a server that waits (the stand-in answers as the test server did: SEND-NOW.md)

    /// A server stood in for the real one. It keeps the chat and answers each call with the whole view, in
    /// the shapes captured from the test server: a message whose video is not in yet has `uploading`, its
    /// reply a `wait`, a reply behind another waits for it, and a stopped waiting reply ends as "*Stopped.*".
    @MainActor private final class Stand {
        var messages: [[String: Any]] = []
        /// What each `POST /turn` carried.
        var turns: [[String: Any]] = []
        /// The reply each `POST /stop` named.
        var stops: [String] = []
        /// Uploads begun and not all in yet.
        var missing: Set<String> = []

        var view: Data {
            try! JSONSerialization.data(withJSONObject: [
                "id": "3441cbd5-c2c7-4ca9-b10f-1cddb2cad321", "provider": "claude", "aiName": "Claude Code", "tools": true,
                "messages": messages, "past": [], "sendNow": true,
            ] as [String: Any])
        }

        /// A message and its reply, as the server files them: "u1" and "r1", "u2" and "r2"…
        func take(_ text: String, files: [String] = []) {
            let n = messages.count / 2 + 1
            var user: [String: Any] = ["id": "u\(n)", "role": "user", "text": text, "at": 1794444151905 + n]
            if !files.isEmpty {
                user["files"] = files.map { id -> [String: Any] in
                    missing.contains(id) ? ["id": id, "name": "Clip.mov", "uploading": true] : ["id": id, "name": "Clip.mov"]
                }
            }
            messages += [user, ["id": "r\(n)", "role": "assistant", "text": "", "at": 1794444151906 + n, "status": "thinking"]]
            settle()
        }

        /// The last part of a video landed: the server joins it and its reply may start.
        func arrived(_ file: String) {
            missing.remove(file)
            for index in messages.indices {
                guard var files = messages[index]["files"] as? [[String: Any]] else { continue }
                for at in files.indices where files[at]["id"] as? String == file { files[at]["uploading"] = nil }
                messages[index]["files"] = files
            }
            settle()
        }

        /// Who waits for what: the first open reply for its videos (or nothing: it is being written), the rest for it.
        private func settle() {
            var first = true
            for index in messages.indices where messages[index]["status"] as? String == "thinking" {
                let videos = (messages[index - 1]["files"] as? [[String: Any]] ?? []).filter { $0["uploading"] != nil }.count
                if !first {
                    messages[index]["wait"] = ["for": "reply", "text": "Waiting for the reply before it"]
                } else if videos > 0 {
                    messages[index]["wait"] = ["for": "videos", "videos": videos, "text": "Waiting for a video to upload"]
                } else {
                    messages[index]["wait"] = nil
                }
                first = false
            }
        }

        func call(_ path: String, _ method: String, _ json: Any?) throws -> Data {
            let body = json as? [String: Any] ?? [:]
            switch (method, path) {
            case ("POST", "/api/assistant/turn"):
                turns.append(body)
                take(body["text"] as? String ?? "", files: body["files"] as? [String] ?? [])
            case ("POST", "/api/assistant/stop"):
                let named = body["reply"] as? String
                guard let index = messages.firstIndex(where: {
                    $0["status"] as? String == "thinking" && (named == nil || $0["id"] as? String == named)
                }) else { throw ToolsetAPI.Failure(status: 404, message: "Nothing is running") }
                stops.append(named ?? "")
                messages[index]["status"] = "done"
                messages[index]["text"] = "*Stopped.*"
                messages[index]["wait"] = nil
                settle()
            default:
                break
            }
            return view
        }

        /// The model's way to it. A video gets the id "f-<its copy>"; `send` says how its parts go.
        func server(queue: URL? = nil,
                    send: @escaping @MainActor (QueuedMessage.Video) async throws -> Void = { _ in }) -> AssistantServer {
            AssistantServer(queue: queue, call: { @MainActor [self] path, method, json in
                try call(path, method, json)
            }, uploader: .init(begin: { @MainActor [self] video in
                missing.insert("f-" + video.copy)
                return "f-" + video.copy
            }, send: { @MainActor [self] video, _, _ in
                try await send(video)
                arrived(video.file ?? "")
                return video.file ?? ""
            }))
        }
    }

    private func until(_ what: String, _ done: () -> Bool) async {
        for _ in 0..<500 where !done() { try? await Task.sleep(for: .milliseconds(10)) }
        XCTAssertTrue(done(), what)
    }

    func testTheModelSendsAMessageWhileItsVideoGoesUpAndTheNextOnesStraightAfter() async {
        let stand = Stand()
        let parts = Gate()
        let model = AssistantModel()
        model.server = { stand.server(send: { _ in await parts.pass() }) }
        await model.load()
        model.send(QueuedMessage(text: "One with a clip", videos: [up("Clip.mov", "c1")]))
        model.send(QueuedMessage(text: "Two"))
        model.send(QueuedMessage(text: "Three"))
        await until("all three went") { stand.turns.count == 3 && model.view?.messages.count == 6 && model.outbox.items.count == 1 }
        // in the order sent, the first naming its video by the id the server gave it, and that video still going up
        XCTAssertEqual(stand.turns.map { $0["text"] as? String }, ["One with a clip", "Two", "Three"])
        XCTAssertEqual(stand.turns.map { $0["files"] as? [String] ?? [] }, [["f-c1"], [], []])
        XCTAssertNotNil(parts.waiting)
        // the conversation shows them, each reply with what it waits for; nothing is drawn twice
        XCTAssertTrue(model.outbox.shown.isEmpty)
        XCTAssertEqual(model.view?.messages.compactMap(\.wait?.text),
                       ["Waiting for a video to upload", "Waiting for the reply before it", "Waiting for the reply before it"])
        XCTAssertEqual(model.view?.messages[0].files?.first?.uploading, true)
        // the first stays on the phone only for its video, under its reply's id
        XCTAssertEqual(model.outbox.items.map(\.reply), ["r1"])
        // the working line is about the first one that waits, until one is being written
        XCTAssertEqual(model.view?.thinking?.id, "r1")
        // the last part lands: its reply starts, and nothing of it is left on the phone
        parts.open()
        await until("the video is up") { model.outbox.items.isEmpty }
        await model.load()
        XCTAssertNil(model.view?.messages[0].files?.first?.uploading)
        XCTAssertNil(model.view?.messages[1].wait)
        XCTAssertEqual(model.view?.thinking?.id, "r1")
        XCTAssertEqual(model.view.flatMap { $0.asked($0.messages[3]) }, model.view?.messages[2].at)
        XCTAssertEqual(stand.turns.count, 3)
    }

    func testAMessageTheServerAlreadyTookIsNotSentAgain() async {
        // the app was closed while the video went up: the message is in the chat, its reply waits
        let stand = Stand()
        stand.missing = ["f-c1"]
        stand.take("One with a clip", files: ["f-c1"])
        let file = scratch()
        let before = AssistantOutbox()
        before.open(file)
        before.add(QueuedMessage(text: "One with a clip", videos: [.init(name: "Clip.mov", copy: "c1", file: "f-c1")], reply: "r1"))
        var resumed: [String?] = []
        let model = AssistantModel()
        model.server = { stand.server(queue: file, send: { resumed.append($0.file) }) }
        await model.load()
        await until("the video is up") { model.outbox.items.isEmpty }
        // it carried on with the same upload, and nothing was sent a second time
        XCTAssertEqual(resumed, ["f-c1"])
        XCTAssertTrue(stand.turns.isEmpty)

        // the answer to a send was lost on the way: the message is in the chat, the phone still holds it as unsent
        let lost = Stand()
        lost.missing = ["f-c2"]
        lost.take("Two with a clip", files: ["f-c2"])
        let parts = Gate()
        let again = AssistantModel()
        again.server = { lost.server(send: { _ in await parts.pass() }) }
        again.outbox.add(QueuedMessage(text: "Two with a clip", videos: [.init(name: "Clip.mov", copy: "c2", file: "f-c2")], triedAfter: ""))
        await again.load()
        await until("it is known as taken") { again.outbox.items.first?.reply == "r1" }
        XCTAssertTrue(lost.turns.isEmpty)
        XCTAssertTrue(again.outbox.shown.isEmpty)
        parts.open()
        await until("its video is up") { again.outbox.items.isEmpty }

        // its reply ended meanwhile (stopped on the computer): its video goes up no more
        let ended = Stand()
        ended.missing = ["f-c3"]
        ended.take("Three with a clip", files: ["f-c3"])
        _ = try? ended.call("/api/assistant/stop", "POST", ["reply": "r1"])
        let third = AssistantModel()
        third.server = { ended.server(send: { _ in XCTFail("went up for a reply that ended") }) }
        third.outbox.add(QueuedMessage(text: "Three with a clip", videos: [.init(name: "Clip.mov", copy: "c3", file: "f-c3")], reply: "r1"))
        await third.load()
        XCTAssertTrue(third.outbox.items.isEmpty)
        XCTAssertTrue(ended.turns.isEmpty)
    }

    func testTheCrossStopsAWaitingReplyByItsIdAndTheNextOneGoesOn() async {
        let stand = Stand()
        let parts = Gate()
        var cancelled = false
        let model = AssistantModel()
        model.server = { stand.server(send: { _ in
            await parts.pass()
            cancelled = Task.isCancelled
            try Task.checkCancellation()
        }) }
        await model.load()
        model.send(QueuedMessage(text: "One with a clip", videos: [up("Clip.mov", "c1")]))
        model.send(QueuedMessage(text: "Two"))
        await until("both went") { stand.turns.count == 2 && parts.waiting != nil }
        await model.stop(reply: "r1")
        // that reply, by its id; his message stays in the chat and its video goes up no more
        XCTAssertEqual(stand.stops, ["r1"])
        XCTAssertEqual(model.view?.messages.map(\.text), ["One with a clip", "*Stopped.*", "Two", ""])
        XCTAssertEqual(model.view?.messages[1].status, "done")
        XCTAssertTrue(model.outbox.items.isEmpty)
        parts.open()
        await until("its upload was stopped") { cancelled }
        // the one behind it is being written now
        XCTAssertEqual(model.view?.thinking?.id, "r2")
        XCTAssertNil(model.view?.thinking?.wait)
        // a reply that has ended already: nothing to say
        await model.stop(reply: "r1")
        XCTAssertNil(model.error)
    }

    func testAVideoThatFailsStopsItsHeldReplyAndTheMessageComesBackAsNotSent() async {
        let stand = Stand()
        let parts = Gate()
        let model = AssistantModel()
        model.server = { stand.server(send: { _ in
            await parts.pass()
            throw AssistantUpload.Unreadable(name: "Clip.mov")
        }) }
        await model.load()
        model.send(QueuedMessage(text: "One with a clip", videos: [up("Clip.mov", "c1")]))
        model.send(QueuedMessage(text: "Two"))
        await until("both went") { stand.turns.count == 2 && parts.waiting != nil }
        parts.open()
        await until("its reply was stopped") { stand.stops == ["r1"] && model.outbox.items.first?.reply == nil }
        // the phone's again, marked, with Try again; the one behind it went on
        XCTAssertEqual(model.outbox.shown.map(\.text), ["One with a clip"])
        XCTAssertEqual(model.outbox.items.first?.failed, "Clip.mov can no longer be read: take it back and add it again")
        XCTAssertEqual(model.view?.messages.map(\.text), ["One with a clip", "*Stopped.*", "Two", ""])
        XCTAssertNil(model.view?.thinking?.wait)
    }

    // MARK: A video goes up from the moment it is picked

    func testAPickedVideoGoesUpBeforeItIsSentAndKeepsItsUploadWhenItIs() async {
        let stand = Stand()
        let parts = Gate()
        var sends = 0
        let model = AssistantModel()
        model.server = { stand.server(send: { _ in
            sends += 1
            await parts.pass()
        }) }
        await model.load()
        // picked: it has the server's id and its parts are going, and nothing is sent
        model.draft.pretend(pictures: [], videos: [up("Clip.mov", "c1")])
        await until("it goes up from the box") { parts.waiting != nil }
        XCTAssertEqual(model.draft.videos.map(\.file), ["f-c1"])
        XCTAssertTrue(stand.turns.isEmpty)
        // Send: the message goes at once with that id, and the upload is the same one
        model.draft.text = "One with a clip"
        model.send(model.draft.take()!)
        await until("it went") { stand.turns.count == 1 && model.view?.messages.count == 2 }
        XCTAssertEqual(stand.turns[0]["files"] as? [String], ["f-c1"])
        XCTAssertEqual(model.view?.messages[1].wait?.text, "Waiting for a video to upload")
        parts.open()
        await until("the video is up") { model.outbox.items.isEmpty }
        XCTAssertEqual(sends, 1)

        // one that is up before he sends: the box names it by the server's id, and the reply waits for nothing
        model.draft.pretend(pictures: [], videos: [up("Other.mov", "c2")])
        await until("its parts go") { parts.waiting != nil }
        parts.open()
        await until("it is up in the box") { model.draft.files == [.init(id: "f-c2", name: "Other.mov")] }
        XCTAssertTrue(model.draft.videos.isEmpty)
        model.draft.text = "Two with a clip"
        model.send(model.draft.take()!)
        await until("it went") { stand.turns.count == 2 && model.view?.messages.count == 4 && model.outbox.items.isEmpty }
        XCTAssertEqual(stand.turns[1]["files"] as? [String], ["f-c2"])
        XCTAssertNil(model.view?.messages[2].files?.first?.uploading)
        XCTAssertTrue(model.outbox.items.isEmpty)
    }

    func testAVideoTakenOffTheBoxStopsGoingUp() async {
        let stand = Stand()
        let first = Gate()
        let second = Gate()
        var cancelled = false
        let model = AssistantModel()
        model.server = { stand.server(send: { video in
            guard video.copy == "c1" else { return await second.pass() }
            await first.pass()
            cancelled = Task.isCancelled
            try Task.checkCancellation()
        }) }
        await model.load()
        model.draft.pretend(pictures: [], videos: [up("Clip.mov", "c1"), up("Other.mov", "c2")])
        await until("the first goes up") { first.waiting != nil }
        model.draft.remove(video: model.draft.videos[0].id)
        // the one after it goes up at once
        await until("the next goes up") { second.waiting != nil }
        first.open()
        await until("its upload was stopped") { cancelled }
        XCTAssertEqual(model.draft.videos.map(\.name), ["Other.mov"])
        second.open()
        await until("it is up") { model.draft.files.map(\.id) == ["f-c2"] }
        XCTAssertTrue(stand.turns.isEmpty)
    }

    func testSendDoesNotWaitForPhotosToHandAVideoOver() async throws {
        let stand = Stand()
        let model = AssistantModel()
        model.server = { stand.server() }
        await model.load()
        // picked, and Photos is still handing it over (a big video, one in iCloud): Send empties the box all the same
        let coming = model.draft.expect()
        XCTAssertEqual(model.draft.videos.map(\.pending), [true])
        model.draft.text = "One with a clip"
        let message = try XCTUnwrap(model.draft.take())
        XCTAssertTrue(model.draft.isEmpty)
        model.send(message)
        model.send(QueuedMessage(text: "Two"))
        // it waits on the phone for its video, and the one behind it waits too
        for _ in 0..<20 { await Task.yield() }
        XCTAssertTrue(stand.turns.isEmpty)
        XCTAssertEqual(model.outbox.shown.map(\.text), ["One with a clip", "Two"])
        // Photos hands it over: it gets its name, goes up, and the message goes
        let picked = AssistantPickedVideo(url: AssistantPickedVideo.folder.appendingPathComponent("test-\(UUID().uuidString)/IMG_2041.MOV"))
        model.draft.handed(coming, picked)
        await until("both went") { stand.turns.count == 2 }
        XCTAssertEqual(stand.turns.map { $0["text"] as? String }, ["One with a clip", "Two"])
        XCTAssertEqual((stand.turns[0]["files"] as? [String])?.count, 1)
        await until("the video is up") { model.outbox.items.isEmpty }

        // one Photos could not hand over: the message is marked, without it, and the next one goes
        let lost = model.draft.expect()
        model.draft.text = "Three with a clip"
        model.send(try XCTUnwrap(model.draft.take()))
        model.send(QueuedMessage(text: "Four"))
        model.draft.handed(lost, nil)
        await until("the next went") { stand.turns.count == 3 && model.outbox.items.count == 1 }
        XCTAssertEqual(stand.turns[2]["text"] as? String, "Four")
        XCTAssertEqual(model.outbox.items.map(\.failed), ["A video could not be read: add it again"])
        XCTAssertNil(model.outbox.items[0].videos)
        // still in the box when Photos gives up: it leaves the box, which says so
        let boxed = model.draft.expect()
        model.draft.handed(boxed, nil)
        XCTAssertTrue(model.draft.videos.isEmpty)
        XCTAssertEqual(model.draft.notice, "A video could not be read")
    }

    func testAVideoStillComingFromPhotosWhenTheAppClosedIsSaidSo() throws {
        let file = scratch()
        let before = AssistantOutbox()
        before.open(file)
        before.add(QueuedMessage(text: "one", videos: [.coming(), .init(name: "Clip.mov", copy: "c1", file: "f1")]))
        before.add(QueuedMessage(text: "two"))
        // no hand-over is running after a restart: the message says so instead of waiting for ever
        let after = AssistantOutbox()
        after.open(file)
        XCTAssertEqual(after.items[0].failed, "A video was still coming from Photos when the app closed: add it again")
        XCTAssertEqual(after.items[0].videos?.map(\.name), ["Clip.mov"])
        XCTAssertNil(after.items[1].failed)
        // a queue saved before videos could be coming reads as it did
        XCTAssertEqual(AssistantOutbox.afterRestart(after.items[1]), after.items[1])
    }

    // MARK: Parts that iOS sends by itself

    func testAPartIsKnownToIOSByItsUploadAndNumber() {
        let part = AssistantTransfers.Part(upload: "1a810b3f-6b22-47b4-8f68-784209dd6dd3", number: 12)
        XCTAssertEqual(part.name, "1a810b3f-6b22-47b4-8f68-784209dd6dd3-12")
        XCTAssertEqual(AssistantTransfers.Part(name: part.name), part)
        XCTAssertEqual(part.file.lastPathComponent, part.name)
        XCTAssertTrue(part.file.path.contains("/Caches/assistant-parts/"))
        // a task that is not one of these
        XCTAssertNil(AssistantTransfers.Part(name: nil))
        XCTAssertNil(AssistantTransfers.Part(name: "something else"))
        XCTAssertNil(AssistantTransfers.Part(name: "-3"))
    }

    func testWhatAFinishedPartCameTo() {
        func came(_ status: Int, _ error: Error? = nil, _ answer: String = "", unanswered: Bool = false) -> Error? {
            AssistantTransfers.failure(status: status, error: error, answer: Data(answer.utf8), unanswered: unanswered)
        }
        // POST …/parts/1 on the test server: taken
        XCTAssertNil(came(200, nil, #"{"ok":true,"partNumber":1,"size":40}"#))
        // a part sent after the server joined the file, as the test server answered it: the sender then asks for the whole
        let late = came(409, nil, #"{"error":"No upload in progress"}"#) as? ToolsetAPI.Failure
        XCTAssertEqual(late?.status, 409)
        XCTAssertEqual(late?.message, "No upload in progress")
        // a busy server is tried again, and waits; no connection only waits
        XCTAssertEqual((came(503) as? ToolsetAPI.Failure)?.message, "Upload failed (HTTP 503)")
        XCTAssertTrue(AssistantUpload.waits(came(503)!))
        XCTAssertTrue(AssistantUpload.waits(came(0, URLError(.networkConnectionLost))!))
        // all of it sent and never answered, or out of time: Not sent, with the reason
        XCTAssertFalse(AssistantUpload.waits(came(0, URLError(.cancelled), unanswered: true)!))
        XCTAssertEqual(came(0, URLError(.timedOut))?.localizedDescription, "No answer from the server")
        // ended because the video was taken off: nothing to say
        XCTAssertTrue(came(0, URLError(.cancelled)) is CancellationError)
    }

    func testLeavingTheAppHandsIOSTheVideosThatHaveBegun() async {
        final class Seen { var handed: [[String]] = [] }
        let seen = Seen()
        let parts = Gate()
        let outbox = AssistantOutbox()
        outbox.add(QueuedMessage(text: "one", videos: [up("A.mov", "a"), up("B.mov", "b")]))
        outbox.add(QueuedMessage(text: "two", videos: [up("C.mov", "c")], failed: "No answer from the server"))
        outbox.add(QueuedMessage(text: "three", videos: [up("D.mov", "d")]))
        // nothing has gone up yet: nothing to hand over
        outbox.leave()
        outbox.upload(.init(begin: { video in
            if video.name == "D.mov" { throw ToolsetAPI.Failure(status: 0, message: "No connection") }
            return "id-" + video.copy
        }, send: { video, _, _ in
            await parts.pass()
            return video.file ?? ""
        }, handOver: { @MainActor videos in seen.handed.append(videos.compactMap(\.file)) }), moved: {})
        while parts.waiting == nil || outbox.items[0].videos?.allSatisfy({ $0.file != nil }) != true { await Task.yield() }
        outbox.leave()
        while seen.handed.isEmpty { await Task.yield() }
        // the ones with the server's id, oldest first: not a Not sent message's, not one that has no id yet
        XCTAssertEqual(seen.handed, [["id-a", "id-b"]])
        parts.open()
        while parts.waiting == nil { await Task.yield() }
        parts.open()
        await outbox.settled()
    }

    // MARK: What goes with a message

    func testAPhonePhotoBecomesASmallJPEG() throws {
        // a 12 MP photo, upright as the camera holds it, in the camera's own format when the simulator can write it
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        let size = CGSize(width: 3024, height: 4032)
        let photo = UIGraphicsImageRenderer(size: size, format: format).image { context in
            for band in 0..<16 {
                UIColor(hue: CGFloat(band) / 16, saturation: 0.8, brightness: 0.9, alpha: 1).setFill()
                context.fill(CGRect(x: 0, y: CGFloat(band) * 252, width: size.width, height: 252))
            }
        }
        let original = try XCTUnwrap(photo.heicData() ?? photo.pngData())
        let jpeg = try XCTUnwrap(AssistantPicture.jpeg(from: original))
        XCTAssertEqual(Array(jpeg.prefix(3)), [0xFF, 0xD8, 0xFF])
        XCTAssertLessThan(jpeg.count, 8 * 1024 * 1024)
        let pixels = try XCTUnwrap(UIImage(data: jpeg)?.cgImage)
        XCTAssertEqual(max(pixels.width, pixels.height), 2000)
        XCTAssertEqual(min(pixels.width, pixels.height), 1500)
        XCTAssertGreaterThan(pixels.height, pixels.width)
        // a small picture is not blown up, and something that is no picture is refused
        let small = UIGraphicsImageRenderer(size: CGSize(width: 320, height: 200), format: format).image { _ in }
        let kept = try XCTUnwrap(AssistantPicture.jpeg(from: try XCTUnwrap(small.pngData())).flatMap(UIImage.init(data:))?.cgImage)
        XCTAssertEqual([kept.width, kept.height], [320, 200])
        XCTAssertNil(AssistantPicture.jpeg(from: Data("not a picture".utf8)))
    }

    func testAVideoIsCutIntoParts() throws {
        // POST /api/assistant/files on the test server (fixtures/assistant-file-start.json): the server names the part size
        struct Started: Decodable {
            let id: String
            let partSize: Int
        }
        let part = try JSONDecoder().decode(Started.self, from: Data(#"{"id":"1a810b3f-6b22-47b4-8f68-784209dd6dd3","partSize":16777216}"#.utf8)).partSize
        XCTAssertEqual(part, 16 * 1024 * 1024)
        // the 206 kB clip uploaded there: one part, the whole file
        XCTAssertEqual(AssistantUpload.partCount(total: 206_330, partSize: part), 1)
        XCTAssertEqual(AssistantUpload.partLength(1, total: 206_330, partSize: part), 206_330)
        // 40 MB: two full parts and the rest
        let total = 40 * 1024 * 1024
        XCTAssertEqual(AssistantUpload.partCount(total: total, partSize: part), 3)
        XCTAssertEqual((1...3).map { AssistantUpload.partLength($0, total: total, partSize: part) }, [part, part, 8 * 1024 * 1024])
        // exactly two parts: no empty third
        XCTAssertEqual(AssistantUpload.partCount(total: 2 * part, partSize: part), 2)
        XCTAssertEqual(AssistantUpload.partLength(2, total: 2 * part, partSize: part), part)
        // smaller than a part, and one byte over
        XCTAssertEqual(AssistantUpload.partCount(total: 70_000, partSize: part), 1)
        XCTAssertEqual(AssistantUpload.partLength(1, total: 70_000, partSize: part), 70_000)
        XCTAssertEqual(AssistantUpload.partCount(total: part + 1, partSize: part), 2)
        XCTAssertEqual(AssistantUpload.partLength(2, total: part + 1, partSize: part), 1)
        // the parts add up to the file, whatever its size
        for total in [1, part - 1, part, 3 * part + 12_345] {
            let count = AssistantUpload.partCount(total: total, partSize: part)
            XCTAssertEqual((1...count).reduce(0) { $0 + AssistantUpload.partLength($1, total: total, partSize: part) }, total)
        }
        XCTAssertEqual(AssistantUpload.partCount(total: 0, partSize: part), 0)
    }
}
