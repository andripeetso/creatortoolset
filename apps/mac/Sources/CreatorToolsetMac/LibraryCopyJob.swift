// A copy of a Media Library in a folder on this Mac (Settings → Media Library → Copies; the server's
// api/library/copies.ts, its device job "copy"; the protocol is the COPY_KIND comment in contracts/devices.ts). The server
// hands this Mac one file at a time; it runs on a thread of its own (a big file takes a while) and the server wakes the
// long poll for the next. The claim's options: op ("check" | "copy"), copy, library, root, init ("1": write the marker),
// and for a copy key, asset, n, rel, prev, size, sha256, paths (JSON list) and url. Then, with the device token, on
// POST /api/devices/relay/job/copy/:id: { beat } every 30 s, then { done: { rel, size, sha256 }, free } | { gone, free }
// | { state: "reconnect" | "full", free }, or …/fail { error }.
// The folder: `.creatortoolset-copy.json` (which copy it is, each file copied), `.creatortoolset-copy.lock` (one writer
// at a time, a heartbeat), `.<name>.partial` while a file is written, `.versions/` for older versions. Nothing in it is
// ever deleted but this Mac's own .partial files; a person's own file at a clip's path stays, the clip goes beside it.
import CryptoKit
import Foundation

/// The device job kind this Mac lists for copies of a library.
let libraryCopyKind = "copy"

/// The file at the top of a copy's folder (contracts/library.ts CopyMarker).
struct CopyMarker: Codable, Equatable {
    struct File: Codable, Equatable {
        var asset: String
        var n: Int
        var rel: String
        var size: Int64
        var sha256: String
    }
    var library: String
    var copy: String
    var files: [String: File]

    static let name = ".creatortoolset-copy.json"
}

/// A reason this file can't be copied, in words for the person.
struct CopyRefused: Error { let why: String }
/// The disk the copy is on is full.
private struct CopyFull: Error {}
/// The relay stopped or the server took the job back: the .partial stays for the next try.
private struct CopyStopped: Error {}

struct LibraryCopyJob {
    let api: DeviceAPI
    let step: EditorJob
    var stopped: @Sendable () -> Bool = { false }
    /// the folders the person gave this app (MediaFiles.swift): a source path outside them is never read; the server's file is
    var granted: [String] = MediaFiles.granted
    var beatEvery: TimeInterval = 30

    static let lockName = ".creatortoolset-copy.lock"
    static let lockStale: TimeInterval = 120

    // MARK: the folder's layout (pure; LibraryCopyJobTests)

    /// A path inside the folder as the server sends it: relative, no `.`/`..`, no empty part.
    static func isRel(_ p: String) -> Bool {
        !p.isEmpty && p.count <= 1000 && !p.hasPrefix("/") && !p.contains("\0") && !p.contains("\\")
            && !p.split(separator: "/", omittingEmptySubsequences: false).contains { $0.isEmpty || $0 == "." || $0 == ".." }
    }

    /// `rel` when nothing is there, else "<stem> 2<ext>", " 3"… beside it.
    static func free(_ rel: String, taken: (String) -> Bool) -> String {
        guard taken(rel) else { return rel }
        let dir = (rel as NSString).deletingLastPathComponent
        let name = (rel as NSString).lastPathComponent
        let stem = (name as NSString).deletingPathExtension
        let ext = (name as NSString).pathExtension
        var k = 2
        while true {
            let n = "\(stem) \(k)\(ext.isEmpty ? "" : ".\(ext)")"
            let candidate = dir.isEmpty ? n : "\(dir)/\(n)"
            if !taken(candidate) { return candidate }
            k += 1
        }
    }

    /// Where the older version `n` at `prev` goes: `.versions/<dir>/<stem> v<n><ext>`.
    static func versionRel(_ prev: String, n: Int) -> String {
        let name = (prev as NSString).lastPathComponent
        let ext = (name as NSString).pathExtension
        return ".versions/\((prev as NSString).deletingLastPathComponent)/\((name as NSString).deletingPathExtension) v\(n)\(ext.isEmpty ? "" : ".\(ext)")"
            .replacingOccurrences(of: "//", with: "/")
    }

