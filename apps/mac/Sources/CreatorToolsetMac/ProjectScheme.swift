import Foundation
import WebKit

// Serves a local recording's files to the web page as `ctlocal://<projectId>/<file>`, so the editor can play, seek and
// read the screen video without an upload. Only the listed files of one project folder are reachable: the id goes
// through ProjectStore, and the file name must be an exact key of `types`. Files are read on a background queue in
// 1 MB pieces; a stop from WebKit ends the read, and nothing is sent to WebKit after it.

final class ProjectScheme: NSObject, WKURLSchemeHandler {
    static let scheme = "ctlocal"
    static let types: [String: String] = [
        "project.json": "application/json",
        "screen-events.json": "application/json",
        "screen-look.json": "application/json",
        "screen.mp4": "video/mp4",
        "camera.mp4": "video/mp4",
        "thumb.jpg": "image/jpeg",
    ]
    /// An open-ended range (`bytes=n-`) is cut to this many bytes, so a seek does not read the rest of the file.
    static let openRangeCap: Int64 = 8 << 20
    private static let chunk: Int64 = 1 << 20

    private let root: @MainActor () -> URL
    /// Tasks still being answered. Holding them keeps their ids unique until they end; `stop` removes one.
    private var live: [ObjectIdentifier: WKURLSchemeTask] = [:]
    // Recursive: WebKit may call stop from inside a delivery on the same thread.
    private let lock = NSRecursiveLock()

    init(root: @escaping @MainActor () -> URL) {
        self.root = root
        super.init()
    }

    static func url(projectID: String, file: String) -> URL {
        URL(string: "\(scheme)://\(projectID)/\(file)")!
    }

    /// The bytes a `Range` header asks for, clamped to the file. Nil when the header is not one range this server
    /// answers: malformed, several ranges, or starting past the end. Also nil for an empty file.
    static func byteRange(header: String?, size: Int64) -> ClosedRange<Int64>? {
        guard let header, header.hasPrefix("bytes="), size > 0 else { return nil }
        let spec = header.dropFirst(6)
        guard !spec.contains(",") else { return nil }
        let parts = spec.split(separator: "-", omittingEmptySubsequences: false)
        guard parts.count == 2 else { return nil }
        let start: Int64, end: Int64
        if let first = Int64(parts[0]) {
            start = first
            end = Int64(parts[1]).map { min($0, size - 1) } ?? min(size - 1, first + openRangeCap - 1)
        } else if let suffix = Int64(parts[1]), suffix > 0 {
            start = max(0, size - suffix)
            end = size - 1
        } else {
            return nil
        }
        guard start >= 0, start < size, start <= end else { return nil }
        return start...end
    }

    func webView(_ webView: WKWebView, start urlSchemeTask: WKURLSchemeTask) {
        let request = urlSchemeTask.request
        guard let url = request.url else { return urlSchemeTask.didFailWithError(CocoaError(.fileReadUnknown)) }
        let task = urlSchemeTask
        lock.lock()
        live[ObjectIdentifier(task)] = task
        lock.unlock()
        let root = MainActor.assumeIsolated { self.root() }
        DispatchQueue.global(qos: .userInitiated).async {
            self.serve(url, method: request.httpMethod, range: request.value(forHTTPHeaderField: "Range"),
                       root: root, task: task)
        }
    }

    func webView(_ webView: WKWebView, stop urlSchemeTask: WKURLSchemeTask) {
        lock.lock()
        live[ObjectIdentifier(urlSchemeTask)] = nil
        lock.unlock()
    }

    private func serve(_ url: URL, method: String?, range: String?, root: URL, task: WKURLSchemeTask) {
        guard method == "GET" else { return reply(task, url, 405, ["Allow": "GET"]) }
        let name = String(url.path.dropFirst())
        guard let type = Self.types[name], let project = ProjectStore.project(id: url.host ?? "", root: root) else {
            return reply(task, url, 404)
        }
        let file = project.folder.appendingPathComponent(name)
        guard let attributes = try? FileManager.default.attributesOfItem(atPath: file.path),
              let size = (attributes[.size] as? NSNumber)?.int64Value,
              let handle = try? FileHandle(forReadingFrom: file) else {
            return reply(task, url, 404)
        }
        defer { try? handle.close() }

        var start: Int64 = 0, end = size - 1, status = 200
        var headers = ["Content-Type": type, "Accept-Ranges": "bytes"]
        if name.hasSuffix(".json") { headers["Cache-Control"] = "no-store" }
        if let range {
            guard let r = Self.byteRange(header: range, size: size) else {
                return reply(task, url, 416, ["Content-Range": "bytes */\(size)"])
            }
            (start, end, status) = (r.lowerBound, r.upperBound, 206)
            headers["Content-Range"] = "bytes \(start)-\(end)/\(size)"
        }
        headers["Content-Length"] = "\(end - start + 1)"
        guard (try? handle.seek(toOffset: UInt64(start))) != nil else { return reply(task, url, 500) }
        guard deliver(task, { $0.didReceive(Self.response(url, status, headers)) }) else { return }

        var left = end - start + 1
        while left > 0 {
            guard let data = try? handle.read(upToCount: Int(min(left, Self.chunk))), !data.isEmpty else {
                deliver(task, last: true) { $0.didFailWithError(CocoaError(.fileReadUnknown)) }
                return
            }
            guard deliver(task, { $0.didReceive(data) }) else { return }
            left -= Int64(data.count)
        }
        deliver(task, last: true) { $0.didFinish() }
    }

    /// A response with no body, then the end of the task.
    private func reply(_ task: WKURLSchemeTask, _ url: URL, _ status: Int, _ headers: [String: String] = [:]) {
        deliver(task, last: true) { t in
            t.didReceive(Self.response(url, status, headers))
            t.didFinish()
        }
    }

    /// Runs `body` only while the task is still live, under the lock that `stop` takes, so WebKit never gets a call
    /// after it stopped the task. `last` ends the task. Returns false when the task was stopped.
    @discardableResult
    private func deliver(_ task: WKURLSchemeTask, last: Bool = false, _ body: (WKURLSchemeTask) -> Void) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        let key = ObjectIdentifier(task)
        guard live[key] != nil else { return false }
        body(task)
        if last { live[key] = nil }
        return true
    }

    private static func response(_ url: URL, _ status: Int, _ headers: [String: String]) -> HTTPURLResponse {
        var all = [
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Expose-Headers": "Content-Range, Content-Length, Accept-Ranges",
        ]
        all.merge(headers) { _, new in new }
        return HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: all)!
    }
}
