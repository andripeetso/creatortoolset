import AVFoundation
import AppKit
import XCTest
@testable import CreatorToolsetMac

/// A made-up script for every card of a made-up version: the card's words on a colour that changes with time. A card
/// whose text is "throw", "loop" or "blank" does that instead, so one step can hold cards that fail in each way.
private let fixtureScript = """
function kitFrame(t, card) {
  if (card.text === 'throw') throw new Error('no such font');
  if (card.text === 'loop') while (true) {}
  if (card.text === 'blank') return;
  const stage = document.getElementById('stage');
  stage.style.background = 'rgb(' + Math.round(200 * t) + ',80,160)';
  stage.textContent = card.text;
}
"""

/// The drawing of an edit's cards against a stand-in server that speaks the device routes: the claim, the read, the
/// draw, the clip and the upload, and each way a step can end.
final class CardJobsTests: XCTestCase {
    private let token = "ctd_test-token"

    private func temp() -> URL {
        let dir = testFolder("card-jobs")
        addTeardownBlock { try? FileManager.default.removeItem(at: dir) }
        return dir
    }

    private func sheet(_ texts: [String], width: Int = 320, height: Int = 568, fps: Double = 12, seconds: Double = 0.5, script: String = fixtureScript) -> String {
        let cards = texts.enumerated().map { ["id": "c\($0 + 1)", "seconds": seconds, "content": ["id": "c\($0 + 1)", "text": $1, "line": "l\($0 + 1)"]] as [String: Any] }
        let all: [String: Any] = ["width": width, "height": height, "fps": fps, "script": script, "cards": cards]
        return String(decoding: try! JSONSerialization.data(withJSONObject: all), as: UTF8.self)
    }