    /// The marker to work with, and whether it must be written; nil: the folder is not this copy's (reconnect).
    /// `present`: the folder is there; `found`: its marker read (nil: none, or unreadable when `unreadable`).
    static func decide(found: CopyMarker?, unreadable: Bool, present: Bool, library: String, copy: String, initial: Bool) -> (marker: CopyMarker, write: Bool)? {
        guard present else { return nil }   // a disk that is not mounted: never a folder made in its place
        if let found, found.library == library, found.copy == copy { return (found, false) }
        guard initial, !unreadable, found == nil || found?.library == library else { return nil }
        return (CopyMarker(library: library, copy: copy, files: found?.files ?? [:]), true)
    }

    // MARK: the folder on disk

    static func readMarker(_ root: URL) -> (marker: CopyMarker?, unreadable: Bool) {
        let file = root.appendingPathComponent(CopyMarker.name)
        guard FileManager.default.fileExists(atPath: file.path) else { return (nil, false) }
        let m = (try? Data(contentsOf: file)).flatMap { try? JSONDecoder().decode(CopyMarker.self, from: $0) }
        return (m, m == nil)
    }

    static func writeMarker(_ m: CopyMarker, _ root: URL) throws {
        let enc = JSONEncoder()
        enc.outputFormatting = [.sortedKeys, .prettyPrinted]
        try enc.encode(m).write(to: root.appendingPathComponent(CopyMarker.name), options: .atomic)
    }

    /// This process's mark in the lock file.
    static let me = "\(macHostName()) \(ProcessInfo.processInfo.processIdentifier)"

    /// Takes or refreshes the folder's lease; false while another writer's is fresh.
    static func lease(_ root: URL, now: Date = Date(), me: String = me) -> Bool {
        let file = root.appendingPathComponent(lockName)
        if let held = (try? Data(contentsOf: file)).flatMap({ try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }),
           let who = held["by"] as? String, who != me, let at = held["at"] as? Double, now.timeIntervalSince1970 - at < lockStale {
            return false
        }
        guard let data = try? JSONSerialization.data(withJSONObject: ["by": me, "at": now.timeIntervalSince1970]),
              (try? data.write(to: file, options: .atomic)) != nil else { return false }
        // ponytail: two writers that both found it stale in the same instant; the read-back settles most of it
        return ((try? JSONSerialization.jsonObject(with: Data(contentsOf: file))) as? [String: Any])?["by"] as? String == me
    }

    static func unlease(_ root: URL, me: String = me) {
        let file = root.appendingPathComponent(lockName)
        if ((try? JSONSerialization.jsonObject(with: Data(contentsOf: file))) as? [String: Any])?["by"] as? String == me {
            try? FileManager.default.removeItem(at: file)
        }
    }

    static func freeBytes(_ root: URL) -> Int64? {
        (try? root.resourceValues(forKeys: [.volumeAvailableCapacityKey]))?.volumeAvailableCapacity.map(Int64.init)
    }

    static func size(_ url: URL) -> Int64? {
        (try? FileManager.default.attributesOfItem(atPath: url.path))?[.size] as? Int64
    }

    static func isFull(_ error: Error) -> Bool {
        let ns = error as NSError
        if ns.domain == NSPOSIXErrorDomain, ns.code == Int(ENOSPC) || ns.code == Int(EDQUOT) { return true }
        if ns.domain == NSCocoaErrorDomain, ns.code == NSFileWriteOutOfSpaceError { return true }
        return (ns.userInfo[NSUnderlyingErrorKey] as? Error).map(isFull) ?? false
    }

    /// Deletes the `.<name>.partial` files left in the folder (never inside a hidden folder).
    static func sweep(_ root: URL) {
        guard let walk = FileManager.default.enumerator(at: root, includingPropertiesForKeys: [.isDirectoryKey], options: [.skipsPackageDescendants]) else { return }
        for case let url as URL in walk {
            let name = url.lastPathComponent
            guard name.hasPrefix(".") else { continue }
            if (try? url.resourceValues(forKeys: [.isDirectoryKey]))?.isDirectory == true { walk.skipDescendants() }
            else if name.hasSuffix(".partial") { try? FileManager.default.removeItem(at: url) }
        }
    }

