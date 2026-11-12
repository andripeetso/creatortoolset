import CryptoKit
import ImageIO
import Photos
import SwiftUI

/// The camera roll: videos or photos from 2023 on, newest first, kept current as Photos changes.
@MainActor
final class PhotoLibrary: NSObject, ObservableObject, PHPhotoLibraryChangeObserver {
    static let shared = PhotoLibrary()

    enum Kind: String, CaseIterable, Identifiable {
        case videos = "Videos"
        case photos = "Photos"
        var id: String { rawValue }
    }

    struct Album: Identifiable, Hashable {
        let id: String
        let title: String
    }

    /// A camera verdict and when it was reached. camera == nil: the file is only in iCloud, so it is tried again a
    /// day later, not on every visit.
    struct CameraMark: Codable {
        var camera: Bool?
        var checkedAt: Date

        nonisolated static let retryUnknownAfter: TimeInterval = 24 * 3600

        func needsCheck(now: Date = Date()) -> Bool {
            camera == nil && checkedAt < now.addingTimeInterval(-Self.retryUnknownAfter)
        }
    }

    @Published private(set) var access = PHPhotoLibrary.authorizationStatus(for: .readWrite)
    @Published var kind: Kind = .videos {
        didSet { reload() }
    }
    @Published private(set) var assets: [PHAsset] = []
    @Published private(set) var albums: [Album] = []
    /// Whether each photo came from a camera, for "Only camera photos". Kept across launches: some answers mean
    /// opening the file to read its metadata.
    @Published private(set) var cameraMarks: [String: CameraMark] = [:]
    @Published private(set) var cameraCheck: (done: Int, total: Int)?
    let images = PHCachingImageManager()
    private var observing = false
    private var cameraTask: Task<Void, Never>?
    /// Photos waiting for the camera check; switching Videos and Photos adds to it instead of starting over.
    private var cameraQueue: [PHAsset] = []
    private var cameraQueued: Set<String> = []
    private var cameraDone = 0
    private let cameraURL = AppFiles.root.appendingPathComponent("camera-photos.json")

    override init() {
        super.init()
        if let data = try? Data(contentsOf: cameraURL), let saved = try? JSONDecoder().decode([String: CameraMark].self, from: data) {
            cameraMarks = saved
        }
        reload()
    }

    /// Screenshots and screen recordings are tagged by iOS; other photos wait for the check below. Unknown counts as
    /// camera, so a photo is never hidden just because it is in iCloud.
    func isFromCamera(_ asset: PHAsset) -> Bool {
        if asset.mediaType == .video { return !asset.mediaSubtypes.contains(.videoScreenRecording) }
        if asset.mediaSubtypes.contains(.photoScreenshot) { return false }
        return cameraMarks[asset.localIdentifier]?.camera ?? true
    }

    var canRead: Bool { access == .authorized || access == .limited }

    func requestAccess() async {
        access = await PHPhotoLibrary.requestAuthorization(for: .readWrite)
        reload()
    }

    func refreshAccess() {
        let current = PHPhotoLibrary.authorizationStatus(for: .readWrite)
        if current != access {
            access = current
            reload()
        }
    }

    /// Footage from 2023 on only: older photos are never listed, checked or opened (a family phone can hold tens of
    /// thousands going back years).
    nonisolated static let earliest: Date = Calendar(identifier: .gregorian)
        .date(from: DateComponents(timeZone: .current, year: 2023, month: 1, day: 1))!

    nonisolated static func fetchOptions() -> PHFetchOptions {
        let options = PHFetchOptions()
        options.predicate = NSPredicate(format: "creationDate >= %@", earliest as NSDate)
        options.sortDescriptors = [NSSortDescriptor(key: "creationDate", ascending: false)]
        return options
    }

    func reload() {
        guard canRead else {
            assets = []
            return
        }
        if !observing {
            PHPhotoLibrary.shared().register(self)
            observing = true
        }
        loadAlbums()
        let result = PHAsset.fetchAssets(with: kind == .videos ? .video : .image, options: Self.fetchOptions())
        var list: [PHAsset] = []
        list.reserveCapacity(result.count)
        result.enumerateObjects { asset, _, _ in list.append(asset) }
        assets = list
        if kind == .photos { checkCameraOrigins() }
    }

    /// The person's own albums, in the order Photos shows them.
    private func loadAlbums() {
        var found: [Album] = []
        PHAssetCollection.fetchAssetCollections(with: .album, subtype: .albumRegular, options: nil)
            .enumerateObjects { collection, _, _ in
                found.append(Album(id: collection.localIdentifier, title: collection.localizedTitle ?? "Album"))
            }
        if found != albums { albums = found }
    }

