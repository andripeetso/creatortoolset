import Foundation
import UIKit

/// Moves every upload into the server's Media Library through its resumable upload
/// (`apps/captions/api/library/routes.ts`): start it, send the bytes in chunks (or the parts straight to the
/// library's bucket), then finish. Each chunk is a background transfer, so it carries on with the phone locked or the
/// app closed, and after any failure the upload resumes from the server's own byte count.
@MainActor
final class UploadEngine: ObservableObject {
    static let shared = UploadEngine()

    let store = UploadStore()
    private let transfers = Transfers.shared
    private var reconciling = false
    private var reconcileAgain = false
    private var timer: Timer?
    /// The server's chunks are 32 MB; never send more in one request.
    private let maxChunk: Int64 = 32 << 20

    init() { transfers.engine = self }

    // MARK: What the screens call

    /// A file picked on the phone, already moved to `AppFiles.upload(id)`. Nothing is sent until Upload.
    func add(id: UUID, filename: String, size: Int64, server: Server) {
        store.add(UploadItem(id: id, filename: filename, size: size, server: server.id))
    }

    /// Upload everything picked, and everything that failed before.
    func uploadAll() {
        for item in store.items where item.state == .picked || item.state == .failed {
            store.update(item.id) {
                $0.state = .sending
                $0.attempts = 0
                $0.nextAttemptAt = nil
                $0.note = nil
            }
        }
        kick()
    }

    func remove(_ id: UUID) {
        Task {
            await transfers.cancel(itemId: id)
            store.remove(id)
        }
    }

    func clearDone() {
        for item in store.items where item.state == .done { store.remove(item.id) }
    }

    func kick() { Task { await reconcile() } }

    /// While the app is open, waiting uploads are looked at every 15 seconds.
    func setActive(_ active: Bool) {
        timer?.invalidate()
        timer = nil
        guard active else { return }
        timer = Timer.scheduledTimer(withTimeInterval: 15, repeats: true) { _ in
            MainActor.assumeIsolated { UploadEngine.shared.kick() }
        }
        kick()
    }

    /// Starts the next request of every upload that has none running.
    func reconcile() async {
        if reconciling {
            reconcileAgain = true
            return
        }
        reconciling = true
        defer { reconciling = false }
        repeat {
            reconcileAgain = false
            let active = await transfers.activeItemIds()
            for item in store.items where item.isWorking && !active.contains(item.id) {
                if let at = item.nextAttemptAt, at > Date() { continue }
                await resume(item.id)
            }
        } while reconcileAgain
    }

    // MARK: Steps

    private func api(for item: UploadItem) -> API? {
        Servers.shared.list.first { $0.id == item.server }.map { API(server: $0.url, cookie: Keychain.get($0.id)) }
    }

    private func resume(_ id: UUID) async {
        guard let item = store.item(id) else { return }
        guard FileManager.default.fileExists(atPath: AppFiles.upload(id).path) else {
            return fail(id, "The copy on the phone is gone: pick the file again")
        }
        guard let api = api(for: item) else { return fail(id, "Its server was removed") }
        do {
            guard let uploadId = item.uploadId else { return try await create(id, api) }
            if item.state == .finishing { return startFinish(id) }
            if let direct = item.direct {
                if let n = direct.nextPart { startPart(id, n) } else { startFinish(id) }
                return
            }
            // where the server's copy ends (HEAD answers through GET, empty)
            let (_, response) = try await API.session.data(for: api.request("/api/library/uploads/\(uploadId)"))
            let http = response as? HTTPURLResponse
            switch http?.statusCode {
            case 200:
                let at = Int64(http?.value(forHTTPHeaderField: "Upload-Offset") ?? "") ?? 0
                at >= item.size ? startFinish(id) : startPatch(id, from: at)
            case 401: perform(.signedOut, id)
            case 404: perform(.startOver("The server dropped the upload: sending it again"), id)
            default: perform(.retryLater("The server answered \(http?.statusCode ?? 0)"), id)
            }
        } catch APIError.signedOut {
            perform(.signedOut, id)
        } catch APIError.server(let status, let message) where status == 413 || status == 507 || status == 404 {
            fail(id, message)
        } catch {
            perform(.retryLater(error.localizedDescription), id)
        }
    }

    private struct Created: Decodable {
        struct Direct: Decodable {
            let partSize: Int64
            let urls: [URL]
        }
        let id: String
        let offset: Int64
        let chunkSize: Int64
        let direct: Direct?
    }

    private struct Libraries: Decodable {
        struct Library: Decodable { let id: String }
        let libraries: [Library]
    }