    /// The marker's files no longer there at their size.
    static func gone(_ m: CopyMarker, root: URL) -> [String] {
        m.files.filter { size(root.appendingPathComponent($0.value.rel)) != $0.value.size }.map(\.key).sorted()
    }

    static func sha256(of url: URL) throws -> String {
        let h = try FileHandle(forReadingFrom: url)
        defer { try? h.close() }
        var hasher = SHA256()
        while let chunk = try h.read(upToCount: 4 << 20), !chunk.isEmpty { hasher.update(data: chunk) }
        return hex(hasher.finalize())
    }

    static func hex(_ d: SHA256.Digest) -> String { d.map { String(format: "%02x", $0) }.joined() }

    // MARK: the job

    func run() -> CardJob.End {
        let base = "/api/devices/relay/job/\(libraryCopyKind)/\(step.id)"
        let o = step.options
        func post(_ body: [String: Any]) -> CardJob.End {
            guard let reply = try? api.call("POST", base, body, tries: 4) else { return .failed("This Mac could not reach the server.") }
            return reply.status == 200 ? .done : reply.status == 404 || reply.status == 401 ? .gone : .failed("HTTP \(reply.status)")
        }
        func fail(_ why: String) -> CardJob.End {
            _ = try? api.call("POST", "\(base)/fail", ["error": String(why.prefix(500))], tries: 4)
            return .failed(why)
        }
        guard let library = o["library"], let copy = o["copy"], let path = o["root"], MediaFiles.isPlain(path), path != "/" else {
            return fail("The copy's folder is missing from the job.")
        }
        let root = URL(fileURLWithPath: path)
        func withFree(_ body: [String: Any]) -> [String: Any] {
            var b = body
            if let f = Self.freeBytes(root) { b["free"] = f }
            return b
        }
        var isDir: ObjCBool = false
        let present = FileManager.default.fileExists(atPath: root.path, isDirectory: &isDir) && isDir.boolValue
        let read = present ? Self.readMarker(root) : (marker: nil, unreadable: false)
        guard let decided = Self.decide(found: read.marker, unreadable: read.unreadable, present: present, library: library, copy: copy, initial: o["init"] == "1") else {
            return post(withFree(["state": "reconnect"]))
        }
        guard Self.lease(root) else { return fail("Another computer or app is writing to this folder now.") }
        defer { Self.unlease(root) }

        // a beat every 30 s keeps the job this Mac's (and the folder's lease fresh); a beat the server refuses stops it
        let lost = Flag()
        let beat = DispatchSource.makeTimerSource(queue: .global(qos: .utility))
        beat.schedule(deadline: .now() + beatEvery, repeating: beatEvery)
        beat.setEventHandler { [api] in
            _ = Self.lease(root)
            if let r = try? api.call("POST", base, ["beat": true], tries: 1, timeout: 20), r.status == 404 || r.status == 401 { lost.set() }
        }
        beat.resume()
        defer { beat.cancel() }
        let halt = { [stopped] in stopped() || lost.isSet }

        do {
            var marker = decided.marker
            if decided.write { try Self.writeMarker(marker, root) }
            if o["op"] == "check" {
                Self.sweep(root)
                return post(withFree(["gone": Self.gone(marker, root: root)]))
            }
            let done = try copyOne(root: root, marker: &marker, halt: halt)
            return post(withFree(["done": done]))
        } catch is CopyStopped {
            return .gone
        } catch let e as CopyRefused {
            return fail(e.why)
        } catch {
            if error is CopyFull || Self.isFull(error) { return post(withFree(["state": "full"])) }
            return fail("The file could not be written to the copy: \(error.localizedDescription)")
        }
    }

