import XCTest
@testable import CreatorToolsetMac

/// This Mac as one of the person's speech computers: transcript steps, the models it says it has, and dictation
/// through the server's engine.
final class SpeechModelsTests: XCTestCase {
    // MARK: the audio and the words

    func testTheServersWAVIsReadWhereverItsDataChunkIs() throws {
        let samples: [Float] = [0, 0.5, -0.5, 0.25]
        var wav = WAVWriter.data(samples: samples, sampleRate: 16000)
        // a LIST chunk (odd length, so padded) between fmt and data, as ffmpeg writes one
        let list = Data("LIST".utf8) + Data([3, 0, 0, 0]) + Data("abc".utf8) + Data([0])
        wav.insert(contentsOf: list, at: 36)
        let read = try WAVReader.samples(wav)
        XCTAssertEqual(read.count, 4)
        for (a, b) in zip(read, samples) { XCTAssertEqual(a, b, accuracy: 0.001) }
        XCTAssertThrowsError(try WAVReader.samples(WAVWriter.data(samples: samples, sampleRate: 44100)))
        XCTAssertThrowsError(try WAVReader.samples(Data("Tiny Acrobatics".utf8)))
    }

    func testWordsAreSentAsTheServerTakesThem() {
        let body = TranscribeJob.body([
            HeardWord(text: " Hello", start: -0.1, end: 0.4),
            HeardWord(text: "[MUSIC]", start: 0.4, end: 0.9),
            HeardWord(text: "there", start: 1.2, end: 1.0),
            HeardWord(text: "never", start: .nan, end: 2),
        ], language: "et")
        XCTAssertEqual(body["language"] as? String, "et")
        XCTAssertEqual(body["words"] as? NSArray, [
            ["text": "Hello", "start": 0.0, "end": 0.4],
            ["text": "there", "start": 1.2, "end": 1.2],
        ])
        XCTAssertNotNil(try? JSONSerialization.data(withJSONObject: body))
        XCTAssertTrue(TranscribeJob.body([], language: "<|et|>")["language"] is NSNull)
    }

    // MARK: the step, against a stand-in server

    private func runner(_ site: FakeSite, speech: SpeechLink) -> RelayRunner {
        let dir = testFolder("speech")
        addTeardownBlock { try? FileManager.default.removeItem(at: dir) }
        return RelayRunner(base: site.url, token: "ctd_test-token", work: dir.appendingPathComponent("relay"), home: dir, speech: speech, onStatus: { _ in }, onRevoked: {})
    }

    private func offMain(_ work: @escaping () -> Void) async {
        await withCheckedContinuation { c in DispatchQueue.global().async { work(); c.resume() } }
    }

    private final class Seen: @unchecked Sendable {
        var wanted: [[String]] = []
        var heard: [(String, [String], Int, Bool)] = []
    }

    private func link(_ seen: Seen, words: [HeardWord] = [HeardWord(text: "Hi", start: 0.1, end: 0.3)], fail: String? = nil) -> SpeechLink {
        SpeechLink(
            claim: { ["models": ["whisper-base.en"], "getting": [], "asked": ["whisper-base.en"]] },
            answered: { _, wanted in seen.wanted.append(wanted); return false },
            transcribe: { model, languages, samples, soon in
                seen.heard.append((model, languages, samples.count, soon))
                if let fail { throw TranscribeRefused(why: fail) }
                return (words, "en")
            })
    }