    private func checkCameraOrigins() {
        let now = Date()
        let pending = assets.filter { asset in
            let id = asset.localIdentifier
            guard !cameraQueued.contains(id), !asset.mediaSubtypes.contains(.photoScreenshot) else { return false }
            return cameraMarks[id]?.needsCheck(now: now) ?? true
        }
        guard !pending.isEmpty else { return }
        cameraQueue.append(contentsOf: pending)
        cameraQueued.formUnion(pending.map(\.localIdentifier))
        cameraCheck = (cameraDone, cameraDone + cameraQueue.count)
        if cameraTask == nil { cameraTask = Task { await drainCameraQueue() } }
    }

    private func drainCameraQueue() async {
        defer {
            cameraTask = nil
            cameraCheck = nil
            cameraQueue = []
            cameraQueued = []
            cameraDone = 0
            saveCameraMarks()
        }
        var batches = 0
        while !cameraQueue.isEmpty {
            let batch = Array(cameraQueue.prefix(100))
            cameraQueue.removeFirst(batch.count)
            let found: [(id: String, camera: Bool?)] = await Task.detached(priority: .utility) {
                batch.map { ($0.localIdentifier, CameraOrigin.quick($0) ?? CameraOrigin.fromMetadata($0)) }
            }.value
            let now = Date()
            for entry in found { cameraMarks[entry.id] = CameraMark(camera: entry.camera, checkedAt: now) }
            cameraDone += batch.count
            cameraCheck = (cameraDone, cameraDone + cameraQueue.count)
            batches += 1
            if batches % 10 == 0 { saveCameraMarks() }  // survives the app being closed mid-check
        }
    }

    private func saveCameraMarks() {
        guard let data = try? JSONEncoder().encode(cameraMarks) else { return }
        try? data.write(to: cameraURL, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }

    nonisolated func photoLibraryDidChange(_ changeInstance: PHChange) {
        Task { @MainActor in self.reload() }
    }
}

/// Did a photo come from a camera, or is it a screenshot or an image saved from another app? The camera roll holds
/// all of them.
enum CameraOrigin {
    /// What the iPhone camera saves; other apps save JPEG or PNG.
    static let cameraFileTypes: Set<String> = ["public.heic", "public.heif", "com.adobe.raw-image", "public.camera-raw-image"]

    /// Decided from what Photos already knows, without opening the file. nil: only the file's metadata can tell.
    static func quick(subtypes: PHAssetMediaSubtype, isBurst: Bool, fileType: String?) -> Bool? {
        if subtypes.contains(.photoScreenshot) { return false }
        let cameraOnly: PHAssetMediaSubtype = [.photoLive, .photoHDR, .photoDepthEffect, .photoPanorama]
        if !subtypes.isDisjoint(with: cameraOnly) || isBurst { return true }
        if let fileType, cameraFileTypes.contains(fileType.lowercased()) { return true }
        return nil
    }

    static func quick(_ asset: PHAsset) -> Bool? {
        quick(subtypes: asset.mediaSubtypes, isBurst: asset.burstIdentifier != nil,
              fileType: Exporter.originalResource(for: asset)?.uniformTypeIdentifier)
    }

    /// A camera writes its maker into the file; a screenshot or a saved picture carries none.
    static func namesACamera(_ properties: [CFString: Any]) -> Bool {
        let tiff = properties[kCGImagePropertyTIFFDictionary] as? [CFString: Any]
        return !((tiff?[kCGImagePropertyTIFFMake] as? String) ?? "").trimmingCharacters(in: .whitespaces).isEmpty
    }

    /// Reads the original file's metadata; off the main thread. nil when the file is only in iCloud (it is never
    /// downloaded just to filter).
    static func fromMetadata(_ asset: PHAsset) -> Bool? {
        let options = PHImageRequestOptions()
        options.isSynchronous = true
        options.isNetworkAccessAllowed = false
        options.version = .original
        options.deliveryMode = .highQualityFormat
        var data: Data?
        PHImageManager.default().requestImageDataAndOrientation(for: asset, options: options) { bytes, _, _, _ in data = bytes }
        guard let data, let source = CGImageSourceCreateWithData(data as CFData, nil),
              let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any] else { return nil }
        return namesACamera(properties)
    }
}

enum ExportError: LocalizedError {
    case noResource, empty