    /// One file into the folder: the `done` the server takes.
    func copyOne(root: URL, marker: inout CopyMarker, halt: @escaping () -> Bool) throws -> [String: Any] {
        let o = step.options
        guard let key = o["key"], let asset = o["asset"], let n = Int(o["n"] ?? ""), let rel = o["rel"], Self.isRel(rel),
              let size = Int64(o["size"] ?? ""), o["prev"].map(Self.isRel) ?? true else {
            throw CopyRefused(why: "The server sent a file this Mac won't write: \(o["rel"] ?? "no path").")
        }
        let sha = o["sha256"].map { $0.lowercased() }.flatMap { $0.isEmpty ? nil : $0 }
        let at = { (r: String) in root.appendingPathComponent(r) }
        let exists = { (r: String) in FileManager.default.fileExists(atPath: at(r).path) }
        func record(_ r: String, _ hash: String) throws -> [String: Any] {
            marker.files[key] = .init(asset: asset, n: n, rel: r, size: size, sha256: hash)
            try Self.writeMarker(marker, root)
            return ["rel": r, "size": size, "sha256": hash]
        }

        // copied before, and the server never heard it
        if let had = marker.files[key], Self.size(at(had.rel)) == size, sha == nil || had.sha256 == sha {
            return ["rel": had.rel, "size": size, "sha256": had.sha256]
        }
        // the clip's older version moves into .versions/ before the new one takes its path
        if let prev = o["prev"], exists(prev),
           let old = marker.files.first(where: { $0.key != key && $0.value.rel == prev && $0.value.asset == asset }) {
            let dest = Self.free(Self.versionRel(prev, n: old.value.n), taken: exists)
            try FileManager.default.createDirectory(at: at(dest).deletingLastPathComponent(), withIntermediateDirectories: true)
            try FileManager.default.moveItem(at: at(prev), to: at(dest))
            marker.files[old.key]?.rel = dest
            try Self.writeMarker(marker, root)
        }
        // a file at the path already: this very file counts as copied; anything else stays and the clip goes beside it
        if exists(rel), Self.size(at(rel)) == size {
            let hash = try Self.sha256(of: at(rel))
            if sha == nil || hash == sha { return try record(rel, hash) }
        }
        let target = Self.free(rel, taken: exists)
        let dir = at(target).deletingLastPathComponent()
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let partial = dir.appendingPathComponent(".\(at(target).lastPathComponent).partial")
        if let free = Self.freeBytes(root), free < size - (Self.size(partial) ?? 0) { throw CopyFull() }

        let got = try fetch(into: partial, size: size, halt: halt)
        guard got.size == size, sha == nil || got.sha == sha else {
            try? FileManager.default.removeItem(at: partial)
            throw CopyRefused(why: "The copied file is not the same as the original (\(got.size == size ? "checksum" : "size")): it is copied again later.")
        }
        // something may have taken the name meanwhile: never over it
        let final = exists(target) ? Self.free(target, taken: exists) : target
        try FileManager.default.moveItem(at: partial, to: at(final))
        return try record(final, got.sha)
    }

