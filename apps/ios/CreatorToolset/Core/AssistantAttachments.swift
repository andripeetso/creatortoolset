import CoreTransferable
import ImageIO
import PhotosUI
import SwiftUI
import UIKit
import UniformTypeIdentifiers

/// A picture as the assistant takes it. The server reads PNG, JPEG, WebP and GIF up to 8 MB and
/// never HEIC, which is what an iPhone's camera makes: every picked picture becomes a JPEG.
enum AssistantPicture {
    static let maxSide = 2000
    static let maxBytes = 8 * 1024 * 1024

    /// A JPEG at most 2000 px on its long side and under 8 MB, turned the way it was taken;
    /// nil when the data is no picture. The picture is shrunk as it is read, so a 48 MP photo
    /// never sits whole in memory.
    static func jpeg(from data: Data, maxSide: Int = maxSide) -> Data? {
        guard let small = shrunk(data, to: maxSide) else { return nil }
        let image = UIImage(cgImage: small)
        for quality in [0.85, 0.6, 0.35] {
            if let jpeg = image.jpegData(compressionQuality: quality), jpeg.count < maxBytes { return jpeg }
        }
        return nil
    }

    private static func shrunk(_ data: Data, to maxSide: Int) -> CGImage? {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil) else { return nil }
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: maxSide,
        ]
        return CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary)
    }

    private static let smalls = NSCache<NSString, UIImage>()

    /// A picture small enough for its chip in the message box, made once.
    static func small(_ picture: QueuedMessage.Picture) -> UIImage? {
        if let hit = smalls.object(forKey: picture.id as NSString) { return hit }
        guard let image = shrunk(picture.jpeg, to: 224).map(UIImage.init(cgImage:)) else { return nil }
        smalls.setObject(image, forKey: picture.id as NSString)
        return image
    }
}

/// A video sent with a message goes up in parts (the server's `api/lib/uploads.ts`), while the message
/// waits on the phone: `POST /api/assistant/files` says the part size, each part is posted by its number,
/// `complete` joins them. An upload begun before carries on from the parts the server has. The parts go
/// through a session iOS runs (`AssistantTransfers`): one at a time while the app is in front, and all
/// that is left at once when it leaves, so they arrive with the phone locked or the app closed.
enum AssistantUpload {
    static func partCount(total: Int, partSize: Int) -> Int {
        guard total > 0, partSize > 0 else { return 0 }
        return (total + partSize - 1) / partSize
    }

    /// How many bytes part `n` (from 1) holds: every part is full but the last.
    static func partLength(_ n: Int, total: Int, partSize: Int) -> Int {
        max(0, min(partSize, total - (n - 1) * partSize))
    }

    /// The phone's copy of the video is gone or empty: trying again fails the same way.
    struct Unreadable: LocalizedError {
        var name: String
        var errorDescription: String? { "\(name) can no longer be read: take it back and add it again" }
    }

    /// The connection dropped or the server is restarting: the upload carries on by itself later, from
    /// the parts the server has. Anything else (the copy is gone, a refusal, a server that never answers
    /// a part) would fail again: the message is marked Not sent.
    static func waits(_ error: Error) -> Bool {
        guard let failure = error as? ToolsetAPI.Failure else { return false }
        return failure.status == 0 || failure.status >= 500
    }

    private struct Started: Decodable {
        let id: String
        let partSize: Int
    }

    private struct Parts: Decodable {
        let partSize: Int
        let parts: [Int]
    }

    private static func signedIn() throws -> ToolsetAPI {
        guard let api = ToolsetAPI.current else { throw ToolsetAPI.Failure(status: 0, message: "Not signed in") }
        return api
    }

    /// A waiting message's video gets its id on the signed-in server: the message can name it from then on.
    static func begin(_ video: QueuedMessage.Video) async throws -> String {
        try await begin(video.url, name: video.name, api: signedIn()).id
    }