    /// A server that hands out step 7 with these cards and takes everything.
    private func site(_ cards: String, beat: String = #"{"ok":true}"#) -> FakeSite {
        let site = FakeSite()
        site.answer = { request in
            if request.path.hasSuffix("/job/7/cards") { return (200, cards) }
            if request.path.hasSuffix("/beat") { return (200, beat) }
            return (200, #"{"ok":true}"#)
        }
        return site
    }

    /// A step runs on a thread of its own, never the main one (the drawing hops there).
    private func offMain<T>(_ work: @escaping () -> T) async -> T {
        await withCheckedContinuation { c in DispatchQueue.global().async { c.resume(returning: work()) } }
    }

    private func run(_ site: FakeSite, limit: TimeInterval = KitRunner.cardLimit, beatEvery: TimeInterval = 15) async -> (end: CardJob.End, folder: URL) {
        let folder = temp().appendingPathComponent("cards/7")
        var job = CardJob(api: DeviceAPI(base: site.url, token: token), id: 7, folder: folder)
        job.limit = limit
        job.beatEvery = beatEvery
        let ready = job
        return (await offMain { ready.run().end }, folder)
    }

    private func paths(_ site: FakeSite) -> [String] { site.requests.map { "\($0.method) \($0.path)" } }
    private let base = "/api/devices/relay/editor/job/7"

    // MARK: the card list

    func testTheCardListIsCheckedBeforeAnythingIsDrawn() throws {
        let good = try CardSheet(json: Data(sheet(["Tiny Acrobatics", "Second card"], fps: 29.97).utf8))
        XCTAssertEqual(good.width, 320)
        XCTAssertEqual(good.fps, 29.97)
        XCTAssertEqual(good.cards.map(\.id), ["c1", "c2"])
        XCTAssertEqual(good.cards[1].content["text"] as? String, "Second card")
        // content is handed to the script as the server sent it, numbers and nested values included
        let rich = try CardSheet(json: Data(#"{"width":320,"height":568,"fps":30,"script":"x","cards":[{"id":5,"seconds":1,"content":{"n":3,"tags":["a"]}}]}"#.utf8))
        XCTAssertEqual(rich.cards[0].id, "5")
        XCTAssertEqual(rich.cards[0].content["n"] as? Int, 3)

        func refused(_ json: String, _ words: String, line: UInt = #line) {
            XCTAssertThrowsError(try CardSheet(json: Data(json.utf8)), line: line) { error in
                guard case CardJobError.sheet(let why) = error else { return XCTFail("\(error)", line: line) }
                XCTAssertTrue(why.contains(words), why, line: line)
            }
        }
        refused("not json", "not a card list")
        refused(sheet(["a"], width: 321), "even numbers")
        refused(sheet(["a"], height: 5000), "even numbers")
        refused(sheet(["a"], fps: 0), "frame rate")
        refused(sheet(["a"], fps: 500), "frame rate")
        refused(sheet(["a"], seconds: 0), "length")
        refused(sheet(["a"], seconds: 31), "length")
        refused(sheet(["a"], script: ""), "no script")
        refused(sheet([]), "1 to 24 cards")
        refused(sheet(Array(repeating: "a", count: 25)), "1 to 24 cards")
        refused(#"{"width":320,"height":568,"fps":30,"script":"x","cards":[{"seconds":1}]}"#, "no id")
        refused(sheet(["a"], script: String(repeating: "x", count: CardSheet.maxBytes)), "over 2 MB")
    }

    func testAFormBodyHoldsItsFilesInOrder() {
        let body = multipartBody([FormPart(name: "clip", filename: "card.mp4", type: "video/mp4", data: Data([0, 13, 10, 45, 45, 255])),
                                  FormPart(name: "still", filename: "first.png", type: "image/png", data: Data("png".utf8))], boundary: "b1")
        let head = "--b1\r\nContent-Disposition: form-data; name=\"clip\"; filename=\"card.mp4\"\r\nContent-Type: video/mp4\r\n\r\n"
        XCTAssertEqual(body.prefix(head.utf8.count), Data(head.utf8))
        XCTAssertEqual(body.suffix(10), Data("\r\n--b1--\r\n".utf8))
        let parts = readMultipart(body, contentType: "multipart/form-data; boundary=b1")
        XCTAssertEqual(parts.map(\.name), ["clip", "still"])
        XCTAssertEqual(parts[0].data, Data([0, 13, 10, 45, 45, 255]))   // bytes that look like a line end or a boundary stay as they are
        XCTAssertEqual(parts[1].filename, "first.png")
        XCTAssertEqual(parts[1].type, "image/png")
    }

    // MARK: one step

    func testAStepIsReadDrawnSentAndDone() async throws {
        let site = site(sheet(["Tiny Acrobatics", "Second card"]))
        let (end, folder) = await run(site)
        XCTAssertEqual(end, .done)
        XCTAssertEqual(paths(site), ["GET \(base)/cards", "POST \(base)/cards/c1", "POST \(base)/cards/c2", "POST \(base)/done"])
        for request in site.requests {
            XCTAssertEqual(request.headers["authorization"], "Bearer \(token)")
        }
        XCTAssertTrue(site.requests[0].body.isEmpty, "the read is a plain GET")
        XCTAssertFalse(FileManager.default.fileExists(atPath: folder.path), "nothing of the step is left on this Mac")

        let upload = site.requests[1]
        let parts = readMultipart(upload.body, contentType: upload.headers["content-type"] ?? "")
        XCTAssertEqual(parts.map(\.name), ["clip", "still", "still", "still"])
        XCTAssertEqual(parts.map(\.filename), ["card.mp4", "first.png", "middle.png", "last.png"])
        XCTAssertEqual(parts.map(\.type), ["video/mp4", "image/png", "image/png", "image/png"])

        // the clip: H.264, the card's size and rate, every frame, no sound
        let clip = temp().appendingPathComponent("c1.mp4")
        try parts[0].data.write(to: clip)
        let asset = AVURLAsset(url: clip)
        let videos = try await asset.loadTracks(withMediaType: .video)
        XCTAssertEqual(videos.count, 1)
        let sound = try await asset.loadTracks(withMediaType: .audio)
        XCTAssertTrue(sound.isEmpty)
        let track = try XCTUnwrap(videos.first)
        let size = try await track.load(.naturalSize)
        XCTAssertEqual(size, CGSize(width: 320, height: 568))
        let rate = try await track.load(.nominalFrameRate)
        XCTAssertEqual(rate, 12, accuracy: 0.01)
        let length = try await asset.load(.duration).seconds
        XCTAssertEqual(length, 0.5, accuracy: 0.001)
        let formats = try await track.load(.formatDescriptions)
        let format = try XCTUnwrap(formats.first)
        XCTAssertEqual(CMFormatDescriptionGetMediaSubType(format), kCMVideoCodecType_H264)

        // the stills: PNG, 540 px wide, and the last one later in the card than the first (its red has grown)
        let stills = try parts.dropFirst().map { try XCTUnwrap(NSBitmapImageRep(data: $0.data)) }
        for still in stills {
            XCTAssertEqual(still.pixelsWide, 540)
            XCTAssertEqual(still.pixelsHigh, 959)   // 568 × 540 / 320, rounded
        }
        let red = try stills.map { try XCTUnwrap($0.colorAt(x: 500, y: 900)).redComponent * 255 }
        XCTAssertLessThan(red[0], 6)
        XCTAssertGreaterThan(red[2], red[1])
        XCTAssertGreaterThan(red[1], red[0])
    }

    func testACardThatFailsIsNamedAndTheOthersAreStillSent() async {
        let site = site(sheet(["Tiny Acrobatics", "throw", "blank", "Fourth card"]))
        let (end, _) = await run(site)
        XCTAssertEqual(paths(site), ["GET \(base)/cards", "POST \(base)/cards/c1", "POST \(base)/cards/c4", "POST \(base)/fail"])
        guard case .failed(let why) = end else { return XCTFail("\(end)") }
        XCTAssertEqual(why, "Card 2 of 4 has a script that failed (Error: no such font). Card 3 of 4 drew nothing.")
        let told = (try? JSONSerialization.jsonObject(with: site.requests[3].body)) as? [String: Any]
        XCTAssertEqual(told?["error"] as? String, why)
    }

    func testACardPastItsTimeFailsThatCardAndTheNextStillDraws() async {
        let site = site(sheet(["loop", "After the loop"]))
        let started = Date()
        let (end, _) = await run(site, limit: 2)
        XCTAssertEqual(paths(site), ["GET \(base)/cards", "POST \(base)/cards/c2", "POST \(base)/fail"])
        XCTAssertEqual(end, .failed("Card 1 of 2 took longer than 2 seconds to draw."))
        XCTAssertLessThan(Date().timeIntervalSince(started), 12, "the step went on once the limit passed")
    }

    func testAStepTakenBackStopsWithoutAnAnswer() async {
        // the server says the step is no longer this Mac's: nothing more is drawn or sent, not even done or fail
        let site = site(sheet(["One", "Two", "Three", "Four", "Five", "Six"], fps: 30, seconds: 2), beat: #"{"ok":false}"#)
        let (end, folder) = await run(site, beatEvery: 0.2)
        XCTAssertEqual(end, .gone)
        XCTAssertFalse(paths(site).contains("POST \(base)/done"))
        XCTAssertFalse(paths(site).contains("POST \(base)/fail"))
        XCTAssertFalse(paths(site).contains("POST \(base)/cards/c6"))
        XCTAssertFalse(FileManager.default.fileExists(atPath: folder.path))
    }

    func testAStepKeepsItsLeaseWhileItWorks() async {
        let site = site(sheet(["One", "Two", "Three"], fps: 30, seconds: 2))
        let (end, _) = await run(site, beatEvery: 0.2)
        XCTAssertEqual(end, .done)
        XCTAssertTrue(paths(site).contains("POST \(base)/beat"))
        XCTAssertEqual(paths(site).last, "POST \(base)/done")
    }

    func testAServerThatCannotGiveTheCardsFailsTheStepInWords() async {
        let missing = FakeSite()
        missing.answer = { $0.path.hasSuffix("/cards") ? (404, #"{"error":"Not found"}"#) : (200, #"{"ok":true}"#) }
        let (end, _) = await run(missing)
        XCTAssertEqual(end, .failed("This edit's cards could not be read from the server (HTTP 404)."))
        XCTAssertEqual(paths(missing), ["GET \(base)/cards", "POST \(base)/fail"])

        let odd = site(#"{"width":321,"height":568,"fps":12,"script":"x","cards":[{"id":"c1","seconds":1}]}"#)
        let (refused, _) = await run(odd)
        XCTAssertEqual(refused, .failed("This edit's cards can't be drawn on this Mac: the picture size must be even numbers from 16 to 4096."))
        XCTAssertEqual(paths(odd), ["GET \(base)/cards", "POST \(base)/fail"])
    }

    func testACardTheServerRefusesFailsTheStep() async {
        let site = FakeSite()
        let cards = sheet(["Tiny Acrobatics", "Second card"])
        site.answer = { request in
            if request.path.hasSuffix("/job/7/cards") { return (200, cards) }
            if request.path.hasSuffix("/cards/c1") { return (413, #"{"error":"Too large"}"#) }
            return (200, #"{"ok":true}"#)
        }
        let (end, _) = await run(site)
        XCTAssertEqual(end, .failed("Card 1 of 2 could not be sent to the server (HTTP 413)."))
        XCTAssertEqual(paths(site), ["GET \(base)/cards", "POST \(base)/cards/c1", "POST \(base)/cards/c2", "POST \(base)/fail"])
    }

    func testACardIdIsSafeInTheAddress() async {
        let site = FakeSite()
        site.answer = { request in
            request.path.hasSuffix("/job/7/cards")
                ? (200, #"{"width":320,"height":568,"fps":12,"script":"function kitFrame(t, card) { document.getElementById('stage').textContent = card.text }","cards":[{"id":"a/b ?#","seconds":0.25,"content":{"text":"Tiny Acrobatics"}}]}"#)
                : (200, #"{"ok":true}"#)
        }
        let (end, _) = await run(site)
        XCTAssertEqual(end, .done)
        XCTAssertEqual(paths(site)[1], "POST \(base)/cards/a%2Fb%20%3F%23")
    }

    // MARK: the claim

    private final class Seen: @unchecked Sendable {
        private let lock = NSLock()
        private var all: [AIStatus] = []
        func add(_ status: AIStatus) { lock.lock(); all.append(status); lock.unlock() }
        var statuses: [AIStatus] { lock.lock(); defer { lock.unlock() }; return all }
    }

    private func runner(_ site: FakeSite, seen: Seen = Seen()) -> RelayRunner {
        let dir = temp()
        return RelayRunner(base: site.url, token: token, work: dir.appendingPathComponent("relay"), home: dir, onStatus: { seen.add($0) }, onRevoked: {})
    }

    private final class Flag: @unchecked Sendable {
        private let lock = NSLock()
        private var on = false
        var isSet: Bool { lock.lock(); defer { lock.unlock() }; return on }
        /// Sets it; true the first time only.
        @discardableResult func set() -> Bool { lock.lock(); defer { lock.unlock() }; let first = !on; on = true; return first }
    }

    /// The runner's own long-poll loop on a thread of its own, until `until` says so or `seconds` pass, then stopped.
    /// True when the loop ended in time: a deadline, never a join, so a loop that hangs fails the test and holds nothing.
    private func serving(_ runner: RelayRunner, upTo seconds: Double, until: @escaping () -> Bool = { false }) async -> Bool {
        let ended = Flag()
        DispatchQueue.global().async {
            runner.serve()
            ended.set()
        }
        let deadline = Date().addingTimeInterval(seconds)
        while Date() < deadline, !until() { try? await Task.sleep(nanoseconds: 20_000_000) }
        runner.stop()
        let limit = Date().addingTimeInterval(4)
        while Date() < limit, !ended.isSet { try? await Task.sleep(nanoseconds: 20_000_000) }
        return ended.isSet
    }

    private let poll = "POST /api/devices/relay/wait"
    private let claim = "POST /api/devices/relay/editor/claim"
    private func json(_ request: FakeSite.Request) -> NSDictionary? { (try? JSONSerialization.jsonObject(with: request.body)) as? NSDictionary }

    func testAServerThatSendsNoHintCostsNoRequestAtAll() async {
        // every server today: the long poll is answered 204 (nothing waits) and knows nothing of a hint
        let site = FakeSite()
        site.answer = { _ in
            Thread.sleep(forTimeInterval: 0.03)
            return (204, "")
        }
        let seen = Seen()
        let ended = await serving(runner(site, seen: seen), upTo: 0.8)
        XCTAssertTrue(ended)
        XCTAssertGreaterThan(site.requests.count, 5, "the loop polled many times")
        for request in site.requests {
            // the same request the app sends today, to the same address; the one thing new is a field in its body
            XCTAssertEqual("\(request.method) \(request.path)", poll)
            XCTAssertEqual(json(request), ["blobs": true, "editor": ["cards-draw"]])
        }
        XCTAssertTrue(seen.statuses.isEmpty, "and nothing a person sees changes")
    }

    func testAHintOnTheLongPollIsClaimedDrawnAndDone() async {
        let cards = sheet(["Tiny Acrobatics", "Second card"])
        let site = FakeSite()
        let hinted = Flag()
        site.answer = { request in
            if request.path.hasSuffix("/relay/wait") {
                let lists = ((try? JSONSerialization.jsonObject(with: request.body)) as? [String: Any])?["editor"] as? [String] ?? []
                // the server's side of it: a step of a listed kind waits, said once, on a poll that listed the kind
                if lists.contains("cards-draw"), hinted.set() { return (200, #"{"editor":true}"#) }
                Thread.sleep(forTimeInterval: 0.03)
                return (204, "")
            }
            if request.path.hasSuffix("/editor/claim") { return (200, #"{"job":{"id":7,"kind":"cards-draw","editId":"e1","variant":"A"}}"#) }
            if request.path.hasSuffix("/job/7/cards") { return (200, cards) }
            return (200, #"{"ok":true}"#)
        }
        let done = "POST \(base)/done"
        let lists = { (request: FakeSite.Request) in self.json(request)?["editor"] != nil }
        let seen = Seen()
        // until the step is done and a later poll lists the kind again
        let ended = await serving(runner(site, seen: seen), upTo: 15) {
            let all = site.requests
            guard let at = all.firstIndex(where: { "\($0.method) \($0.path)" == done }) else { return false }
            return all[(at + 1)...].contains(where: lists)
        }
        XCTAssertTrue(ended)
        let all = site.requests
        let names = all.map { "\($0.method) \($0.path)" }
        XCTAssertEqual(names.first, poll)
        XCTAssertEqual(names.filter { $0 != poll }, [claim, "GET \(base)/cards", "POST \(base)/cards/c1", "POST \(base)/cards/c2", done],
                       "one claim for the one hint, and the step it gave")
        guard let claimed = names.firstIndex(of: claim), let finished = names.firstIndex(of: done) else { return XCTFail("no step") }
        // while it draws, its polls go on for AI requests but list no kind: one card step at a time
        let during = all[(claimed + 1)..<finished].filter { $0.path.hasSuffix("/relay/wait") }
        XCTAssertFalse(during.isEmpty)
        XCTAssertTrue(during.allSatisfy { self.json($0) == ["blobs": true] })
        XCTAssertEqual(seen.statuses.map(\.drawing), [true, false])
        XCTAssertTrue(seen.statuses.allSatisfy { $0.lastError == nil && $0.running == 0 })
    }

    func testAServerThatHintsWronglyGetsOneClaimNotALoop() async {
        // a server that says a step waits on every poll, whatever the poll listed, and then has none
        let site = FakeSite()
        site.answer = { $0.path.hasSuffix("/relay/wait") ? (200, #"{"editor":true}"#) : (200, #"{"job":null}"#) }
        let seen = Seen()
        let ended = await serving(runner(site, seen: seen), upTo: 1.5)
        XCTAssertTrue(ended)
        // the hint is followed once; the next poll lists no kind, and a hint it did not ask for is left alone for a poll's length
        XCTAssertEqual(paths(site), [poll, claim, poll])
        XCTAssertEqual(json(site.requests[0]), ["blobs": true, "editor": ["cards-draw"]])
        XCTAssertEqual(json(site.requests[2]), ["blobs": true])
        XCTAssertTrue(seen.statuses.isEmpty)
    }

    func testAClaimThatFindsNoStepKeepsTheMacQuietForAWhile() {
        let site = FakeSite()
        site.answer = { _ in (200, #"{"job":null}"#) }   // another Mac of the account was first
        let seen = Seen()
        let runner = runner(site, seen: seen)
        XCTAssertEqual(runner.editorKinds(now: 1000), ["cards-draw"])
        XCTAssertNil(runner.claimStep(now: 1000))
        XCTAssertEqual(paths(site), [claim])
        XCTAssertEqual(site.requests[0].headers["authorization"], "Bearer \(token)")
        XCTAssertEqual(String(decoding: site.requests[0].body, as: UTF8.self), #"{"kinds":["cards-draw"]}"#)
        XCTAssertNil(runner.editorKinds(now: 1000), "no kind is listed for a poll's length, so no hint and no claim")
        XCTAssertNil(runner.editorKinds(now: 1024.9))
        XCTAssertEqual(runner.editorKinds(now: 1025), ["cards-draw"])

        // a server whose claim route refuses: an hour; one that is restarting: a poll's length
        for (status, quiet) in [(404, 3600.0), (400, 3600.0), (502, 25.0)] {
            let other = FakeSite()
            other.answer = { _ in (status, #"{"error":"no"}"#) }
            let runner = self.runner(other, seen: seen)
            XCTAssertNil(runner.claimStep(now: 1000))
            XCTAssertNil(runner.editorKinds(now: 1000 + quiet - 0.1), "HTTP \(status)")
            XCTAssertEqual(runner.editorKinds(now: 1000 + quiet), ["cards-draw"], "HTTP \(status)")
        }
        XCTAssertTrue(seen.statuses.isEmpty, "none of it is an error a person sees")

        // the poll's body: as today when no kind is to be said, the kinds otherwise, and none for a Mac that can't draw
        XCTAssertEqual(runner.waitBody(listing: nil) as NSDictionary, ["blobs": true])
        XCTAssertEqual(runner.waitBody(listing: ["cards-draw"]) as NSDictionary, ["blobs": true, "editor": ["cards-draw"]])
        XCTAssertEqual(runner.waitBody(listing: []) as NSDictionary, ["blobs": true, "editor": [String]()])
        // only {"editor": true} is the hint
        XCTAssertTrue(RelayRunner.editorWaits(Data(#"{"editor":true}"#.utf8)))
        for other in [#"{"editor":false}"#, #"{"editor":"yes"}"#, "{}", #"{"job":null}"#, "", "not json"] {
            XCTAssertFalse(RelayRunner.editorWaits(Data(other.utf8)), other)
        }
    }

    func testAClaimedStepIsDrawnOneAtATimeAndIsNotAnAIRequest() async {
        let cards = sheet(["Tiny Acrobatics", "Second card"])
        let site = FakeSite()
        site.answer = { request in
            if request.path.hasSuffix("/editor/claim") { return (200, #"{"job":{"id":7,"kind":"cards-draw","editId":"e1","variant":"A"}}"#) }
            if request.path.hasSuffix("/job/7/cards") { return (200, cards) }
            return (200, #"{"ok":true}"#)
        }
        let seen = Seen()
        let runner = runner(site, seen: seen)
        let step = runner.claimStep(now: 1000)
        XCTAssertEqual(step, EditorJob(id: 7, kind: "cards-draw"))
        // one card step at a time: no kind is listed while this one is drawn, however long that takes
        XCTAssertNil(runner.editorKinds(now: 100_000))
        guard let step else { return }
        await offMain { runner.drawCards(step) }
        XCTAssertEqual(paths(site), [claim, "GET \(base)/cards", "POST \(base)/cards/c1", "POST \(base)/cards/c2", "POST \(base)/done"])
        // the menu saw it drawing and then not, with no AI request running and no AI error
        XCTAssertEqual(seen.statuses.map(\.drawing), [true, false])
        XCTAssertTrue(seen.statuses.allSatisfy { $0.lastError == nil && $0.running == 0 })
        // listed again on the next poll: the server hints at once when more steps wait
        XCTAssertEqual(runner.editorKinds(now: 1001), ["cards-draw"])
    }

    func testAStepSaidOnDoneIsDrawnAtOnceWithNoPollBetween() async {
        // an edit queues one step a version: the answer to the first one's done says the next waits
        let cards = sheet(["Tiny Acrobatics"])
        let site = FakeSite()
        let first = Flag()
        site.answer = { request in
            if request.path.hasSuffix("/editor/claim") { return (200, first.set() ? #"{"job":{"id":7,"kind":"cards-draw","editId":"e1","variant":"A"}}"# : #"{"job":{"id":8,"kind":"cards-draw","editId":"e1","variant":"B"}}"#) }
            if request.path.hasSuffix("/cards") { return (200, cards) }
            if request.path.hasSuffix("/job/7/done") { return (200, #"{"ok":true,"editor":true}"#) }
            return (200, #"{"ok":true}"#)
        }
        let seen = Seen()
        let runner = runner(site, seen: seen)
        guard let step = runner.claimStep(now: 1000) else { return XCTFail("no step") }
        await offMain { runner.drawCards(step) }
        let job = "/api/devices/relay/editor/job"
        XCTAssertEqual(paths(site), [claim, "GET \(job)/7/cards", "POST \(job)/7/cards/c1", "POST \(job)/7/done",
                                     claim, "GET \(job)/8/cards", "POST \(job)/8/cards/c1", "POST \(job)/8/done"])
        XCTAssertEqual(seen.statuses.map(\.drawing), [true, false], "one Drawing cards row for both")

        // a server that says so wrongly gets one claim, and then this Mac lists no kind for a poll's length
        let wrong = FakeSite()
        let once = Flag()
        wrong.answer = { request in
            if request.path.hasSuffix("/editor/claim") { return (200, once.set() ? #"{"job":{"id":7,"kind":"cards-draw","editId":"e1","variant":"A"}}"# : #"{"job":null}"#) }
            if request.path.hasSuffix("/cards") { return (200, cards) }
            return (200, #"{"ok":true,"editor":true}"#)
        }
        let other = self.runner(wrong)
        guard let again = other.claimStep(now: 1000) else { return XCTFail("no step") }
        await offMain { other.drawCards(again) }
        XCTAssertEqual(paths(wrong), [claim, "GET \(job)/7/cards", "POST \(job)/7/cards/c1", "POST \(job)/7/done", claim])
        XCTAssertNil(other.editorKinds())
    }

    func testAMacThatCannotShutAScriptInSaysSoAndListsNoKindFromThenOn() async {
        await MainActor.run { KitRunner.calls.needed = ["NoSuchFeature"] }   // as on a macOS whose WebKit lacks the switch
        addTeardownBlock { await MainActor.run { KitRunner.calls = KitCalls() } }
        let cards = sheet(["Tiny Acrobatics", "Second card"])
        let site = FakeSite()
        site.answer = { request in
            if request.path.hasSuffix("/editor/claim") { return (200, #"{"job":{"id":7,"kind":"cards-draw","editId":"e1","variant":"A"}}"#) }
            if request.path.hasSuffix("/job/7/cards") { return (200, cards) }
            return (200, #"{"ok":true}"#)
        }
        let runner = runner(site)
        guard let step = runner.claimStep(now: 1000) else { return XCTFail("no step") }
        await offMain { runner.drawCards(step) }
        // nothing was drawn or sent, the step failed in words, and no request was added to say so
        XCTAssertEqual(paths(site), [claim, "GET \(base)/cards", "POST \(base)/fail"])
        let told = (try? JSONSerialization.jsonObject(with: site.requests[2].body)) as? [String: Any]
        XCTAssertEqual(told?["error"] as? String, "Cards can't be drawn on this Mac: this macOS has no switch for link preconnect (NoSuchFeature).")
        // from now on its polls say it draws none, so the server stops counting on it and another Mac gets the step
        for now in [1001.0, 5000, 1_000_000] { XCTAssertEqual(runner.editorKinds(now: now), []) }
        XCTAssertEqual(runner.waitBody(listing: runner.editorKinds()) as NSDictionary, ["blobs": true, "editor": [String]()])
    }

    func testAStepOfAKindThisMacDidNotListIsHandedBack() {
        let site = FakeSite()
        site.answer = { $0.path.hasSuffix("/editor/claim") ? (200, #"{"job":{"id":9,"kind":"resolve","editId":"e1","variant":""}}"#) : (200, #"{"ok":true}"#) }
        let runner = runner(site)
        XCTAssertNil(runner.claimStep(now: 1000))
        XCTAssertEqual(paths(site), [claim, "POST /api/devices/relay/editor/job/9/fail"])
        XCTAssertNil(runner.editorKinds(now: 1001))
    }

    func testTheMenuRowSaysWhatThisMacIsDoing() {
        XCTAssertEqual(activityRows(sessions: [], aiRunning: 0, drawing: true).active.map(\.detail), ["Drawing cards"])
        XCTAssertEqual(activityRows(sessions: [], aiRunning: 2, drawing: true).active.map(\.detail), ["2 AI requests · Drawing cards"])
        XCTAssertEqual(activityRows(sessions: [], aiRunning: 1).active.map(\.detail), ["1 AI request"])
        XCTAssertTrue(activityRows(sessions: [], aiRunning: 0).active.isEmpty)
    }

    // MARK: one clip a person can watch

    /// `CT_CARD_REPORT=<folder> swift test --filter testReportOneCard`: one made-up card at an edit's real size goes
    /// through a whole step, and the folder gets what the server was sent: the clip, its three stills, and the raw
    /// upload with its Content-Type (so another parser can read it).
    func testReportOneCard() async throws {
        guard let out = ProcessInfo.processInfo.environment["CT_CARD_REPORT"] else { throw XCTSkip("set CT_CARD_REPORT to a folder") }
        let script = """
        function kitFrame(t, card) {
          const stage = document.getElementById('stage');
          const ease = x => 1 - Math.pow(1 - Math.min(1, Math.max(0, x)), 3);
          const up = ease(t / 0.5), bar = ease((t - 0.25) / 0.6), out = ease((t - 2.0) / 0.4);
          stage.innerHTML =
            '<div style="position:absolute;inset:0;background:linear-gradient(160deg,#1b1340,#3a1d6e 55%,#e0457b)"></div>' +
            '<div style="position:absolute;left:96px;right:96px;top:' + (760 + 120 * (1 - up)) + 'px;opacity:' + (up * (1 - out)) + ';color:#fff;font:800 132px/1.05 -apple-system,Helvetica,sans-serif;letter-spacing:-2px">' + card.text + '</div>' +
            '<div style="position:absolute;left:96px;top:1120px;height:14px;width:' + (560 * bar) + 'px;background:#ffd166;border-radius:7px;opacity:' + (1 - out) + '"></div>' +
            '<div style="position:absolute;left:96px;top:1180px;opacity:' + (bar * (1 - out)) + ';color:#ffd166;font:600 54px -apple-system,Helvetica,sans-serif">' + card.line + '</div>';
        }
        """
        let all: [String: Any] = ["width": 1080, "height": 1920, "fps": 30, "script": script,
                                  "cards": [["id": "c1", "seconds": 2.4, "content": ["id": "c1", "text": "Tiny Acrobatics", "line": "Three moves for week one"]] as [String: Any]]]
        let site = site(String(decoding: try JSONSerialization.data(withJSONObject: all), as: UTF8.self))
        let started = Date()
        let (end, _) = await run(site)
        XCTAssertEqual(end, .done)
        print("REPORT one card of 1080 × 1920, 2.4 s at 30 frames a second: read, drawn, sent and done in \(Date().timeIntervalSince(started)) s")
        let upload = try XCTUnwrap(site.requests.first { $0.path.hasSuffix("/cards/c1") })
        let folder = URL(fileURLWithPath: out)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        try upload.body.write(to: folder.appendingPathComponent("upload.body"))
        try Data((upload.headers["content-type"] ?? "").utf8).write(to: folder.appendingPathComponent("upload.content-type"))
        for part in readMultipart(upload.body, contentType: upload.headers["content-type"] ?? "") {
            try part.data.write(to: folder.appendingPathComponent(part.filename))
        }
    }

    /// `CT_CARD_SERVER=<address> CT_CARD_TOKEN=<device token> CT_CARD_STOP=<file>`: this Mac's own long poll serves a real
    /// server, as the app's does (RelayRunner.serve and nothing else of the app), drawing every card step it is handed,
    /// until the file exists. Run it with the home folder moved under TMPDIR: a failed step is written to the app's log.
    func testServeARealServer() async throws {
        let env = ProcessInfo.processInfo.environment
        guard let server = env["CT_CARD_SERVER"].flatMap(URL.init(string:)), let token = env["CT_CARD_TOKEN"], let stop = env["CT_CARD_STOP"]
        else { throw XCTSkip("set CT_CARD_SERVER, CT_CARD_TOKEN and CT_CARD_STOP") }
        let scratch = try XCTUnwrap(env["TMPDIR"])
        guard AppLog.path.hasPrefix(scratch) else { return XCTFail("the app log would be \(AppLog.path), outside TMPDIR") }
        let dir = temp()
        let real = RelayRunner(base: server, token: token, work: dir.appendingPathComponent("relay"), home: dir,
                               onStatus: { print("STATUS drawing=\($0.drawing) running=\($0.running) error=\($0.lastError ?? "-")") }, onRevoked: { print("REVOKED") })
        // not asked to end within 4 s: a real server holds the poll in flight for up to 25 s after the stop
        _ = await serving(real, upTo: 3 * 3600) { FileManager.default.fileExists(atPath: stop) }
    }
}
