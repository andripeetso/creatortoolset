import XCTest
@testable import CreatorToolsetMac

/// The loop's order, the mic going away, History's pruning, and the device-change reading.
final class DictationLoopFixTests: XCTestCase {
    private final class FakeCapture: Capturing {
        var recording = false
        /// Thrown by the next finish instead of returning the recording.
        var failure: Error?
        func start() throws { recording = true }
        func finish() throws -> [Float] {
            defer { recording = false; failure = nil }
            if let failure { throw failure }
            return recording ? [Float](repeating: 0.1, count: 16_000) : []
        }
        func stop() -> [Float] { (try? finish()) ?? [] }
    }

    private final class Delivered: Delivering {
        var texts: [String] = []
        func deliver(_ text: String, focusAtStart: FocusSnapshot?) throws { texts.append(text) }
    }

    @MainActor private final class Failures: DictationObserver {
        var errors: [Error] = []
        func dictationFailed(_ error: Error) { errors.append(error) }
    }

    /// Answers the transcription started `n`-th (from 0) whenever the test says, in any order.
    private actor Model: Transcriber {
        let modelID = "fake"
        private var waiting: [Int: CheckedContinuation<Transcript, Error>] = [:]
        private var started = 0
        func transcribe(_ audio: [Float], context: TranscriptionContext) async throws -> Transcript {
            let n = started
            started += 1
            return try await withCheckedThrowingContinuation { waiting[n] = $0 }
        }
        func answer(_ n: Int, _ text: String) { waiting.removeValue(forKey: n)!.resume(returning: Transcript(text: text)) }
        func fail(_ n: Int) { waiting.removeValue(forKey: n)!.resume(throwing: TranscriberError.notLoaded) }
        var count: Int { started }
    }

    private var dir: URL!

    override func setUp() async throws {
        dir = FileManager.default.temporaryDirectory.appendingPathComponent("dictation-fix-\(UUID().uuidString)")
    }

    override func tearDown() async throws {
        try? FileManager.default.removeItem(at: dir)
    }

    @MainActor
    private func loop(_ model: Model, _ delivered: Delivered, _ capture: FakeCapture? = nil,
                      _ failures: Failures? = nil) -> (DictationController, DictationRecordings) {
        let recordings = DictationRecordings(directory: dir)
        let c = DictationController(capture: capture ?? FakeCapture(), transcriber: model, observers: [failures ?? Failures()],
                                    delivery: delivered,
                                    recordings: recordings)
        c.focus = { nil }
        return (c, recordings)
    }

    @MainActor private func dictate(_ c: DictationController, _ model: Model, started: Int) async {
        c.press()
        c.release()
        for _ in 0..<200 where await model.count < started { try? await Task.sleep(nanoseconds: 5_000_000) }
    }

    @MainActor private func waitFor(_ check: () -> Bool) async {
        for _ in 0..<200 where !check() { try? await Task.sleep(nanoseconds: 5_000_000) }
    }

    @MainActor func testAShortDictationWaitsForTheLongerOneReleasedBeforeIt() async {
        let model = Model(), delivered = Delivered()
        let (c, recordings) = loop(model, delivered)
        await dictate(c, model, started: 1)
        await dictate(c, model, started: 2)
        await model.answer(1, "second")
        await waitFor { recordings.recent().contains { $0.text == "second" } }
        try? await Task.sleep(nanoseconds: 50_000_000)
        XCTAssertEqual(delivered.texts, [], "kept in History, not pasted ahead of the first")
        await model.answer(0, "first")
        await waitFor { delivered.texts.count == 2 }
        XCTAssertEqual(delivered.texts, ["first", "second"])
        XCTAssertEqual(c.state, .idle)
    }

    @MainActor func testAnEarlierFailureDoesNotHoldBackTheNext() async {
        let model = Model(), delivered = Delivered()
        let (c, _) = loop(model, delivered)
        await dictate(c, model, started: 1)
        await dictate(c, model, started: 2)
        await model.answer(1, "second")
        await model.fail(0)
        // the on-device model gets one more try before the dictation fails
        for _ in 0..<200 where await model.count < 3 { try? await Task.sleep(nanoseconds: 5_000_000) }
        await model.fail(2)
        await waitFor { delivered.texts == ["second"] }
        XCTAssertEqual(delivered.texts, ["second"])
        await waitFor { c.state == .idle }
        XCTAssertEqual(c.state, .idle)
    }

