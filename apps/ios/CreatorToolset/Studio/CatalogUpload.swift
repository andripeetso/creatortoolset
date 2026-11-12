import Foundation
import Photos

// The studio's Media Library is the catalog behind its plug-in. The Upload tab's clips go there through the plug-in's
// proxy, with the studio's own sign-in: a video through the fast route (TUS to the video edge, which the library then
// fetches), anything else, or when the fast route fails, straight to the library in resumable pieces. A clip counts
// as in the library only when the library's sha256 is the phone's.

/// The fast route's upload of one clip.
struct RelaySession: Codable, Hashable {
    var ingestId: String
    var videoId: String
    var libraryId: String
    var signature: String
    var expiresAt: Int64
    var uploadURL: URL
}

/// Where one clip stands with the catalog (saved with the upload, so a relaunch carries on).
struct CatalogSend: Codable, Hashable {
    /// On the fast route; nil when it goes straight to the library.
    var relay: RelaySession?
    /// The library's upload (the fast route's or the direct one).
    var ingestId: String?
    var chunkSize: Int64?
    /// The fast route refused it or the server has none: straight to the library from now on.
    var direct = false
    /// Fresh uploads for this clip so far (`CatalogRules.maxRestarts`).
    var restarts = 0
    /// When the fast route had every byte; the library has `confirmGiveUp` to fetch it.
    var sentAt: Date?
}

/// The library's answer about an upload (`POST api/uploads/status`); anything it adds later is `unknown`.
enum ServerUploadState: String {
    case complete, duplicate, receiving, failed
    case missing
    case unknown

    init(server: String?) { self = ServerUploadState(rawValue: server ?? "") ?? .unknown }
}

/// The `Upload-State` header of a direct upload (HEAD api/uploads/:id).
enum DirectUploadState: String {
    case uploading, complete, unknown

    init(server: String?) { self = DirectUploadState(rawValue: server ?? "") ?? .unknown }
}

extension ServerPlugins.Known {
    /// The server's Media Library is the studio's catalog: the Upload tab sends there and shows it.
    var catalog: Bool { plugins.contains(Studio.plugin) && mainSource != nil }
}

extension APIError {
    /// Worth trying again later rather than giving up on the clip.
    var transient: Bool { [0, 408, 409, 425, 429].contains(status) || status >= 500 }
}

/// The catalog's upload and clip routes, through the plug-in's proxy with the studio's sign-in cookie.
struct CatalogAPI {
    let api: API

    /// A catalog path through the plug-in's proxy (`api/clips`, `download/7`).
    static func path(_ path: String) -> String { Studio.path("/media/" + path) }

    func request(_ path: String, method: String = "GET", json: Any? = nil) -> URLRequest {
        var request = api.request(Self.path(path), method: method, json: json)
        request.timeoutInterval = 60
        return request
    }

