import XCTest
@testable import CreatorToolsetMac

final class TalkRouterTests: XCTestCase {
    func testF13StartsAndStops() {
        var r = TalkRouter()
        XCTAssertEqual(r.route(.toggle, recording: false), .start(quiet: false))
        XCTAssertEqual(r.route(.toggle, recording: true), .stop)
    }

    func testF13StopsARecordingTheHoldStarted() {
        var r = TalkRouter()
        XCTAssertEqual(r.route(.holdDown, recording: false), .start(quiet: true))
        XCTAssertEqual(r.route(.toggle, recording: true), .stop)
        // the hold's own release afterwards does nothing
        XCTAssertNil(r.route(.holdUp, recording: false))
    }

    func testAHoldDuringAnF13RecordingDoesNothing() {
        var r = TalkRouter()
        XCTAssertEqual(r.route(.toggle, recording: false), .start(quiet: false))
        XCTAssertNil(r.route(.holdDown, recording: true))
        XCTAssertNil(r.route(.holdUp, recording: true))
        XCTAssertNil(r.route(.holdCancel, recording: true))
        XCTAssertEqual(r.route(.toggle, recording: true), .stop)
    }

    func testTheHoldReleaseStopsOnlyItsOwnRecording() {
        var r = TalkRouter()
        XCTAssertEqual(r.route(.holdDown, recording: false), .start(quiet: true))
        XCTAssertEqual(r.route(.holdUp, recording: true), .stop)
        XCTAssertEqual(r.route(.holdDown, recording: false), .start(quiet: true))
        XCTAssertEqual(r.route(.holdCancel, recording: true), .cancelRecording)
    }

    func testF16DiscardsInEveryState() {
        var r = TalkRouter()
        XCTAssertEqual(r.route(.cancel, recording: false), .discard)
        _ = r.route(.toggle, recording: false)
        XCTAssertEqual(r.route(.cancel, recording: true), .discard)
        XCTAssertNil(r.source)
        _ = r.route(.holdDown, recording: false)
        XCTAssertEqual(r.route(.cancel, recording: true), .discard)
        XCTAssertNil(r.route(.holdUp, recording: false))
    }

    func testARecordingThatFailedToStartLeavesNoOwner() {
        var r = TalkRouter()
        _ = r.route(.holdDown, recording: false)
        // capture failed: nothing records, so the next F13 starts a new one
        XCTAssertEqual(r.route(.toggle, recording: false), .start(quiet: false))
        XCTAssertEqual(r.source, .toggle)
    }
}

final class FunctionKeyTests: XCTestCase {
    func testOnlyBoundKeysAreSwallowedAndOnlyAFirstKeyDownFires() {
        XCTAssertTrue(functionKeyVerdict(bound: false, keyDown: true, autorepeat: false) == (false, false))
        XCTAssertTrue(functionKeyVerdict(bound: true, keyDown: true, autorepeat: false) == (true, true))
        XCTAssertTrue(functionKeyVerdict(bound: true, keyDown: true, autorepeat: true) == (true, false))
        XCTAssertTrue(functionKeyVerdict(bound: true, keyDown: false, autorepeat: false) == (true, false))
    }

    func testAFirstHoldBeforeAccessibilityNeedsTheKeyAloneAndLongEnough() {
        XCTAssertTrue(firstHoldCounts(heldFor: 1.5, secondsSinceKeyDown: 5))
        XCTAssertFalse(firstHoldCounts(heldFor: 0.1, secondsSinceKeyDown: 5), "a stray tap")
        XCTAssertFalse(firstHoldCounts(heldFor: 0.6, secondsSinceKeyDown: 5), "brushing it")
        XCTAssertFalse(firstHoldCounts(heldFor: 1.5, secondsSinceKeyDown: 0.2), "fn with an arrow")
        XCTAssertFalse(firstHoldCounts(heldFor: 60, secondsSinceKeyDown: 100), "a key left down")
    }
}

final class DictationPrefsTests: XCTestCase {
    private func defaults() -> UserDefaults {
        let name = "dictation-test-\(UUID().uuidString)"
        let d = UserDefaults(suiteName: name)!
        addTeardownBlock { d.removePersistentDomain(forName: name) }
        return d
    }

    func testDefaultsAreOnWithFnAndTurbo() {
        let p = DictationPrefs.load(defaults())
        XCTAssertTrue(p.on)
        XCTAssertEqual(p.hold, .fn)
        XCTAssertEqual(p.model, "whisper-large-v3-turbo")
        XCTAssertEqual(p.keep, 10)
        XCTAssertTrue(p.sounds)
    }

