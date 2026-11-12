import Foundation
import Photos
import UIKit

/// Moves every upload into the server's Media Library through its resumable upload
/// (`apps/captions/api/library/routes.ts`): start it, send the bytes in chunks (or the parts straight to the
/// library's bucket), then finish. Each chunk is a background transfer, so it carries on with the phone locked or the
/// app closed, and after any failure the upload resumes from the server's own byte count.
///
/// A clip of the camera roll is first copied out of Photos (`preparing`). On a server whose Media Library is a
/// plug-in's, the Upload tab's clips go there instead (`Studio/CatalogUpload.swift`); a New edit's clips always go to
/// the server's own library, which starts the edit from their upload ids.
@MainActor
final class UploadEngine: ObservableObject {
    static let shared = UploadEngine()

    let store = UploadStore()
    let transfers = Transfers.shared
    private var reconciling = false
    private var reconcileAgain = false
    private var timer: Timer?
    /// The server's chunks are 32 MB; never send more in one request.
    private let maxChunk: Int64 = 32 << 20

    init() {
        transfers.engine = self
        // a piece saved into Photos from a server is never offered back as footage
        SaveToPhotos.added = { ids in LibraryIndex.shared.markInLibrary(ids, server: Servers.shared.currentId) }
    }

    // MARK: What the screens call

    /// A file picked on the phone, already moved to `AppFiles.upload(id)`. Nothing is sent until Upload.
    func add(id: UUID, filename: String, size: Int64, server: Server, edit: UUID? = nil) {
        var item = UploadItem(id: id, filename: filename, size: size, server: server.id)
        item.edit = edit
        store.add(item)
    }

    /// Camera-roll clips, waiting for Upload. A clip already waiting or on its way to that server is not added twice.
    func add(_ assets: [PHAsset], server: String) {
        store.add(assets.filter { store.byAsset[UploadStore.key(asset: $0.localIdentifier, server: server)].map(\.isFinished) ?? true }
            .map { UploadItem(asset: $0.localIdentifier, filename: Exporter.name(for: $0), isVideo: $0.mediaType == .video,
                              capturedAt: $0.creationDate, server: server) })
    }

    /// Upload everything picked, and everything that failed before (a New edit's clips go with their edit).
    func uploadAll() {
        for item in store.items where (item.state == .picked || item.state == .failed) && item.edit == nil {
            retry(item.id)
        }
    }

    /// One clip again from the start of its way: the copy on the phone, then the server's own count.
    func retry(_ id: UUID) {
        store.update(id) {
            $0.state = .preparing
            $0.attempts = 0
            $0.nextAttemptAt = nil
            $0.note = nil
            $0.catalog = nil
        }
        kick()
    }

    func remove(_ id: UUID) {
        Task {
            await transfers.cancel(itemId: id)
            store.remove(id)
            AppFiles.removeSlices(of: id)
        }
    }

    func clearDone() {
        for item in store.items where item.state == .done && item.edit == nil { store.remove(item.id) }
    }

    /// A New edit's clips: each one's upload made on the server, its bytes not sent yet. The upload ids in the order
    /// given; a clip that has one already keeps it.
    func prepare(_ ids: [UUID]) async throws -> [String] {
        for id in ids where store.item(id)?.uploadId == nil {
            guard let item = store.item(id), let api = api(for: item) else { throw APIError.server(404, "Its server was removed") }
            try await makeUpload(id, api)
        }
        return ids.compactMap { store.item($0)?.uploadId }
    }

    /// Then their bytes, through the background session.
    func send(_ ids: [UUID]) {
        for id in ids {
            store.update(id) {
                $0.state = .sending
                $0.attempts = 0
                $0.nextAttemptAt = nil
                $0.note = nil
            }
        }
        kick()
    }