    /// POST /api/library/:id/uploads into the account's first library.
    private func create(_ id: UUID, _ api: API) async throws {
        guard let item = store.item(id) else { return }
        let libraries: Libraries = try await api.get("/api/library")
        guard let library = libraries.libraries.first else { return fail(id, "This server has no Media Library") }
        let data = try await api.send("/api/library/\(library.id)/uploads",
                                      json: ["filename": item.filename, "size": item.size])
        let created = try JSONDecoder().decode(Created.self, from: data)
        store.update(id) {
            $0.uploadId = created.id
            $0.chunkSize = created.chunkSize
            $0.direct = created.direct.map { UploadItem.Direct(partSize: $0.partSize, urls: $0.urls) }
            $0.sent = 0
        }
        if created.direct != nil { startPart(id, 1) } else { startPatch(id, from: created.offset) }
    }

    private func startPatch(_ id: UUID, from offset: Int64) {
        guard let item = store.item(id), let uploadId = item.uploadId, let api = api(for: item) else { return }
        let step = TransferStep(itemId: id, kind: .patch, offset: offset)
        let length = min(item.size - offset, min(item.chunkSize ?? maxChunk, maxChunk))
        let body = AppFiles.slice(step)
        do {
            try AppFiles.copy(AppFiles.upload(id), from: offset, length: length, to: body)
        } catch {
            return perform(.retryLater("Couldn't read the copy on the phone"), id)
        }
        var request = api.request("/api/library/uploads/\(uploadId)", method: "PATCH")
        request.setValue("application/offset+octet-stream", forHTTPHeaderField: "Content-Type")
        request.setValue(String(offset), forHTTPHeaderField: "Upload-Offset")
        request.allowsCellularAccess = !UserDefaults.standard.bool(forKey: "wifiOnly")
        store.update(id) {
            $0.state = .sending
            $0.sent = offset
        }
        transfers.start(request, file: body, step: step)
    }

    /// A part straight to the bucket's signed URL: no cookie and no other header goes with it.
    private func startPart(_ id: UUID, _ n: Int) {
        guard let item = store.item(id), let direct = item.direct, n >= 1, n <= direct.urls.count else { return }
        let step = TransferStep(itemId: id, kind: .part, part: n)
        let offset = Int64(n - 1) * direct.partSize
        let body = AppFiles.slice(step)
        do {
            try AppFiles.copy(AppFiles.upload(id), from: offset, length: min(direct.partSize, item.size - offset), to: body)
        } catch {
            return perform(.retryLater("Couldn't read the copy on the phone"), id)
        }
        var request = URLRequest(url: direct.urls[n - 1])
        request.httpMethod = "PUT"
        request.allowsCellularAccess = !UserDefaults.standard.bool(forKey: "wifiOnly")
        store.update(id) {
            $0.state = .sending
            $0.sent = offset
        }
        transfers.start(request, file: body, step: step)
    }

    private func startFinish(_ id: UUID) {
        guard let item = store.item(id), let uploadId = item.uploadId, let api = api(for: item) else { return }
        let step = TransferStep(itemId: id, kind: .finish)
        let body = AppFiles.slice(step)
        let parts = (item.direct?.etags ?? [:]).sorted { $0.key < $1.key }.map { ["number": $0.key, "etag": $0.value] as [String: Any] }
        let json = item.direct == nil ? Data() : (try? JSONSerialization.data(withJSONObject: ["parts": parts])) ?? Data()
        FileManager.default.createFile(atPath: body.path, contents: json)
        var request = api.request("/api/library/uploads/\(uploadId)/finish", method: "POST")
        if !json.isEmpty { request.setValue("application/json", forHTTPHeaderField: "Content-Type") }
        store.update(id) {
            $0.state = .finishing
            $0.sent = $0.size
            $0.note = "Finishing…"
        }
        transfers.start(request, file: body, step: step)
    }

    // MARK: Answers

    func progress(_ step: TransferStep, sent: Int64) {
        guard let item = store.item(step.itemId) else { return }
        switch step.kind {
        case .patch: store.liveBytes[step.itemId] = step.offset + sent
        case .part: store.liveBytes[step.itemId] = Int64(step.part - 1) * (item.direct?.partSize ?? 0) + sent
        case .finish: break
        }
    }

    func transferFinished(_ step: TransferStep, response: HTTPURLResponse?, body: Data, error: Error?) {
        try? FileManager.default.removeItem(at: AppFiles.slice(step))
        store.liveBytes[step.itemId] = nil
        guard let item = store.item(step.itemId), item.isWorking else { return }
        if let error = error as NSError?, error.code == NSURLErrorCancelled { return }
        let action = Rules.after(step, status: response?.statusCode ?? 0,
                                 uploadOffset: response?.value(forHTTPHeaderField: "Upload-Offset").flatMap { Int64($0) },
                                 etag: response?.value(forHTTPHeaderField: "ETag"),
                                 size: item.size, body: body, networkError: error != nil || response == nil)
        perform(action, step.itemId)
    }

