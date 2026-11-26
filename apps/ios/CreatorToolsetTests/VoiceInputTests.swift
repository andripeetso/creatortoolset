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
        let voice = VoiceInput(mic: .init(start: { started += 1 }, stop: { file })) { url, _ in
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
        let voice = VoiceInput(mic: .init(start: {}, stop: { file })) { _, _ in
            throw ToolsetAPI.Failure(status: 402, message: "Needs a Deepgram key")
        }
        await voice.record()
        await voice.finish()
        XCTAssertEqual(voice.notice, "Needs a Deepgram key")
        XCTAssertEqual(voice.phase, .idle)

        let silent = VoiceInput(mic: .init(start: {}, stop: { file })) { _, _ in "  " }
        await silent.record()
        await silent.finish()
        XCTAssertEqual(silent.notice, "Didn't catch anything. Try again a little closer to the mic.")

        let refused = VoiceInput(mic: .init(start: { throw ToolsetAPI.Failure(status: 0, message: "The microphone is off") }, stop: { nil })) { _, _ in "" }
        await refused.record()
        XCTAssertEqual(refused.phase, .idle)
        XCTAssertEqual(refused.notice, "The microphone is off")
    }

    func testStoppingWhileTheWordsAreWrittenDownPutsNothingInTheBox() async {
        var answer: CheckedContinuation<String, Never>?
        let file = FileManager.default.temporaryDirectory.appendingPathComponent("voice-test-\(UUID().uuidString).m4a")
        let voice = VoiceInput(mic: .init(start: {}, stop: { file })) { _, preparing in
            preparing()   // the phone's model is still downloading
            return await withCheckedContinuation { answer = $0 }
        }
        var box = "Hi"
        voice.toggle { box = VoiceInput.appended($0, to: box) }
        await voice.record()
        await Task.yield()
        let finishing = Task { await voice.finish() }
        for _ in 0..<1000 where answer == nil { await Task.yield() }
        XCTAssertEqual(voice.status, "Getting the speech model ready")
        voice.toggle { _ in }   // Stop while the words are written down
        XCTAssertEqual(voice.phase, .idle)
        XCTAssertNil(voice.status)
        answer?.resume(returning: " late words ")   // the answer comes after the stop
        await finishing.value
        XCTAssertEqual(box, "Hi")
        XCTAssertNil(voice.notice)
        XCTAssertEqual(voice.phase, .idle)
    }

    func testLeavingWhileTheMicIsStillStartingRecordsNothing() async {
        var started: CheckedContinuation<Void, Never>?
        var stopped = 0
        let voice = VoiceInput(mic: .init(start: { await withCheckedContinuation { started = $0 } },
                                          stop: { stopped += 1; return nil })) { _, _ in "x" }
        let asked = Task { await voice.record() }
        for _ in 0..<1000 where started == nil { await Task.yield() }
        voice.cancel()   // the chat was left while the microphone was still starting
        started?.resume()
        await asked.value
        XCTAssertEqual(voice.phase, .idle)
        XCTAssertEqual(stopped, 1)   // the microphone it started is let go
    }

    func testThePhoneWritesItDownInTheFirstVoiceLanguageUnlessTheMicIsDeepgramOrOpenAI() throws {
        func prefs(_ json: String) throws -> PhoneSpeech.Prefs { try JSONDecoder().decode(PhoneSpeech.Prefs.self, from: Data(json.utf8)) }
        let auto = #""stt":{"default":{"engine":"auto"},"per":{}}"#
        XCTAssertEqual(PhoneSpeech.language(try prefs(#"{"languages":["en"],\#(auto)}"#), phone: ["en-GB", "et-EE"]), "en-GB")
        XCTAssertEqual(PhoneSpeech.language(try prefs(#"{"languages":["et"],\#(auto)}"#), phone: ["en-GB"]), "et")
        XCTAssertEqual(PhoneSpeech.language(try prefs(#"{"languages":[],\#(auto)}"#), phone: ["de-DE"]), "de-DE")
        XCTAssertEqual(PhoneSpeech.language(nil, phone: ["en-US"]), "en-US")   // settings not read: the phone's own language
        // several languages: the first one is the one written down (the rest are heard by the server only)
        XCTAssertEqual(PhoneSpeech.language(try prefs(#"{"languages":["et","en"],\#(auto)}"#), phone: ["en-GB"]), "et")
        // local is the phone too; Deepgram or OpenAI chosen for the mic (or for everything else) is the server's
        XCTAssertEqual(PhoneSpeech.language(try prefs(#"{"languages":["en"],"stt":{"default":{"engine":"auto"},"per":{}}}"#), phone: ["en-GB"]), "en-GB")
        XCTAssertEqual(PhoneSpeech.language(try prefs(#"{"languages":["en"],"stt":{"default":{"engine":"local"},"per":{}}}"#), phone: ["en-GB"]), "en-GB")
        XCTAssertNil(PhoneSpeech.language(try prefs(#"{"languages":["en"],"stt":{"default":{"engine":"auto"},"per":{"mic":{"engine":"deepgram"}}}}"#), phone: ["en-GB"]))
        XCTAssertNil(PhoneSpeech.language(try prefs(#"{"languages":["en"],"stt":{"default":{"engine":"openai"},"per":{}}}"#), phone: ["en-GB"]))
    }

    func testTheServerSaysWhatTheMicNeedsInOneLine() throws {
        func prefs(_ json: String) throws -> PhoneSpeech.Prefs { try JSONDecoder().decode(PhoneSpeech.Prefs.self, from: Data(json.utf8)) }
        let keyless = try prefs(#"{"languages":[],"stt":{"default":{"engine":"deepgram"},"per":{}},"resolved":[{"use":"mic","needs":"Add your Deepgram (or OpenAI) key in Settings → API keys","key":"DEEPGRAM_API_KEY"}]}"#)
        XCTAssertEqual(PhoneSpeech.needs(keyless), "Needs a Deepgram key")
        let ready = try prefs(#"{"languages":[],"stt":{"default":{"engine":"auto"},"per":{}},"resolved":[{"use":"mic","engine":"openai","model":"whisper-1"}]}"#)
        XCTAssertNil(PhoneSpeech.needs(ready))
        XCTAssertNil(PhoneSpeech.needs(nil))
    }

    func testMisheardWordsAreRewrittenToTheirTerm() throws {
        let words = try JSONDecoder().decode([PhoneSpeech.Prefs.Word].self, from: Data(#"[{"term":"Creator Toolset","soundsLike":["creator tool set","creater toolset"]}]"#.utf8))
        XCTAssertEqual(PhoneSpeech.rewrite("Open creator tool set and CREATER TOOLSET, not precreator toolset.", words),
                       "Open Creator Toolset and Creator Toolset, not precreator toolset.")
        XCTAssertEqual(PhoneSpeech.rewrite("nothing to change", words), "nothing to change")
    }

    func testARefusalWithAReasonOffersItsSettingsPage() {
        let key = CodedRefusal(status: 422, code: "SPEECH", line: "Add a key", reason: "missing-key")
        XCTAssertEqual(VoiceInput.fix(for: key), VoiceInput.Fix(label: "Open API keys", href: "/settings/keys"))
        let model = CodedRefusal(status: 422, code: "SPEECH", line: "No model", reason: "model-unavailable")
        XCTAssertEqual(VoiceInput.fix(for: model), VoiceInput.Fix(label: "Open Voice settings", href: "/settings/voice"))
        XCTAssertNil(VoiceInput.fix(for: CodedRefusal(status: 429, code: "SPEECH", line: "Busy", reason: "rate-limit")))
        XCTAssertNil(VoiceInput.fix(for: ToolsetAPI.Failure(status: 402, message: "Needs a Deepgram key")))
    }

    func testLeavingWhileRecordingThrowsTheRecordingAway() async {
        var written = false
        let voice = VoiceInput(mic: .init(start: {}, stop: { nil })) { _, _ in written = true; return "x" }
        await voice.record()
        voice.cancel()
        XCTAssertEqual(voice.phase, .idle)
        XCTAssertFalse(written)
    }
}