    @MainActor func testADiscardedTranscriptionNeitherCountsNorHoldsBackTheNext() async {
        let model = Model(), delivered = Delivered()
        let (c, _) = loop(model, delivered)
        await dictate(c, model, started: 1)
        c.discard()
        await dictate(c, model, started: 2)
        XCTAssertEqual(c.state, .transcribing)
        await model.answer(1, "after the cancel")
        await waitFor { delivered.texts == ["after the cancel"] }
        XCTAssertEqual(delivered.texts, ["after the cancel"])
        XCTAssertEqual(c.state, .idle, "the cancelled one, still running, no longer counts")
        await model.answer(0, "cancelled")
        try? await Task.sleep(nanoseconds: 50_000_000)
        XCTAssertEqual(delivered.texts, ["after the cancel"])
        XCTAssertEqual(c.state, .idle)
    }

    @MainActor func testTheMicGoingAwayKeepsWhatItCaughtInHistoryAndPastesNothing() async {
        let model = Model(), delivered = Delivered(), capture = FakeCapture(), failures = Failures()
        let (c, recordings) = loop(model, delivered, capture, failures)
        c.press()
        capture.failure = CaptureError.routeChanged(captured: [Float](repeating: 0.1, count: 8_000))
        c.release()
        XCTAssertEqual(c.state, .idle)
        XCTAssertEqual(recordings.recent().count, 1)
        XCTAssertNil(recordings.recent().first?.text)
        XCTAssertEqual(DictationPill.message(for: failures.errors[0]), "microphone went away while recording · saved in History")
        let started = await model.count
        XCTAssertEqual(started, 0)
        XCTAssertEqual(delivered.texts, [])
    }

    @MainActor func testTheCaptureBufferKeepsWhatItCaughtWhenTheRouteChanged() {
        let buffer = CaptureBuffer()
        buffer.reset(startedAt: 0)
        [Float](repeating: 0.2, count: 160).withUnsafeBufferPointer { buffer.append($0, inputFrames: 480, at: 0) }
        buffer.markRouteChanged()
        XCTAssertThrowsError(try buffer.finish()) { error in
            guard case CaptureError.routeChanged(let captured) = error else { return XCTFail("\(error)") }
            XCTAssertEqual(captured.count, 160)
        }
        buffer.reset(startedAt: 0)
        XCTAssertEqual(try buffer.finish(), [], "the next recording starts clean")
    }

    @MainActor func testOnlyTheRecordedDeviceGoingAwayIsARouteChange() {
        let built = InputDevice(sampleRate: 48_000, channels: 1, id: 5)
        let same = DeviceWatcher.Snapshot(isAlive: true, device: built)
        XCTAssertEqual(HALInput.classify(built: built, current: same), .none, "another default input changes nothing")
        XCTAssertEqual(HALInput.classify(built: built, current: .init(isAlive: false, device: built)), .route)
        let faster = InputDevice(sampleRate: 96_000, channels: 1, id: 5)
        XCTAssertEqual(HALInput.classify(built: built, current: .init(isAlive: true, device: faster)), .format(faster))
        let broken = InputDevice(sampleRate: 0, channels: 1, id: 5)
        XCTAssertEqual(HALInput.classify(built: built, current: .init(isAlive: true, device: broken)), .route)
    }

    @MainActor func testHistoryPrunesOnlyTranscribedRecordings() throws {
        let recordings = DictationRecordings(directory: dir)
        recordings.keep = 1
        let day = 1_800_000_000.0
        let a = try XCTUnwrap(recordings.save([0.1], at: Date(timeIntervalSince1970: day)))
        recordings.saveTranscript("a", for: a)
        let failed = try XCTUnwrap(recordings.save([0.1], at: Date(timeIntervalSince1970: day + 60)))
        let running = try XCTUnwrap(recordings.save([0.1], at: Date(timeIntervalSince1970: day + 120)))
        XCTAssertEqual(recordings.recent().count, 3, "neither the failed nor the running one is pruned")
        recordings.saveTranscript("done", for: running)
        XCTAssertEqual(recordings.recent().map(\.wav.lastPathComponent), [running, failed].map(\.lastPathComponent), "the older transcribed one goes")
        recordings.saveTranscript("late", for: a)
        XCTAssertFalse(FileManager.default.fileExists(atPath: DictationRecordings.transcriptURL(for: a).path))
    }
}
