// Dictation written down by the person's server (Settings → AI → Voice → Dictation → Engine): the recording goes to
// POST /api/transcribe/mic with the window's session, and the server's engine for talking to the assistant (their own
// Deepgram or OpenAI key, Settings → API keys) answers { text, language }. This Mac's model (the default) needs no server.
import Foundation

/// Who writes dictation down; stored on this Mac (dictation is per Mac) under `dictation.engine`.
enum DictationEngine: String {
    case thisMac = "mac"
    case server

    /// The server's engine is wired here (ServerTranscriber), so Settings offers it.
    static let serverWired = true
}

struct ServerTranscriber: Transcriber {
    let modelID = "server"
    /// The site with the window's session; nil while the app has no server open.
    let site: @Sendable () async -> Site?

    func transcribe(_ audio: [Float], context: TranscriptionContext) async throws -> Transcript {
        guard let site = await site(), let url = URL(string: "/api/transcribe/mic", relativeTo: site.base) else {
            throw ServerDictationError(userMessage: "Open a server in Creator Toolset to dictate with it")
        }
        let seconds = Double(audio.count) / AudioCapture.targetSampleRate
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.httpShouldHandleCookies = false
        request.allHTTPHeaderFields = HTTPCookie.requestHeaderFields(with: site.cookies)
        request.setValue("audio/wav", forHTTPHeaderField: "Content-Type")
        request.httpBody = WAVWriter.data(samples: audio, sampleRate: Int(AudioCapture.targetSampleRate))
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForResource = Self.timeout(seconds: seconds)
        let session = URLSession(configuration: config)
        defer { session.finishTasksAndInvalidate() }
        let data: Data, status: Int
        do {
            let (d, response) = try await session.data(for: request)
            data = d
            status = (response as? HTTPURLResponse)?.statusCode ?? 0
        } catch {
            throw ServerDictationError(userMessage: "Your server didn't answer")
        }
        return Transcript(text: try Self.text(status: status, data: data))
    }

    /// The longest the words may take: no longer than the recording itself, and at least 3 s, the time a short one
    /// needs to reach the server and come back.
    static func timeout(seconds: TimeInterval) -> TimeInterval { max(3, seconds) }

    /// The words from the server's answer, or what to tell the person. Pure, so it is tested.
    static func text(status: Int, data: Data) throws -> String {
        let body = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
        let error = body?["error"] as? String
        switch status {
        case 200:
            return (body?["text"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        case 402 where body?["code"] as? String == "NEEDS_KEY":
            // the same words as Settings: "Needs a Deepgram key"
            throw ServerDictationError(userMessage: error.flatMap { $0.hasPrefix("Needs") ? $0 : nil } ?? "Needs a Deepgram key")
        case 401:
            throw ServerDictationError(userMessage: "Sign in to your server to dictate with it")
        default:
            throw ServerDictationError(userMessage: error.map { String($0.prefix(120)) } ?? "Your server couldn't write it down (HTTP \(status))")
        }
    }
}

struct ServerDictationError: UserFacingError, LocalizedError, Equatable {
    let userMessage: String
    var errorDescription: String? { userMessage }
}