    /// Clips sent again from their copies on the phone, as new uploads (a New edit's Try again).
    func restart(_ ids: [UUID]) async {
        for id in ids {
            await transfers.cancel(itemId: id)
            store.update(id) {
                $0.uploadId = nil
                $0.direct = nil
                $0.sent = 0
                $0.state = .picked
                $0.duplicate = false
                $0.attempts = 0
                $0.nextAttemptAt = nil
                $0.note = nil
            }
        }
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
            for listed in store.items where listed.isWorking {
                // asked fresh for each clip: the one before may have taken a while (a copy out of Photos), and a
                // clip that started sending meanwhile must not be started twice
                guard let item = store.item(listed.id), item.isWorking else { continue }
                if let at = item.nextAttemptAt, at > Date() { continue }
                if await transfers.activeItemIds().contains(item.id) { continue }
                switch item.state {
                case .preparing: await prepare(item.id)
                case .confirming: break
                default: item.route == .catalog ? await catalogResume(item.id) : await resume(item.id)
                }
            }
            await catalogConfirm()
        } while reconcileAgain
    }

    // MARK: Steps

    func api(for item: UploadItem) -> API? {
        Servers.shared.list.first { $0.id == item.server }.map { API(server: $0.url, cookie: Keychain.get($0.id)) }
    }

    /// The copy on the phone (out of Photos for a camera-roll clip), then where it goes, then on its way.
    func prepare(_ id: UUID) async {
        guard var item = store.item(id) else { return }
        guard let api = api(for: item) else { return fail(id, "Its server was removed") }
        do {
            if !FileManager.default.fileExists(atPath: AppFiles.upload(id).path) {
                // a file from Files or a New edit clip has nothing to copy it again from
                guard let assetId = item.assetId else { return fail(id, "The copy on the phone is gone: pick the file again") }
                guard let asset = PHAsset.fetchAssets(withLocalIdentifiers: [assetId], options: nil).firstObject else {
                    return fail(id, "This clip is no longer in Photos")
                }
                note(id, "Getting it from Photos…")
                let exported = try await Exporter.export(asset, to: AppFiles.upload(id))
                store.update(id) {
                    $0.size = exported.size
                    $0.filename = exported.filename
                    $0.sha256 = nil
                    $0.uploadId = nil
                    $0.direct = nil
                    $0.sent = 0
                }
            }
            if item.route == nil {
                let route = try await Self.route(for: item, api: api)
                store.update(id) { $0.route = route }
            }
            guard let fresh = store.item(id) else { return }
            item = fresh
            if item.route == .catalog { return await catalogPrepare(id, api) }
            store.update(id) {
                $0.state = .sending
                $0.note = nil
            }
            await resume(id)
        } catch APIError.signedOut {
            perform(.signedOut, id)
        } catch let error as ExportError {
            fail(id, error.localizedDescription)
        } catch {
            // offline, or Photos couldn't hand it over yet (an iCloud download, low space): later
            perform(.retryLater(error.localizedDescription), id)
        }
    }

    /// A New edit's clips go to the server's own library; the Upload tab's to a plug-in's library when the server's
    /// Media Library is one. Asked of the clip's own server, which may not be the one in use.
    private static func route(for item: UploadItem, api: API) async throws -> UploadItem.Route {
        if item.edit != nil { return .library }
        // a debug build can send there on a scratch server whose library lists no source: -UploadRoute catalog
        if debugArg("UploadRoute") == "catalog" { return .catalog }
        return try await ServerPlugins.read(api).sendsToCatalog ? .catalog : .library
    }

    func note(_ id: UUID, _ text: String?) {
        store.update(id) { $0.note = text }
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

    private func create(_ id: UUID, _ api: API) async throws {
        try await makeUpload(id, api)
        guard let item = store.item(id) else { return }
        if item.direct != nil { startPart(id, 1) } else { startPatch(id, from: item.sent) }
    }

    /// POST /api/library/:id/uploads into the account's first library.
    private func makeUpload(_ id: UUID, _ api: API) async throws {
        guard let item = store.item(id) else { return }
        let libraries: Libraries = try await api.get("/api/library")
        guard let library = libraries.libraries.first else { throw APIError.server(404, "This server has no Media Library") }
        let data = try await api.send("/api/library/\(library.id)/uploads",
                                      json: ["filename": item.filename, "size": item.size])
        let created = try JSONDecoder().decode(Created.self, from: data)
        store.update(id) {
            $0.uploadId = created.id
            $0.chunkSize = created.chunkSize
            $0.direct = created.direct.map { UploadItem.Direct(partSize: $0.partSize, urls: $0.urls) }
            $0.sent = created.offset
        }
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
        case .relayPatch, .catalogPatch: store.liveBytes[step.itemId] = step.offset + sent
        case .finish, .relayComplete, .catalogComplete: break
        }
    }

    func transferFinished(_ step: TransferStep, response: HTTPURLResponse?, body: Data, error: Error?) {
        if step.catalog { return catalogFinished(step, response: response, body: body, error: error) }
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

    func perform(_ action: NextAction, _ id: UUID) {
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
            landed(id, duplicate: duplicate)
        case .startOver(let why):
            // a new upload id is one the edit never hears of: its row says so and offers Try again
            if store.item(id)?.edit != nil { return fail(id, why) }
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

    /// In the library. A New edit's copy stays until its edit has started (Try again sends it once more); any other
    /// copy is deleted, and its camera-roll clip carries the green check from now on.
    func landed(_ id: UUID, duplicate: Bool) {
        store.update(id) {
            $0.state = .done
            $0.duplicate = duplicate
            $0.sent = $0.size
            $0.note = nil
            $0.nextAttemptAt = nil
            $0.finishedAt = Date()
            $0.catalog = nil
        }
        guard let item = store.item(id), item.edit == nil else { return }
        try? FileManager.default.removeItem(at: AppFiles.upload(id))
        AppFiles.removeSlices(of: id)
        if let asset = item.assetId { LibraryIndex.shared.markInLibrary([asset], server: item.server) }
    }

    func fail(_ id: UUID, _ why: String) {
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