    /// A waiting message's video, to the signed-in server.
    static func send(_ video: QueuedMessage.Video, begun: @escaping @MainActor (String) -> Void,
                     progress: @escaping @Sendable (Double) -> Void) async throws -> String {
        try await send(video.url, name: video.name, resuming: video.file, api: signedIn(), begun: begun, progress: progress)
    }

    private static func size(_ file: URL) throws -> Int {
        guard let size = (try? FileManager.default.attributesOfItem(atPath: file.path))?[.size] as? NSNumber,
              size.intValue > 0 else { throw Unreadable(name: file.lastPathComponent) }
        return size.intValue
    }

    private static func begin(_ file: URL, name: String, api: ToolsetAPI) async throws -> Started {
        let mime = UTType(filenameExtension: file.pathExtension)?.preferredMIMEType ?? "video/mp4"
        let started = try JSONDecoder().decode(Started.self, from: try await api.send(
            "/api/assistant/files", json: ["name": name, "mime": mime, "size": try size(file)]))
        await AssistantTransfers.shared.note(started.id, partSize: started.partSize, parts: [])
        return started
    }

    /// Uploads the file and answers its id. With `resuming` (the id of an upload begun before) only the
    /// parts the server lacks go. `begun` hears the id as soon as the server gives it; `progress` 0…1 as the bytes go.
    static func send(_ file: URL, name: String, resuming known: String?, api: ToolsetAPI,
                     begun: @escaping @MainActor (String) -> Void,
                     progress: @escaping @Sendable (Double) -> Void) async throws -> String {
        let total = try size(file)
        guard let handle = try? FileHandle(forReadingFrom: file) else { throw Unreadable(name: file.lastPathComponent) }
        defer { try? handle.close() }
        var have: Set<Int> = []
        let started: Started
        if let known, let parts = try await parts(of: known, api: api) {
            started = Started(id: known, partSize: parts.partSize)
            have = Set(parts.parts)
            await AssistantTransfers.shared.note(known, partSize: parts.partSize, parts: parts.parts)
        } else if let known, (try? await api.data(api.request("/api/assistant/files/\(known)/complete", method: "POST"),
                                                      session: ToolsetAPI.slow)) != nil {
            // it was up whole: only the answer was lost on the way
            progress(1)
            return known
        } else {
            // ponytail: an upload the server no longer holds starts again under a new id; a message the server
            // already took waits for the old one until the server gives up on it (12 hours)
            started = try await begin(file, name: name, api: api)
            await begun(started.id)
        }
        let base = "/api/assistant/files/\(started.id)"
        // ponytail: one part at a time in front; three at once, as Caption Studio sends, if phone videos upload too slowly
        // iOS sends the parts it was handed in any order: how far it is counts every part the server has
        var done = have.reduce(0) { $0 + partLength($1, total: total, partSize: started.partSize) }
        for n in 1...max(1, partCount(total: total, partSize: started.partSize)) where !have.contains(n) {
            try Task.checkCancellation()
            // a debug build can go slowly, to watch a message wait for its video: -AssistantSlowParts <seconds>
            if let pause = debugArg("AssistantSlowParts").flatMap(Double.init) { try await Task.sleep(for: .seconds(pause)) }
            let before = done
            progress(Double(before) / Double(total))
            do {
                try await sendPart(.init(upload: started.id, number: n), of: handle, total: total, partSize: started.partSize, api: api) { sent in
                    progress(Double(before + Int(sent)) / Double(total))
                }
                done += partLength(n, total: total, partSize: started.partSize)
            } catch let failure as ToolsetAPI.Failure where failure.status == 409 {
                break   // the server holds no such upload any more: joined already (complete says so), or gone
            }
        }
        _ = try await api.data(api.request("\(base)/complete", method: "POST"), session: ToolsetAPI.slow)
        progress(1)
        return started.id
    }

