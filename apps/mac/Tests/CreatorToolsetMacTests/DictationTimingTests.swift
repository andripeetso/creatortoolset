import XCTest
@testable import CreatorToolsetMac

/// By hand only: `DICTATION_TIME_WAVS=<wav>:<wav> DICTATION_TIME_MODEL=whisper-large-v3-turbo swift test --filter
/// DictationTimingTests`. Times the model's load (twice: cold, then warm) and each clip's transcription, with a model
/// already on this Mac; it never downloads one.
final class DictationTimingTests: XCTestCase {
    func testTimesLoadAndTranscription() async throws {
        let env = ProcessInfo.processInfo.environment
        guard let wavs = env["DICTATION_TIME_WAVS"]?.split(separator: ":").map(String.init) else { throw XCTSkip("by hand only") }
        let model = ModelRegistry.find(env["DICTATION_TIME_MODEL"] ?? "whisper-large-v3-turbo")!
        guard ModelFiles.base(holding: model.whisperKitID!) != nil else { throw XCTSkip("\(model.id) isn't on this Mac") }
        for round in ["cold", "warm"] {
            let transcriber = WhisperKitTranscriber(model: model)
            var start = Date()
            try await transcriber.warmUp()
            print("TIMING \(model.id) load \(round): \(String(format: "%.2f", Date().timeIntervalSince(start))) s")
            for wav in wavs {
                let samples = try AudioFileLoader.load(url: URL(fileURLWithPath: wav))
                start = Date()
                let text = try await transcriber.transcribe(samples, context: TranscriptionContext()).text
                print("TIMING \(round) \(String(format: "%.2f", Double(samples.count) / 16_000)) s of audio in \(String(format: "%.2f", Date().timeIntervalSince(start))) s: \(text)")
            }
            await transcriber.unload()
        }
    }
}