    /// Writes the file to `partial` from the first readable path of the right size, else the server's file (resumed
    /// from a .partial already there). Synced; its size and SHA-256.
    func fetch(into partial: URL, size: Int64, halt: @escaping () -> Bool) throws -> (size: Int64, sha: String) {
        let paths = (o("paths").data(using: .utf8).flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String] }) ?? []
        let local = paths.lazy.compactMap { p -> URL? in
            guard case .file(let real, _) = MediaFiles.gate(p, granted: granted), Self.size(URL(fileURLWithPath: real)) == size else { return nil }
            return URL(fileURLWithPath: real)
        }.first
        guard local != nil || step.options["url"] != nil else {
            throw CopyRefused(why: "This Mac can't read the file: it is in none of the folders this app was given, and the server has no copy of it.")
        }
        let resume = local == nil && (Self.size(partial) ?? .max) <= size
        if !resume { try Data().write(to: partial) }
        let sink = try Sink(partial)
        defer { try? sink.handle.close() }
        if resume { try sink.hashExisting() }

        if let local {
            let h = try FileHandle(forReadingFrom: local)
            defer { try? h.close() }
            while let chunk = try h.read(upToCount: 4 << 20), !chunk.isEmpty {
                if halt() { throw CopyStopped() }
                try sink.write(chunk)
            }
        } else if sink.count < size {   // a .partial already whole asks for nothing more
            try download(o("url"), from: sink.count, into: sink, halt: halt)
        }
        try sink.handle.synchronize()
        return (sink.count, Self.hex(sink.hasher.finalize()))
    }

    private func o(_ k: String) -> String { step.options[k] ?? "" }

    /// GET `path` on the server with the device token, from byte `offset` on (Range), streamed into `sink`.
    private func download(_ path: String, from offset: Int64, into sink: Sink, halt: @escaping () -> Bool) throws {
        var request = URLRequest(url: URL(string: path, relativeTo: api.base) ?? api.base)
        request.timeoutInterval = 120   // between bytes, not for the whole file
        request.setValue("Bearer \(api.token)", forHTTPHeaderField: "Authorization")
        request.setValue("CreatorToolsetMac/\(appVersion)", forHTTPHeaderField: "User-Agent")
        if offset > 0 { request.setValue("bytes=\(offset)-", forHTTPHeaderField: "Range") }
        let stream = Stream(sink: sink, offset: offset, halt: halt, host: api.base.host)
        let session = URLSession(configuration: .ephemeral, delegate: stream, delegateQueue: nil)
        session.dataTask(with: request).resume()
        stream.done.wait()
        session.finishTasksAndInvalidate()
        if let error = stream.error { throw error }
        guard stream.status == 200 || stream.status == 206 else {
            throw CopyRefused(why: "The server did not send the file (HTTP \(stream.status)).")
        }
    }
}

/// The .partial being written, and its hash so far.
private final class Sink {
    let handle: FileHandle
    let url: URL
    var hasher = SHA256()
    var count: Int64 = 0

    init(_ url: URL) throws {
        self.url = url
        handle = try FileHandle(forUpdating: url)
    }

    /// The bytes a .partial already holds go into the hash; writing goes on at its end.
    func hashExisting() throws {
        while let chunk = try handle.read(upToCount: 4 << 20), !chunk.isEmpty {
            hasher.update(data: chunk)
            count += Int64(chunk.count)
        }
    }

    func write(_ data: Data) throws {
        try handle.write(contentsOf: data)
        hasher.update(data: data)
        count += Int64(data.count)
    }

    func reset() throws {
        try handle.truncate(atOffset: 0)
        hasher = SHA256()
        count = 0
    }
}

private final class Flag: @unchecked Sendable {
    private let lock = NSLock()
    private var value = false
    func set() { lock.lock(); value = true; lock.unlock() }
    var isSet: Bool { lock.lock(); defer { lock.unlock() }; return value }
}

/// The server's file, streamed into the sink as it arrives.
private final class Stream: NSObject, URLSessionDataDelegate, @unchecked Sendable {
    let sink: Sink
    let offset: Int64
    let halt: () -> Bool
    let host: String?
    let done = DispatchSemaphore(value: 0)
    var status = 0
    var error: Error?

    init(sink: Sink, offset: Int64, halt: @escaping () -> Bool, host: String?) {
        self.sink = sink
        self.offset = offset
        self.halt = halt
        self.host = host
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        // the token is for the server only: a stored file served from elsewhere gets no Authorization
        var next = request
        if request.url?.host != host { next.setValue(nil, forHTTPHeaderField: "Authorization") }
        completionHandler(next)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
                    completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        status = (response as? HTTPURLResponse)?.statusCode ?? 0
        // a server that ignores the Range sends the whole file: start the .partial over
        if status == 200, offset > 0 {
            do { try sink.reset() } catch { self.error = error }
        }
        completionHandler((status == 200 || status == 206) && error == nil ? .allow : .cancel)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        guard error == nil else { return }
        do {
            if halt() { throw CopyStopped() }
            try sink.write(data)
        } catch {
            self.error = error
            dataTask.cancel()
        }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        if self.error == nil, let error, status == 200 || status == 206 { self.error = error }
        done.signal()
    }
}
