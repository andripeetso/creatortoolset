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

/// A video sent with a message goes up first, in parts (the server's `api/lib/uploads.ts`):
/// `POST /api/assistant/files` says the part size, each part is posted by its number, `complete` joins them.
enum AssistantUpload {
    static func partCount(total: Int, partSize: Int) -> Int {
        guard total > 0, partSize > 0 else { return 0 }
        return (total + partSize - 1) / partSize
    }

    /// How many bytes part `n` (from 1) holds: every part is full but the last.
    static func partLength(_ n: Int, total: Int, partSize: Int) -> Int {
        max(0, min(partSize, total - (n - 1) * partSize))
    }

    private struct Started: Decodable {
        let id: String
        let partSize: Int
    }

    /// Uploads the file and answers its id; `progress` hears 0…1 as the bytes go.
    static func send(_ file: URL, name: String, api: ToolsetAPI, progress: @escaping @Sendable (Double) -> Void) async throws -> String {
        let total = (try FileManager.default.attributesOfItem(atPath: file.path)[.size] as? NSNumber)?.intValue ?? 0
        guard total > 0 else { throw ToolsetAPI.Failure(status: 0, message: "The video file is empty.") }
        let mime = UTType(filenameExtension: file.pathExtension)?.preferredMIMEType ?? "video/mp4"
        let started = try JSONDecoder().decode(Started.self, from: try await api.send(
            "/api/assistant/files", json: ["name": name, "mime": mime, "size": total]))
        let base = "/api/assistant/files/\(started.id)"
        let handle = try FileHandle(forReadingFrom: file)
        defer { try? handle.close() }
        // ponytail: one part at a time; three at once, as Caption Studio sends, if phone videos upload too slowly
        for n in 1...max(1, partCount(total: total, partSize: started.partSize)) {
            try Task.checkCancellation()
            let before = (n - 1) * started.partSize
            try handle.seek(toOffset: UInt64(before))
            let body = try handle.read(upToCount: partLength(n, total: total, partSize: started.partSize)) ?? Data()
            var request = api.request("\(base)/parts/\(n)", method: "POST")
            request.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type")
            request.setValue(String(started.partSize), forHTTPHeaderField: "Upload-Part-Size")
            request.setValue(String(total), forHTTPHeaderField: "Upload-Length")
            // a minute with nothing moving, the answer included: the part failed (an older server never answers a big part)
            request.timeoutInterval = 60
            try await sendPart(request, body) { sent in progress(Double(before + Int(sent)) / Double(total)) }
        }
        _ = try await api.data(api.request("\(base)/complete", method: "POST"), session: ToolsetAPI.slow)
        progress(1)
        return started.id
    }

    /// One part, tried three times: a refusal (4xx) or a minute without an answer stops at once,
    /// a dropped connection or a busy server is tried again.
    private static func sendPart(_ request: URLRequest, _ body: Data, sent: @escaping @Sendable (Int64) -> Void) async throws {
        var attempt = 0
        while true {
            attempt += 1
            do {
                let (data, response) = try await ToolsetAPI.slow.upload(for: request, from: body, delegate: SentBytes(report: sent))
                let status = (response as? HTTPURLResponse)?.statusCode ?? 0
                if (200..<300).contains(status) { return }
                let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
                let failure = ToolsetAPI.Failure(status: status, message: object?["error"] as? String ?? "Upload failed (HTTP \(status))")
                if status < 500 || attempt == 3 { throw failure }
            } catch let failure as ToolsetAPI.Failure {
                throw failure
            } catch is CancellationError {
                throw CancellationError()
            } catch {
                if Task.isCancelled { throw CancellationError() }
                if (error as? URLError)?.code == .timedOut { throw ToolsetAPI.Failure(status: 0, message: "No answer from the server") }
                if attempt == 3 { throw ToolsetAPI.Failure(status: 0, message: "The upload stopped") }
            }
            try await Task.sleep(for: .seconds(2 * attempt))
        }
    }

    private final class SentBytes: NSObject, URLSessionTaskDelegate {
        let report: @Sendable (Int64) -> Void
        init(report: @escaping @Sendable (Int64) -> Void) { self.report = report }