    /// The parts the server has of an upload begun before; nil when it holds no such upload (finished, or gone).
    private static func parts(of id: String, api: ToolsetAPI) async throws -> Parts? {
        do {
            return try JSONDecoder().decode(Parts.self, from: try await api.data(api.request("/api/assistant/files/\(id)/parts")))
        } catch let failure as ToolsetAPI.Failure where failure.status == 404 {
            return nil
        }
    }

    /// The app leaves the front: every part these videos still lack is handed to iOS now, in order, so
    /// they go on up by themselves. What the phone has no room for goes when the app is open again.
    static func handOver(_ videos: [QueuedMessage.Video]) async {
        guard let api = ToolsetAPI.current else { return }
        for video in videos {
            guard let id = video.file, let total = try? size(video.url) else { continue }
            // what the server has is known from when the upload began or carried on: only one from before the app started is asked about
            var known = await AssistantTransfers.shared.known(id)
            if known == nil, let asked = try? await parts(of: id, api: api) { known = (asked.partSize, Set(asked.parts)) }
            guard let known, let handle = try? FileHandle(forReadingFrom: video.url) else { continue }
            defer { try? handle.close() }
            for n in 1...max(1, partCount(total: total, partSize: known.partSize)) where !known.parts.contains(n) {
                let part = AssistantTransfers.Part(upload: id, number: n)
                guard await AssistantTransfers.shared.needs(part) else { continue }
                guard room(for: partLength(n, total: total, partSize: known.partSize)),
                      let body = try? partBody(handle, n, total: total, partSize: known.partSize) else { return }
                try? await AssistantTransfers.shared.handOver(part, request(part, total: total, partSize: known.partSize, api: api), body: body)
            }
        }
    }

    /// Each part waits in a file of its own until iOS has sent it: never into the phone's last half gigabyte.
    private static func room(for bytes: Int) -> Bool {
        let free = (try? AssistantTransfers.Part.folder.deletingLastPathComponent()
            .resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey]))?.volumeAvailableCapacityForImportantUsage
        return free.map { $0 > Int64(bytes) + 500_000_000 } ?? true
    }

    private static func request(_ part: AssistantTransfers.Part, total: Int, partSize: Int, api: ToolsetAPI) -> URLRequest {
        var request = api.request("/api/assistant/files/\(part.upload)/parts/\(part.number)", method: "POST")
        request.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type")
        request.setValue(String(partSize), forHTTPHeaderField: "Upload-Part-Size")
        request.setValue(String(total), forHTTPHeaderField: "Upload-Length")
        return request
    }

    private static func partBody(_ handle: FileHandle, _ n: Int, total: Int, partSize: Int) throws -> Data {
        try handle.seek(toOffset: UInt64((n - 1) * partSize))
        return try handle.read(upToCount: partLength(n, total: total, partSize: partSize)) ?? Data()
    }

    /// One part, tried three times: a refusal (4xx) or no answer stops at once, a busy server is tried
    /// again. A part iOS was handed before is waited for, not sent twice.
    private static func sendPart(_ part: AssistantTransfers.Part, of handle: FileHandle, total: Int, partSize: Int, api: ToolsetAPI,
                                 sent: @escaping @Sendable (Int64) -> Void) async throws {
        var attempt = 0
        while true {
            attempt += 1
            do {
                let body = try await AssistantTransfers.shared.needs(part) ? partBody(handle, part.number, total: total, partSize: partSize) : nil
                try await AssistantTransfers.shared.send(part, request(part, total: total, partSize: partSize, api: api), body: body, sent: sent)
                return
            } catch let failure as ToolsetAPI.Failure where failure.status >= 500 && attempt < 3 {
                try await Task.sleep(for: .seconds(2 * attempt))
            }
        }
    }
}

/// A picked video, copied out of Photos into the app's temporary folder (a file, so a long
/// video never has to fit in memory). The copy goes when the upload ends or the video is taken off.
struct AssistantPickedVideo: Transferable {
    let url: URL

    static let folder = FileManager.default.temporaryDirectory.appendingPathComponent("assistant-videos", isDirectory: true)