    func testSaveAndLoad() {
        let d = defaults()
        var p = DictationPrefs()
        p.on = false
        p.hold = nil
        p.model = "whisper-base.en"
        p.keep = 25
        p.sounds = false
        p.save(d)
        XCTAssertEqual(DictationPrefs.load(d), p)
        p.hold = .rightOption
        p.save(d)
        XCTAssertEqual(DictationPrefs.load(d).hold, .rightOption)
    }

    func testAnUnknownModelLoadsAsTheDefault() {
        let d = defaults()
        d.set("whisper-gigantic", forKey: DictationPrefs.keys.model)
        d.set(0, forKey: DictationPrefs.keys.keep)
        XCTAssertEqual(DictationPrefs.load(d).model, "whisper-large-v3-turbo")
        XCTAssertEqual(DictationPrefs.load(d).keep, 1)
    }

    func testImportTakesTheEarlierAppsChoicesButNeverItsServer() throws {
        let json = """
        {"hotkey":{"key":"f13"},"model":{"id":"whisper-small"},
         "extras":{"keepRecordings":25,"sounds":false,"server":"http://tiny-acrobatics.example:7886/api/transcribe"}}
        """
        let p = DictationPrefs().importing(settings: Data(json.utf8), legacyKey: nil)
        XCTAssertNil(p.hold, "F13 talked there, so no hold key here")
        XCTAssertEqual(p.model, "whisper-small")
        XCTAssertEqual(p.keep, 25)
        XCTAssertFalse(p.sounds)
        XCTAssertTrue(p.on)
    }

