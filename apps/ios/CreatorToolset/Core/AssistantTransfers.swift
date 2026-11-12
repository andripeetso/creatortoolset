import Foundation
import UIKit

/// A video's parts go up through a session iOS runs itself, so they carry on with the phone locked,
/// the app in the background or closed. iOS takes a part's bytes from a file: each part is written
/// under the app's caches, handed over, and removed when iOS is done with it.
@MainActor
final class AssistantTransfers: NSObject, URLSessionDataDelegate {
    static let shared = AssistantTransfers()
    /// The name iOS knows the session by: the app delegate hands a wake-up for it to `finished`.
    static let identifier = (Bundle.main.bundleIdentifier ?? "creatortoolset") + ".assistant-videos"
    /// A part whose bytes are all sent and that gets no answer for this long has failed: it is not a slow network.
    static let answerWithin = 120.0

    /// One part of one upload. iOS keeps its task under `name`, and its bytes wait in the file of that name.
    struct Part: Hashable {
        let upload: String
        let number: Int

        /// Where the parts' bytes wait: under the app's caches.
        static let folder = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("assistant-parts", isDirectory: true)

        var name: String { "\(upload)-\(number)" }
        var file: URL { Self.folder.appendingPathComponent(name) }

        init(upload: String, number: Int) {
            self.upload = upload
            self.number = number
        }

        init?(name: String?) {
            guard let name, let dash = name.lastIndex(of: "-"), let number = Int(name[name.index(after: dash)...]),
                  dash != name.startIndex else { return nil }
            self.init(upload: String(name[..<dash]), number: number)
        }
    }

    /// iOS woke the app because parts finished while it was away: called once they are dealt with.
    var finished: (() -> Void)?
    private var session: URLSession!
    /// The parts on their way, by name.
    private var live: [String: URLSessionTask] = [:]
    /// The parts the server answered since the app started: none goes twice.
    private var done: Set<String> = []
    /// Parts ended here because the server never answered them.
    private var unanswered: Set<String> = []
    private var answers: [Int: Data] = [:]
    private var waiters: [String: [UUID: CheckedContinuation<Void, Error>]] = [:]
    private var reports: [String: (Int64) -> Void] = [:]
    /// What the server holds of each upload, as last heard: its part size and its parts. Kept so that
    /// handing over needs no question to the server in the moment the app leaves the front.
    private var held: [String: (partSize: Int, parts: Set<Int>)] = [:]
    /// Done once the parts iOS still held from before the app started are known.
    private var restored: Task<Void, Never>!

    private override init() {
        super.init()
        let config = URLSessionConfiguration.background(withIdentifier: Self.identifier)
        config.isDiscretionary = false
        config.sessionSendsLaunchEvents = true
        config.httpShouldSetCookies = false
        config.httpCookieStorage = nil
        // as long as the server waits for a video that has stopped arriving
        config.timeoutIntervalForResource = 12 * 3600
        session = URLSession(configuration: config, delegate: self, delegateQueue: .main)
        restored = Task { [self] in
            for task in await session.allTasks where task.state == .running || task.state == .suspended {
                if let name = task.taskDescription { live[name] = task }
            }
            // a part's file with no task: left behind by a crash
            let files = (try? FileManager.default.contentsOfDirectory(at: Part.folder, includingPropertiesForKeys: nil)) ?? []
            for file in files where live[file.lastPathComponent] == nil { try? FileManager.default.removeItem(at: file) }
        }
    }

    func note(_ upload: String, partSize: Int, parts: [Int]) {
        held[upload] = (partSize, Set(parts))
    }

    func known(_ upload: String) -> (partSize: Int, parts: Set<Int>)? { held[upload] }

    /// Whether a part still has to be handed over: not while it is on its way, not once the server has answered it.
    func needs(_ part: Part) async -> Bool {
        await restored.value
        return live[part.name] == nil && !done.contains(part.name)
    }

