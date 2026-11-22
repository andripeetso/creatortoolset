import CryptoKit
import Foundation

// The Media Library's thumbnails and sprites, kept on this Mac: `ctlocal://thumb/<base64url of the server path with its
// query>` (the page's localThumb, src/lib/local-thumbs.ts). ProjectScheme answers it: from Caches/Thumbs when the cache
// holds the file, else from the page's own server with the window's cookies, and a 200 is kept. A file is keyed by the
// server's origin, the account's proxy folder there (ProxyCache.allowed: one per server and account) and the path with
// its query, so a remade thumb (its `v=` changes) is a new file and another account never reads one.

enum ThumbCache {
    static let host = "thumb"
    /// The least recently used files go first once the folder is over this many bytes.
    static let limit: Int64 = 1 << 30

    static var dir: URL {
        FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0].appendingPathComponent("Thumbs", isDirectory: true)
    }

    /// The address of a server path (with its query) in the thumb scheme.
    static func url(target: String) -> URL {
        let b64 = Data(target.utf8).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
        return URL(string: "\(ProjectScheme.scheme)://\(host)/\(b64)")!
    }

    /// The server path and query a thumb address names, when `accepts` takes it; nil for anything else.
    static func target(from url: URL) -> String? {
        guard url.host == host else { return nil }
        var b64 = String(url.path.dropFirst())
        guard !b64.isEmpty, b64.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-" || $0 == "_") }) else { return nil }
        b64 = b64.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        b64 += String(repeating: "=", count: (4 - b64.count % 4) % 4)
        guard let data = Data(base64Encoded: b64), let target = String(data: data, encoding: .utf8), accepts(target) else { return nil }
        return target
    }

    /// Only a Media Library thumb or sprite of one version: /api/library/media/<id>/(thumb|sprite), and after a `?` only
    /// plain query characters. Nothing else reaches the server through this scheme.
    static func accepts(_ target: String) -> Bool {
        let parts = target.split(separator: "?", maxSplits: 1, omittingEmptySubsequences: false)
        guard parts.count == 1 || parts[1].allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber || "_=&.-".contains($0)) }) else { return false }
        let segments = parts[0].split(separator: "/", omittingEmptySubsequences: false)
        return segments.count == 6 && segments[0].isEmpty && segments[1] == "api" && segments[2] == "library" && segments[3] == "media"
            && !segments[4].isEmpty && segments[4].allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-" || $0 == "_") })
            && (segments[5] == "thumb" || segments[5] == "sprite")
    }

    /// The page's server as an origin (scheme, host, port): the base the target is asked of.
    static func origin(_ page: URL) -> URL? {
        var parts = URLComponents(url: page, resolvingAgainstBaseURL: false)
        parts?.path = ""
        parts?.query = nil
        parts?.fragment = nil
        return parts?.url
    }

    /// The cache file of a thumb: one per server, account (its proxy folder, ProxyCache.allowed) and target.
    static func file(in dir: URL, origin: URL, account: String, target: String) -> URL {
        let key = Data("\(origin.absoluteString)\n\(account)\n\(target)".utf8)
        return dir.appendingPathComponent(SHA256.hash(data: key).map { String(format: "%02x", $0) }.joined() + ".jpg")
    }

    /// The kept bytes of a file, its use time renewed (the least recently used goes first in `prune`); nil when not kept.
    static func read(_ file: URL) -> Data? {
        guard let data = try? Data(contentsOf: file) else { return nil }
        try? FileManager.default.setAttributes([.modificationDate: Date()], ofItemAtPath: file.path)
        return data
    }

    static func write(_ data: Data, to file: URL) throws {
        try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        try data.write(to: file, options: .atomic)
    }

    private static let lock = NSLock()
    private static var lastPrune = Date.distantPast

    /// `prune` at most every ten minutes, after a write.
    static func pruneIfDue(_ dir: URL) {
        let due = lock.withLock { () -> Bool in
            guard Date().timeIntervalSince(lastPrune) > 600 else { return false }
            lastPrune = Date()
            return true
        }
        if due { prune(dir, cap: limit) }
    }

    /// Deletes the least recently used files until the folder is at most `cap` bytes.
    static func prune(_ dir: URL, cap: Int64) {
        let keys: Set<URLResourceKey> = [.contentModificationDateKey, .fileSizeKey]
        let files = ((try? FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: Array(keys))) ?? []).map { file -> (URL, Date, Int64) in
            let values = try? file.resourceValues(forKeys: keys)
            return (file, values?.contentModificationDate ?? .distantPast, Int64(values?.fileSize ?? 0))
        }
        var total = files.reduce(Int64(0)) { $0 + $1.2 }
        for (file, _, size) in files.sorted(by: { $0.1 < $1.1 }) where total > cap {
            try? FileManager.default.removeItem(at: file)
            total -= size
        }
    }

    /// No URL cache under it: the kept file is the only copy on this Mac.
    static let session: URLSession = {
        let config = URLSessionConfiguration.ephemeral
        config.urlCache = nil
        config.requestCachePolicy = .reloadIgnoringLocalCacheData
        return URLSession(configuration: config, delegate: Redirects(), delegateQueue: nil)
    }()

    /// A redirect off the server (a bucket's signed link) is followed without the window's cookies: URLSession keeps a
    /// request's own headers on the next one, and the sign-in must never reach another host.
    static func followed(_ next: URLRequest, from original: URL?) -> URLRequest {
        guard let to = next.url, let from = original,
              to.scheme != from.scheme || to.host != from.host || to.port != from.port else { return next }
        var stripped = next
        stripped.setValue(nil, forHTTPHeaderField: "Cookie")
        return stripped
    }

    final class Redirects: NSObject, URLSessionTaskDelegate {
        func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                        newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
            completionHandler(ThumbCache.followed(request, from: task.originalRequest?.url))
        }
    }

    /// The server's answer to a target: its status and bytes, asked of `origin` with the window's cookies.
    static func fetch(origin: URL, target: String, cookies: [HTTPCookie]) async throws -> (status: Int, data: Data) {
        var request = URLRequest(url: URL(string: target, relativeTo: origin) ?? origin)
        request.httpShouldHandleCookies = false
        request.allHTTPHeaderFields = HTTPCookie.requestHeaderFields(with: cookies)
        let (data, response) = try await session.data(for: request)
        return ((response as? HTTPURLResponse)?.statusCode ?? 0, data)
    }
}