    /// The answer, whatever its status; no answer at all is `.offline`. Sends no cookie to anyone but the server
    /// (`API.session` keeps none), so it also asks the video edge.
    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        do {
            let (data, response) = try await API.session.data(for: request)
            guard let http = response as? HTTPURLResponse else { throw APIError.offline }
            return (data, http)
        } catch let error as URLError where error.code != .cancelled {
            throw APIError.offline
        }
    }

    /// The JSON of a 2xx answer; anything else is an `APIError` (`failure`).
    func json(_ request: URLRequest) async throws -> [String: Any] {
        let (data, http) = try await send(request)
        let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
        guard (200..<300).contains(http.statusCode) else { throw await failure(http.statusCode, object) }
        return object
    }

    /// A 401 signs the server in use out. While the studio restarts the library can't check the sign-in and answers
    /// 403 `toolset_unreachable`: that is a wait, not a refusal. The proxy's bare 404 means the account has no Media
    /// Library (or the server no catalog).
    func failure(_ status: Int, _ object: [String: Any]) async -> APIError {
        if status == 401 {
            let id = api.server.absoluteString
            await MainActor.run { if Servers.shared.currentId == id { Servers.shared.sessionExpired() } }
            return .signedOut
        }
        let message = object["error"] as? String ?? "The server answered \(status)"
        if CatalogRules.restarting(status, object) { return .server(503, "The library is restarting") }
        if status == 404 && message == "Not found" { return .server(404, "The Media Library isn't on for this account") }
        return .server(status, message)
    }

    // MARK: What the library already has

    /// sha256 fingerprints the library already holds. A server without the check answers 404: none.
    func known(_ hashes: [String]) async throws -> Set<String> {
        let (data, http) = try await send(request("api/uploads/known", method: "POST", json: ["sha256": hashes]))
        if http.statusCode == 404 { return [] }
        let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
        guard (200..<300).contains(http.statusCode) else { throw await failure(http.statusCode, object) }
        return Set((object["known"] as? [String: Any] ?? [:]).keys)
    }

    /// Filenames whose name and size match a library clip. Names must be unique within one call.
    func sameFiles(_ files: [(name: String, size: Int64)]) async throws -> Set<String> {
        let body = ["files": files.map { ["filename": $0.name, "size_bytes": $0.size] }]
        let object = try await json(request("api/uploads/dupe-check", method: "POST", json: body))
        let results = object["results"] as? [String: [String: Any]] ?? [:]
        return Set(results.compactMap { name, result in
            (result["has_match"] as? Bool == true && result["size_match"] as? Bool == true) ? name : nil
        })
    }

    // MARK: Starting an upload

    private func createBody(_ item: UploadItem) -> [String: Any] {
        var body: [String: Any] = ["filename": item.filename, "size_bytes": item.size, "destination": "auto"]
        if let at = item.capturedAt { body["source_created_at"] = ISO8601DateFormatter().string(from: at) }
        return body
    }

    struct RelayMint {
        let ingestId: String
        let videoId: String
        let libraryId: String
        let signature: String
        let expiresAt: Int64
        let endpoint: URL
    }

    /// A fast-route upload for a video; nil when the server has none (501).
    func createRelay(_ item: UploadItem) async throws -> RelayMint? {
        let (data, http) = try await send(request("api/uploads/relay", method: "POST", json: createBody(item)))
        if http.statusCode == 501 { return nil }
        let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
        guard http.statusCode == 201 else { throw await failure(http.statusCode, object) }
        guard let ingest = object["ingest_id"] as? String, let video = object["video_id"] as? String,
              let endpoint = (object["endpoint"] as? String).flatMap(URL.init(string:)),
              let signature = object["authorization_signature"] as? String else {
            throw APIError.server(502, "Couldn't start the upload")
        }
        return RelayMint(ingestId: ingest, videoId: video, libraryId: object["library_id"].map { "\($0)" } ?? "",
                         signature: signature, expiresAt: (object["authorization_expires_at"] as? NSNumber)?.int64Value ?? 0,
                         endpoint: endpoint)
    }

    static func tusHeaders(videoId: String, libraryId: String, signature: String, expiresAt: Int64) -> [String: String] {
        ["AuthorizationSignature": signature, "AuthorizationExpire": String(expiresAt), "LibraryId": libraryId,
         "VideoId": videoId, "Tus-Resumable": "1.0.0"]
    }

    static func tusHeaders(_ relay: RelaySession) -> [String: String] {
        tusHeaders(videoId: relay.videoId, libraryId: relay.libraryId, signature: relay.signature, expiresAt: relay.expiresAt)
    }

    /// The upload on the edge (no cookie goes there); its address.
    func tusCreate(_ mint: RelayMint, item: UploadItem) async throws -> URL {
        var request = URLRequest(url: mint.endpoint)
        request.httpMethod = "POST"
        for (key, value) in Self.tusHeaders(videoId: mint.videoId, libraryId: mint.libraryId, signature: mint.signature,
                                            expiresAt: mint.expiresAt) {
            request.setValue(value, forHTTPHeaderField: key)
        }
        request.setValue(String(item.size), forHTTPHeaderField: "Upload-Length")
        let meta = "filetype \(Data("video/quicktime".utf8).base64EncodedString()),title \(Data(item.filename.utf8).base64EncodedString())"
        request.setValue(meta, forHTTPHeaderField: "Upload-Metadata")
        let (_, http) = try await send(request)
        guard http.statusCode == 201, let location = http.value(forHTTPHeaderField: "Location"),
              let url = URL(string: location, relativeTo: mint.endpoint)?.absoluteURL else {
            throw APIError.server(http.statusCode, "The fast route refused the upload (HTTP \(http.statusCode))")
        }
        return url
    }

    /// Bytes the edge holds; nil when that upload no longer exists.
    func tusOffset(_ relay: RelaySession) async throws -> Int64? {
        var request = URLRequest(url: relay.uploadURL)
        request.httpMethod = "HEAD"
        for (key, value) in Self.tusHeaders(relay) { request.setValue(value, forHTTPHeaderField: key) }
        let (_, http) = try await send(request)
        switch http.statusCode {
        case 200, 204: return Int64(http.value(forHTTPHeaderField: "Upload-Offset") ?? "") ?? 0
        case 429, 500...599: throw APIError.server(http.statusCode, "The upload server had a hiccup")
        default: return nil
        }
    }

    /// A resumable upload straight to the library: its id, piece size and where it stands.
    func createDirect(_ item: UploadItem) async throws -> (ingestId: String, chunkSize: Int64, offset: Int64) {
        let object = try await json(request("api/uploads", method: "POST", json: createBody(item)))
        guard let ingest = object["ingest_id"] as? String else { throw APIError.server(502, "The server didn't start the upload") }
        return (ingest, (object["chunk_size"] as? NSNumber)?.int64Value ?? CatalogRules.maxPiece,
                (object["offset"] as? NSNumber)?.int64Value ?? 0)
    }

    /// (bytes received, state) of a direct upload; nil when it is gone.
    func directOffset(_ ingestId: String) async throws -> (offset: Int64, state: DirectUploadState)? {
        let (data, http) = try await send(request("api/uploads/\(ingestId)", method: "HEAD"))
        switch http.statusCode {
        case 204, 200:
            let state = DirectUploadState(server: http.value(forHTTPHeaderField: "Upload-State"))
            guard state != .unknown else { return nil }
            return (Int64(http.value(forHTTPHeaderField: "Upload-Offset") ?? "") ?? 0, state)
        case 404, 409, 410:
            return nil
        default:
            throw await failure(http.statusCode, (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:])
        }
    }

    struct Status {
        let state: ServerUploadState
        let sha256: String?
    }

    func statuses(_ ingestIds: [String]) async throws -> [String: Status] {
        guard !ingestIds.isEmpty else { return [:] }
        let object = try await json(request("api/uploads/status", method: "POST", json: ["ingest_ids": ingestIds]))
        return (object["uploads"] as? [String: [String: Any]] ?? [:]).mapValues {
            Status(state: ServerUploadState(server: $0["state"] as? String), sha256: $0["sha256"] as? String)
        }
    }
}

