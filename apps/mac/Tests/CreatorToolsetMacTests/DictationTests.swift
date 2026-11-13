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
        XCTAssertEqual(p.keys, .holdFn)
        XCTAssertEqual(p.engine, .thisMac)
        XCTAssertNil(p.model, "none picked: the default for the person's languages")
        XCTAssertEqual(p.keep, 10)
        XCTAssertTrue(p.sounds)
    }

    func testSaveAndLoad() {
        let d = defaults()
        var p = DictationPrefs()
        p.on = false
        p.keys = DictationKeys(talk: .key(Shortcut(keyCode: 49, carbonModifiers: 2048, display: "⌥Space")), cancel: .key(.function(106, "F16")))
        p.engine = .server
        p.model = "whisper-base.en"
        p.keep = 25
        p.sounds = false
        p.save(d)
        XCTAssertEqual(DictationPrefs.load(d), p)
        p.keys.talk = .hold(.rightOption)
        p.keys.cancel = nil
        p.save(d)
        XCTAssertEqual(DictationPrefs.load(d).keys, DictationKeys(talk: .hold(.rightOption)))
    }

    func testAnUnknownModelLoadsAsTheDefault() {
        let d = defaults()
        d.set("whisper-gigantic", forKey: DictationPrefs.keys.model)
        d.set(0, forKey: DictationPrefs.keys.keep)
        XCTAssertNil(DictationPrefs.load(d).model)
        XCTAssertEqual(DictationPrefs.load(d).keep, 1)
    }

    func testParakeetIsTheDefaultForEnglishAloneAndTurboOtherwise() {
        XCTAssertEqual(ModelRegistry.standardID(for: ["en"]), "parakeet-tdt-0.6b-v3")
        XCTAssertEqual(ModelRegistry.standardID(for: ["en", "et"]), "whisper-large-v3-turbo")
        XCTAssertEqual(ModelRegistry.standardID(for: []), "whisper-large-v3-turbo")
        let v2 = ModelRegistry.find("parakeet-tdt-0.6b-v2")!
        XCTAssertEqual(ParakeetFiles.folder(v2, in: URL(fileURLWithPath: "/d")).path, "/d/models/parakeet/parakeet-tdt-0.6b-v2")
        XCTAssertTrue(v2.transcriber() is ParakeetTranscriber)
    }

    func testImportTakesTheEarlierAppsChoices() throws {
        let json = """
        {"hotkey":{"key":"f13"},"model":{"id":"whisper-small"},
         "extras":{"keepRecordings":25,"sounds":false,"server":"http://tiny-acrobatics.example:7886/api/transcribe"}}
        """
        let p = DictationPrefs().importing(settings: Data(json.utf8), legacyKey: nil)
        XCTAssertEqual(p.keys, .functionKeys, "F13 talked there: F13–F16 here, no hold key")
        XCTAssertEqual(p.model, "whisper-small")
        XCTAssertEqual(p.keep, 25)
        XCTAssertFalse(p.sounds)
        XCTAssertTrue(p.on)
    }

    func testTheEarlierAppsSpeechServerComesOverApartAndOnlyWhenItIsOne() {
        let with = #"{"extras":{"server":" http://tiny-acrobatics.example:7886/api/transcribe "}}"#
        XCTAssertEqual(DictationPrefs.earlierServer(settings: Data(with.utf8)), "http://tiny-acrobatics.example:7886/api/transcribe")
        XCTAssertNil(DictationPrefs.earlierServer(settings: Data(#"{"extras":{"server":""}}"#.utf8)))
        XCTAssertNil(DictationPrefs.earlierServer(settings: Data(#"{"extras":{"server":"not an address"}}"#.utf8)))
        XCTAssertNil(DictationPrefs.earlierServer(settings: nil))
        XCTAssertEqual(DictationPrefs().importing(settings: Data(with.utf8), legacyKey: nil).server, "", "only `earlierServer` takes it")
        let d = defaults()
        var p = DictationPrefs()
        p.server = "http://tiny-acrobatics.example:7886/api/transcribe"
        p.languages = ["et", "en"]
        p.save(d)
        XCTAssertEqual(DictationPrefs.load(d), p)
        p.languages = nil
        p.save(d)
        XCTAssertNil(DictationPrefs.load(d).languages, "no ticks: back to the server's or the Mac's languages")
    }

    func testImportFallsBackToTheOlderKeyAndKeepsDefaultsForTheRest() {
        let p = DictationPrefs().importing(settings: nil, legacyKey: "right-option")
        XCTAssertEqual(p.keys.talk, .hold(.rightOption))
        XCTAssertEqual(p.keys.cancel, .key(.function(106, "F16")))
        XCTAssertEqual(p, { var d = DictationPrefs(); d.keys = .functionKeys; d.keys.talk = .hold(.rightOption); return d }())
        XCTAssertEqual(DictationPrefs().importing(settings: Data("{}".utf8), legacyKey: "f13").keys, .functionKeys)
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

/// The person's own speech server first, this Mac's model when it doesn't answer, and the pill while the model loads.
@MainActor
final class SpeechServerTests: XCTestCase {
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

    /// This Mac's model, stood in for: it answers "from this Mac", and loads only when `finishLoading` is called.
    private actor LocalModel: LoadingTranscriber {
        let modelID = "local"
        nonisolated let onDisk: Bool
        private var isLoaded: Bool
        private var waiting: [CheckedContinuation<Void, Never>] = []
        private(set) var calls = 0
        init(loaded: Bool = true, onDisk: Bool = true) { isLoaded = loaded; self.onDisk = onDisk }
        func loaded() async -> Bool { isLoaded }
        func unload() async { isLoaded = false }
        func load() async throws {
            if isLoaded { return }
            await withCheckedContinuation { waiting.append($0) }
        }
        func finishLoading() { isLoaded = true; waiting.forEach { $0.resume() }; waiting = [] }
        var loading: Bool { !waiting.isEmpty }
        func transcribe(_ audio: [Float], context: TranscriptionContext) async throws -> Transcript {
            calls += 1
            return Transcript(text: "from this Mac")
        }
    }

    @MainActor private final class Said: DictationObserver {
        var events: [String] = []
        func dictationStarted() { events.append("listening") }
        func dictationTranscribing() { events.append("transcribing") }
        func dictationWaitingForModel() { events.append("getting the model ready") }
        func dictationFinished(_ result: DictationResult) { events.append("done") }
        func dictationFailed(_ error: Error) { events.append("failed: \(DictationPill.message(for: error) ?? "")") }
    }

    private var dir: URL!

    override func setUp() async throws {
        dir = FileManager.default.temporaryDirectory.appendingPathComponent("dictation-server-\(UUID().uuidString)")
    }

    override func tearDown() async throws {
        try? FileManager.default.removeItem(at: dir)
    }

    @MainActor
    private func dictate(local: LocalModel, server: URL?, said: Said? = nil) async -> (DictationController, Delivered) {
        let delivered = Delivered()
        let c = DictationController(capture: FakeCapture(), transcriber: local, observers: [said ?? Said()], delivery: delivered,
                                    recordings: DictationRecordings(directory: dir))
        c.focus = { nil }
        c.remote = server.map(SpeechServerTranscriber.init)
        c.press()
        c.release()
        return (c, delivered)
    }

    @MainActor
    private func waitFor(_ check: () async -> Bool) async {
        for _ in 0..<1000 where !(await check()) { try? await Task.sleep(nanoseconds: 5_000_000) }
    }

    @MainActor
    func testTheServerIsAskedFirstWithTheRecordingAsAWav() async throws {
        let site = FakeSite()
        site.answer = { _ in (200, #"{"text":" from the server "}"#) }
        let local = LocalModel()
        let (c, delivered) = await dictate(local: local, server: site.url.appendingPathComponent("api/transcribe"))
        await waitFor { c.state == .idle }
        XCTAssertEqual(delivered.texts, ["from the server"])
        let calls = await local.calls
        XCTAssertEqual(calls, 0, "this Mac's model is not asked")
        let request = try XCTUnwrap(site.requests.first)
        XCTAssertEqual(request.method, "POST")
        XCTAssertEqual(request.path, "/api/transcribe")
        XCTAssertEqual(request.headers.first { $0.key.lowercased() == "content-type" }?.value, "audio/wav")
        XCTAssertEqual(String(decoding: request.body.prefix(4), as: UTF8.self), "RIFF")
    }

    @MainActor
    func testAServerThatFailsOrIsOffFallsBackToThisMac() async throws {
        let site = FakeSite()
        site.answer = { _ in (500, #"{"error":"busy"}"#) }
        let (c, delivered) = await dictate(local: LocalModel(), server: site.url.appendingPathComponent("api/transcribe"))
        await waitFor { c.state == .idle }
        XCTAssertEqual(delivered.texts, ["from this Mac"])
        // nothing listens there at all
        let off = URL(string: "http://127.0.0.1:9/api/transcribe")!
        let (c2, delivered2) = await dictate(local: LocalModel(), server: off)
        await waitFor { c2.state == .idle }
        XCTAssertEqual(delivered2.texts, ["from this Mac"])
    }

    @MainActor
    func testWithAServerDownAndNoModelHereNothingDownloadsAndHistoryKeepsIt() async {
        let off = URL(string: "http://127.0.0.1:9/api/transcribe")!
        let said = Said()
        let local = LocalModel(loaded: false, onDisk: false)
        let (c, delivered) = await dictate(local: local, server: off, said: said)
        await waitFor { c.state == .idle }
        XCTAssertEqual(delivered.texts, [])
        let loading = await local.loading
        XCTAssertFalse(loading)
        XCTAssertEqual(said.events.last, "failed: Your speech server didn't answer · saved in History")
    }

    @MainActor
    func testThePillSaysTheModelIsGettingReadyInsteadOfCountingSeconds() async {
        let said = Said()
        let local = LocalModel(loaded: false)
        let (c, delivered) = await dictate(local: local, server: nil, said: said)
        await waitFor { await local.loading }
        XCTAssertEqual(said.events, ["listening", "transcribing", "getting the model ready"])
        await local.finishLoading()
        await waitFor { c.state == .idle }
        XCTAssertEqual(said.events, ["listening", "transcribing", "getting the model ready", "transcribing", "done"])
        XCTAssertEqual(delivered.texts, ["from this Mac"])
    }

    @MainActor
    func testACancelWhileTheModelLoadsKeepsThePillQuietAndTheRecordingInHistory() async {
        let said = Said()
        let local = LocalModel(loaded: false)
        let (c, delivered) = await dictate(local: local, server: nil, said: said)
        await waitFor { await local.loading }
        c.discard()
        await local.finishLoading()
        let recordings = DictationRecordings(directory: dir)
        await waitFor { recordings.recent().first?.text != nil }
        XCTAssertEqual(said.events, ["listening", "transcribing", "getting the model ready", "failed: Cancelled"])
        XCTAssertEqual(delivered.texts, [])
        XCTAssertEqual(recordings.recent().first?.text, "from this Mac")
    }

    func testAddressesAndTimeouts() {
        XCTAssertNotNil(SpeechServerTranscriber.url("http://tiny-acrobatics.example:7886/api/transcribe"))
        XCTAssertNil(SpeechServerTranscriber.url(""))
        XCTAssertNil(SpeechServerTranscriber.url("tiny-acrobatics.example"))
        XCTAssertNil(SpeechServerTranscriber.url("ftp://tiny-acrobatics.example/x"))
        XCTAssertEqual(SpeechServerTranscriber.timeout(seconds: 0), 4)
        XCTAssertEqual(SpeechServerTranscriber.timeout(seconds: 20), 9)
    }
}

final class SetupPageTests: XCTestCase {
    func testTheLineFollowsTheTalkKey() {
        XCTAssertEqual(SetupFacts.line(for: .key(.function(105, "F13"))), "Press F13, speak, press again.")
        XCTAssertEqual(SetupFacts.line(for: .hold(.fn)), "Hold fn, speak, and let go.")
        XCTAssertEqual(SetupFacts.line(for: nil), "Choose a talk key, then speak.")
        XCTAssertEqual(SetupFacts.summary(["English"]), "English")
        XCTAssertEqual(SetupFacts.summary(["English", "Estonian", "Finnish"]), "English +2")
    }

    func testLanguagesListTheMacsAndTickedFirst() {
        let menu = LanguageChecklist.menu(preferred: ["en", "xx"], ticked: ["et"])
        XCTAssertEqual(menu.mac, ["en", "et"], "unknown codes are left out")
        XCTAssertFalse(menu.common.contains("en"))
        XCTAssertFalse(menu.more.contains("et"))
    }

    /// The menu bar's Dictate while the other dictation app has the keys: it quits that app and switches dictation on
    /// here (it used to quit and stop there, leaving dictation off for someone who had switched it off).
    @MainActor
    func testDictateWhileTheOtherAppIsOpenQuitsItAndTurnsDictationOn() {
        let d = Dictation.shared
        let was = d.prefs.on
        defer { d.command("on", was ? "1" : "0"); d.earlierAppOpen = false }
        d.command("on", "0")
        d.earlierAppOpen = true
        var quits = 0
        d.toggle { quits += 1 }
        XCTAssertEqual(quits, 1)
        XCTAssertTrue(d.prefs.on)
    }
}

final class DictationKeysTests: XCTestCase {
    private let optionSpace = KeyBinding.key(Shortcut(keyCode: 49, carbonModifiers: 2048, display: "⌥Space"))

    func testNoTalkKeyIsKeptAsNone() {
        let name = "dictation-keys-\(UUID().uuidString)"
        let d = UserDefaults(suiteName: name)!
        defer { d.removePersistentDomain(forName: name) }
        DictationKeys().save(d)
        XCTAssertTrue(DictationKeys.isSaved(d), "the next launch must not put the first keys back")
        XCTAssertEqual(DictationKeys.load(d), DictationKeys())
    }

    func testFirstKeysFollowTheKeyboard() {
        XCTAssertEqual(DictationKeys.first(hadDictation: false, keyboardHasF13: true), .functionKeys)
        XCTAssertEqual(DictationKeys.first(hadDictation: true, keyboardHasF13: false), .functionKeys, "keeps the keys it had")
        let laptop = DictationKeys.first(hadDictation: false, keyboardHasF13: false)
        XCTAssertEqual(laptop.talk, .hold(.fn))
        XCTAssertNil(laptop.history)
        XCTAssertNil(laptop.file)
        XCTAssertNil(laptop.cancel)
    }

    func testClashesAreRefusedWithASentence() {
        let keys = DictationKeys.functionKeys
        XCTAssertEqual(keys.problem(.key(.function(107, "F14")), for: .talk, recording: nil), "That clashes with History (F14).")
        XCTAssertNil(keys.problem(.key(.function(105, "F13")), for: .talk, recording: nil), "its own key again")
        XCTAssertEqual(keys.problem(.key(.standard), for: .file, recording: .standard), "That clashes with the recording shortcut (⌥⇧R).")
        XCTAssertEqual(keys.problem(.key(.function(106, "F16")), for: nil, recording: nil), "That clashes with Cancel (F16).")
        XCTAssertEqual(keys.problem(.hold(.fn), for: .history, recording: nil), "Only Talk can be a key you hold.")
        // holding right ⌥ to talk and ⌥Space to cancel: the hold would start on the way to the combination
        var held = DictationKeys(talk: .hold(.rightOption))
        XCTAssertEqual(held.problem(optionSpace, for: .cancel, recording: nil), "That clashes with Talk (Hold right ⌥).")
        held.talk = .hold(.fn)
        XCTAssertNil(held.problem(optionSpace, for: .cancel, recording: nil))
    }

    func testAPickerTakesACombinationAFunctionKeyOrALoneHeldModifier() {
        var c = KeyCapture(allowsHold: true)
        XCTAssertEqual(c.keyDown(keyCode: 49, flags: .option, characters: " "), .binding(optionSpace))
        XCTAssertEqual(c.keyDown(keyCode: 105, flags: .function, characters: nil), .binding(.key(.function(105, "F13"))))
        if case .refused = c.keyDown(keyCode: 0, flags: [], characters: "a") {} else { XCTFail("a bare letter would type nothing") }
        XCTAssertEqual(c.keyDown(keyCode: 53, flags: [], characters: nil), .keep)
        XCTAssertEqual(c.keyDown(keyCode: 51, flags: [], characters: nil), .clear)
        // right ⌥ down and up on its own
        XCTAssertNil(c.flagsChanged(keyCode: 61, flags: .option))
        XCTAssertEqual(c.flagsChanged(keyCode: 61, flags: []), .binding(.hold(.rightOption)))
        // ⌥ down, then a key: a combination, not a hold
        XCTAssertNil(c.flagsChanged(keyCode: 58, flags: .option))
        _ = c.keyDown(keyCode: 49, flags: .option, characters: " ")
        XCTAssertNil(c.flagsChanged(keyCode: 58, flags: []))
        // ⌘ held, then ⌥: not alone
        XCTAssertNil(c.flagsChanged(keyCode: 55, flags: .command))
        XCTAssertNil(c.flagsChanged(keyCode: 58, flags: [.command, .option]))
        XCTAssertNil(c.flagsChanged(keyCode: 58, flags: .command))
        // fn on its own
        XCTAssertNil(c.flagsChanged(keyCode: 63, flags: .function))
        XCTAssertEqual(c.flagsChanged(keyCode: 63, flags: []), .binding(.hold(.fn)))
        var noHold = KeyCapture(allowsHold: false)
        XCTAssertNil(noHold.flagsChanged(keyCode: 61, flags: .option))
        XCTAssertNil(noHold.flagsChanged(keyCode: 61, flags: []))
    }

    func testTheTapMatchesTheModifiersButNotFn() {
        let set = KeycodeSet()
        set.set([keyCombo(49, 2048), keyCombo(105, 0)])
        XCTAssertTrue(set.press(49, modifiers: carbonModifiers(.maskAlternate)))
        XCTAssertFalse(set.press(49, modifiers: 0), "Space alone types a space")
        XCTAssertTrue(set.press(105, modifiers: carbonModifiers(.maskSecondaryFn)), "F13 arrives with fn")
        XCTAssertTrue(set.release(49), "its key-up is swallowed too")
        XCTAssertFalse(set.release(49))
        XCTAssertFalse(set.release(0))
    }
}

final class EarlierAppTests: XCTestCase {
    func testNoKeyIsRegisteredWhileTheEarlierAppRuns() {
        XCTAssertTrue(Dictation.earlierAppRunning(in: ["com.apple.finder", Dictation.earlierAppID, nil]))
        XCTAssertFalse(Dictation.earlierAppRunning(in: ["com.apple.finder", nil]))
        XCTAssertTrue(Dictation.keysLive(on: true, paused: false, earlierAppOpen: false))
        XCTAssertFalse(Dictation.keysLive(on: true, paused: false, earlierAppOpen: true), "it has the same keys")
        XCTAssertFalse(Dictation.keysLive(on: true, paused: true, earlierAppOpen: false), "a key picker is open")
        XCTAssertFalse(Dictation.keysLive(on: false, paused: false, earlierAppOpen: false))
        // the menu row says why a click does nothing while the earlier app has the keys
        XCTAssertEqual(Dictation.menuTitle(phase: .off, earlierAppOpen: true), EarlierDictationApp.switchLine)
        XCTAssertEqual(Dictation.menuTitle(phase: .off, earlierAppOpen: false), "Dictate")
    }
}

/// The settings answer the page reads: built from a dictionary literal, where a key written twice stops the app.
@MainActor
final class DictationBridgeStateTests: XCTestCase {
    func testTheSettingsAnswerBuildsWithEveryField() {
        let state = Dictation.shared.bridgeState()
        for key in ["on", "keys", "picking", "paused", "setUp", "engine", "model", "models", "keep", "sounds", "server", "needs"] {
            XCTAssertNotNil(state[key], "missing \(key)")
        }
    }
}

/// The setup page's own model download (SetupGuide `SetupDownload`): the page leaves no download behind it was not asked for.
final class SetupDownloadTests: XCTestCase {
    func testLeavingWithoutGetStartedStopsOnlyThePagesOwnDownload() {
        var page = SetupDownload()
        page.opened()
        page.prepared(before: nil, after: "whisper-large-v3-turbo")
        // Not now, Esc, the close button, ⌘W: stopped
        XCTAssertEqual(page.closed(gotStarted: false, running: "whisper-large-v3-turbo"), "whisper-large-v3-turbo")
        // Get Started: it goes on
        page.opened()
        page.prepared(before: nil, after: "whisper-large-v3-turbo")
        XCTAssertNil(page.closed(gotStarted: true, running: "whisper-large-v3-turbo"))
        // one that was running before the page opened (Settings' Download) is not the page's
        page.opened()
        page.prepared(before: "parakeet-tdt-0.6b-v3", after: "parakeet-tdt-0.6b-v3")
        XCTAssertNil(page.closed(gotStarted: false, running: "parakeet-tdt-0.6b-v3"))
        // the page's own one already finished, another one runs now: that one goes on
        page.opened()
        page.prepared(before: nil, after: "whisper-large-v3-turbo")
        XCTAssertNil(page.closed(gotStarted: false, running: "whisper-small"))
        // a model already here: nothing downloads, nothing to stop
        page.opened()
        page.prepared(before: nil, after: nil)
        XCTAssertNil(page.closed(gotStarted: false, running: nil))
    }

    func testNothingStartsOnceThePageHasGone() {
        var page = SetupDownload()
        XCTAssertFalse(page.mayPrepare)
        page.opened()
        XCTAssertTrue(page.mayPrepare)
        XCTAssertNil(page.closed(gotStarted: false, running: nil))
        // the server's languages answer after Not now: no download may start, and none would count as the page's
        XCTAssertFalse(page.mayPrepare)
        page.prepared(before: nil, after: "whisper-large-v3-turbo")
        XCTAssertNil(page.started)
    }
}
