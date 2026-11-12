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
        XCTAssertEqual(after.items.last?.attached, "Clip.mov")

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
