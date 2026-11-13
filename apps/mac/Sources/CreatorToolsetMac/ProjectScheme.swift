import Foundation
import WebKit

// Serves a local recording's files to the web page as `ctlocal://<projectId>/<file>`, so the editor can play, seek and
// read the screen video without an upload. Only the listed files of one project folder are reachable: the id goes
// through ProjectStore, and the file name must be an exact key of `types`. Files are read on a background queue in
// 1 MB pieces; a stop from WebKit ends the read, and nothing is sent to WebKit after it.
//
// `ctlocal://media/<base64url of an absolute path>` serves an edit's original video and sound files the same way, only
// from the folders the user granted in this app's own open panel (MediaFiles.swift decides).
//
// Every answer to WebKit is made on the main thread, with nothing held while waiting for it. WebKit starts and stops
// tasks on the main thread, and an answer made from another thread waits for the main thread inside WebKit. Until
// 0.13.1 the answers were made from the reading thread under a lock that start and stop also took: one request
// answering while the next one started left each waiting for the other, and the app stood still for good (the page
// plays a recording and reads its pointer log at once, so the editor froze the app within a second).

final class ProjectScheme: NSObject, WKURLSchemeHandler {
    static let scheme = "ctlocal"
    static let types: [String: String] = [
        "project.json": "application/json",
        "screen-events.json": "application/json",
        "screen-look.json": "application/json",
        "screen.mp4": "video/mp4",
        "camera.mp4": "video/mp4",
        "camera-faces.json": "application/json",
        "thumb.jpg": "image/jpeg",
    ]
    /// An open-ended range (`bytes=n-`) is cut to this many bytes, so a seek does not read the rest of the file.
    static let openRangeCap: Int64 = 8 << 20
    private static let chunk: Int64 = 1 << 20

    private let root: @MainActor () -> URL
    private let granted: @MainActor () -> [String]
    /// Tasks still being answered. Holding them keeps their ids unique until they end; `stop` removes one. Read and
    /// written on the main thread only.
    private var live: [ObjectIdentifier: WKURLSchemeTask] = [:]

    init(root: @escaping @MainActor () -> URL, granted: @escaping @MainActor () -> [String] = { MediaFiles.granted }) {
        self.root = root
        self.granted = granted
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
        live[ObjectIdentifier(task)] = task
        let (root, granted) = MainActor.assumeIsolated { (self.root(), self.granted()) }
        DispatchQueue.global(qos: .userInitiated).async {
            self.serve(url, method: request.httpMethod, range: request.value(forHTTPHeaderField: "Range"),
                       root: root, granted: granted, task: task)
        }
    }

    func webView(_ webView: WKWebView, stop urlSchemeTask: WKURLSchemeTask) {
        live[ObjectIdentifier(urlSchemeTask)] = nil
    }

    private func serve(_ url: URL, method: String?, range: String?, root: URL, granted: [String], task: WKURLSchemeTask) {
        guard method == "GET" else { return reply(task, url, 405, ["Allow": "GET"]) }
        if url.host == MediaFiles.host {
            guard let path = MediaFiles.path(from: url) else { return reply(task, url, 404) }
            switch MediaFiles.gate(path, granted: granted) {
            case .status(let status): return reply(task, url, status)
            case .file(let real, let type): return stream(URL(fileURLWithPath: real), type: type, url, range: range, task: task)
            }
        }
        let name = String(url.path.dropFirst())
        guard let type = Self.types[name], let project = ProjectStore.project(id: url.host ?? "", root: root) else {
            return reply(task, url, 404)
        }
        stream(project.folder.appendingPathComponent(name), type: type, url, range: range, task: task)
    }

    /// One file as the answer to `url`: all of it, or the one range asked for, in 1 MB pieces.
    private func stream(_ file: URL, type: String, _ url: URL, range: String?, task: WKURLSchemeTask) {
        guard let attributes = try? FileManager.default.attributesOfItem(atPath: file.path),
              let size = (attributes[.size] as? NSNumber)?.int64Value,
              let handle = try? FileHandle(forReadingFrom: file) else {
            return reply(task, url, 404)
        }
        defer { try? handle.close() }

        var start: Int64 = 0, end = size - 1, status = 200
        var headers = ["Content-Type": type, "Accept-Ranges": "bytes"]
        if type == "application/json" { headers["Cache-Control"] = "no-store" }
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

    /// Runs `body` on the main thread, and only while the task is still live there, so WebKit never gets a call after
    /// it stopped the task. The reading thread waits for it holding nothing, so the main thread is never kept from
    /// starting or stopping another task. `last` ends the task. Returns false when the task was stopped.
    @discardableResult
    private func deliver(_ task: WKURLSchemeTask, last: Bool = false, _ body: (WKURLSchemeTask) -> Void) -> Bool {
        DispatchQueue.main.sync {
            let key = ObjectIdentifier(task)
            guard live[key] != nil else { return false }
            body(task)
            if last { live[key] = nil }
            return true
        }
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