    static var transferRepresentation: some TransferRepresentation {
        FileRepresentation(importedContentType: .movie) { received in
            let own = folder.appendingPathComponent(UUID().uuidString, isDirectory: true)
            try FileManager.default.createDirectory(at: own, withIntermediateDirectories: true)
            let copy = own.appendingPathComponent(received.file.lastPathComponent)
            try FileManager.default.copyItem(at: received.file, to: copy)
            return AssistantPickedVideo(url: copy)
        }
    }

    func discard() {
        try? FileManager.default.removeItem(at: url.deletingLastPathComponent())
    }
}

extension QueuedMessage.Video {
    init(_ picked: AssistantPickedVideo) {
        self.init(name: picked.url.lastPathComponent, copy: picked.url.deletingLastPathComponent().lastPathComponent)
    }

    /// Its copy on the phone, found again by name.
    var url: URL {
        AssistantPickedVideo.folder.appendingPathComponent(copy, isDirectory: true).appendingPathComponent(name)
    }

    /// The copy is still there (iOS may empty the temporary folder while the app is closed).
    var readable: Bool { FileManager.default.fileExists(atPath: url.path) }

    /// One Photos has yet to hand over: it stands in the box, and in its message, under a name for now.
    static func coming() -> QueuedMessage.Video {
        .init(name: "Video", copy: "coming-" + UUID().uuidString, pending: true)
    }

    /// Photos handed it over: its real name and its copy.
    mutating func take(_ picked: AssistantPickedVideo) {
        name = picked.url.lastPathComponent
        copy = picked.url.deletingLastPathComponent().lastPathComponent
        pending = nil
    }

    /// The video is not wanted any more: its copy goes, and so do its parts still on their way.
    func discard() {
        AssistantPickedVideo(url: url).discard()
        if let file { Task { @MainActor in AssistantTransfers.shared.cancel(file) } }
    }
}

/// What is in the message box: the words, pictures ready to go, and picked videos. A video stays on the phone
/// until Send: Send empties the box at once, even while Photos is still handing a video over, and the
/// message's videos go up behind it (`AssistantOutbox` sends them).
@MainActor
final class AssistantDraft: ObservableObject {
    static let maxPictures = 6
    // a shoot's worth of clips: the AI Editor takes up to 50 chat videos in one edit
    static let maxVideos = 50

    @Published var text = ""
    @Published private(set) var pictures: [QueuedMessage.Picture] = []
    /// Picked videos, on their way up; one Photos is still handing over is `pending`.
    @Published private(set) var videos: [QueuedMessage.Video] = []
    /// Videos that are up already: picked a while ago, or of a message taken back.
    @Published private(set) var files: [QueuedMessage.File] = []
    /// Told when a video is picked, has come out of Photos or is taken off: its upload starts or stops.
    var changed: (() -> Void)?
    /// A video that left with its message before Photos had handed it over: here it is (nil: it could not be read).
    var handedOver: ((String, AssistantPickedVideo?) -> Void)?
    /// Something picked could not be added: said once, above the box.
    @Published var notice: String?
    /// Photos is still handing over what was picked.
    @Published private(set) var reading = false

    var hasAttachment: Bool { !pictures.isEmpty || !videos.isEmpty || !files.isEmpty }
    var isEmpty: Bool { text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !hasAttachment }
    private var videoCount: Int { videos.count + files.count }

