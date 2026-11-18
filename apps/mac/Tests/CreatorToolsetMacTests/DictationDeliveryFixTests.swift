@testable import CreatorToolsetMac
import XCTest

/// Two pastes close together, a password manager's clipboard, words in brackets, and a speech server that is off.
final class DictationDeliveryFixTests: XCTestCase {
    /// The clipboard with a promise on it; `targetReads` is the app handling the next ⌘V.
    private final class FakePasteboard: PasteboardAccess {
        var changeCount = 0
        var contents = PasteboardSnapshot(items: [])
        var promised: String?
        var onRead: (() -> Void)?
        var got: [String] = []

        func snapshot() -> PasteboardSnapshot { contents }

        func restore(_ snapshot: PasteboardSnapshot) {
            contents = snapshot
            promised = nil
            changeCount += 1
        }

        func promise(_ text: String, markers: [String], onRead: @escaping () -> Void) {
            contents = PasteboardSnapshot(items: [markers.map { PasteboardRepresentation(type: $0, data: Data()) }])
            promised = text
            self.onRead = onRead
            changeCount += 1
        }

        func targetReads() {
            got.append(promised ?? "<nothing>")
            onRead?()
        }
    }

    private var pasteboard: FakePasteboard!
    private var pending: [() -> Void] = []
    private var commandVs = 0
    private var session: PasteboardSession!

    override func setUp() {
        pasteboard = FakePasteboard()
        pending = []
        commandVs = 0
        session = PasteboardSession(
            pasteboard: pasteboard,
            settleDelay: 0.25,
            postPaste: { [unowned self] in self.commandVs += 1 },
            schedule: { [unowned self] _, work in self.pending.append(work) }
        )
    }

    /// Runs everything scheduled so far (settle delays, give-ups), not what that schedules.
    private func runPending() {
        let work = pending
        pending = []
        work.forEach { $0() }
    }

    func testEachCommandVGetsItsOwnTextInOrder() {
        let original = PasteboardSnapshot(items: [[PasteboardRepresentation(type: "public.utf8-plain-text", data: Data("mine".utf8))]])
        pasteboard.contents = original
        session.paste("one")
        session.paste("two")
        XCTAssertEqual(commandVs, 1, "the second waits for the first to be read")
        pasteboard.targetReads()
        pending.removeFirst()()  // the settle delay: "one" is done, "two" goes
        XCTAssertEqual(commandVs, 2)
        pasteboard.targetReads()
        pending.remove(at: 1)()  // the settle delay of "two"; pending[0] is the stale give-up of "one"
        pending.forEach { $0() }  // stale give-ups change nothing
        XCTAssertEqual(pasteboard.got, ["one", "two"])
        XCTAssertEqual(pasteboard.contents, original)
        XCTAssertFalse(session.isRestorePending)
    }

    func testAnUnreadPasteGivenUpStillSendsTheNext() {
        session.paste("one")
        session.paste("two")
        runPending()  // settle delay and the 3 s give-up of "one", never read
        XCTAssertEqual(commandVs, 2)
        pasteboard.targetReads()
        XCTAssertEqual(pasteboard.got, ["two"])
    }

    func testAPasswordManagersClipboardIsClearedNotPutBack() {
        for marker in ["org.nspasteboard.ConcealedType", "org.nspasteboard.TransientType"] {
            setUp()
            pasteboard.contents = PasteboardSnapshot(items: [[
                PasteboardRepresentation(type: "public.utf8-plain-text", data: Data("hunter2".utf8)),
                PasteboardRepresentation(type: marker, data: Data()),
            ]])
            session.paste("one")
            pasteboard.targetReads()
            runPending()
            XCTAssertEqual(pasteboard.contents, PasteboardSnapshot(items: []), marker)
        }
    }

    func testWordsInBracketsOrStarsStay() {
        XCTAssertEqual(WhisperKitTranscriber.sanitize("ship v2 (the beta build) on Friday"), "ship v2 (the beta build) on Friday")
        XCTAssertEqual(WhisperKitTranscriber.sanitize("that was *really* good"), "that was *really* good")
        XCTAssertEqual(WhisperKitTranscriber.sanitize(" (music) "), "")
        XCTAssertEqual(WhisperKitTranscriber.sanitize("*laughs* (music) [BLANK_AUDIO]"), "")
    }

    func testAServerThatFailedIsSkippedForAMinuteThenAskedAgain() async throws {
        let site = FakeSite()
        site.answer = { _ in (500, "{}") }
        let endpoint = site.url.appendingPathComponent("api/transcribe")
        let server = SpeechServerTranscriber(endpoint: endpoint)
        let audio = [Float](repeating: 0.1, count: 1_600)
        do { _ = try await server.transcribe(audio, context: TranscriptionContext()); XCTFail("500 is a failure") } catch {}
        XCTAssertEqual(site.requests.count, 1)
        do { _ = try await server.transcribe(audio, context: TranscriptionContext()); XCTFail("skipped") } catch {}
        XCTAssertEqual(site.requests.count, 1, "skipped, no wait for the timeout")

        SpeechServerTranscriber.downUntil.withLock { $0[endpoint] = Date() - 1 }
        site.answer = { _ in (200, #"{"text":"back"}"#) }
        let text = try await server.transcribe(audio, context: TranscriptionContext()).text
        XCTAssertEqual(text, "back")
        XCTAssertEqual(site.requests.count, 2)
    }
}