// MARK: Reading the library

extension CatalogAPI {
    /// The website's one ranked search (keywords and meaning), or with no words every finished clip, newest first.
    /// With the ETag of what the phone shows, an unchanged answer is a bodiless 304: nil.
    func clips(search words: String, media: CatalogMedia, etag: String?) async throws -> (clips: [CatalogClip], etag: String?)? {
        var query = URLComponents()
        var items: [URLQueryItem] = []
        if !words.isEmpty { items.append(URLQueryItem(name: "q", value: words)) }
        if let value = media.query, !words.isEmpty { items.append(URLQueryItem(name: "media", value: value)) }
        query.queryItems = items.isEmpty ? nil : items
        var request = request("api/clips" + (query.percentEncodedQuery.map { "?" + $0 } ?? ""))
        request.timeoutInterval = 45
        if let etag { request.setValue(etag, forHTTPHeaderField: "If-None-Match") }
        let (data, http) = try await send(request)
        if http.statusCode == 304 { return nil }
        let object = try? JSONSerialization.jsonObject(with: data)
        guard (200..<300).contains(http.statusCode) else { throw await failure(http.statusCode, object as? [String: Any] ?? [:]) }
        let found = ((object as? [[String: Any]]) ?? []).compactMap(CatalogClip.init).filter(media.matches)
        // a search keeps the server's ranking; the plain list is newest first
        let ordered = words.isEmpty ? found.sorted { ($0.shotAt ?? .distantPast) > ($1.shotAt ?? .distantPast) } : found
        return (ordered, http.value(forHTTPHeaderField: "ETag"))
    }

