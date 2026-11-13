import CoreML
import Foundation
import WhisperKit

actor WhisperKitTranscriber: Transcriber {
    let modelID: String
    private let model: TranscriptionModel
    let tuning: WhisperTuning
    private var pipeline: WhisperKit?
    /// Set by `unload`: this transcriber was replaced and loads nothing more.
    private var retired = false

    init(model: TranscriptionModel, tuning: WhisperTuning = .standard) {
        self.modelID = model.id
        self.model = model
        self.tuning = tuning
    }

    /// Loads the model into memory; downloads it first into this app's folder
    /// when no complete copy is on this Mac (`ModelFiles`). A copy already on
    /// disk is loaded as it is, with no network call. `progress` gets the
    /// download's fraction done, 0 to 1, when there is anything to download.
    func warmUp(progress: (@Sendable (Double) -> Void)? = nil) async throws {
        if pipeline != nil || retired { return }
        // one load at a time: a second caller (the first dictation, while the launch's load runs) waits for it
        if let loading { return try await loading.value }
        let task = Task { try await self.load(progress: progress) }
        loading = task
        defer { loading = nil }
        try await task.value
    }

    private var loading: Task<Void, Error>?

    private func load(progress: (@Sendable (Double) -> Void)?) async throws {
        guard let whisperKitID = model.whisperKitID else {
            throw TranscriberError.missingEngineID
        }
        DictationLog.info("loading \(model.id)...")
        // Explicit downloadBase: the HubApi default is ~/Documents/huggingface,
        // which iCloud may evict. The tokenizer folder follows downloadBase.
        let base: URL
        let folder: URL
        if let found = ModelFiles.base(holding: whisperKitID) {
            base = found
            folder = ModelFiles.folder(whisperKitID, in: found)
        } else {
            base = try ModelFiles.ownBase()
            // The same download WhisperKit's init would run, called here to see
            // its progress. Files already on disk are not fetched again.
            folder = try await WhisperKit.download(variant: whisperKitID, downloadBase: base) { p in
                progress?(p.fractionCompleted)
            }
        }
        try Task.checkCancellation()
        let config = WhisperKitConfig(
            model: whisperKitID,
            downloadBase: base,
            modelFolder: folder.path,
            computeOptions: ModelComputeOptions(
                melCompute: tuning.melCompute,
                audioEncoderCompute: tuning.encoderCompute,
                textDecoderCompute: tuning.decoderCompute
            ),
            verbose: false,
            prewarm: true,
            load: true,
            download: false
        )
        let loaded = try await WhisperKit(config)
        // Replaced while loading (a model change): drop it.
        if retired {
            await loaded.unloadModels()
            return
        }
        pipeline = loaded
        DictationLog.info("✓ \(model.id) ready")
    }

    /// Whether the model is in memory.
    var isLoaded: Bool { pipeline != nil }

    /// Whether a complete copy is on this Mac, so loading it downloads nothing.
    nonisolated var onDisk: Bool { model.whisperKitID.flatMap { ModelFiles.base(holding: $0) } != nil }

    /// Frees the model after a swap to another one. A load still running
    /// finishes and is dropped, and a later `warmUp` returns at once.
    func unload() async {
        retired = true
        guard let pipeline else { return }
        self.pipeline = nil
        await pipeline.unloadModels()
    }

    /// Uses `context.language`, or with none (Automatic) detects one among
    /// `context.spokenLanguages`; see `SpokenLanguage`.
    func transcribe(_ audio: [Float], context: TranscriptionContext) async throws -> Transcript {
        if pipeline == nil { try await warmUp() }
        guard let pipeline else { throw TranscriberError.notLoaded }

        let started = CFAbsoluteTimeGetCurrent()
        let input = tuning.prepare(audio)
        let trimTime = CFAbsoluteTimeGetCurrent() - started

        let detectStarted = CFAbsoluteTimeGetCurrent()
        let spoken = context.spokenLanguages.isEmpty ? SpokenLanguage.preferredCodes() : context.spokenLanguages
        let (language, detected) = await chooseLanguage(input, setting: context.language, spoken: spoken, pipeline: pipeline)
        let detectTime = detected ? CFAbsoluteTimeGetCurrent() - detectStarted : 0

        let options = tuning.decodingOptions(
            language: language,
            promptTokens: nil,
            audioSeconds: Double(input.count) / Double(WhisperKit.sampleRate)
        )
        let results = try await pipeline.transcribe(audioArray: input, decodeOptions: options)
        let raw = results.map(\.text).joined(separator: " ")
        let text = Self.sanitize(raw)
        var timings = Self.timings(
            from: results.map(\.timings),
            audioSeconds: Double(input.count) / Double(WhisperKit.sampleRate),
            preprocessing: trimTime,
            languageDetection: detectTime,
            total: CFAbsoluteTimeGetCurrent() - started
        )
        timings.language = language ?? (model.isMultilingual ? nil : model.languages.first)
        return Transcript(text: text, timings: timings)
    }

    /// A transcript for the server (TranscribeJob.swift): every word with its start and end in seconds from the
    /// audio's first sample, and the language heard. Among `languages` when given, else among every language the model
    /// knows. The audio is used as it is, never trimmed or padded, so the times are the recording's own.
    func words(_ audio: [Float], languages: [String]) async throws -> (words: [HeardWord], language: String?) {
        if pipeline == nil { try await warmUp() }
        guard let pipeline else { throw TranscriberError.notLoaded }
        let (language, _) = await chooseLanguage(audio, setting: nil, spoken: languages, pipeline: pipeline)
        var options = tuning.decodingOptions(language: language, promptTokens: nil, audioSeconds: Double(audio.count) / Double(WhisperKit.sampleRate))
        options.wordTimestamps = true
        let results = try await pipeline.transcribe(audioArray: audio, decodeOptions: options)
        let words = results.flatMap { $0.segments.flatMap { $0.words ?? [] } }
            .map { HeardWord(text: $0.word, start: Double($0.start), end: Double($0.end)) }
        return (words, language ?? results.first?.language ?? (model.isMultilingual ? nil : model.languages.first))
    }

    /// The language to decode `input` in, or nil for none, and whether
    /// detection ran. Logs what detection heard and what was chosen, as
    /// codes, never text.
    private func chooseLanguage(
        _ input: [Float],
        setting: String?,
        spoken: [String],
        pipeline: WhisperKit
    ) async -> (language: String?, detected: Bool) {
        switch SpokenLanguage.plan(setting: setting, spoken: spoken, model: model) {
        case .none:
            return (nil, false)
        case .fixed(let code):
            return (code, false)
        case .detect(let candidates):
            let among = candidates.isEmpty ? Array(model.supportedLanguages) : candidates
            let fallback = candidates.first
            guard !input.isEmpty else { return (fallback, false) }
            do {
                let ranked = try await LanguageDetector.detect(input, among: among, pipeline: pipeline)
                let chosen = ranked[0].code
                DictationLog.info("language: \(chosen) (" + ranked.prefix(3).map {
                    String(format: "%@ %.2f", $0.code, $0.probability)
                }.joined(separator: " · ") + ")")
                return (chosen, true)
            } catch {
                DictationLog.warning("language detection failed: \(error); using \(fallback ?? "the model's default")")
                return (fallback, true)
            }
        }
    }

    /// WhisperKit's per-stage timings folded into our stages. The decoder
    /// is what the pipeline spent outside preprocessing, the encoder and
    /// windowing; post-processing is the rest of the call. `ownPreprocessing` is
    /// time spent on the audio before handing it to WhisperKit.
    static func timings(
        from results: [TranscriptionTimings],
        audioSeconds: TimeInterval,
        preprocessing ownPreprocessing: TimeInterval,
        languageDetection: TimeInterval = 0,
        total: TimeInterval
    ) -> TranscriberTimings {
        var out = TranscriberTimings(
            audioSeconds: audioSeconds,
            preprocessing: ownPreprocessing,
            languageDetection: languageDetection,
            total: total
        )
        for t in results {
            let preprocessing = t.audioProcessing + t.logmels
            out.preprocessing += preprocessing
            out.encoder += t.encoding
            out.decoder += max(0, t.fullPipeline - preprocessing - t.encoding - t.decodingWindowing)
            out.windows += Int(t.totalEncodingRuns)
            out.tokens += Int(t.totalDecodingLoops)
            // WhisperKit records the index of the last failed attempt, so one
            // fallback reads 0; any fallback time means at least one happened.
            if t.decodingFallback > 0 { out.fallbacks += Int(t.totalDecodingFallbacks) + 1 }
        }
        out.postprocessing = max(0, total - out.preprocessing - out.languageDetection - out.encoder - out.decoder)
        return out
    }

    /// Strip Whisper's non-speech bracket tokens ([BLANK_AUDIO], [MUSIC],
    /// (silence), <|nospeech|>, etc.) and collapse whitespace. When the model
    /// hears silence it emits these literally; we don't want to paste them.
    static func sanitize(_ text: String) -> String {
        let patterns = [
            #"\[[^\]]*\]"#,        // [BLANK_AUDIO], [MUSIC], [Applause]
            #"\([^)]*\)"#,          // (silence), (music playing)
            #"<\|[^|]*\|>"#,        // <|nospeech|>, <|endoftext|>
            #"\*[^*]*\*"#,          // *background noise*
        ]
        var out = text
        for p in patterns {
            out = out.replacingOccurrences(of: p, with: " ", options: .regularExpression)
        }
        out = out.replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression)
        return out.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}

enum TranscriberError: Error {
    case missingEngineID
    case notLoaded
}

/// Where the Whisper models run and how they decode. `standard` is what the
/// app uses; each choice in it was measured against WhisperKit's defaults
/// (`baseline`) on Apple silicon.
struct WhisperTuning: Equatable, @unchecked Sendable {
    var melCompute: MLComputeUnits = .cpuAndGPU
    var encoderCompute: MLComputeUnits = .cpuAndNeuralEngine
    var decoderCompute: MLComputeUnits = .cpuAndNeuralEngine
    /// Ask for text only when the audio fits one window. Dictation never
    /// uses segment timestamps.
    var withoutTimestamps = false
    /// Cut leading and trailing silence before transcription.
    var trimSilence = false
    /// Seconds of silence put before the audio after the trim, so speech
    /// never starts at the model's first sample.
    var leadPadding: Double = 0
    /// Seconds of silence put after the audio after the trim.
    var trailPadding: Double = 0

    /// WhisperKit's defaults.
    static let baseline = WhisperTuning()

    /// A transcript with word times (TranscribeJob.swift): the compute units of `standard`, with nothing cut or added.
    static let words = WhisperTuning(melCompute: .cpuOnly)

    static let standard = WhisperTuning(
        melCompute: .cpuOnly,
        withoutTimestamps: true,
        trimSilence: true,
        leadPadding: 0.3,
        trailPadding: 0.3
    )

    /// The samples the model gets for a capture: trimmed if `trimSilence`,
    /// then padded with silence. An empty capture stays empty. Pure, so it is
    /// tested.
    func prepare(_ audio: [Float]) -> [Float] {
        let trimmed = trimSilence ? SilenceTrimmer.trim(audio) : audio
        guard !trimmed.isEmpty, leadPadding > 0 || trailPadding > 0 else { return trimmed }
        let lead = Self.samples(leadPadding)
        let trail = Self.samples(trailPadding)
        var out = [Float](repeating: 0, count: lead + trimmed.count + trail)
        out.replaceSubrange(lead..<(lead + trimmed.count), with: trimmed)
        return out
    }

    /// `seconds` of 16 kHz audio as a sample count; negative counts as none.
    static func samples(_ seconds: Double) -> Int {
        max(0, Int((seconds * Double(WhisperKit.sampleRate)).rounded()))
    }

    /// Options for one transcription. `language` is the language to decode
    /// in, already chosen (see `SpokenLanguage`), or nil for a model that has
    /// only one. Detection never runs in the decode, and the task is always
    /// transcribe: no path falls into Whisper's translate-to-English.
    func decodingOptions(language: String?, promptTokens: [Int]?, audioSeconds: Double) -> DecodingOptions {
        var options = DecodingOptions(task: .transcribe, language: language, detectLanguage: false)
        options.promptTokens = promptTokens
        options.withoutTimestamps = withoutTimestamps && Self.fitsOneWindow(audioSeconds)
        return options
    }

    /// True when `seconds` of audio decode in a single 30 s window. Past that,
    /// WhisperKit needs segment timestamps to pick where the next window
    /// starts; without them it cuts at exactly 30 s, through a word.
    static func fitsOneWindow(_ seconds: Double) -> Bool {
        seconds <= Double(Constants.defaultWindowSamples) / Double(WhisperKit.sampleRate)
    }
}

/// How a dictation's spoken language is chosen. Pure, so it is tested.
///
/// - A single-language model such as `whisper-base.en` is never told a
///   language and never asked to detect one: it only knows one.
/// - An explicit Language setting is used as given, with detection off.
/// - Automatic chooses among the languages the user speaks (the Languages
///   setting, or the Mac's preferred languages until it is set), and only
///   among them: `LanguageDetector` lets no other language compete. Whisper
///   confuses close languages on short clips (Spanish heard as Italian or
///   Portuguese, Serbian heard as Spanish), and a wrong language comes
///   back as a translation. With one language there is nothing to detect.
enum SpokenLanguage {
    /// What to do before decoding.
    enum Plan: Equatable, Sendable {
        /// Pass no language: the model has only one.
        case none
        /// Decode in this language, detection off.
        case fixed(String)
        /// Detect which of these languages is spoken. Empty when none of the
        /// user's languages is one the model knows: then every language
        /// competes, as in WhisperKit's own detection.
        case detect(among: [String])
    }

    /// The plan for `model` with the Language setting `setting` (an ISO 639-1
    /// code, or nil for Automatic) and the languages the user speaks,
    /// `spoken`. A code the model does not support, such as a typo in a hand
    /// edit, counts as Automatic.
    static func plan(setting: String?, spoken: [String], model: TranscriptionModel) -> Plan {
        guard model.isMultilingual else { return .none }
        let supported = model.supportedLanguages
        if let code = setting?.lowercased(), supported.contains(code) {
            return .fixed(code)
        }
        var seen = Set<String>()
        let candidates = spoken.map { $0.lowercased() }.filter { supported.contains($0) && seen.insert($0).inserted }
        if candidates.count == 1 { return .fixed(candidates[0]) }
        return .detect(among: candidates)
    }

    /// Softmax over `scores` (a logit per language): each language's
    /// probability among these languages only, highest first.
    static func probabilities(_ scores: [(String, Float)]) -> [(code: String, probability: Float)] {
        guard let top = scores.map(\.1).max() else { return [] }
        let weights = scores.map { ($0.0, exp($0.1 - top)) }
        let total = weights.reduce(0) { $0 + $1.1 }
        return weights
            .map { (code: $0.0, probability: $0.1 / total) }
            .sorted { $0.probability > $1.probability }
    }

    /// `identifiers` (as in `Locale.preferredLanguages`: "en-US", "pt-BR",
    /// "zh-Hans-CN") reduced to ISO 639-1 codes, in order, without repeats.
    static func preferredCodes(_ identifiers: [String] = Locale.preferredLanguages) -> [String] {
        var seen = Set<String>()
        return identifiers.compactMap { id -> String? in
            let language = Locale.Language(identifier: id)
            let code = language.languageCode?.identifier(.alpha2) ?? language.languageCode?.identifier
            return code?.lowercased()
        }
        .filter { seen.insert($0).inserted }
    }

    /// Every language Whisper's multilingual models know, as codes. From
    /// WhisperKit, so it follows the package.
    static let whisperLanguages: Set<String> = Constants.languageCodes

    /// `code`'s name in the user's language, for the Language picker:
    /// "Portuguese", "Português". Falls back to Whisper's English name.
    static func displayName(_ code: String, locale: Locale = .current) -> String {
        if let name = locale.localizedString(forLanguageCode: code), name != code {
            return name.prefix(1).uppercased() + name.dropFirst()
        }
        // Some codes have several names ("flemish", "dutch"); pick one stably.
        let whisperName = Constants.languages.filter { $0.value == code }.map(\.key).min() ?? code
        return whisperName.capitalized
    }
}

extension TranscriptionModel {
    /// True if the model hears more than one language. Registry entries say
    /// so with `languages: ["multi"]`.
    var isMultilingual: Bool {
        languages.contains("multi") || languages.count > 1
    }

    /// The language codes the model can be told to expect.
    var supportedLanguages: Set<String> {
        languages.contains("multi") ? SpokenLanguage.whisperLanguages : Set(languages)
    }
}

/// Whisper's language detection, choosing only among the user's languages.
///
/// The steps are WhisperKit's `detectLangauge` (the first 30 s of audio, the
/// mel spectrogram, the encoder, then one decoder step after
/// `<|startoftranscript|>`), with one difference: WhisperKit lets every
/// language token compete and takes the top one, while this reads only the
/// scores of `languages` and shares the probability among them. With English
/// and Spanish, a Spanish clip can never come back as Italian or Portuguese,
/// which Whisper confuses it with on short clips, and a wrong language comes
/// back as a translation.
enum LanguageDetector {
    enum DetectionError: Error {
        case unavailable(String)
    }

    /// The most likely of `languages` in `audio`, with each language's
    /// probability, highest first. `languages` must be codes the model knows.
    static func detect(
        _ audio: [Float],
        among languages: [String],
        pipeline: WhisperKit
    ) async throws -> [(code: String, probability: Float)] {
        guard let tokenizer = pipeline.tokenizer else { throw DetectionError.unavailable("no tokenizer") }
        let decoder = pipeline.textDecoder

        guard let samples = pipeline.audioProcessor.padOrTrim(
            fromArray: audio,
            startAt: 0,
            toLength: pipeline.featureExtractor.windowSamples ?? Constants.defaultWindowSamples
        ) else { throw DetectionError.unavailable("no audio") }
        guard let mel = try await pipeline.featureExtractor.logMelSpectrogram(fromAudio: samples),
              let encoded = try await pipeline.audioEncoder.encodeFeatures(mel) as? MLMultiArray
        else { throw DetectionError.unavailable("encoder produced nothing") }

        let start = tokenizer.specialTokens.startOfTranscriptToken
        guard let inputs = try decoder.prepareDecoderInputs(withPrompt: [start]) as? DecodingInputs else {
            throw DetectionError.unavailable("unexpected decoder inputs")
        }
        inputs.inputIds[0] = NSNumber(value: start)
        inputs.cacheLength[0] = NSNumber(value: 0)
        let output = try await decoder.predictLogits(TextDecoderMLMultiArrayInputType(
            inputIds: inputs.inputIds,
            cacheLength: inputs.cacheLength,
            keyCache: inputs.keyCache,
            valueCache: inputs.valueCache,
            kvCacheUpdateMask: inputs.kvCacheUpdateMask,
            encoderOutputEmbeds: encoded,
            decoderKeyPaddingMask: inputs.decoderKeyPaddingMask
        )) as? TextDecoderMLMultiArrayOutputType
        guard let logits = output?.logits else { throw DetectionError.unavailable("decoder produced nothing") }

        // Each language's score is the logit of its token, <|es|> for "es".
        let scores: [(String, Float)] = languages.compactMap { code in
            guard let token = tokenizer.convertTokenToId("<|\(code)|>") else { return nil }
            return (code, logits[[0, 0, NSNumber(value: token)]].floatValue)
        }
        guard !scores.isEmpty else { throw DetectionError.unavailable("no language tokens") }
        return SpokenLanguage.probabilities(scores)
    }
}

/// A speech-to-text engine. Called from the main actor; implementations do
/// their work elsewhere (WhisperKitTranscriber is an actor).
///
/// A protocol so the dictation loop is tested with a fake one.
protocol Transcriber: Sendable {
    var modelID: String { get }
    func transcribe(_ audio: [Float], context: TranscriptionContext) async throws -> Transcript
}

/// A transcriber whose model has to load before it writes anything (this Mac's Whisper): the loop waits for it, and
/// says so (DictationController).
protocol LoadingTranscriber: Transcriber {
    /// A complete copy is on this Mac, so loading downloads nothing.
    var onDisk: Bool { get }
    func loaded() async -> Bool
    func load() async throws
}

extension WhisperKitTranscriber: LoadingTranscriber {
    func loaded() async -> Bool { isLoaded }
    func load() async throws { try await warmUp() }
}

/// What the transcriber is told about the dictation beyond the audio.
struct TranscriptionContext: Equatable, Sendable {
    /// Spoken language as an ISO 639-1 code, or nil to let the engine decide.
    var language: String?
    /// The languages the person speaks, most used first, which Automatic
    /// chooses among. Empty for the Mac's preferred languages.
    var spokenLanguages: [String] = []
}

struct TranscriptionModel: Equatable, Sendable {
    let id: String
    let displayName: String
    /// The WhisperKit variant, the folder name under argmaxinc/whisperkit-coreml.
    let whisperKitID: String?
    let sizeMB: Int
    let languages: [String]
}

/// The models dictation can run. Large v3 Turbo is the default: it hears
/// every language Whisper knows and is the one measured best on mixed speech.
enum ModelRegistry {
    static let standardID = "whisper-large-v3-turbo"

    static let shared: [TranscriptionModel] = [
        TranscriptionModel(id: "whisper-large-v3-turbo", displayName: "Whisper Large v3 Turbo",
                           whisperKitID: "openai_whisper-large-v3-v20240930_turbo", sizeMB: 1620, languages: ["multi"]),
        TranscriptionModel(id: "whisper-small", displayName: "Whisper Small",
                           whisperKitID: "openai_whisper-small", sizeMB: 490, languages: ["multi"]),
        TranscriptionModel(id: "whisper-small.en", displayName: "Whisper Small (English)",
                           whisperKitID: "openai_whisper-small.en", sizeMB: 488, languages: ["en"]),
        TranscriptionModel(id: "whisper-base.en", displayName: "Whisper Base (English)",
                           whisperKitID: "openai_whisper-base.en", sizeMB: 145, languages: ["en"]),
    ]

    static func find(_ id: String) -> TranscriptionModel? {
        shared.first { $0.id == id }
    }

    /// `id`, or the default model for an id this app doesn't know.
    static func model(_ id: String?) -> TranscriptionModel {
        id.flatMap(find) ?? find(standardID)!
    }
}

/// One word heard, with its times in seconds from the audio's start.
struct HeardWord: Equatable, Sendable {
    var text: String
    var start: Double
    var end: Double
}

struct TranscriberTimings: Equatable, Sendable {
    /// No time spent, for a transcription the engine did not time.
    static let zero = TranscriberTimings()

    /// Seconds of audio handed to the model, after any trimming.
    var audioSeconds: TimeInterval = 0
    /// Silence trimming, padding the window, and the log-mel spectrogram.
    var preprocessing: TimeInterval = 0
    /// Detecting the spoken language before decoding (Automatic): its
    /// own mel spectrogram and encoder pass, and one decoder step.
    var languageDetection: TimeInterval = 0
    /// The audio encoder, over every 30 s window.
    var encoder: TimeInterval = 0
    /// Decoder setup, the prompt, the token loop, and any temperature fallbacks.
    var decoder: TimeInterval = 0
    /// Segmenting, detokenizing and cleaning up the text.
    var postprocessing: TimeInterval = 0
    /// The whole `transcribe` call, wall clock.
    var total: TimeInterval = 0
    /// The language decoded in, as a code, or nil when unknown.
    var language: String?
    /// 30 s windows encoded.
    var windows = 0
    /// Decoder steps, prompt included.
    var tokens = 0
    /// Temperature fallbacks: decodes thrown away and retried.
    var fallbacks = 0
}

/// What the transcriber hands to delivery.
///
/// Holds the person's words. Never log it; it is kept only in History's
/// transcript files. Observers get counts and timings (`DictationResult`).
struct Transcript: Equatable, Sendable {
    var text: String
    /// Where the transcriber spent its time, when the engine reports it.
    var timings: TranscriberTimings?

    init(text: String, timings: TranscriberTimings? = nil) {
        self.text = text
        self.timings = timings
    }
}