    var errorDescription: String? {
        switch self {
        case .noResource: "Photos has no file for this clip"
        case .empty: "The clip is empty"
        }
    }
}

/// Copies a clip out of Photos into the app and fingerprints it.
enum Exporter {
    /// The version seen in Photos: the edit when there is one.
    static func uploadResource(for asset: PHAsset) -> PHAssetResource? {
        let resources = PHAssetResource.assetResources(for: asset)
        if asset.mediaType == .video {
            return resources.first { $0.type == .fullSizeVideo } ?? resources.first { $0.type == .video }
        }
        return resources.first { $0.type == .fullSizePhoto } ?? resources.first { $0.type == .photo }
    }

    static func originalResource(for asset: PHAsset) -> PHAssetResource? {
        let resources = PHAssetResource.assetResources(for: asset)
        let wanted: PHAssetResourceType = asset.mediaType == .video ? .video : .photo
        return resources.first { $0.type == wanted } ?? resources.first
    }

    /// The camera's file name, e.g. IMG_1234.MOV.
    static func name(for asset: PHAsset) -> String {
        originalResource(for: asset)?.originalFilename ?? (asset.mediaType == .video ? "video.mov" : "photo.jpg")
    }

    /// The original's name and size, for the library's name-and-size check.
    static func nameAndSize(for asset: PHAsset) -> (name: String, size: Int64)? {
        guard let resource = originalResource(for: asset),
              let size = (resource.value(forKey: "fileSize") as? NSNumber)?.int64Value, size > 0 else { return nil }
        return (resource.originalFilename, size)
    }

    /// Into `file` (an iCloud-only clip is downloaded): its size and its name, the camera's name with the edit's
    /// extension.
    static func export(_ asset: PHAsset, to file: URL) async throws -> (size: Int64, filename: String) {
        guard let resource = uploadResource(for: asset) else { throw ExportError.noResource }
        let original = name(for: asset)
        var ext = (resource.originalFilename as NSString).pathExtension
        if ext.isEmpty { ext = (original as NSString).pathExtension }
        let filename = ext.isEmpty ? original : "\((original as NSString).deletingPathExtension).\(ext)"
        try? FileManager.default.removeItem(at: file)
        let options = PHAssetResourceRequestOptions()
        options.isNetworkAccessAllowed = true
        try await withCheckedThrowingContinuation { (done: CheckedContinuation<Void, Error>) in
            PHAssetResourceManager.default().writeData(for: resource, toFile: file, options: options) { error in
                if let error { done.resume(throwing: error) } else { done.resume() }
            }
        }
        let size = ((try? FileManager.default.attributesOfItem(atPath: file.path)[.size]) as? NSNumber)?.int64Value ?? 0
        guard size > 0 else {
            try? FileManager.default.removeItem(at: file)
            throw ExportError.empty
        }
        return (size, filename)
    }

    static func sha256(of file: URL) async throws -> String {
        try await Task.detached(priority: .utility) {
            let handle = try FileHandle(forReadingFrom: file)
            defer { try? handle.close() }
            var hasher = SHA256()
            while let data = try handle.read(upToCount: 8 << 20), !data.isEmpty { hasher.update(data: data) }
            return hasher.finalize().map { String(format: "%02x", $0) }.joined()
        }.value
    }
}

/// Which camera-roll clips a server's library already has, by the original's name and size (the website's uploader
/// checks the same). Clips sent from this phone are marked the moment they land; the exact fingerprint is checked again
/// right before sending. Kept per server.
@MainActor
final class LibraryIndex: ObservableObject {
    static let shared = LibraryIndex()

    struct Mark: Codable {
        var name: String
        var size: Int64
        var inLibrary: Bool
        var checkedAt: Date
    }

    /// Server id → clip → mark.
    @Published private(set) var marks: [String: [String: Mark]] = [:]
    @Published private(set) var progress: (done: Int, total: Int)?
    private var running: Task<Void, Never>?
    private var queue: [PHAsset] = []
    private var queued: Set<String> = []
    private var done = 0
    private let url: URL

    init(url: URL = AppFiles.root.appendingPathComponent("library-index.json")) {
        self.url = url
        if let data = try? Data(contentsOf: url), let saved = try? JSONDecoder().decode([String: [String: Mark]].self, from: data) {
            marks = saved
        }
    }

    func isInLibrary(_ assetId: String, server: String?) -> Bool {
        server.flatMap { marks[$0]?[assetId]?.inLibrary } == true
    }