    /// A short-lived signed link to the certified video on the video edge, for the player.
    func videoURL(_ clip: Int) async throws -> URL {
        let object = try await json(request("api/clips/\(clip)/download-url"))
        guard let text = object["url"] as? String, let url = URL(string: text), url.scheme == "https" || url.scheme == "http" else {
            throw APIError.server(409, "This video can't be played yet")
        }
        return url
    }

    /// The certified file with its catalog name into Photos, dated when it was shot; its Photos id.
    @MainActor
    func saveToPhotos(_ clip: CatalogClip, progress: @escaping @Sendable (Double) -> Void) async throws -> String {
        let status = await PHPhotoLibrary.requestAuthorization(for: .readWrite)
        guard status == .authorized || status == .limited else {
            throw SaveToPhotos.Failure(message: "Allow Creator Toolset to use Photos in Settings to save clips.")
        }
        let (temporary, response) = try await API.session.download(for: request("download/\(clip.id)"), delegate: DownloadProgress(report: progress))
        let status2 = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status2) else {
            try? FileManager.default.removeItem(at: temporary)
            throw SaveToPhotos.Failure(message: status2 == 404 || status2 == 409 ? "This clip isn't ready to download yet." : "Download failed (HTTP \(status2)).")
        }
        // Photos reads the type from the extension
        let ext = (clip.filename as NSString).pathExtension
        let file = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
            .appendingPathExtension(ext.isEmpty ? (clip.isVideo ? "mp4" : "jpg") : ext)
        try FileManager.default.moveItem(at: temporary, to: file)
        defer { try? FileManager.default.removeItem(at: file) }
        var assetId: String?
        try await PHPhotoLibrary.shared().performChanges {
            let request = PHAssetCreationRequest.forAsset()
            let options = PHAssetResourceCreationOptions()
            options.originalFilename = clip.filename
            request.addResource(with: clip.isVideo ? .video : .photo, fileURL: file, options: options)
            if let shotAt = clip.shotAt { request.creationDate = shotAt }
            assetId = request.placeholderForCreatedAsset?.localIdentifier
        }
        guard let assetId else { throw SaveToPhotos.Failure(message: "Photos didn't keep the clip") }
        return assetId
    }

    /// Follows the download task's own progress.
    private final class DownloadProgress: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
        let report: @Sendable (Double) -> Void
        private var observation: NSKeyValueObservation?
        init(report: @escaping @Sendable (Double) -> Void) { self.report = report }

        func urlSession(_ session: URLSession, didCreateTask task: URLSessionTask) {
            observation = task.progress.observe(\.fractionCompleted) { [report] progress, _ in report(progress.fractionCompleted) }
        }
    }
}

/// What to do after a step to the catalog finished.
enum CatalogNext: Equatable {
    case send(from: Int64)
    case complete
    /// fast route: wait until the library fetched it
    case confirm
    case finished(sha256: String?, duplicate: Bool)
    /// ask the server where it stands
    case resync
    /// the upload is gone: a fresh one
    case newSession(String)
    case sendDirectly(String)
    case retryLater(String)
    case signedOut
    case failed(String)
}

enum CatalogRules {
    /// Failed tries in a row before a clip needs a look.
    static let maxAttempts = 12
    /// Fresh uploads for one clip before it leaves the fast route, then fails.
    static let maxRestarts = 3
    /// The proxy takes pieces up to 16 MiB.
    static let maxPiece: Int64 = 16 << 20
    /// A fast-route upload the library hasn't fetched after this long is sent again directly.
    static let confirmGiveUp: TimeInterval = 90 * 60

    static func exhausted(afterAttempt attempts: Int) -> Bool { attempts + 1 >= maxAttempts }