    private func perform(_ action: NextAction, _ id: UUID) {
        switch action {
        case .send(let from):
            store.update(id) {
                $0.attempts = 0
                $0.note = nil
            }
            startPatch(id, from: from)
        case .partDone(let n, let etag):
            store.update(id) {
                $0.direct?.etags[n] = etag
                $0.attempts = 0
                $0.note = nil
            }
            if let next = store.item(id)?.direct?.nextPart { startPart(id, next) } else { startFinish(id) }
        case .finish:
            startFinish(id)
        case .done(let duplicate):
            store.update(id) {
                $0.state = .done
                $0.duplicate = duplicate
                $0.sent = $0.size
                $0.note = nil
            }
            try? FileManager.default.removeItem(at: AppFiles.upload(id))
        case .startOver(let why):
            let attempts = (store.item(id)?.attempts ?? 0) + 1
            if attempts > 5 { return fail(id, why) }
            store.update(id) {
                $0.uploadId = nil
                $0.direct = nil
                $0.sent = 0
                $0.state = .sending
                $0.attempts = attempts
                $0.note = why
            }
            kick()
        case .retryLater(let why):
            // a lost connection never gives up: the upload waits, at most 10 minutes between tries
            store.update(id) {
                $0.attempts += 1
                $0.nextAttemptAt = Date().addingTimeInterval(Rules.backoff($0.attempts))
                $0.note = why
            }
        case .signedOut:
            if Servers.shared.currentId == store.item(id)?.server { Servers.shared.sessionExpired() }
            fail(id, "Signed out: sign in again in More, then Upload")
        case .failed(let why):
            fail(id, why)
        }
    }

    private func fail(_ id: UUID, _ why: String) {
        store.update(id) {
            $0.state = .failed
            $0.note = why
        }
    }
}

/// The background URLSession. iOS runs these uploads itself and relaunches the app in the background when one ends,
/// so the next chunk can be queued. It keeps no cookies: the server's requests carry the sign-in header themselves.
final class Transfers: NSObject, URLSessionDataDelegate {
    static let identifier = (Bundle.main.bundleIdentifier ?? "com.creatortoolset.ios") + ".transfers"
    static let shared = Transfers()

    private(set) var session: URLSession!
    /// From the app delegate when iOS relaunched the app for finished transfers; called once they are handled.
    var backgroundCompletion: (() -> Void)?
    weak var engine: UploadEngine?
    private var bodies: [Int: Data] = [:]

    override init() {
        super.init()
        let config = URLSessionConfiguration.background(withIdentifier: Self.identifier)
        config.isDiscretionary = false
        config.sessionSendsLaunchEvents = true
        config.httpShouldSetCookies = false
        config.httpCookieStorage = nil
        config.timeoutIntervalForRequest = 120
        session = URLSession(configuration: config, delegate: self, delegateQueue: .main)
    }

    func start(_ request: URLRequest, file: URL, step: TransferStep) {
        let task = session.uploadTask(with: request, fromFile: file)
        task.taskDescription = step.encoded
        task.resume()
    }

    func activeItemIds() async -> Set<UUID> {
        let tasks = await session.allTasks
        return Set(tasks.filter { $0.state == .running || $0.state == .suspended }
            .compactMap { TransferStep(encoded: $0.taskDescription)?.itemId })
    }

    func cancel(itemId: UUID) async {
        for task in await session.allTasks where TransferStep(encoded: task.taskDescription)?.itemId == itemId {
            task.cancel()
        }
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        bodies[dataTask.taskIdentifier, default: Data()].append(data)
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didSendBodyData bytesSent: Int64,
                    totalBytesSent: Int64, totalBytesExpectedToSend: Int64) {
        guard let step = TransferStep(encoded: task.taskDescription) else { return }
        MainActor.assumeIsolated { engine?.progress(step, sent: totalBytesSent) }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        let body = bodies.removeValue(forKey: task.taskIdentifier) ?? Data()
        guard let step = TransferStep(encoded: task.taskDescription) else { return }
        let response = task.response as? HTTPURLResponse
        MainActor.assumeIsolated { engine?.transferFinished(step, response: response, body: body, error: error) }
    }

    func urlSessionDidFinishEvents(forBackgroundURLSession session: URLSession) {
        let completion = backgroundCompletion
        backgroundCompletion = nil
        _ = MainActor.assumeIsolated {
            Task {
                await UploadEngine.shared.reconcile()
                completion?()
            }
        }
    }
}