    func testATranscriptIsClaimedWithTheModelsHeardAndItsWordsSent() async throws {
        let site = FakeSite()
        let wav = WAVWriter.data(samples: [Float](repeating: 0.1, count: 1600), sampleRate: 16000)
        site.answer = { request in
            if request.path.hasSuffix("/editor/claim") {
                return (200, #"{"job":{"id":5,"kind":"transcribe","editId":"","variant":"","model":"whisper-base.en","languages":["en"]},"models":["whisper-base.en"]}"#)
            }
            return (200, #"{"ok":true}"#)
        }
        site.bytes = { $0.method == "GET" && $0.path == "/api/devices/relay/transcribe/5" ? wav : nil }
        let seen = Seen()
        let runner = runner(site, speech: link(seen))
        XCTAssertEqual(runner.editorKinds(now: 0), ["cards-draw", "cutout", "transcribe"])
        let step = try XCTUnwrap(runner.claimStep(now: 1000))
        XCTAssertEqual(step, EditorJob(id: 5, kind: "transcribe", model: "whisper-base.en", languages: ["en"]))
        let claim = try XCTUnwrap(JSONSerialization.jsonObject(with: site.requests[0].body) as? NSDictionary)
        XCTAssertEqual(claim, ["kinds": ["cards-draw", "cutout", "transcribe"], "models": ["whisper-base.en"], "getting": [], "asked": ["whisper-base.en"]])
        XCTAssertEqual(seen.wanted, [["whisper-base.en"]])
        await offMain { runner.runSteps(step) }
        XCTAssertEqual(site.requests.map { "\($0.method) \($0.path)" },
                       ["POST /api/devices/relay/editor/claim", "GET /api/devices/relay/transcribe/5", "POST /api/devices/relay/transcribe/5"])
        XCTAssertEqual(seen.heard.first?.0, "whisper-base.en")
        XCTAssertEqual(seen.heard.first?.1, ["en"])
        XCTAssertEqual(seen.heard.first?.2, 1600)
        XCTAssertEqual(seen.heard.first?.3, false)   // a library transcript: its own model, loaded for it
        let sent = try XCTUnwrap(JSONSerialization.jsonObject(with: site.requests[2].body) as? NSDictionary)
        XCTAssertEqual(sent, ["words": [["text": "Hi", "start": 0.1, "end": 0.3]], "language": "en"])
    }

    func testAMicRecordingIsMarkedSoonSoOnlyALoadedModelHearsIt() async throws {
        let data = Data(#"{"job":{"id":9,"kind":"transcribe","editId":"","variant":"","model":"whisper-large-v3-turbo","languages":[],"soon":true}}"#.utf8)
        XCTAssertEqual(EditorJob(claim: data), EditorJob(id: 9, kind: "transcribe", model: "whisper-large-v3-turbo", languages: [], soon: true))
        // a model this Mac has but has not loaded: refused at once, so the server goes on another way within its wait.
        // Off the main thread, as the relay runs it (it waits there for dictation's answer from the main actor).
        let start = Date()
        let result = await Task.detached { Result { try SpeechModels.transcript(model: "whisper-base.en", languages: [], samples: [0.1, 0.2], soon: true) } }.value
        guard case .failure(let error) = result else { return XCTFail("heard with no loaded model") }
        XCTAssertTrue(error is TranscribeRefused, "\(error)")
        XCTAssertLessThan(Date().timeIntervalSince(start), 2)
    }

    func testATranscriptThatCannotBeMadeOrIsRefusedIsFailedNeverLeftWaiting() async throws {
        for (fail, postStatus, why) in [("This Mac does not have Whisper Small.", 200, "This Mac does not have Whisper Small."),
                                         (nil, 400, "The server refused the words (HTTP 400).")] {
            let site = FakeSite()
            let wav = WAVWriter.data(samples: [0.1, 0.2], sampleRate: 16000)
            site.answer = { request in
                if request.path.hasSuffix("/editor/claim") { return (200, #"{"job":{"id":5,"kind":"transcribe","model":"whisper-small"}}"#) }
                if request.method == "POST", request.path == "/api/devices/relay/transcribe/5" { return (postStatus, #"{"error":"no"}"#) }
                return (200, #"{"ok":true}"#)
            }
            site.bytes = { $0.method == "GET" ? wav : nil }
            let runner = runner(site, speech: link(Seen(), fail: fail))
            let step = try XCTUnwrap(runner.claimStep(now: 1000))
            await offMain { runner.runSteps(step) }
            let last = try XCTUnwrap(site.requests.last)
            XCTAssertEqual(last.path, "/api/devices/relay/transcribe/5/fail")
            XCTAssertEqual((try? JSONSerialization.jsonObject(with: last.body)) as? NSDictionary, ["error": why])
        }
    }

    func testAClaimOfItsOwnSaysWhatItHasAndLeavesTheHintsAlone() throws {
        let site = FakeSite()
        site.answer = { _ in (200, #"{"job":null,"models":["whisper-large-v3-turbo"]}"#) }
        let seen = Seen()
        let runner = runner(site, speech: link(seen))
        XCTAssertNil(runner.claimStep(now: 1000, hinted: false))
        XCTAssertEqual(seen.wanted, [["whisper-large-v3-turbo"]])
        XCTAssertNotNil(runner.editorKinds(now: 1001), "a claim of its own never quiets the poll")
        // an older server says nothing of models: nothing here is touched
        site.answer = { _ in (200, #"{"job":null}"#) }
        XCTAssertNil(runner.claimStep(now: 1000, hinted: false))
        XCTAssertEqual(seen.wanted.count, 1)
    }

    // MARK: the earlier app's folder

    func testAModelInTheEarlierAppsFolderIsSetAsideNeverDeletedAndComesBackWithNoDownload() throws {
        let earlier = testFolder("earlier")
        defer { try? FileManager.default.removeItem(at: earlier) }
        let variant = "openai_whisper-tiny-test"
        let folder = ModelFiles.folder(variant, in: earlier)
        for name in ["AudioEncoder.mlmodelc", "TextDecoder.mlmodelc", "MelSpectrogram.mlmodelc"] {
            try FileManager.default.createDirectory(at: folder.appendingPathComponent(name), withIntermediateDirectories: true)
        }
        defer { _ = SpeechModels.restore(variant, earlier: earlier) }
        SpeechModels.setAside(variant, earlier: earlier)
        XCTAssertTrue(SpeechModels.isSetAside(variant))
        XCTAssertTrue(ModelFiles.isComplete(folder), "its files stay")
        XCTAssertTrue(SpeechModels.restore(variant, earlier: earlier))
        XCTAssertFalse(SpeechModels.isSetAside(variant))
        XCTAssertFalse(SpeechModels.restore(variant, earlier: earlier), "only one set aside comes back")
    }

    // MARK: what the owner wants on this Mac

    func testTheOwnersWishesAreDoneOneDownloadAtATimeAndAFailedOneWaits() {
        let now = Date()
        let at = Date(timeIntervalSince1970: 0)
        // wanted and missing: queued; here and not wanted: removed; one downloading is left alone
        var p = SpeechModels.plan(wanted: ["whisper-small", "whisper-base.en"], held: ["whisper-large-v3-turbo", "whisper-base.en"],
                                  downloading: nil, queue: [], failed: [:], now: now)
        XCTAssertEqual(p.remove, ["whisper-large-v3-turbo"])
        XCTAssertEqual(p.queue, ["whisper-small"])
        p = SpeechModels.plan(wanted: [], held: ["whisper-small"], downloading: "whisper-small", queue: ["whisper-base.en"], failed: ["whisper-small.en": at], now: now)
        XCTAssertEqual(p.remove, [], "a download in progress is not removed under itself")
        XCTAssertEqual(p.queue, [], "a wish taken back leaves the queue")
        XCTAssertTrue(p.failed.isEmpty)
        // a failed download is tried again only after `retry`; ids this Mac doesn't run are left alone
        let failed = ["whisper-small": now.addingTimeInterval(-60)]
        p = SpeechModels.plan(wanted: ["whisper-small", "whisper-large-v3"], held: [], downloading: nil, queue: [], failed: failed, now: now)
        XCTAssertEqual(p.queue, [])
        XCTAssertEqual(p.failed, failed)
        p = SpeechModels.plan(wanted: ["whisper-small"], held: [], downloading: nil, queue: [], failed: failed, now: now.addingTimeInterval(SpeechModels.retry))
        XCTAssertEqual(p.queue, ["whisper-small"])
        XCTAssertTrue(p.failed.isEmpty)
    }

    // MARK: the earlier dictation app

    private final class Pasted: Delivering {
        var texts: [String] = []
        func deliver(_ text: String, focusAtStart: FocusSnapshot?) throws { texts.append(text) }
    }

    @MainActor
    func testNothingIsPastedWhileTheEarlierAppIsOpen() {
        let pasted = Pasted()
        var open = true
        let delivery = UnlessEarlierApp(pasted, running: { open })
        XCTAssertThrowsError(try delivery.deliver("hi", focusAtStart: nil)) { XCTAssertTrue($0 is EarlierAppOpen) }
        open = false
        XCTAssertNoThrow(try delivery.deliver("hi", focusAtStart: nil))
        XCTAssertEqual(pasted.texts, ["hi"])
    }

    func testWhileTheEarlierDictationAppRunsNothingHereListens() throws {
        XCTAssertTrue(EarlierDictationApp.listens(on: true, earlierRunning: false))
        XCTAssertFalse(EarlierDictationApp.listens(on: true, earlierRunning: true), "no keys, nothing pasted")
        XCTAssertFalse(EarlierDictationApp.listens(on: false, earlierRunning: false))
        XCTAssertTrue(EarlierDictationApp.running(among: ["com.apple.finder", nil, EarlierDictationApp.bundleID]))
        XCTAssertFalse(EarlierDictationApp.running(among: ["com.apple.finder", nil]))
        // the id is the app's own, where it is installed
        let plist = URL(fileURLWithPath: "/Applications/Parrot.app/Contents/Info.plist")
        guard let info = NSDictionary(contentsOf: plist) else { throw XCTSkip("the earlier app isn't installed here") }
        XCTAssertEqual(info["CFBundleIdentifier"] as? String, EarlierDictationApp.bundleID)
    }

    // MARK: dictation through the server

    func testTheServersAnswerIsTheWordsOrWhatToSay() throws {
        XCTAssertEqual(try ServerTranscriber.text(status: 200, data: Data(#"{"text":" Hi there ","language":"en"}"#.utf8)), "Hi there")
        let needs = Data(#"{"error":"Needs an OpenAI key","code":"NEEDS_KEY"}"#.utf8)
        XCTAssertThrowsError(try ServerTranscriber.text(status: 402, data: needs)) {
            XCTAssertEqual($0 as? ServerDictationError, ServerDictationError(userMessage: "Needs an OpenAI key"))
        }
        let odd = Data(#"{"error":"Add your Deepgram (or OpenAI) key in Settings → API keys","code":"NEEDS_KEY"}"#.utf8)
        XCTAssertThrowsError(try ServerTranscriber.text(status: 402, data: odd)) {
            XCTAssertEqual(($0 as? ServerDictationError)?.userMessage, "Needs a Deepgram key")
        }
        XCTAssertThrowsError(try ServerTranscriber.text(status: 502, data: Data("<html>".utf8))) {
            XCTAssertEqual(($0 as? ServerDictationError)?.userMessage, "Your server couldn't write it down (HTTP 502)")
        }
        // the wait is the recording's own length, with a floor for a short one
        XCTAssertEqual(ServerTranscriber.timeout(seconds: 1), 10)
        XCTAssertEqual(ServerTranscriber.timeout(seconds: 20), 20)
    }

    func testAFailedServerDictationSaysWhyAndThatItIsInHistory() {
        let failed = TranscriptionFailed(underlying: ServerDictationError(userMessage: "Needs a Deepgram key"), saved: URL(fileURLWithPath: "/x.wav"))
        XCTAssertEqual(failed.userMessage, "Needs a Deepgram key · saved in History")
        XCTAssertEqual(TranscriptionFailed(underlying: CocoaError(.fileNoSuchFile), saved: nil).userMessage, "Transcription failed")
    }

    func testTheEngineIsKeptOnThisMac() {
        let d = UserDefaults(suiteName: "speech-models-test")!
        defer { d.removePersistentDomain(forName: "speech-models-test") }
        XCTAssertEqual(DictationPrefs.load(d).engine, .thisMac)
        var p = DictationPrefs.load(d)
        p.engine = .server
        p.save(d)
        XCTAssertEqual(DictationPrefs.load(d).engine, .server)
    }

    /// The real model on a real recording, by hand only: `SPEECH_LIVE_WAV=<a 16 kHz wav over 30 s> swift test --filter
    /// SpeechModelsTests`. Needs Whisper Base (English) already on this Mac; it never downloads one.
    func testWordTimesRunOnAcrossWindows() throws {
        guard let path = ProcessInfo.processInfo.environment["SPEECH_LIVE_WAV"] else { throw XCTSkip("by hand only") }
        let samples = try AudioFileLoader.load(url: URL(fileURLWithPath: path))
        XCTAssertGreaterThan(samples.count, 16000 * 31)
        let heard = try SpeechModels.transcript(model: "whisper-base.en", languages: [], samples: samples)
        let words = try XCTUnwrap(heard.words as [HeardWord]?)
        XCTAssertGreaterThan(words.last?.start ?? 0, 30, "times count from the recording's start, past the first window")
        XCTAssertEqual(words.map(\.start), words.map(\.start).sorted())
    }
}

/// The setup page's download leaves no wish behind unless the person pressed Get Started (CT WHIP's ruling, 11-13).
final class SetupPageWishTests: XCTestCase {
    @MainActor
    func testAPageStoppedDownloadIsNotTriedAgainByAClaimOrATimer() {
        let models = SpeechModels.shared
        // a download that failed on its own is reported as getting and tried again after `retry`
        models.finished("whisper-small", ok: false)
        XCTAssertTrue((models.claim()["getting"] as? [String] ?? []).contains("whisper-small"))
        // one the page stopped (Not now) is not: no getting, no retry, no wish of its own in the claim
        models.stopped("whisper-small")
        let claim = models.claim()
        XCTAssertFalse((claim["getting"] as? [String] ?? []).contains("whisper-small"))
        XCTAssertFalse((claim["asked"] as? [String] ?? []).contains("whisper-small"))
        // and with no wish from the server, nothing queues it, now or later
        let later = SpeechModels.plan(wanted: [], held: [], downloading: nil, queue: [], failed: [:], now: Date().addingTimeInterval(3600))
        XCTAssertEqual(later.queue, [])
    }

    func testGetStartedKeepsThePagesDownloadAsAWishAndNotNowDoesNot() {
        var page = SetupDownload()
        page.opened()
        page.prepared(before: nil, after: "whisper-large-v3-turbo")
        XCTAssertEqual(page.wish, "whisper-large-v3-turbo")   // Get Started asks for it
        _ = page.closed(gotStarted: false, running: "whisper-large-v3-turbo")
        XCTAssertNil(page.wish)                                // Not now: nothing to ask
        // the page's model, finished but not asked yet, and one asked here the server has not heard: not removed
        let p = SpeechModels.plan(wanted: [], held: ["whisper-large-v3-turbo", "parakeet-tdt-0.6b-v3"], downloading: nil, queue: [],
                                  failed: [:], now: Date(), keep: ["whisper-large-v3-turbo"])
        XCTAssertEqual(p.remove, ["parakeet-tdt-0.6b-v3"])
    }
}