    /// 5 s, 10 s, 20 s … up to 10 minutes.
    static func backoff(attempt: Int) -> TimeInterval { min(600, 5 * pow(2, Double(max(0, attempt - 1)))) }

    /// The library couldn't ask the studio who is signed in (it is restarting).
    static func restarting(_ status: Int, _ object: [String: Any]?) -> Bool {
        status == 403 && object?["code"] as? String == "toolset_unreachable"
    }

    static func after(_ kind: TransferStep.Kind, status: Int, uploadOffset: Int64?, size: Int64, body: Data,
                      networkError: Bool) -> CatalogNext {
        if networkError { return .retryLater("The connection dropped") }
        let json = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any]
        if restarting(status, json) { return .retryLater("The library is restarting") }
        let hiccup = "The server had a hiccup (HTTP \(status))"
        let said = json?["error"] as? String ?? "HTTP \(status)"
        switch kind {
        case .relayPatch:
            switch status {
            case 200, 204:
                guard let offset = uploadOffset else { return .resync }
                return offset >= size ? .complete : .send(from: offset)
            case 409: return .resync
            case 401, 403, 404, 410: return .newSession("The upload link expired")
            case 429, 500...599: return .retryLater(hiccup)
            default: return .sendDirectly("The fast route refused it (HTTP \(status))")
            }
        case .relayComplete:
            switch status {
            case 200: return .confirm
            case 401: return .signedOut
            case 403, 404: return .sendDirectly("The library couldn't take it from the fast route")
            case 409, 429, 500...599: return .retryLater(hiccup)
            default: return .sendDirectly(said)
            }
        case .catalogPatch:
            switch status {
            case 204, 409:
                guard let offset = uploadOffset else { return .resync }
                return offset >= size ? .complete : .send(from: offset)
            case 401: return .signedOut
            case 400, 404, 410, 413: return .newSession("The server refused a piece (HTTP \(status))")
            case 429, 500...599: return .retryLater(hiccup)
            default: return .failed(said)
            }
        case .catalogComplete:
            switch status {
            case 200:
                let duplicate = json?["duplicate_of"] != nil && !(json?["duplicate_of"] is NSNull)
                return .finished(sha256: json?["sha256"] as? String, duplicate: duplicate)
            case 401: return .signedOut
            case 409: return .resync
            case 404: return .newSession("The server lost the upload")
            case 429, 500...599: return .retryLater(hiccup)
            default: return .failed(said)
            }
        case .patch, .part, .finish:
            return .failed(said)
        }
    }
}

// MARK: The way through the catalog, step by step

extension UploadEngine {
    /// The copy is on the phone: fingerprint it, skip it when the library has these bytes, else start sending.
    func catalogPrepare(_ id: UUID, _ api: API) async {
        let catalog = CatalogAPI(api: api)
        do {
            if store.item(id)?.sha256 == nil {
                note(id, "Checking the library…")
                let sha = try await Exporter.sha256(of: AppFiles.upload(id))
                store.update(id) { $0.sha256 = sha }
            }
            guard let sha = store.item(id)?.sha256 else { return }
            if try await catalog.known([sha]).contains(sha) { return landed(id, duplicate: true) }
            store.update(id) {
                $0.state = .sending
                $0.note = nil
            }
            try await catalogBegin(id, catalog)
        } catch {
            catalogHandle(error, id)
        }
    }

    /// A new upload: the fast route for a video, straight to the library otherwise.
    private func catalogBegin(_ id: UUID, _ catalog: CatalogAPI) async throws {
        guard let item = store.item(id) else { return }
        var send = item.catalog ?? CatalogSend()
        send.relay = nil
        send.ingestId = nil
        if item.isVideo == true && !send.direct {
            if let mint = try await catalog.createRelay(item) {
                do {
                    let url = try await catalog.tusCreate(mint, item: item)
                    send.relay = RelaySession(ingestId: mint.ingestId, videoId: mint.videoId, libraryId: mint.libraryId,
                                              signature: mint.signature, expiresAt: mint.expiresAt, uploadURL: url)
                    send.ingestId = mint.ingestId
                    store.update(id) {
                        $0.catalog = send
                        $0.state = .sending
                        $0.sent = 0
                        $0.note = nil
                    }
                    return startRelayPatch(id, from: 0)
                } catch let error as APIError where !error.transient {
                    send.direct = true
                }
            } else {
                send.direct = true
            }
        }
        let made = try await catalog.createDirect(item)
        send.ingestId = made.ingestId
        send.chunkSize = made.chunkSize
        send.direct = true
        store.update(id) {
            $0.catalog = send
            $0.state = .sending
            $0.sent = made.offset
            $0.note = nil
        }
        startCatalogPatch(id, from: made.offset)
    }

