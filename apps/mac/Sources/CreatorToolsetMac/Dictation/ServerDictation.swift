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

    /// The longest the words may take: no longer than the recording itself, and at least 10 s: a short one needs the
    /// trip to the server, and when the server's mic runs on the person's computers and they are busy, it waits up to
    /// 4 s for one before its key writes it (MIC_LIMITS).
    static func timeout(seconds: TimeInterval) -> TimeInterval { max(10, seconds) }

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

/// A speech server of the person's own, by address (Settings → AI → Voice → Dictation → Speech server; empty for
/// everyone by default): each recording is POSTed to it as a WAV first and its `{"text": …}` used. When it can't be
/// reached in time, the recording goes to this Mac's model (DictationController).
struct SpeechServerTranscriber: Transcriber {
    let endpoint: URL
    var modelID: String { "speech server" }

    private struct Response: Decodable { let text: String }

    /// An address with http(s) and a host, or nil (empty, or not one).
    static func url(_ text: String) -> URL? {
        guard let url = URL(string: text.trimmingCharacters(in: .whitespaces)), ["http", "https"].contains(url.scheme ?? ""),
              url.host?.isEmpty == false else { return nil }
        return url
    }

    /// Quick to give up when the server is off, with time for a long recording.
    static func timeout(seconds: TimeInterval) -> TimeInterval { 4 + seconds * 0.25 }

    /// The first connection after launch can fail with "offline" while macOS checks Local Network access, so that
    /// error is tried once more.
    func transcribe(_ audio: [Float], context: TranscriptionContext) async throws -> Transcript {
        do {
            return Transcript(text: try await post(audio))
        } catch let error as URLError where error.code == .notConnectedToInternet {
            try await Task.sleep(nanoseconds: 300_000_000)
            return Transcript(text: try await post(audio))
        }
    }

    /// Opens the connection early (its /health), so the first dictation doesn't pay for it.
    func warmUp() async {
        var request = URLRequest(url: endpoint.deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("health"))
        request.timeoutInterval = 5
        for attempt in 1...10 {
            if (try? await URLSession.shared.data(for: request)) != nil {
                return DictationLog.info("speech server reachable (attempt \(attempt))")
            }
            try? await Task.sleep(nanoseconds: 1_000_000_000)
        }
        DictationLog.warning("speech server not reachable; this Mac's model until it is")
    }

    private func post(_ audio: [Float]) async throws -> String {
        var request = URLRequest(url: endpoint)
        request.httpMethod = "POST"
        request.setValue("audio/wav", forHTTPHeaderField: "Content-Type")
        request.timeoutInterval = Self.timeout(seconds: Double(audio.count) / AudioCapture.targetSampleRate)
        let body = WAVWriter.data(samples: audio, sampleRate: Int(AudioCapture.targetSampleRate))
        let (data, response) = try await URLSession.shared.upload(for: request, from: body)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
            throw URLError(.badServerResponse)
        }
        return try JSONDecoder().decode(Response.self, from: data).text.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}
