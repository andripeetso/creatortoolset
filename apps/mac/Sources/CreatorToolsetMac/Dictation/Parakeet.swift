// Dictation's Parakeet models (NVIDIA Parakeet TDT, converted to Core ML), run on the Neural Engine through FluidAudio
// (THIRD_PARTY_NOTICES.md). Measured on an M-series Mac on 2026-11-13: a few seconds of speech in 0.06 to 0.2 s, the
// first load in a new app about 25 s, against Whisper turbo's 1 to 1.5 s and 160 s. Kept apart from Whisper.swift,
// whose WhisperKit has types of the same names.
import FluidAudio
import Foundation

/// Where a Parakeet model's files are: one folder under this app's dictation folder.
enum ParakeetFiles {
    static func version(_ m: TranscriptionModel) -> AsrModelVersion { m.parakeet?.contains("-v2-") == true ? .v2 : .v3 }

    /// "FluidInference/parakeet-tdt-0.6b-v3-coreml" → <base>/models/parakeet/parakeet-tdt-0.6b-v3 (FluidAudio's own name).
    static func folder(_ m: TranscriptionModel, in base: URL = DictationPaths.base) -> URL {
        let repo = (m.parakeet ?? "").split(separator: "/").last.map(String.init) ?? ""
        let name = repo.hasSuffix("-coreml") ? String(repo.dropLast(7)) : repo
        return base.appendingPathComponent("models/parakeet/\(name)", isDirectory: true)
    }

    static func isComplete(_ m: TranscriptionModel, in base: URL = DictationPaths.base) -> Bool {
        AsrModels.modelsExist(at: folder(m, in: base), version: version(m))
    }

    /// Downloads `m` (and readies it for this Mac) unless it is here; `progress` gets 0 to 1.
    @discardableResult
    static func download(_ m: TranscriptionModel, in base: URL = DictationPaths.base,
                         progress: (@Sendable (Double) -> Void)? = nil) async throws -> URL {
        let folder = folder(m, in: base)
        if isComplete(m, in: base) { return folder }
        try FileManager.default.createDirectory(at: folder.deletingLastPathComponent(), withIntermediateDirectories: true,
                                                attributes: [.posixPermissions: 0o700])
        try await AsrModels.download(to: folder, version: version(m), progressHandler: { progress?($0.fractionCompleted) })
        return folder
    }

    static func remove(_ m: TranscriptionModel, in base: URL = DictationPaths.base) {
        try? FileManager.default.removeItem(at: folder(m, in: base))
    }
}

actor ParakeetTranscriber: LoadingTranscriber {
    let modelID: String
    private let model: TranscriptionModel
    private let base: URL
    private var asr: AsrManager?
    private var loading: Task<Void, Error>?
    /// Set by `unload`: this transcriber was replaced and loads nothing more.
    private var retired = false

    init(model: TranscriptionModel, base: URL = DictationPaths.base) {
        self.modelID = model.id
        self.model = model
        self.base = base
    }

    nonisolated var onDisk: Bool { ParakeetFiles.isComplete(model, in: base) }

    func loaded() async -> Bool { asr != nil }

    /// Loads the model, downloading it first when it isn't here. A copy on disk loads with no network call.
    func load() async throws {
        if asr != nil || retired { return }
        if let loading { return try await loading.value }
        let task = Task { try await self.loadNow() }
        loading = task
        defer { loading = nil }
        try await task.value
    }

    private func loadNow() async throws {
        DictationLog.info("loading \(model.id)...")
        let folder = try await ParakeetFiles.download(model, in: base)
        let made = AsrManager()
        try await made.loadModels(AsrModels.loadLocal(from: folder, version: ParakeetFiles.version(model)))
        if retired { return await made.cleanup() }
        asr = made
        DictationLog.info("✓ \(model.id) ready")
    }

    func unload() async {
        retired = true
        guard let asr else { return }
        self.asr = nil
        await asr.cleanup()
    }

    /// The language is the model's own to find (v3 hears 25 European languages, v2 English); `context` isn't needed.
    func transcribe(_ audio: [Float], context: TranscriptionContext) async throws -> Transcript {
        let started = CFAbsoluteTimeGetCurrent()
        let result = try await run(audio)
        let seconds = Double(audio.count) / 16_000
        return Transcript(text: result.text.trimmingCharacters(in: .whitespacesAndNewlines),
                          timings: TranscriberTimings(audioSeconds: seconds, total: CFAbsoluteTimeGetCurrent() - started))
    }

    /// Each word with its times, for a transcript the server asked this Mac for (SpeechModels.transcript).
    func words(_ audio: [Float]) async throws -> (words: [HeardWord], language: String?) {
        let result = try await run(audio)
        let words = buildWordTimings(from: result.tokenTimings ?? []).map { HeardWord(text: $0.word, start: $0.startTime, end: $0.endTime) }
        return (words, ParakeetFiles.version(model) == .v2 ? "en" : nil)
    }

    private func run(_ audio: [Float]) async throws -> ASRResult {
        try await load()
        guard let asr else { throw TranscriberError.notLoaded }
        // it refuses under a second; silence after a short word changes nothing
        let least = ASRConstants.minimumRequiredSamples(forSampleRate: 16_000)
        let input = audio.count < least ? audio + [Float](repeating: 0, count: least - audio.count) : audio
        var state = TdtDecoderState.make()
        return try await asr.transcribe(input, decoderState: &state)
    }
}