    /// A clip on its way with no transfer running: ask where it stands and carry on from there.
    func catalogResume(_ id: UUID) async {
        guard let item = store.item(id) else { return }
        guard let api = api(for: item) else { return fail(id, "Its server was removed") }
        guard FileManager.default.fileExists(atPath: AppFiles.upload(id).path), item.sha256 != nil else {
            store.update(id) {
                $0.state = .preparing
                $0.catalog = nil
            }
            return await prepare(id)
        }
        let catalog = CatalogAPI(api: api)
        do {
            if let relay = item.catalog?.relay {
                if let offset = try await catalog.tusOffset(relay) {
                    return offset >= item.size ? startRelayComplete(id) : startRelayPatch(id, from: offset)
                }
                // the edge's upload is gone: maybe because the library fetched it already
                if let status = try await catalog.statuses([relay.ingestId])[relay.ingestId] {
                    switch status.state {
                    case .complete, .duplicate: return acceptServerCopy(id, sha: status.sha256, duplicate: status.state == .duplicate)
                    case .receiving:
                        return store.update(id) {
                            $0.state = .confirming
                            if $0.catalog?.sentAt == nil { $0.catalog?.sentAt = Date() }
                        }
                    case .failed, .missing: return sendDirectly(id, "The library couldn't fetch it from the fast route: sending it directly")
                    case .unknown: break
                    }
                }
            } else if let ingest = item.catalog?.ingestId {
                if let (offset, state) = try await catalog.directOffset(ingest) {
                    return state == .complete || offset >= item.size ? startCatalogComplete(id) : startCatalogPatch(id, from: offset)
                }
            }
            try await catalogBegin(id, catalog)
        } catch {
            catalogHandle(error, id)
        }
    }

    // MARK: Background steps

    private func startRelayPatch(_ id: UUID, from offset: Int64) {
        guard let item = store.item(id), let relay = item.catalog?.relay else { return catalogStartOver(id) }
        let step = TransferStep(itemId: id, kind: .relayPatch, offset: offset)
        // the whole rest in one request: iOS sends it without waking the app in between
        var body = AppFiles.upload(id)
        if offset > 0 {
            body = AppFiles.slice(step)
            do {
                try AppFiles.copy(AppFiles.upload(id), from: offset, length: item.size - offset, to: body)
            } catch {
                return catalogRetryLater(id, "Couldn't read the copy on the phone")
            }
        }
        var request = URLRequest(url: relay.uploadURL)
        request.httpMethod = "PATCH"
        for (key, value) in CatalogAPI.tusHeaders(relay) { request.setValue(value, forHTTPHeaderField: key) }
        request.setValue("application/offset+octet-stream", forHTTPHeaderField: "Content-Type")
        request.setValue(String(offset), forHTTPHeaderField: "Upload-Offset")
        request.allowsCellularAccess = !UserDefaults.standard.bool(forKey: "wifiOnly")
        store.update(id) {
            $0.state = .sending
            $0.sent = offset
        }
        transfers.start(request, file: body, step: step)
    }

    private func startRelayComplete(_ id: UUID) {
        guard let item = store.item(id), let api = api(for: item), let relay = item.catalog?.relay else { return catalogStartOver(id) }
        let step = TransferStep(itemId: id, kind: .relayComplete)
        let body = AppFiles.slice(step)
        FileManager.default.createFile(atPath: body.path,
                                       contents: try? JSONSerialization.data(withJSONObject: ["video_id": relay.videoId]))
        var request = CatalogAPI(api: api).request("api/uploads/relay/\(relay.ingestId)/complete", method: "POST")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        store.update(id) {
            $0.state = .finishing
            $0.sent = $0.size
        }
        transfers.start(request, file: body, step: step)
    }