    /// What was picked in Photos: pictures become JPEGs, videos are copied out. Each video stands in the
    /// box at once and Photos hands it over meanwhile, however long that takes: Send does not wait for it.
    func add(_ picked: [PhotosPickerItem]) async {
        notice = nil
        var dropped = false
        var coming: [(String, PhotosPickerItem)] = []
        for item in picked where !item.supportedContentTypes.contains(where: { $0.conforms(to: .image) }) {
            guard videoCount < Self.maxVideos else { dropped = true; continue }
            coming.append((expect(), item))
        }
        if !coming.isEmpty {
            Task {
                for (id, item) in coming { self.handed(id, try? await item.loadTransferable(type: AssistantPickedVideo.self)) }
            }
        }
        reading = true
        defer { reading = false }
        for item in picked {
            if item.supportedContentTypes.contains(where: { $0.conforms(to: .image) }) {
                guard pictures.count < Self.maxPictures else { dropped = true; continue }
                guard let data = try? await item.loadTransferable(type: Data.self),
                      let jpeg = await Task.detached(operation: { AssistantPicture.jpeg(from: data) }).value else {
                    notice = "A picture could not be read"
                    continue
                }
                // a second pick may have filled the box while this one was read
                guard pictures.count < Self.maxPictures else { dropped = true; continue }
                pictures.append(.init(name: "Photo \(pictures.count + 1).jpg", jpeg: jpeg))
            }
        }
        if dropped { notice = "Up to \(Self.maxPictures) pictures and \(Self.maxVideos) videos per message" }
    }

    /// A video was picked: it stands in the box until Photos hands it over. Answers its id.
    func expect() -> String {
        let video = QueuedMessage.Video.coming()
        videos.append(video)
        return video.id
    }

    /// Photos handed a picked video over (nil: it could not be read): from now on it goes up. One that left
    /// with its message meanwhile is passed on to it; one taken off meanwhile is thrown away.
    func handed(_ id: String, _ picked: AssistantPickedVideo?) {
        guard let index = videos.firstIndex(where: { $0.id == id }) else {
            if let handedOver { handedOver(id, picked) } else { picked?.discard() }
            return
        }
        if let picked {
            videos[index].take(picked)
            changed?()
        } else {
            videos.remove(at: index)
            notice = "A video could not be read"
        }
    }

    func remove(picture id: String) {
        pictures.removeAll { $0.id == id }
    }

    /// Taken off before sending: its upload stops and what went up of it is left to the server to drop.
    func remove(video id: String) {
        videos.first { $0.id == id }?.discard()
        videos.removeAll { $0.id == id }
        changed?()
    }

    func remove(file id: String) {
        files.removeAll { $0.id == id }
    }

    /// The message as it goes, and an empty box; nil while there is nothing to send or a picture is still being read.
    /// Its videos keep going up; one Photos is still handing over goes with it as it is.
    func take() -> QueuedMessage? {
        guard !isEmpty, !reading else { return nil }
        let message = QueuedMessage(
            text: text.trimmingCharacters(in: .whitespacesAndNewlines), images: pictures, files: files,
            videos: videos.isEmpty ? nil : videos)
        text = ""
        pictures = []
        videos = []
        files = []
        notice = nil
        return message
    }

    /// A message taken back from the queue: its words (after what is already in the box) and what it carried.
    /// A video half way up carries on from there when it goes again; one whose copy is gone is left out.
    func putBack(_ message: QueuedMessage) {
        let written = text.trimmingCharacters(in: .whitespacesAndNewlines)
        text = written.isEmpty ? message.text : message.text.isEmpty ? text : "\(text)\n\n\(message.text)"
        pictures = Array((pictures + message.images).prefix(Self.maxPictures))
        files += message.files
        let waiting = message.videos ?? []
        let kept = waiting.filter { $0.pending == true || $0.readable }
        videos += kept
        if kept.count < waiting.count { notice = "A video could not be read" }
        changed?()
    }

    #if DEBUG
    /// A screenshot's box: pictures and videos, without Photos.
    func pretend(pictures: [QueuedMessage.Picture], videos: [QueuedMessage.Video]) {
        self.pictures = pictures
        self.videos = videos
        changed?()
    }

    /// A file as if it had been picked in Photos, handed over after `seconds`: it goes up for real from then.
    func pretendPicked(_ file: URL, after seconds: Double = 0) {
        let id = expect()
        guard seconds > 0 else { return handed(id, AssistantPickedVideo(url: file)) }
        Task {
            try? await Task.sleep(for: .seconds(seconds))
            self.handed(id, AssistantPickedVideo(url: file))
        }
    }
    #endif
}
