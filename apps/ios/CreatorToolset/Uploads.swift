import Foundation

/// One file on its way to the server's Media Library. The file is copied into the app (`AppFiles.uploads`), so an
/// upload carries on after the app is closed: a pick from Files at once, a clip of the camera roll when Upload is pressed.
struct UploadItem: Codable, Identifiable, Hashable {
    /// picked: waits for Upload. preparing: copied out of Photos and fingerprinted. confirming: the library is fetching
    /// it from where it was sent (a studio's fast route).
    enum State: String, Codable { case picked, preparing, sending, finishing, confirming, done, failed }
    /// Where it goes: the server's own Media Library, or a plug-in's library behind it (`Studio/CatalogUpload.swift`).
    enum Route: String, Codable { case library, catalog }

    let id: UUID
    var filename: String
    var size: Int64
    /// The server it goes to (`Server.id`), fixed when it is picked.
    let server: String
    var state: State = .picked
    var sent: Int64 = 0
    /// The server's upload (POST /api/library/:id/uploads).
    var uploadId: String?
    var chunkSize: Int64?
    /// A library on a storage bucket: the parts go straight to the bucket's signed URLs, and their ETags to `finish`.
    var direct: Direct?
    var duplicate = false
    var note: String?
    var attempts = 0
    var nextAttemptAt: Date?
    /// The phone's New edit it is a clip of (`PhoneEdit.id`): it waits for that Start, not for Upload.
    var edit: UUID?
    // Added later: optional, so a queue saved by an older build still reads.
    /// The camera-roll clip it is (`PHAsset.localIdentifier`); nil for a file picked in Files or for New edit.
    var assetId: String?
    var isVideo: Bool?
    var capturedAt: Date?
    /// Decided once, before the first byte; nil (an older upload) is the server's own library.
    var route: Route?
    /// The phone's fingerprint of the file (the plug-in's library checks it).
    var sha256: String?
    var catalog: CatalogSend?
    var finishedAt: Date?

    struct Direct: Codable, Hashable {
        let partSize: Int64
        let urls: [URL]
        var etags: [Int: String] = [:]
        var nextPart: Int? { (1...urls.count).first { etags[$0] == nil } }
    }

    var isWorking: Bool { state == .preparing || state == .sending || state == .finishing || state == .confirming }
    var isFinished: Bool { state == .done }

    /// A clip of the camera roll, waiting for Upload.
    init(asset: String, filename: String, isVideo: Bool, capturedAt: Date?, server: String, id: UUID = UUID()) {
        self.init(id: id, filename: filename, size: 0, server: server)
        assetId = asset
        self.isVideo = isVideo
        self.capturedAt = capturedAt
    }

    init(id: UUID, filename: String, size: Int64, server: String) {
        self.id = id
        self.filename = filename
        self.size = size
        self.server = server
    }
}

/// The uploads, saved as JSON next to their files.
@MainActor
final class UploadStore: ObservableObject {
    @Published private(set) var items: [UploadItem] = [] {
        didSet { byAsset = Self.byAsset(items) }
    }
    /// Bytes of the chunk in flight, for the progress bar only (not saved).
    @Published var liveBytes: [UUID: Int64] = [:]
    /// The newest upload of each camera-roll clip, per server (`key(asset:server:)`).
    private(set) var byAsset: [String: UploadItem] = [:]

    private let file = AppFiles.root.appendingPathComponent("uploads.json")

    init() {
        if let data = try? Data(contentsOf: file), let saved = try? JSONDecoder().decode([UploadItem].self, from: data) {
            items = saved
        }
    }

    func item(_ id: UUID) -> UploadItem? { items.first { $0.id == id } }

    nonisolated static func key(asset: String, server: String) -> String { server + "|" + asset }

    nonisolated static func byAsset(_ items: [UploadItem]) -> [String: UploadItem] {
        var out: [String: UploadItem] = [:]
        for item in items { if let asset = item.assetId { out[key(asset: asset, server: item.server)] = item } }
        return out
    }

    /// Sent so far: the running transfer's bytes when there is one.
    func sentBytes(_ item: UploadItem) -> Int64 { max(item.sent, liveBytes[item.id] ?? 0) }

    func add(_ item: UploadItem) { add([item]) }

    func add(_ fresh: [UploadItem]) {
        guard !fresh.isEmpty else { return }
        items.append(contentsOf: fresh)
        save()
    }

    func update(_ id: UUID, _ change: (inout UploadItem) -> Void) {
        guard let i = items.firstIndex(where: { $0.id == id }) else { return }
        change(&items[i])
        save()
    }

    func remove(_ id: UUID) {
        items.removeAll { $0.id == id }
        liveBytes[id] = nil
        try? FileManager.default.removeItem(at: AppFiles.upload(id))
        save()
    }

    private func save() {
        try? JSONEncoder().encode(items).write(to: file, options: .atomic)
    }
}

enum AppFiles {
    static let root: URL = {
        let url = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }()

    static let uploads: URL = dir("uploads")
    static let slices: URL = dir("slices")

    static func upload(_ id: UUID) -> URL { uploads.appendingPathComponent(id.uuidString) }
    static func slice(_ step: TransferStep) -> URL { slices.appendingPathComponent("\(step.itemId.uuidString)-\(step.kind.rawValue)-\(step.part)") }