    private func startCatalogPatch(_ id: UUID, from offset: Int64) {
        guard let item = store.item(id), let api = api(for: item), let ingest = item.catalog?.ingestId else { return catalogStartOver(id) }
        let step = TransferStep(itemId: id, kind: .catalogPatch, offset: offset)
        let body = AppFiles.slice(step)
        let length = min(item.size - offset, min(item.catalog?.chunkSize ?? CatalogRules.maxPiece, CatalogRules.maxPiece))
        do {
            try AppFiles.copy(AppFiles.upload(id), from: offset, length: length, to: body)
        } catch {
            return catalogRetryLater(id, "Couldn't read the copy on the phone")
        }
        var request = CatalogAPI(api: api).request("api/uploads/\(ingest)", method: "PATCH")
        request.setValue("application/offset+octet-stream", forHTTPHeaderField: "Content-Type")
        request.setValue(String(offset), forHTTPHeaderField: "Upload-Offset")
        request.allowsCellularAccess = !UserDefaults.standard.bool(forKey: "wifiOnly")
        store.update(id) {
            $0.state = .sending
            $0.sent = offset
        }
        transfers.start(request, file: body, step: step)
    }

    private func startCatalogComplete(_ id: UUID) {
        guard let item = store.item(id), let api = api(for: item), let ingest = item.catalog?.ingestId else { return catalogStartOver(id) }
        let step = TransferStep(itemId: id, kind: .catalogComplete)
        let body = AppFiles.slice(step)
        FileManager.default.createFile(atPath: body.path, contents: Data())
        store.update(id) {
            $0.state = .finishing
            $0.sent = $0.size
            $0.note = "Finishing…"
        }
        transfers.start(CatalogAPI(api: api).request("api/uploads/\(ingest)/complete", method: "POST"), file: body, step: step)
    }

    // MARK: Answers

    func catalogFinished(_ step: TransferStep, response: HTTPURLResponse?, body: Data, error: Error?) {
        try? FileManager.default.removeItem(at: AppFiles.slice(step))
        store.liveBytes[step.itemId] = nil
        guard let item = store.item(step.itemId), item.isWorking else { return }
        if let error = error as NSError?, error.code == NSURLErrorCancelled { return }
        let action = CatalogRules.after(step.kind, status: response?.statusCode ?? 0,
                                        uploadOffset: response?.value(forHTTPHeaderField: "Upload-Offset").flatMap { Int64($0) },
                                        size: item.size, body: body, networkError: error != nil || response == nil)
        let id = step.itemId
        let relay = step.kind == .relayPatch || step.kind == .relayComplete
        switch action {
        case .send(let from):
            store.update(id) {
                $0.sent = from
                $0.attempts = 0
                $0.note = nil
            }
            relay ? startRelayPatch(id, from: from) : startCatalogPatch(id, from: from)
        case .complete:
            relay ? startRelayComplete(id) : startCatalogComplete(id)
        case .confirm:
            store.update(id) {
                $0.state = .confirming
                $0.catalog?.sentAt = Date()
                $0.attempts = 0
                $0.note = nil
            }
            kick()
        case .finished(let sha, let duplicate):
            acceptServerCopy(id, sha: sha, duplicate: duplicate)
        case .resync:
            store.update(id) { $0.nextAttemptAt = nil }
            kick()
        case .newSession(let why):
            catalogRestart(id, why)
        case .sendDirectly(let why):
            sendDirectly(id, why)
        case .retryLater(let why):
            catalogRetryLater(id, why)
        case .signedOut:
            perform(.signedOut, id)
        case .failed(let why):
            fail(id, why)
        }
    }

