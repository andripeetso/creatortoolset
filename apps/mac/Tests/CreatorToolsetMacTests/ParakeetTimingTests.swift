import XCTest
@testable import CreatorToolsetMac

/// By hand only: `DICTATION_TIME_WAVS=<wav>:<wav> PARAKEET_BASE=<folder> DICTATION_TIME_MODEL=parakeet-tdt-0.6b-v3 swift test
/// --filter ParakeetTimingTests`. Downloads the model under PARAKEET_BASE when it isn't there (never into this app's own
/// folder), then times its load (twice: cold, then warm) and each clip's transcription. PARAKEET_COPY=<folder>: a base
/// holding a copy never loaded before, loaded first (the first load in a new app).
final class ParakeetTimingTests: XCTestCase {
    func testTimesLoadAndTranscription() async throws {
        let env = ProcessInfo.processInfo.environment
        guard let wavs = env["DICTATION_TIME_WAVS"]?.split(separator: ":").map(String.init), let dir = env["PARAKEET_BASE"]
        else { throw XCTSkip("by hand only") }
        let model = ModelRegistry.find(env["DICTATION_TIME_MODEL"] ?? ModelRegistry.englishID)!
        let base = URL(fileURLWithPath: dir)
        var start = Date()
        try await ParakeetFiles.download(model, in: base)
        print("TIMING \(model.id) download: \(String(format: "%.2f", Date().timeIntervalSince(start))) s")
        var rounds = [("cold", base), ("warm", base)]
        if let copy = env["PARAKEET_COPY"] { rounds.insert(("first", URL(fileURLWithPath: copy)), at: 0) }
        for (round, from) in rounds {
            let transcriber = ParakeetTranscriber(model: model, base: from)
            start = Date()
            try await transcriber.load()
            print("TIMING \(model.id) load \(round): \(String(format: "%.2f", Date().timeIntervalSince(start))) s")
            for wav in wavs {
                let samples = try AudioFileLoader.load(url: URL(fileURLWithPath: wav))
                start = Date()
                let text = try await transcriber.transcribe(samples, context: TranscriptionContext()).text
                print("TIMING \(round) \(String(format: "%.2f", Double(samples.count) / 16_000)) s of audio in \(String(format: "%.2f", Date().timeIntervalSince(start))) s: \(text)")
            }
            let words = try await transcriber.words(AudioFileLoader.load(url: URL(fileURLWithPath: wavs[0]))).words
            XCTAssertFalse(words.isEmpty)
            print("TIMING words: " + words.map { "\($0.text)@\(String(format: "%.2f", $0.start))" }.joined(separator: " "))
            await transcriber.unload()
        }
    }
}