    static func removeSlices(of id: UUID) {
        let names = (try? FileManager.default.contentsOfDirectory(atPath: slices.path)) ?? []
        for name in names where name.hasPrefix(id.uuidString) { try? FileManager.default.removeItem(at: slices.appendingPathComponent(name)) }
    }

    private static func dir(_ name: String) -> URL {
        let url = root.appendingPathComponent(name, isDirectory: true)
        try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true,
                                                 attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication])
        return url
    }

    /// Bytes [offset, offset+length) of `source` into `destination`, 8 MB at a time.
    static func copy(_ source: URL, from offset: Int64, length: Int64, to destination: URL) throws {
        try? FileManager.default.removeItem(at: destination)
        FileManager.default.createFile(atPath: destination.path, contents: nil,
                                       attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication])
        let input = try FileHandle(forReadingFrom: source)
        let output = try FileHandle(forWritingTo: destination)
        defer {
            try? input.close()
            try? output.close()
        }
        try input.seek(toOffset: UInt64(offset))
        var remaining = length
        while remaining > 0 {
            guard let data = try input.read(upToCount: Int(min(remaining, 8 << 20))), !data.isEmpty else { break }
            try output.write(contentsOf: data)
            remaining -= Int64(data.count)
        }
    }
}

/// One request of an upload, run by the background session. Encoded in the task's description, so a finished
/// transfer still finds its upload after iOS relaunched the app.
struct TransferStep: Equatable {
    /// patch, part, finish: the server's own library. The catalog's: bytes to the fast route (`relay`), its complete,
    /// a piece straight to the library, its complete (`Studio/CatalogUpload.swift`).
    enum Kind: String { case patch, part, finish, relayPatch, relayComplete, catalogPatch, catalogComplete }

    let itemId: UUID
    let kind: Kind
    /// patch: the offset it starts at. part: unused.
    var offset: Int64 = 0
    /// part: its number, from 1.
    var part: Int = 0

    var encoded: String { "\(itemId.uuidString)|\(kind.rawValue)|\(offset)|\(part)" }
    var catalog: Bool { [.relayPatch, .relayComplete, .catalogPatch, .catalogComplete].contains(kind) }

    init(itemId: UUID, kind: Kind, offset: Int64 = 0, part: Int = 0) {
        self.itemId = itemId
        self.kind = kind
        self.offset = offset
        self.part = part
    }

    init?(encoded: String?) {
        let f = (encoded ?? "").split(separator: "|").map(String.init)
        guard f.count == 4, let id = UUID(uuidString: f[0]), let kind = Kind(rawValue: f[1]),
              let offset = Int64(f[2]), let part = Int(f[3]) else { return nil }
        self.init(itemId: id, kind: kind, offset: offset, part: part)
    }
}

/// What comes after a request's answer. Pure, so the tests check every answer the server gives
/// (`apps/captions/api/library/routes.ts`: uploads, PATCH, finish).
enum NextAction: Equatable {
    case send(from: Int64)
    case partDone(Int, etag: String)
    case finish
    case done(duplicate: Bool)
    /// The server no longer has the upload: start a new one from byte 0.
    case startOver(String)
    case retryLater(String)
    case signedOut
    case failed(String)
}

enum Rules {
    static func after(_ step: TransferStep, status: Int, uploadOffset: Int64?, etag: String?, size: Int64,
                      body: Data, networkError: Bool) -> NextAction {
        if networkError { return .retryLater("Waiting for a connection") }
        if status == 401 { return .signedOut }
        let json = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any]
        let bodyOffset = (json?["offset"] as? NSNumber)?.int64Value
        let message = json?["error"] as? String ?? "The server answered \(status)"
        switch step.kind {
        case .patch:
            if status == 204 || status == 200, let at = uploadOffset {
                return at >= size ? .finish : .send(from: at)
            }
            if status == 409, let at = bodyOffset { return .send(from: at) }
            if status == 404 { return .startOver("The server dropped the upload: sending it again") }
        case .part:
            if (200..<300).contains(status), let etag, !etag.isEmpty { return .partDone(step.part, etag: etag) }
            // a signed part URL expired
            if status == 403 { return .startOver("The upload link expired: sending it again") }
        case .finish:
            if status == 200 {
                if json?["duplicateOf"] != nil { return .done(duplicate: true) }
                if json?["assetId"] != nil { return .done(duplicate: false) }
            }
            if status == 409, let at = bodyOffset { return at >= size ? .finish : .send(from: at) }
            // "Already finished": the answer to an earlier finish was lost. Sent again, the server answers that it
            // has the file (duplicateOf), so the upload ends either way.
            if status == 409 { return .startOver("Checking that the server has it") }
            // gone, or the bucket refused the parts: the server marked it failed
            if status == 404 || status == 400 || status == 500 { return .startOver(message) }
        case .relayPatch, .relayComplete, .catalogPatch, .catalogComplete:
            break
        }
        if status == 413 || status == 507 { return .failed(message) }
        if status >= 500 || status == 409 || status == 429 { return .retryLater(message) }
        return .failed(message)
    }

    /// Seconds before try number `attempts` (1, 2, …): 10 s doubling, at most 10 minutes.
    static func backoff(_ attempts: Int) -> TimeInterval {
        min(600, 10 * pow(2, Double(max(0, attempts - 1))))
    }
}
