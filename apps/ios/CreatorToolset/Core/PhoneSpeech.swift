import AVFoundation
import Foundation
import Speech

/// The phone writing down what is said to it (Apple's speech engine, iOS 26), so a spoken message needs neither the server
/// nor a computer. Only while the person's mic is on Automatic (Settings → AI → Voice) and they speak one language the
/// engine hears; a chosen engine, several languages or one it doesn't hear (Estonian) go to the server as before.
/// The engine's model is the system's own: the first message in a language goes to the server while the system downloads
/// it in the background, and every one after is written down here.
@MainActor
enum PhoneSpeech {
    /// The language for the recording being made, nil when the server writes it down.
    private static var pick: Task<Locale?, Never>?
    private static var downloading: Set<String> = []

    /// Recording started: read the person's Voice settings while they speak.
    static func warm() { pick = Task { await choose() } }

    /// The words, or nil when the phone doesn't write this one down.
    static func transcribe(_ file: URL) async -> String? {
        guard #available(iOS 26, *), let locale = await pick?.value,
              let words = try? await Engine.transcribe(file, locale: locale), !words.isEmpty else { return nil }
        return words
    }

    struct Prefs: Decodable {
        struct Choice: Decodable { let engine: String }
        struct Stt: Decodable {
            let `default`: Choice
            let per: [String: Choice]
        }
        let languages: [String]
        let stt: Stt
    }

    /// The language the phone writes the mic down in (a BCP 47 id), or nil for the server. No settings (the server not
    /// reached, an older one) is Automatic in the phone's own language.
    nonisolated static func language(_ prefs: Prefs?, phone: [String]) -> String? {
        if let p = prefs, (p.stt.per["mic"] ?? p.stt.default).engine != "auto" { return nil }
        let spoken = prefs?.languages ?? []
        guard spoken.count <= 1 else { return nil }  // the engine hears one language; the server's hear several at once
        guard let code = spoken.first else { return phone.first }
        // the phone's own variant of it (en-GB, not the engine's first English)
        return phone.first { Locale(identifier: $0).language.languageCode?.identifier == code } ?? code
    }

    private static func choose() async -> Locale? {
        guard #available(iOS 26, *), SpeechTranscriber.isAvailable,
              let id = language(await prefs(), phone: Locale.preferredLanguages),
              let locale = await SpeechTranscriber.supportedLocale(equivalentTo: Locale(identifier: id)) else { return nil }
        switch await AssetInventory.status(forModules: [Engine.transcriber(locale)]) {
        case .installed: return locale
        case .unsupported: return nil
        default:
            let key = locale.identifier(.bcp47)
            if downloading.insert(key).inserted {
                Task {
                    try? await Engine.install(locale)
                    downloading.remove(key)
                }
            }
            return nil
        }
    }

    private static func prefs() async -> Prefs? {
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

    static func transcribe(_ file: URL, locale: Locale) async throws -> String {
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
