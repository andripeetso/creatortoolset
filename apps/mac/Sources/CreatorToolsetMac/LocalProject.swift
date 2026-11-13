import AVFoundation
import AppKit
import Foundation

// One screen recording kept on disk as a folder, `<yyyy-MM-dd HH.mm.ss>.ctrec/`, holding project.json, screen.mp4,
// screen-events.json, thumb.jpg and, once the editor saves, screen-look.json. The folder is the only copy until the
// user saves or shares the video, so nothing here deletes anything except through `delete()` (Trash).

enum LocalProjectError: Error, Equatable {
    case lookTooLarge
    case lookNotJSON
}

struct LocalProject {
    /// project.json as written to disk.
    private struct Meta: Codable {
        var v = 1
        var id: String
        var name: String
        var state: String
        var createdAt: Date
        var durationMs: Int
        var width: Int
        var height: Int
        var tracks: [String]
        var camera: Bool
    }

    private static let stamp: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "yyyy-MM-dd HH.mm.ss"
        return f
    }()

    let id: String
    let folder: URL
    var name: String
    var createdAt: Date
    var durationMs: Int
    var width: Int
    var height: Int
    var tracks: [String]
    var camera: Bool
    /// "recording" until markReady, then "ready".
    var state: String

    var screenURL: URL { folder.appendingPathComponent("screen.mp4") }
    var eventsURL: URL { folder.appendingPathComponent("screen-events.json") }
    var cameraURL: URL { folder.appendingPathComponent("camera.mp4") }
    /// Where the face is in the camera file, for the editor's Follow my face (CameraFaces.swift).
    var facesURL: URL { folder.appendingPathComponent("camera-faces.json") }
    var thumbURL: URL { folder.appendingPathComponent("thumb.jpg") }
    var lookURL: URL { folder.appendingPathComponent("screen-look.json") }
    private var metaURL: URL { folder.appendingPathComponent("project.json") }

    /// Creates the folder and a project.json in state "recording". Throws if the folder for that second already exists.
    static func create(in root: URL, at date: Date) throws -> LocalProject {
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let label = stamp.string(from: date)
        let folder = root.appendingPathComponent("\(label).ctrec", isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: false)
        let id = (0..<12).map { _ in String(Int.random(in: 0...15), radix: 16) }.joined()
        let project = LocalProject(id: id, folder: folder, name: "Screen recording \(label)", createdAt: date,
                                   durationMs: 0, width: 0, height: 0, tracks: [], camera: false, state: "recording")
        try project.writeMeta()
        return project
    }

    static func open(folder: URL) throws -> LocalProject {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        let meta = try decoder.decode(Meta.self, from: Data(contentsOf: folder.appendingPathComponent("project.json")))
        guard ProjectStore.isValidID(meta.id) else { throw CocoaError(.fileReadCorruptFile) }
        return LocalProject(id: meta.id, folder: folder, name: meta.name, createdAt: meta.createdAt,
                            durationMs: meta.durationMs, width: meta.width, height: meta.height,
                            tracks: meta.tracks, camera: meta.camera, state: meta.state)
    }

    func writeEvents(_ data: Data) throws {
        try data.write(to: eventsURL, options: .atomic)
    }

    /// Saves the editor's look. Must be JSON and at most 256 KB.
    func writeLook(_ data: Data) throws {
        guard data.count <= 256 * 1024 else { throw LocalProjectError.lookTooLarge }
        guard (try? JSONSerialization.jsonObject(with: data, options: .fragmentsAllowed)) != nil else {
            throw LocalProjectError.lookNotJSON
        }
        try data.write(to: lookURL, options: .atomic)
    }

    /// Records what the finished file holds and sets state "ready".
    mutating func markReady(durationMs: Int, width: Int, height: Int, tracks: [String], camera: Bool) throws {
        self.durationMs = durationMs
        self.width = width
        self.height = height
        self.tracks = tracks
        self.camera = camera
        state = "ready"
        try writeMeta()
    }

    /// A JPEG of the frame at 0.5 s (the first frame when the video is shorter), at most 640 px on either side.
    func writeThumb(from video: URL) async throws {
        let asset = AVURLAsset(url: video)
        let generator = AVAssetImageGenerator(asset: asset)
        generator.appliesPreferredTrackTransform = true
        generator.maximumSize = CGSize(width: 640, height: 640)
        let seconds = try await asset.load(.duration).seconds
        let at = CMTime(seconds: seconds > 0.5 ? 0.5 : 0, preferredTimescale: 600)
        let (image, _) = try await generator.image(at: at)
        guard let jpeg = NSBitmapImageRep(cgImage: image).representation(using: .jpeg, properties: [.compressionFactor: 0.8]) else {
            throw CocoaError(.fileWriteUnknown)
        }
        try jpeg.write(to: thumbURL, options: .atomic)
    }

    /// Moves the whole folder to the Trash.
    func delete() throws {
        try FileManager.default.trashItem(at: folder, resultingItemURL: nil)
    }

    var listing: [String: Any] {
        ["id": id, "name": name, "createdAt": Int(createdAt.timeIntervalSince1970 * 1000), "durationMs": durationMs,
         "width": width, "height": height, "camera": camera]
    }

    private func writeMeta() throws {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        encoder.outputFormatting = [.sortedKeys]
        let meta = Meta(id: id, name: name, state: state, createdAt: createdAt, durationMs: durationMs,
                        width: width, height: height, tracks: tracks, camera: camera)
        try encoder.encode(meta).write(to: metaURL, options: .atomic)
    }
}

/// Finds local projects. The only way from an id (which comes from a URL) to a folder.
enum ProjectStore {
    /// Exactly 12 lowercase hex characters.
    static func isValidID(_ id: String) -> Bool {
        id.utf8.count == 12 && id.utf8.allSatisfy { (48...57).contains($0) || (97...102).contains($0) }
    }

    /// Ready projects, newest first.
    static func list(root: URL) -> [LocalProject] {
        all(root: root).filter { $0.state == "ready" }.sorted { $0.createdAt > $1.createdAt }
    }

    /// Any project with this id, ready or still recording.
    // ponytail: scans the folders on every call (the scheme asks once per range request); fine for hundreds of takes, keep an id-to-folder map when it is not.
    static func project(id: String, root: URL) -> LocalProject? {
        guard isValidID(id) else { return nil }
        return all(root: root).first { $0.id == id }
    }

    private static func all(root: URL) -> [LocalProject] {
        let entries = (try? FileManager.default.contentsOfDirectory(at: root, includingPropertiesForKeys: nil,
                                                                    options: [.skipsHiddenFiles])) ?? []
        return entries.filter { $0.pathExtension == "ctrec" }.compactMap { try? LocalProject.open(folder: $0) }
    }
}
