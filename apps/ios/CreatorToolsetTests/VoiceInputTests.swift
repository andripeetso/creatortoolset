import XCTest
@testable import CreatorToolset

/// The assistant's mic: what the message box's buttons are, and a recording's way from the mic to the box.
@MainActor
final class VoiceInputTests: XCTestCase {
    func testTheMicTakesTheRoundButtonOnlyWhenTheBoxIsEmptyAndNoReplyIsBeingWritten() {
        let empty = ComposerButtons(empty: true, working: false, stops: false, mic: .idle)
        XCTAssertEqual(empty.round, .mic)
        XCTAssertFalse(empty.micBeside)
        // words in the box: Send, the mic beside it
        let typed = ComposerButtons(empty: false, working: false, stops: false, mic: .idle)
        XCTAssertEqual(typed.round, .send)
        XCTAssertTrue(typed.micBeside)
        // a reply being written: its Stop stays, the mic beside it
        let replying = ComposerButtons(empty: true, working: true, stops: true, mic: .idle)
        XCTAssertEqual(replying.round, .stopReply)
        XCTAssertTrue(replying.micBeside)
    }

    func testWhileRecordingThereIsOneRedStopAndItIsTheRecordings() {
        let recording = ComposerButtons(empty: true, working: true, stops: true, mic: .recording(since: Date()))
        XCTAssertEqual(recording.round, .stopRecording)
        XCTAssertFalse(recording.micBeside)
        let writing = ComposerButtons(empty: false, working: false, stops: false, mic: .writing)
        XCTAssertEqual(writing.round, .writing)
        XCTAssertFalse(writing.micBeside)
    }

    func testAMessageBoxWithoutAMicIsAsBefore() {
        XCTAssertEqual(ComposerButtons(empty: true, working: false, stops: false, mic: nil).round, .send)
        XCTAssertEqual(ComposerButtons(empty: true, working: true, stops: true, mic: nil).round, .stopReply)
        XCTAssertFalse(ComposerButtons(empty: true, working: false, stops: false, mic: nil).micBeside)
    }

    func testSpokenWordsGoAfterWhatIsInTheBox() {
        XCTAssertEqual(VoiceInput.appended("Find my next idea", to: ""), "Find my next idea")
        XCTAssertEqual(VoiceInput.appended("for the reel", to: "An idea  \n"), "An idea for the reel")
        XCTAssertEqual(VoiceInput.clock(7), "0:07")
        XCTAssertEqual(VoiceInput.clock(90), "1:30")
    }

    func testARecordingIsWrittenDownIntoTheBoxAndNeverSent() async {
        var started = 0
        let file = FileManager.default.temporaryDirectory.appendingPathComponent("voice-test-\(UUID().uuidString).m4a")
        FileManager.default.createFile(atPath: file.path, contents: Data([0]))
        let voice = VoiceInput(mic: .init(start: { started += 1 }, stop: { file })) { url in
            XCTAssertEqual(url, file)
            return " Find my next content idea "
        }
        var box = "Hi"
        voice.toggle { box = VoiceInput.appended($0, to: box) }
        await voice.record()   // asked to start twice at once: the mic starts once
        await Task.yield()
        guard case .recording = voice.phase else { return XCTFail("not recording: \(voice.phase)") }
        XCTAssertEqual(started, 1)
        await voice.finish()
        XCTAssertEqual(voice.phase, .idle)
        XCTAssertEqual(box, "Hi Find my next content idea")
        XCTAssertNil(voice.notice)
        XCTAssertFalse(FileManager.default.fileExists(atPath: file.path))
    }

    func testWhatWentWrongIsOneQuietLine() async {
        let file = FileManager.default.temporaryDirectory.appendingPathComponent("voice-test-\(UUID().uuidString).m4a")
        let voice = VoiceInput(mic: .init(start: {}, stop: { file })) { _ in
            throw ToolsetAPI.Failure(status: 402, message: "Needs a Deepgram key")
        }
        await voice.record()
        await voice.finish()
        XCTAssertEqual(voice.notice, "Needs a Deepgram key")
        XCTAssertEqual(voice.phase, .idle)

        let silent = VoiceInput(mic: .init(start: {}, stop: { file })) { _ in "  " }
        await silent.record()
        await silent.finish()
        XCTAssertEqual(silent.notice, "Didn't catch anything. Try again a little closer to the mic.")

        let refused = VoiceInput(mic: .init(start: { throw ToolsetAPI.Failure(status: 0, message: "The microphone is off") }, stop: { nil })) { _ in "" }
        await refused.record()
        XCTAssertEqual(refused.phase, .idle)
        XCTAssertEqual(refused.notice, "The microphone is off")
    }

    func testLeavingWhileRecordingThrowsTheRecordingAway() async {
        var written = false
        let voice = VoiceInput(mic: .init(start: {}, stop: { nil })) { _ in written = true; return "x" }
        await voice.record()
        voice.cancel()
        XCTAssertEqual(voice.phase, .idle)
        XCTAssertFalse(written)
    }
}