    /// Hands a part to iOS, which sends it whatever becomes of the app. Nothing when it needs no sending.
    func handOver(_ part: Part, _ request: URLRequest, body: Data) async throws {
        guard await needs(part) else { return }
        try FileManager.default.createDirectory(at: Part.folder, withIntermediateDirectories: true)
        try body.write(to: part.file)
        let task = session.uploadTask(with: request, fromFile: part.file)
        task.taskDescription = part.name
        live[part.name] = task
        task.resume()
    }

    /// Sends a part and returns once the server has answered it; `sent` hears its bytes go. `body` is nil
    /// for a part handed over before. A wait that is cancelled leaves the part going: iOS finishes it.
    func send(_ part: Part, _ request: URLRequest, body: Data?, sent: @escaping (Int64) -> Void) async throws {
        if let body { try await handOver(part, request, body: body) }
        await restored.value
        guard live[part.name] != nil else {
            if done.contains(part.name) { return }
            throw ToolsetAPI.Failure(status: 0, message: "The upload stopped")
        }
        reports[part.name] = sent
        let waiter = UUID()
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                if Task.isCancelled {
                    continuation.resume(throwing: CancellationError())
                } else {
                    waiters[part.name, default: [:]][waiter] = continuation
                }
            }
        } onCancel: {
            Task { @MainActor in self.waiters[part.name]?.removeValue(forKey: waiter)?.resume(throwing: CancellationError()) }
        }
    }

    /// A video that is not wanted any more: its parts on their way end, and their files go with them.
    func cancel(_ upload: String) {
        Task { [self] in
            await restored.value
            for (name, task) in live where Part(name: name)?.upload == upload { task.cancel() }
        }
    }

    /// What a finished part came to, as the rest of the app reads errors: nil is "the server took it".
    nonisolated static func failure(status: Int, error: Error?, answer: Data, unanswered: Bool) -> Error? {
        if error == nil, (200..<300).contains(status) { return nil }
        if unanswered || (error as? URLError)?.code == .timedOut {
            return ToolsetAPI.Failure(status: 408, message: "No answer from the server")
        }
        if (error as? URLError)?.code == .cancelled { return CancellationError() }
        if error != nil { return ToolsetAPI.Failure(status: 0, message: "The upload stopped") }
        let object = (try? JSONSerialization.jsonObject(with: answer)) as? [String: Any]
        return ToolsetAPI.Failure(status: status, message: object?["error"] as? String ?? "Upload failed (HTTP \(status))")
    }

    // MARK: What iOS tells (on the main queue)

    nonisolated func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        MainActor.assumeIsolated { answers[dataTask.taskIdentifier, default: Data()].append(data) }
    }

    nonisolated func urlSession(_ session: URLSession, task: URLSessionTask, didSendBodyData bytesSent: Int64,
                                totalBytesSent: Int64, totalBytesExpectedToSend: Int64) {
        MainActor.assumeIsolated {
            guard let name = task.taskDescription else { return }
            reports[name]?(totalBytesSent)
            guard totalBytesSent >= totalBytesExpectedToSend else { return }
            // all of it is with the server: its answer is due
            Task { [self] in
                try? await Task.sleep(for: .seconds(Self.answerWithin))
                guard live[name] === task, task.state == .running else { return }
                unanswered.insert(name)
                task.cancel()
            }
        }
    }

    nonisolated func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        MainActor.assumeIsolated {
            let answer = answers.removeValue(forKey: task.taskIdentifier) ?? Data()
            guard let part = Part(name: task.taskDescription) else { return }
            if live[part.name] === task { live[part.name] = nil }
            if live[part.name] == nil { try? FileManager.default.removeItem(at: part.file) }
            let failure = Self.failure(status: (task.response as? HTTPURLResponse)?.statusCode ?? 0, error: error,
                                       answer: answer, unanswered: unanswered.remove(part.name) != nil)
            if failure == nil { done.insert(part.name) }
            reports[part.name] = nil
            for waiter in (waiters.removeValue(forKey: part.name) ?? [:]).values {
                if let failure { waiter.resume(throwing: failure) } else { waiter.resume() }
            }
        }
    }

    nonisolated func urlSessionDidFinishEvents(forBackgroundURLSession session: URLSession) {
        MainActor.assumeIsolated {
            let tell = finished
            finished = nil
            tell?()
        }
    }
}
