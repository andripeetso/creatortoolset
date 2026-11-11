import AVKit
import CryptoKit
import SwiftUI
import UIKit

/// The name the screens shared with other Creator Toolset phone code use for the server's client.
typealias ToolsetAPI = API
/// The one-line problem, under the name those screens use.
typealias ToolsetMessage = Problem

extension API {
    typealias Failure = APIError

    /// The server in use, read from what `Servers` saved (any thread may ask); nil before one is added.
    static var current: API? {
        let defaults = UserDefaults.standard
        guard let data = defaults.data(forKey: Servers.listKey),
              let list = try? JSONDecoder().decode([Server].self, from: data) else { return nil }
        let id = defaults.string(forKey: Servers.currentKey) ?? list.first?.id
        return list.first { $0.id == id }.map { API(server: $0.url, cookie: Keychain.get($0.id), username: $0.username) }
    }

    /// For calls that take minutes (an upload's part, transcription, the change stream).
    static let slow: URLSession = {
        let config = URLSessionConfiguration.default
        config.httpShouldSetCookies = false
        config.httpCookieStorage = nil
        config.timeoutIntervalForRequest = 600
        return URLSession(configuration: config)
    }()

    static let snake: JSONDecoder = {
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        return decoder
    }()

    /// Lists kept on disk are kept per server and account: an admin's names a viewer's don't.
    var cacheKey: String {
        "\(server.host() ?? "")\(server.port.map { "-\($0)" } ?? "")-\(username ?? "local")"
    }

    /// Downloads a file (a redirect to storage is followed, without the cookie) into `folder` under its name.
    func download(_ path: String, filename: String, into folder: URL) async throws -> URL {
        let temporary: URL
        let response: URLResponse
        do {
            (temporary, response) = try await API.session.download(for: request(path))
        } catch let error as URLError where error.code != .cancelled {
            throw APIError.offline
        }
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else {
            try? FileManager.default.removeItem(at: temporary)
            throw APIError.server(status, status == 403 ? "Only admins download this." : "Download failed (\(status))")
        }
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        // Photos reads the type from the extension
        let name = (filename as NSString).pathExtension.isEmpty ? filename + ".mp4" : filename
        let file = folder.appendingPathComponent(name)
        try? FileManager.default.removeItem(at: file)
        try FileManager.default.moveItem(at: temporary, to: file)
        return file
    }

    /// Downloads a file into Photos.
    @MainActor
    func saveToPhotos(_ path: String, filename: String) async throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        try await SaveToPhotos.add([try await download(path, filename: filename, into: folder)])
    }
}

/// Last answers on disk, so a screen shows what it had at once and then checks again (Caches: iOS may clear it; it
/// is simply fetched again). Name a list with `api.cacheKey` in it.
enum DiskCache {
    private static let folder = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
        .appendingPathComponent("toolset", isDirectory: true)

    static func read<T: Decodable>(_ name: String, as type: T.Type = T.self) -> T? {
        guard let data = try? Data(contentsOf: folder.appendingPathComponent(name + ".json")) else { return nil }
        return try? JSONDecoder().decode(T.self, from: data)
    }

    static func write<T: Encodable>(_ name: String, _ value: T) {
        guard let data = try? JSONEncoder().encode(value) else { return }
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        try? data.write(to: folder.appendingPathComponent(name + ".json"), options: .atomic)
    }
}

/// Pictures from the server in use: memory while the app runs, disk between launches, so a grid appears at once the
/// second time. Kept per server and account.
@MainActor
final class ToolsetImages {
    static let shared = ToolsetImages()
    private let memory = NSCache<NSString, UIImage>()
    private var loading: [String: Task<UIImage?, Never>] = [:]
    private static let folder = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
        .appendingPathComponent("toolset-images", isDirectory: true)

    init() { memory.totalCostLimit = 100 * 1024 * 1024 }

    func image(_ path: String, maxPixels: Int) async -> UIImage? {
        guard let api = API.current else { return nil }
        let key = "\(api.cacheKey)|\(maxPixels)|\(path)"
        if let hit = memory.object(forKey: key as NSString) { return hit }
        if let running = loading[key] { return await running.value }
        let digest = SHA256.hash(data: Data(key.utf8)).map { String(format: "%02x", $0) }.joined()
        let folder = Self.folder
        let file = folder.appendingPathComponent(digest + ".jpg")
        let task = Task<UIImage?, Never> {
            if let saved = await Task.detached(priority: .userInitiated, operation: {
                UIImage(contentsOfFile: file.path)?.preparingForDisplay()
            }).value { return saved }
            guard let data = try? await api.data(api.request(path)) else { return nil }
            return await Task.detached(priority: .userInitiated) {
                let image = Self.decode(data, maxPixels: maxPixels)
                if let jpeg = image?.jpegData(compressionQuality: 0.8) {
                    try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
                    try? jpeg.write(to: file, options: .atomic)
                }
                return image
            }.value
        }
        loading[key] = task
        let image = await task.value
        loading[key] = nil
        if let image, let cg = image.cgImage {
            memory.setObject(image, forKey: key as NSString, cost: cg.bytesPerRow * cg.height)
        }
        return image
    }

    /// A picture decoded no larger than `maxPixels` on its long edge (a grid cell needs a few hundred pixels).
    nonisolated static func decode(_ data: Data, maxPixels: Int) -> UIImage? {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil) else { return nil }
        let options: [CFString: Any] = [kCGImageSourceCreateThumbnailFromImageAlways: true,
                                        kCGImageSourceCreateThumbnailWithTransform: true,
                                        kCGImageSourceShouldCacheImmediately: true,
                                        kCGImageSourceThumbnailMaxPixelSize: maxPixels]
        guard let cg = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else { return nil }
        return UIImage(cgImage: cg)
    }
}

/// A picture from the server in use (nil path: the placeholder).
struct ToolsetImage: View {
    let path: String?
    var maxPixels = 400
    var contentMode: ContentMode = .fill
    @State private var image: UIImage?

    var body: some View {
        ZStack {
            Rectangle().fill(Color(.secondarySystemBackground))
            if let image {
                Image(uiImage: image).resizable().aspectRatio(contentMode: contentMode)
            }
        }
        .task(id: path) {
            guard let path else { return }
            image = await ToolsetImages.shared.image(path, maxPixels: maxPixels)
        }
    }
}

/// A launch argument in a debug build (`-OpenPath /review/<id>` for simulator checks without taps); always nil in a
/// release build.
func debugArg(_ key: String) -> String? {
    #if DEBUG
    return UserDefaults.standard.string(forKey: key)
    #else
    return nil
    #endif
}

/// "0:12", "1:04:09".
func clock(_ seconds: Double) -> String {
    let s = Int(max(0, seconds.rounded(.down)))
    return s >= 3600 ? String(format: "%d:%02d:%02d", s / 3600, s / 60 % 60, s % 60)
        : String(format: "%d:%02d", s / 60, s % 60)
}