        func urlSession(_ session: URLSession, task: URLSessionTask, didSendBodyData bytesSent: Int64,
                        totalBytesSent: Int64, totalBytesExpectedToSend: Int64) {
            report(totalBytesSent)
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

/// What is in the message box: the words, pictures ready to go, and videos that upload as soon as
/// they are picked (the message waits for them).
@MainActor
final class AssistantDraft: ObservableObject {
    static let maxPictures = 6
    static let maxVideos = 5

    struct Video: Identifiable, Equatable {
        let id = UUID().uuidString
        var name: String
        /// 0…1 while it uploads.
        var progress = 0.0
        /// The server's id once it is up.
        var fileID: String?
        var error: String?
    }

    @Published var text = ""
    @Published private(set) var pictures: [QueuedMessage.Picture] = []
    @Published private(set) var videos: [Video] = []
    /// Something picked could not be added: said once, above the box.
    @Published var notice: String?
    /// Pictures are being read from Photos.
    @Published private(set) var reading = false
    private var uploads: [String: Task<Void, Never>] = [:]
    /// Each video's copy out of Photos, kept until it is up or taken off, so a failed upload can be tried again.
    private var copies: [String: AssistantPickedVideo] = [:]

    var hasAttachment: Bool { !pictures.isEmpty || !videos.isEmpty }
    /// A video is still on its way up, or failed: the message can't go yet.
    var blocked: Bool { reading || videos.contains { $0.fileID == nil } }
    var isEmpty: Bool { text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !hasAttachment }

    /// What was picked in Photos: pictures become JPEGs, videos start uploading.
    func add(_ picked: [PhotosPickerItem]) async {
        notice = nil
        reading = true
        defer { reading = false }
        var dropped = false
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
            } else {
                guard videos.count < Self.maxVideos else { dropped = true; continue }
                guard let video = try? await item.loadTransferable(type: AssistantPickedVideo.self) else {
                    notice = "A video could not be read"
                    continue
                }
                guard videos.count < Self.maxVideos else {
                    video.discard()
                    dropped = true
                    continue
                }
                upload(video)
            }
        }
        if dropped { notice = "Up to \(Self.maxPictures) pictures and \(Self.maxVideos) videos per message" }
    }

    private func upload(_ picked: AssistantPickedVideo) {
        let video = Video(name: picked.url.lastPathComponent)
        videos.append(video)
        copies[video.id] = picked
        start(video.id)
    }

    /// A failed upload, from its start again.
    // ponytail: the whole file again; ask the server which parts it has (GET …/parts) if phone videos get long
    func retry(video id: String) {
        change(id) {
            $0.error = nil
            $0.progress = 0
        }
        start(id)
    }

    private func start(_ id: String) {
        guard uploads[id] == nil, let picked = copies[id], let name = videos.first(where: { $0.id == id })?.name else { return }
        guard let api = ToolsetAPI.current else {
            change(id) { $0.error = "Sign in first" }
            return
        }
        uploads[id] = Task { [weak self] in
            do {
                let fileID = try await AssistantUpload.send(picked.url, name: name, api: api) { fraction in
                    Task { @MainActor in self?.change(id) { $0.progress = max($0.progress, fraction) } }
                }
                self?.change(id) { $0.fileID = fileID }
                self?.copies.removeValue(forKey: id)?.discard()
            } catch is CancellationError {
            } catch {
                self?.change(id) { $0.error = error.localizedDescription }
            }
            self?.uploads[id] = nil
        }
    }

    func remove(picture id: String) {
        pictures.removeAll { $0.id == id }
    }

    /// Takes a video off the message; one still uploading stops.
    func remove(video id: String) {
        uploads.removeValue(forKey: id)?.cancel()
        copies.removeValue(forKey: id)?.discard()
        videos.removeAll { $0.id == id }
    }

    /// The message as it goes, and an empty box; nil while there is nothing to send or a video is not up yet.
    func take() -> QueuedMessage? {
        guard !isEmpty, !blocked else { return nil }
        let message = QueuedMessage(
            text: text.trimmingCharacters(in: .whitespacesAndNewlines), images: pictures,
            files: videos.compactMap { video in video.fileID.map { .init(id: $0, name: video.name) } })
        text = ""
        pictures = []
        videos = []
        notice = nil
        return message
    }

    /// A message taken back from the queue: its words (after what is already in the box) and what it carried.
    func putBack(_ message: QueuedMessage) {
        let written = text.trimmingCharacters(in: .whitespacesAndNewlines)
        text = written.isEmpty ? message.text : message.text.isEmpty ? text : "\(text)\n\n\(message.text)"
        pictures = Array((pictures + message.images).prefix(Self.maxPictures))
        videos += message.files.map { Video(name: $0.name, progress: 1, fileID: $0.id) }
    }

    private func change(_ id: String, _ edit: (inout Video) -> Void) {
        guard let index = videos.firstIndex(where: { $0.id == id }) else { return }
        edit(&videos[index])
    }

    #if DEBUG
    /// A screenshot's box: pictures and a video half way up, without Photos.
    func pretend(pictures: [QueuedMessage.Picture], videos: [Video]) {
        self.pictures = pictures
        self.videos = videos
    }

    /// A file as if it had been picked in Photos: it uploads for real.
    func pretendPicked(_ file: URL) {
        upload(AssistantPickedVideo(url: file))
    }
    #endif
}