    func markInLibrary(_ assetIds: [String], server: String?) {
        guard let server, !assetIds.isEmpty else { return }
        for id in assetIds {
            var mark = marks[server]?[id] ?? Mark(name: "", size: 0, inLibrary: true, checkedAt: Date())
            mark.inLibrary = true
            marks[server, default: [:]][id] = mark
        }
        save()
    }

    /// "Not uploaded" is asked again once a day, for clips uploaded from somewhere else (the computer, the website).
    nonisolated static let recheckAfter: TimeInterval = 24 * 3600

    nonisolated static func needsCheck(_ mark: Mark?, now: Date = Date()) -> Bool {
        guard let mark else { return true }
        return !mark.inLibrary && mark.checkedAt < now.addingTimeInterval(-recheckAfter)
    }

    /// Queues the clips that need asking and keeps the one running check going: switching Videos and Photos adds to
    /// it, never starts it over. `check` answers which of the names (with their sizes) the library has.
    func refresh(_ assets: [PHAsset], server: String, check: @escaping ([(name: String, size: Int64)]) async throws -> Set<String>) {
        let now = Date()
        let known = marks[server] ?? [:]
        let pending = assets.filter { !queued.contains($0.localIdentifier) && Self.needsCheck(known[$0.localIdentifier], now: now) }
        guard !pending.isEmpty else { return }
        queue.append(contentsOf: pending)
        queued.formUnion(pending.map(\.localIdentifier))
        progress = (done, done + queue.count)
        if running == nil { running = Task { await drain(server: server, check: check) } }
    }

    private func drain(server: String, check: ([(name: String, size: Int64)]) async throws -> Set<String>) async {
        defer {
            running = nil
            progress = nil
            queue = []
            queued = []
            done = 0
            save()
        }
        var batches = 0
        while !queue.isEmpty {
            let batch = Array(queue.prefix(200))
            queue.removeFirst(batch.count)
            let named: [(id: String, name: String, size: Int64)] = await Task.detached(priority: .utility) {
                batch.compactMap { asset in Exporter.nameAndSize(for: asset).map { (asset.localIdentifier, $0.name, $0.size) } }
            }.value
            // the server answers per name, and iPhones reuse IMG_ numbers: each request carries every name once
            var remaining = named
            while !remaining.isEmpty {
                var seen = Set<String>()
                var round: [(id: String, name: String, size: Int64)] = []
                var later: [(id: String, name: String, size: Int64)] = []
                for entry in remaining {
                    if seen.insert(entry.name.lowercased()).inserted { round.append(entry) } else { later.append(entry) }
                }
                guard let found = try? await check(round.map { ($0.name, $0.size) }) else { return }  // offline: next time
                let now = Date()
                for entry in round {
                    let already = marks[server]?[entry.id]?.inLibrary == true
                    marks[server, default: [:]][entry.id] = Mark(name: entry.name, size: entry.size,
                                                                inLibrary: already || found.contains(entry.name), checkedAt: now)
                }
                remaining = later
            }
            done += batch.count
            progress = (done, done + queue.count)
            batches += 1
            if batches % 10 == 0 { save() }
        }
    }

    private func save() {
        guard let data = try? JSONEncoder().encode(marks) else { return }
        try? data.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }
}

/// A square thumbnail of a Photos clip.
struct AssetThumbnail: View {
    let assetId: String
    var side: CGFloat = 120
    @State private var image: UIImage?

    var body: some View {
        ZStack {
            Rectangle().fill(Color(.secondarySystemBackground))
            if let image { Image(uiImage: image).resizable().scaledToFill() }
        }
        .clipped()
        .task(id: assetId) { await load() }
    }

    private func load() async {
        guard let asset = PHAsset.fetchAssets(withLocalIdentifiers: [assetId], options: nil).firstObject else { return }
        let scale = UIScreen.main.scale
        let size = CGSize(width: side * scale, height: side * scale)
        let options = PHImageRequestOptions()
        options.deliveryMode = .opportunistic
        options.isNetworkAccessAllowed = true
        options.resizeMode = .fast
        let images = PhotoLibrary.shared.images
        let stream = AsyncStream<UIImage> { continuation in
            let request = images.requestImage(for: asset, targetSize: size, contentMode: .aspectFill, options: options) { picture, info in
                if let picture { continuation.yield(picture) }
                if !((info?[PHImageResultIsDegradedKey] as? Bool) ?? false) { continuation.finish() }
            }
            continuation.onTermination = { _ in images.cancelImageRequest(request) }
        }
        for await picture in stream { image = picture }
    }
}
