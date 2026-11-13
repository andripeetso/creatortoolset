import AVFoundation
import Foundation

/// Talk instead of type in the assistant's message box. The phone only records: the person's server writes it down
/// with the engine chosen for talking to the assistant (Settings → AI → Voice, `POST /api/transcribe/mic`), and the
/// words go into the box to be read, changed and sent. Nothing is sent by itself.
@MainActor
final class VoiceInput: ObservableObject {
    enum Phase: Equatable {
        case idle
        case recording(since: Date)
        /// The recording is with the server.
        case writing
    }

    /// The microphone: start, and stop with the recording's file (nil when nothing was recorded).
    struct Mic {
        var start: @MainActor () async throws -> Void
        var stop: @MainActor () -> URL?
    }

    @Published private(set) var phase = Phase.idle
    /// What went wrong, said once above the box.
    @Published var notice: String?

    /// The longest message spoken in one go, as on the computer.
    static let maxSeconds = 120

    private let mic: Mic
    private let writeDown: (URL) async throws -> String
    private var starting = false
    private var limit: Task<Void, Never>?
    private var put: (String) -> Void = { _ in }

    init(mic: Mic = .phone(), writeDown: @escaping (URL) async throws -> String = VoiceInput.upload) {
        self.mic = mic
        self.writeDown = writeDown
    }

    /// The mic button: start recording (the words then go to `put`), or stop and have it written down.
    func toggle(_ put: @escaping (String) -> Void) {
        switch phase {
        case .idle:
            self.put = put
            Task { await record() }
        case .recording:
            Task { await finish() }
        case .writing:
            break
        }
    }

    func record() async {
        guard phase == .idle, !starting else { return }
        starting = true
        defer { starting = false }
        notice = nil
        do {
            try await mic.start()
        } catch {
            notice = Self.say(error)
            return
        }
        phase = .recording(since: Date())
        limit = Task { [weak self] in
            try? await Task.sleep(for: .seconds(Self.maxSeconds))
            if !Task.isCancelled { await self?.finish() }
        }
    }

    func finish() async {
        guard case .recording = phase else { return }
        limit?.cancel()
        guard let file = mic.stop() else { phase = .idle; return }
        phase = .writing
        defer {
            try? FileManager.default.removeItem(at: file)
            phase = .idle
        }
        do {
            let text = try await writeDown(file).trimmingCharacters(in: .whitespacesAndNewlines)
            if text.isEmpty { notice = "Didn't catch anything. Try again a little closer to the mic." } else { put(text) }
        } catch {
            notice = Self.say(error)
        }
    }

    /// Leaving the chat while recording: the recording is thrown away and the mic let go.
    func cancel() {
        guard case .recording = phase else { return }
        limit?.cancel()
        if let file = mic.stop() { try? FileManager.default.removeItem(at: file) }
        phase = .idle
    }

    /// Spoken words added to what is in the box, after a space.
    nonisolated static func appended(_ words: String, to box: String) -> String {
        let kept = box.replacingOccurrences(of: #"\s+$"#, with: "", options: .regularExpression)
        return kept.isEmpty ? words : "\(kept) \(words)"
    }

    /// Seconds as the recording's clock shows them: 0:07, 1:30.
    nonisolated static func clock(_ seconds: Int) -> String {
        "\(seconds / 60):\(String(format: "%02d", seconds % 60))"
    }

    private static func say(_ error: Error) -> String {
        (error as? LocalizedError)?.errorDescription ?? "Couldn't write that down"
    }

    /// The recording to the signed-in server; its words back.
    nonisolated static func upload(_ file: URL) async throws -> String {
        guard let api = ToolsetAPI.current else { throw ToolsetAPI.Failure(status: 0, message: "Not signed in") }
        var request = api.request("/api/transcribe/mic", method: "POST")
        request.setValue("audio/mp4", forHTTPHeaderField: "Content-Type")
        request.httpBody = try Data(contentsOf: file)
        let answer = try await api.data(request, session: ToolsetAPI.slow)
        struct Heard: Decodable { let text: String }
        return try JSONDecoder().decode(Heard.self, from: answer).text
    }
}

private struct MicProblem: LocalizedError {
    let errorDescription: String?
}

extension VoiceInput.Mic {
    /// The phone's microphone: AAC in m4a, 16 kHz mono (what speech engines take, and small to send).
    static func phone() -> Self {
        var recorder: AVAudioRecorder?
        return .init(start: {
            guard await AVAudioApplication.requestRecordPermission() else {
                throw MicProblem(errorDescription: "The microphone is off for Creator Toolset: turn it on in Settings → Privacy & Security → Microphone")
            }
            ReadAloud.shared.stop()
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.record, mode: .default)
            try session.setActive(true)
            let file = FileManager.default.temporaryDirectory.appendingPathComponent("voice-\(UUID().uuidString).m4a")
            let made = try AVAudioRecorder(url: file, settings: [
                AVFormatIDKey: kAudioFormatMPEG4AAC, AVSampleRateKey: 16_000, AVNumberOfChannelsKey: 1, AVEncoderBitRateKey: 32_000,
            ])
            guard made.record() else {
                try? session.setActive(false, options: .notifyOthersOnDeactivation)
                throw MicProblem(errorDescription: "The microphone could not start")
            }
            recorder = made
        }, stop: {
            guard let made = recorder else { return nil }
            made.stop()
            recorder = nil
            try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
            return made.url
        })
    }
}