    func testImportFallsBackToTheOlderKeyAndKeepsDefaultsForTheRest() {
        let p = DictationPrefs().importing(settings: nil, legacyKey: "right-option")
        XCTAssertEqual(p.hold, .rightOption)
        XCTAssertEqual(p, { var d = DictationPrefs(); d.hold = .rightOption; return d }())
        XCTAssertEqual(DictationPrefs().importing(settings: Data("{}".utf8), legacyKey: "f13").hold, nil)
        XCTAssertEqual(DictationPrefs().importing(settings: Data("not json".utf8), legacyKey: nil), DictationPrefs())
        let unknown = DictationPrefs().importing(settings: Data(#"{"model":{"id":"parakeet"},"hotkey":{"key":"caps"}}"#.utf8), legacyKey: nil)
        XCTAssertEqual(unknown, DictationPrefs())
    }
}

final class ModelFilesTests: XCTestCase {
    private func temp() throws -> URL {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("dictation-models-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: url) }
        return url
    }

    private func put(_ variant: String, in base: URL, complete: Bool) throws {
        let folder = ModelFiles.folder(variant, in: base)
        let parts = complete ? ["AudioEncoder.mlmodelc", "TextDecoder.mlmodelc", "MelSpectrogram.mlmodelc"] : ["AudioEncoder.mlmodelc"]
        for part in parts {
            try FileManager.default.createDirectory(at: folder.appendingPathComponent(part), withIntermediateDirectories: true)
        }
    }

    func testAModelAlreadyOnThisMacIsUsedWhereItIs() throws {
        let own = try temp(), earlier = try temp()
        let v = "openai_whisper-large-v3-v20240930_turbo"
        XCTAssertNil(ModelFiles.base(holding: v, bases: [own, earlier]))
        try put(v, in: earlier, complete: true)
        XCTAssertEqual(ModelFiles.base(holding: v, bases: [own, earlier]), earlier)
        try put(v, in: own, complete: false)
        XCTAssertEqual(ModelFiles.base(holding: v, bases: [own, earlier]), earlier, "a download that stopped halfway")
        try put(v, in: own, complete: true)
        XCTAssertEqual(ModelFiles.base(holding: v, bases: [own, earlier]), own)
    }

    func testRemoveDeletesOnlyThisAppsCopy() throws {
        let own = try temp(), earlier = try temp()
        let v = "openai_whisper-base.en"
        try put(v, in: earlier, complete: true)
        XCTAssertFalse(ModelFiles.isOwn(v, base: own))
        ModelFiles.remove(v, base: own)
        XCTAssertTrue(ModelFiles.isComplete(ModelFiles.folder(v, in: earlier)))
        try put(v, in: own, complete: true)
        XCTAssertTrue(ModelFiles.isOwn(v, base: own))
        ModelFiles.remove(v, base: own)
        XCTAssertFalse(ModelFiles.isOwn(v, base: own))
        XCTAssertTrue(ModelFiles.isComplete(ModelFiles.folder(v, in: earlier)))
    }

    func testSizes() {
        XCTAssertEqual(modelSize(1620), "1.6 GB")
        XCTAssertEqual(modelSize(490), "490 MB")
    }
}

/// The dictation loop with a fake microphone, model and cursor.
@MainActor
final class DictationControllerTests: XCTestCase {
    private final class FakeCapture: Capturing {
        var recording = false
        func start() throws { recording = true }
        func finish() throws -> [Float] {
            defer { recording = false }
            return recording ? [Float](repeating: 0.1, count: 16_000) : []
        }
        func stop() -> [Float] { (try? finish()) ?? [] }
    }

    private final class Delivered: Delivering {
        var texts: [String] = []
        func deliver(_ text: String, focusAtStart: FocusSnapshot?) throws { texts.append(text) }
    }

    /// Answers each transcription when `answer` is called, so a test can cancel while it runs.
    private actor SlowModel: Transcriber {
        let modelID = "fake"
        private var waiting: [CheckedContinuation<Transcript, Error>] = []
        func transcribe(_ audio: [Float], context: TranscriptionContext) async throws -> Transcript {
            try await withCheckedThrowingContinuation { waiting.append($0) }
        }
        func answer(_ text: String) {
            waiting.removeFirst().resume(returning: Transcript(text: text))
        }
        var pending: Int { waiting.count }
    }

    private var dir: URL!

    override func setUp() async throws {
        dir = FileManager.default.temporaryDirectory.appendingPathComponent("dictation-loop-\(UUID().uuidString)")
    }

    override func tearDown() async throws {
        try? FileManager.default.removeItem(at: dir)
    }

    private func loop(_ model: SlowModel, _ delivered: Delivered) -> (DictationController, DictationRecordings) {
        let recordings = DictationRecordings(directory: dir)
        let c = DictationController(capture: FakeCapture(), transcriber: model, observers: [], delivery: delivered,
                                    recordings: recordings)
        c.focus = { nil }
        return (c, recordings)
    }

    private func settle(_ model: SlowModel, pending: Int) async {
        for _ in 0..<200 where await model.pending != pending { try? await Task.sleep(nanoseconds: 5_000_000) }
    }

    private func waitFor(_ check: () -> Bool) async {
        for _ in 0..<200 where !check() { try? await Task.sleep(nanoseconds: 5_000_000) }
    }

    func testATranscriptIsPastedAndKeptInHistory() async {
        let model = SlowModel(), delivered = Delivered()
        let (c, recordings) = loop(model, delivered)
        c.press()
        XCTAssertEqual(c.state, .recording)
        c.release()
        XCTAssertEqual(c.state, .transcribing)
        await settle(model, pending: 1)
        await model.answer("Tiny Acrobatics")
        await waitFor { c.state == .idle }
        XCTAssertEqual(delivered.texts, ["Tiny Acrobatics"])
        XCTAssertEqual(recordings.recent().map(\.text), ["Tiny Acrobatics"])
    }

    func testF16DuringATranscriptionPastesNothingButHistoryKeepsIt() async {
        let model = SlowModel(), delivered = Delivered()
        let (c, recordings) = loop(model, delivered)
        c.press()
        c.release()
        await settle(model, pending: 1)
        c.discard()
        XCTAssertEqual(c.state, .idle)
        await model.answer("never pasted")
        await waitFor { recordings.recent().first?.text != nil }
        XCTAssertEqual(delivered.texts, [])
        XCTAssertEqual(recordings.recent().map(\.text), ["never pasted"])
    }

    func testF16WhileRecordingSavesNothing() async {
        let model = SlowModel(), delivered = Delivered()
        let (c, recordings) = loop(model, delivered)
        c.press()
        c.discard()
        XCTAssertEqual(c.state, .idle)
        let pending = await model.pending
        XCTAssertEqual(pending, 0)
        XCTAssertTrue(recordings.recent().isEmpty)
        c.discard()   // nothing running: nothing happens
        XCTAssertEqual(c.state, .idle)
    }

    func testANewRecordingWhileTheLastIsStillTranscribing() async {
        let model = SlowModel(), delivered = Delivered()
        let (c, _) = loop(model, delivered)
        c.press()
        c.release()
        await settle(model, pending: 1)
        c.press()
        XCTAssertEqual(c.state, .recording)
        await model.answer("first")
        await waitFor { delivered.texts == ["first"] }
        XCTAssertEqual(c.state, .recording, "the new recording keeps going")
    }

    func testHistoryKeepsTheNewestOnly() {
        let recordings = DictationRecordings(directory: dir)
        recordings.keep = 2
        for i in 0..<3 { _ = recordings.save([0.1], at: Date(timeIntervalSince1970: 1_800_000_000 + Double(i) * 60)) }
        XCTAssertEqual(recordings.recent().count, 2)
        // two in the same second both stay
        recordings.keep = 10
        let date = Date(timeIntervalSince1970: 1_900_000_000)
        XCTAssertNotEqual(recordings.save([0.1], at: date), recordings.save([0.1], at: date))
        XCTAssertNotNil(DictationRecordings.date(of: recordings.recent()[0].wav))
    }
}
