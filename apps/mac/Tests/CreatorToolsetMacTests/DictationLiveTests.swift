import XCTest
@testable import CreatorToolsetMac

/// The real model on a real clip, by hand only: `DICTATION_LIVE_WAV=<a 16 kHz wav of the words below> swift test
/// --filter DictationLiveTests`. Needs Whisper Base (English) already on this Mac; it never downloads one.
final class DictationLiveTests: XCTestCase {
    func testAModelOnDiskTranscribesAClip() async throws {
        guard let wav = ProcessInfo.processInfo.environment["DICTATION_LIVE_WAV"] else { throw XCTSkip("by hand only") }
        let model = ModelRegistry.find("whisper-base.en")!
        guard ModelFiles.base(holding: model.whisperKitID!) != nil else { throw XCTSkip("Whisper Base isn't on this Mac") }
        let samples = try AudioFileLoader.load(url: URL(fileURLWithPath: wav))
        let transcriber = WhisperKitTranscriber(model: model)
        let text = try await transcriber.transcribe(samples, context: TranscriptionContext()).text
        XCTAssertTrue(text.lowercased().contains("acrobatics"), text)
        await transcriber.unload()
    }
}