    /// The library says it has the file: taken only when its sha256 is the phone's.
    private func acceptServerCopy(_ id: UUID, sha: String?, duplicate: Bool) {
        if let sha, let mine = store.item(id)?.sha256, sha.lowercased() != mine.lowercased() {
            return catalogRestart(id, "The library's copy didn't match: sending it again")
        }
        landed(id, duplicate: duplicate)
    }

    private func catalogStartOver(_ id: UUID) {
        store.update(id) {
            $0.state = .preparing
            $0.catalog = nil
            $0.sent = 0
        }
        kick()
    }

    private func catalogRestart(_ id: UUID, _ why: String) {
        guard store.item(id) != nil else { return }
        let send = store.item(id)?.catalog ?? CatalogSend()
        if send.restarts >= CatalogRules.maxRestarts {
            guard send.relay != nil else { return fail(id, "The server kept losing this upload (\(why))") }
            return sendDirectly(id, why)
        }
        store.update(id) {
            $0.catalog = send
            $0.catalog?.restarts += 1
            $0.catalog?.relay = nil
            $0.catalog?.ingestId = nil
            $0.sent = 0
            $0.note = why
            $0.state = .sending
        }
        kick()
    }

    /// Off the fast route for good. Counts against the same cap, so a clip the library keeps refusing ends as failed.
    private func sendDirectly(_ id: UUID, _ why: String) {
        guard let send = store.item(id)?.catalog else { return catalogStartOver(id) }
        if send.direct && send.relay == nil && send.restarts >= CatalogRules.maxRestarts {
            return fail(id, "The server kept losing this upload (\(why))")
        }
        store.update(id) {
            $0.state = .sending
            $0.catalog?.direct = true
            $0.catalog?.restarts = send.direct ? send.restarts + 1 : 0
            $0.catalog?.relay = nil
            $0.catalog?.ingestId = nil
            $0.sent = 0
            $0.note = why
        }
        kick()
    }

    /// The clips the fast route has delivered: has the library fetched them yet? Per server.
    func catalogConfirm() async {
        let waiting = store.items.filter { $0.state == .confirming }
        for items in Dictionary(grouping: waiting, by: \.server).values {
            guard let api = items.first.flatMap(api(for:)) else { continue }
            do {
                let statuses = try await CatalogAPI(api: api).statuses(items.compactMap { $0.catalog?.ingestId })
                for item in items {
                    guard let ingest = item.catalog?.ingestId, let status = statuses[ingest] else { continue }
                    switch status.state {
                    case .complete, .duplicate:
                        acceptServerCopy(item.id, sha: status.sha256, duplicate: status.state == .duplicate)
                    case .failed, .missing:
                        sendDirectly(item.id, "The library couldn't fetch it from the fast route: sending it directly")
                    case .receiving, .unknown:
                        if let sentAt = item.catalog?.sentAt, Date().timeIntervalSince(sentAt) > CatalogRules.confirmGiveUp {
                            sendDirectly(item.id, "The library is slow to fetch it: sending it directly")
                        }
                    }
                }
            } catch APIError.signedOut {
                for item in items { perform(.signedOut, item.id) }
            } catch {
                // offline: the next look tries again
            }
        }
    }

    /// Waits and tries again; after `CatalogRules.maxAttempts` tries in a row the clip needs a look (Try again counts
    /// from zero).
    private func catalogRetryLater(_ id: UUID, _ why: String) {
        guard let item = store.item(id) else { return }
        if CatalogRules.exhausted(afterAttempt: item.attempts) {
            return fail(id, "Gave up after \(CatalogRules.maxAttempts) tries: \(why)")
        }
        store.update(id) {
            $0.attempts += 1
            $0.nextAttemptAt = Date().addingTimeInterval(CatalogRules.backoff(attempt: $0.attempts))
            $0.note = why
        }
    }

    private func catalogHandle(_ error: Error, _ id: UUID) {
        guard let error = error as? APIError else {
            return catalogRetryLater(id, "Photos couldn't hand it over yet (\(error.localizedDescription))")
        }
        if error == .signedOut { return perform(.signedOut, id) }
        error.transient ? catalogRetryLater(id, error.message) : fail(id, error.message)
    }
}
