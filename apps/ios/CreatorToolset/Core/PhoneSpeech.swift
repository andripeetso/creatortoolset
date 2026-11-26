import AVFoundation
import Foundation
import Speech

/// The phone writing down what is said to it (Apple's speech engine, iOS 26), so a spoken message needs neither the server
/// nor a computer and no API key. Used whenever the person's mic is not set to Deepgram or OpenAI (Settings → AI → Voice),
/// in the first of their Voice languages the engine hears; one it doesn't hear (Estonian) goes to the server, never written
/// down as another language. The engine's model is the system's own: it is made ready when recording starts, and the
/// person waits for it at the stop (only while it is still downloading) before anything goes to the server.
@MainActor
enum PhoneSpeech {
    struct Prefs: Decodable {
        struct Choice: Decodable { let engine: String }
        struct Stt: Decodable {
            let `default`: Choice
            let per: [String: Choice]
        }
        struct Word: Decodable {
            let term: String
            let soundsLike: [String]
        }
        /// What one use runs on now; `needs` is why it can't (a key, a model), `key` the key it needs.
        struct Resolved: Decodable {
            let use: String
            let needs: String?
            let key: String?
        }
        let languages: [String]
        let stt: Stt
        let words: [Word]?
        let resolved: [Resolved]?
    }

    /// The recording being made: the engine's language, and the words it listens for.
    private struct Session {
        let locale: Locale
        let words: [Prefs.Word]
    }

    /// The model for the recording being made, ready when the task answers; nil when the phone's attempt can't go on.
    private static var pick: Task<Session?, Never>?
    /// A model is being downloaded for the recording being made.
    private static var installing = false

    /// Recording is about to start: the model for the person's language is made ready in the background. False when the
    /// phone can't write this language down at all (the server does).
    static func warm(_ prefs: Prefs?) async -> Bool {
        pick = nil
        guard #available(iOS 26, *), SpeechTranscriber.isAvailable,
              let id = language(prefs, phone: Locale.preferredLanguages),
              let locale = await SpeechTranscriber.supportedLocale(equivalentTo: Locale(identifier: id)) else { return false }
        let session = Session(locale: locale, words: prefs?.words ?? [])
        switch await AssetInventory.status(forModules: [Engine.transcriber(locale)]) {
        case .installed:
            pick = Task<Session?, Never> { session }
        case .unsupported:
            return false
        default:
            installing = true
            pick = Task<Session?, Never> {
                defer { installing = false }
                do {
                    try await Engine.install(locale)
                    return session
                } catch {
                    return nil
                }
            }
        }
        return true
    }

    /// The words, or nil when the phone doesn't write this one down (the server does). `preparing` is called first when the
    /// model is still downloading, so the person sees why the wait is long.
    static func transcribe(_ file: URL, preparing: @escaping () -> Void) async -> String? {
        guard #available(iOS 26, *), let task = pick else { return nil }
        if installing { preparing() }
        guard let session = await task.value,
              let said = try? await Engine.transcribe(file, session.locale, terms: session.words.map(\.term)),
              !said.isEmpty else { return nil }
        return rewrite(said, session.words)
    }

    /// Each misheard spelling (`soundsLike`) in what was heard becomes its term: whole words, any capitals.
    nonisolated static func rewrite(_ text: String, _ words: [Prefs.Word]) -> String {
        words.reduce(text) { said, word in
            word.soundsLike.reduce(said) { out, heard in
                let edge = #"[\p{L}\p{N}]"#
                let pattern = "(?<!\(edge))" + NSRegularExpression.escapedPattern(for: heard) + "(?!\(edge))"
                guard let regex = try? NSRegularExpression(pattern: pattern, options: .caseInsensitive) else { return out }
                return regex.stringByReplacingMatches(in: out, range: NSRange(out.startIndex..., in: out),
                                                      withTemplate: NSRegularExpression.escapedTemplate(for: word.term))
            }
        }
    }

    /// The language the phone writes the mic down in (a BCP 47 id), or nil for the server when the mic is set to Deepgram or
    /// OpenAI. The first of the person's Voice languages, else the phone's own.
    nonisolated static func language(_ prefs: Prefs?, phone: [String]) -> String? {
        if let p = prefs, ["deepgram", "openai"].contains((p.stt.per["mic"] ?? p.stt.default).engine) { return nil }
        guard let code = prefs?.languages.first else { return phone.first }
        // the phone's own variant of it (en-GB, not the engine's first English)
        return phone.first { Locale(identifier: $0).language.languageCode?.identifier == code } ?? code
    }

    /// Why the server can't write the mic down, as one line ("Needs a Deepgram key"), or nil when it can or doesn't say.
    static func needs(_ prefs: Prefs?) -> String? {
        guard let mic = prefs?.resolved?.first(where: { $0.use == "mic" }), let need = mic.needs else { return nil }
        switch mic.key {
        case "OPENAI_API_KEY": return "Needs an OpenAI key"
        case "DEEPGRAM_API_KEY": return "Needs a Deepgram key"
        default: return need
        }
    }

    /// The last answer, by server: a tap starts recording at once with it, and it is read again in the background.
    private static var last: (server: String?, prefs: Prefs)?

    static func prefs() async -> Prefs? {
        let server = Servers.shared.currentId
        if let kept = last, kept.server == server {
            Task {
                if let fresh = await fetchPrefs(), Servers.shared.currentId == server { last = (server, fresh) }
            }
            return kept.prefs
        }
        let fresh = await fetchPrefs()
        if let fresh, Servers.shared.currentId == server { last = (server, fresh) }
        return fresh
    }

    private static func fetchPrefs() async -> Prefs? {
        guard let api = ToolsetAPI.current else { return nil }
        var request = api.request("/api/voice-prefs")
        request.timeoutInterval = 4
        guard let data = try? await api.data(request) else { return nil }
        return try? JSONDecoder().decode(Prefs.self, from: data)
    }
}

@available(iOS 26, *)
private enum Engine {
    static func transcriber(_ locale: Locale) -> SpeechTranscriber { SpeechTranscriber(locale: locale, preset: .transcription) }

    static func install(_ locale: Locale) async throws {
        if let request = try await AssetInventory.assetInstallationRequest(supporting: [transcriber(locale)]) {
            try await request.downloadAndInstall()
        }
    }

    static func transcribe(_ file: URL, _ locale: Locale, terms: [String]) async throws -> String {
        let audio = try AVAudioFile(forReading: file)
        let transcriber = transcriber(locale)
        let analyzer = SpeechAnalyzer(modules: [transcriber])
        let lines = Task {
            var out: [String] = []
            for try await result in transcriber.results where result.isFinal {
                let line = String(result.text.characters).trimmingCharacters(in: .whitespacesAndNewlines)
                if !line.isEmpty { out.append(line) }
            }
            return out
        }
        do {
            if !terms.isEmpty {
                let context = AnalysisContext()
                context.contextualStrings[.general] = terms   // the person's own names, listened for
                try await analyzer.setContext(context)
            }
            if let end = try await analyzer.analyzeSequence(from: audio) {
                try await analyzer.finalizeAndFinish(through: end)
            } else {
                await analyzer.cancelAndFinishNow()
            }
            return try await lines.value.joined(separator: " ")
        } catch {
            lines.cancel()
            await analyzer.cancelAndFinishNow()
            throw error
        }
    }
}
