// A copy of a Media Library in a folder on this Mac (Settings → Media Library → Copies; the server's
// api/library/copies.ts, its device job "copy"). The protocol and the folder's format are the COPY_KIND comment in
// contracts/devices.ts, the same on the Linux helper (helper.py): keep the two alike. The server hands this Mac one file
// at a time; it runs on a thread of its own (a big file takes a while) and the server wakes the long poll for the next.
// The claim's options: op ("check" | "copy" | "send"), device (this computer's id), copy, library, root, init ("1": write
// the marker), and for a copy key, asset, n, rel, prev, size, sha256, paths (JSON list) and url; a send has key, size,
// paths and url. Then, with the device token, on POST /api/devices/relay/job/copy/:id: { beat } every 30 s, then
// { done: { rel, size, sha256 }, free } | { gone, free } | { state: "reconnect" | "full", free }, or …/fail { error };
// a send posts the original's bytes to …/file.
// The folder: `.creatortoolset-copy.json` (which copy it is, each file copied), `.creatortoolset-copy.lock` (one writer
// at a time: { device, at }, stale by its time on the share), `.<name>.<device>.partial` while a file is written,
// `.versions/` for older versions. Nothing in it is ever deleted but this computer's own partials; a person's own file at
// a clip's path stays, the clip goes beside it.
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
/// The relay stopped, the server took the job back or another computer took the folder: the partial stays for the next try.
private struct CopyStopped: Error {}
/// The folder is not the one the job opened any more (its disk went away, or its marker did).
private struct CopyReconnect: Error {}

struct LibraryCopyJob {
    let api: DeviceAPI
    let step: EditorJob
    var stopped: @Sendable () -> Bool = { false }
    /// the folders the person gave this app (MediaFiles.swift): a source path outside them is never read; the server's file is
    var granted: [String] = []
    var beatEvery: TimeInterval = 30

    static let lockName = ".creatortoolset-copy.lock"
    /// a lock whose file on the share is this old is free to take
    static let lockStale: TimeInterval = 600

    // MARK: the folder's layout (pure; LibraryCopyJobTests)

    /// A path inside the folder as the server sends it: relative, no `.`/`..`, no empty part.
    static func isRel(_ p: String) -> Bool {
        !p.isEmpty && p.count <= 1000 && !p.hasPrefix("/") && !p.contains("\0") && !p.contains("\\")
            && !p.split(separator: "/", omittingEmptySubsequences: false).contains { $0.isEmpty || $0 == "." || $0 == ".." }
    }

    /// The server's path as written in the folder: in NFC, a "\" as "_".
    static func clean(_ p: String) -> String {
        p.replacingOccurrences(of: "\\", with: "_").precomposedStringWithCanonicalMapping
    }

    /// `rel` when nothing is there, else "<stem> 2<ext>", " 3"… beside it; the stem trimmed so its partial's name
    /// (`.<name>.<device>.partial`) fits 255 bytes.
    static func free(_ rel: String, device: String, taken: (String) -> Bool) -> String {
        let dir = (rel as NSString).deletingLastPathComponent
        let name = (rel as NSString).lastPathComponent
        let ext = (name as NSString).pathExtension
        let room = 255 - ".\(device).partial".utf8.count - 1
        var k = 1
        while true {
            let tail = (k == 1 ? "" : " \(k)") + (ext.isEmpty ? "" : ".\(ext)")
            var stem = (name as NSString).deletingPathExtension
            while !stem.isEmpty, stem.utf8.count + tail.utf8.count > room { stem.removeLast() }
            let candidate = dir.isEmpty ? stem + tail : "\(dir)/\(stem)\(tail)"
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

    /// This job's files into the marker on disk, read again first (another computer may have written it since).
    static func update(_ root: URL, library: String, copy: String, _ files: [String: CopyMarker.File]) throws {
        guard var m = readMarker(root).marker, m.library == library, m.copy == copy else { throw CopyReconnect() }
        m.files.merge(files) { $1 }
        try writeMarker(m, root)
    }

    /// The lock's device ("" for a lock that is not { device, at }: another writer's) and its time on the share; nil: none.
    static func lock(_ root: URL) -> (device: String, mtime: Date)? {
        let file = root.appendingPathComponent(lockName)
        guard let mtime = (try? FileManager.default.attributesOfItem(atPath: file.path))?[.modificationDate] as? Date else { return nil }
        let held = (try? Data(contentsOf: file)).flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
        return (held?["device"] as? String ?? "", mtime)
    }

    /// Writes the lock as ours (temp file renamed over it) and reads it back: true when it is ours.
    private static func writeLock(_ root: URL, device: String, now: Date) -> Bool {
        let file = root.appendingPathComponent(lockName)
        let temp = root.appendingPathComponent("\(lockName).\(device).tmp")
        guard let data = try? JSONSerialization.data(withJSONObject: ["device": device, "at": Int(now.timeIntervalSince1970)]),
              (try? data.write(to: temp)) != nil, rename(temp.path, file.path) == 0 else {
            try? FileManager.default.removeItem(at: temp)
            return false
        }
        return lock(root)?.device == device
    }

    /// Takes the folder's lease; false while another writer's lock is fresh (its file on the share under 10 min old).
    static func lease(_ root: URL, device: String, now: Date = Date()) -> Bool {
        if let held = lock(root), held.device != device, now.timeIntervalSince(held.mtime) < lockStale { return false }
        return writeLock(root, device: device, now: now)
    }

    /// A beat's look at the lease: rewritten when still ours; false when it is not (the job stops).
    static func beat(_ root: URL, device: String) -> Bool {
        lock(root)?.device == device && writeLock(root, device: device, now: Date())
    }

    static func unlease(_ root: URL, device: String) {
        if lock(root)?.device == device { try? FileManager.default.removeItem(at: root.appendingPathComponent(lockName)) }
    }

    static func freeBytes(_ root: URL) -> Int64? {
        (try? root.resourceValues(forKeys: [.volumeAvailableCapacityKey]))?.volumeAvailableCapacity.map(Int64.init)
    }

    static func size(_ url: URL) -> Int64? {
        (try? FileManager.default.attributesOfItem(atPath: url.path))?[.size] as? Int64
    }

    /// The disk a path is on; nil when it is not there.
    static func disk(_ path: String) -> dev_t? {
        var s = stat()
        return stat(path, &s) == 0 ? s.st_dev : nil
    }

    /// The same file on disk (device and inode).
    static func sameFile(_ a: String, _ b: String) -> Bool {
        var x = stat(), y = stat()
        return stat(a, &x) == 0 && stat(b, &y) == 0 && x.st_dev == y.st_dev && x.st_ino == y.st_ino
    }

    /// The file at `rel` in the folder, its name compared in NFC (Swift compares strings by canonical equivalence, so an
    /// NFD name on a share equals its NFC form); nil when there is none.
    static func onDisk(_ rel: String, root: URL) -> URL? {
        let url = root.appendingPathComponent(rel)
        if FileManager.default.fileExists(atPath: url.path) { return url }
        let dir = url.deletingLastPathComponent(), name = url.lastPathComponent
        // ponytail: lists the folder for each name not found as is; a cached listing if folders get huge
        return (try? FileManager.default.contentsOfDirectory(atPath: dir.path))?.first { $0 == name }.map { dir.appendingPathComponent($0) }
    }

    /// The folders of `dir` inside the folder, one at a time: never the folder itself (an unmounted disk's path stays empty).
    static func makeDirs(_ dir: String, in root: URL) throws {
        var url = root
        for part in dir.split(separator: "/") {
            url.appendPathComponent(String(part))
            do { try FileManager.default.createDirectory(at: url, withIntermediateDirectories: false) } catch CocoaError.fileWriteFileExists {}
        }
    }

    static func isFull(_ error: Error) -> Bool {
        let ns = error as NSError
        if ns.domain == NSPOSIXErrorDomain, ns.code == Int(ENOSPC) || ns.code == Int(EDQUOT) { return true }
        if ns.domain == NSCocoaErrorDomain, ns.code == NSFileWriteOutOfSpaceError { return true }
        return (ns.userInfo[NSUnderlyingErrorKey] as? Error).map(isFull) ?? false
    }

    /// Deletes this computer's `.<name>.<device>.partial` files in the folder (never inside a hidden folder), but `keep`;
    /// another computer's partial is never touched.
    static func sweep(_ root: URL, device: String, keep: URL? = nil) {
        guard let walk = FileManager.default.enumerator(at: root, includingPropertiesForKeys: [.isDirectoryKey], options: [.skipsPackageDescendants]) else { return }
        let kept = keep?.resolvingSymlinksInPath().path
        for case let url as URL in walk {
            let name = url.lastPathComponent
            guard name.hasPrefix(".") else { continue }
            if (try? url.resourceValues(forKeys: [.isDirectoryKey]))?.isDirectory == true { walk.skipDescendants() }
            else if name.hasSuffix(".\(device).partial"), url.resolvingSymlinksInPath().path != kept { try? FileManager.default.removeItem(at: url) }
        }
    }

    /// The marker's files no longer there at their size.
    static func gone(_ m: CopyMarker, root: URL) -> [String] {
        m.files.filter { onDisk($0.value.rel, root: root).flatMap(size) != $0.value.size }.map(\.key).sorted()
    }

    static func sha256(of url: URL) throws -> String {
        let h = try FileHandle(forReadingFrom: url)
        defer { try? h.close() }
        var hasher = SHA256()
        while let chunk = try h.read(upToCount: 4 << 20), !chunk.isEmpty { hasher.update(data: chunk) }
        return hex(hasher.finalize())
    }

    static func hex(_ d: SHA256.Digest) -> String { d.map { String(format: "%02x", $0) }.joined() }

    static func list(_ json: String?) -> [String] {
        (json?.data(using: .utf8).flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String] }) ?? []
    }

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
        if o["op"] == "send" { return send(base, fail: fail) }
        guard let device = o["device"], !device.isEmpty, !device.contains("/") else {
            return fail("The server is older than this app: update it to keep copies on this Mac.")
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
        guard let decided = Self.decide(found: read.marker, unreadable: read.unreadable, present: present, library: library, copy: copy, initial: o["init"] == "1"),
              let opened = Self.disk(root.path) else {
            return post(withFree(["state": "reconnect"]))
        }
        guard Self.lease(root, device: device) else { return fail("Another computer or app is writing to this folder now.") }
        defer { Self.unlease(root, device: device) }

        // a beat every 30 s keeps the job this Mac's and the folder's lease fresh; a lease that is someone else's now, or a
        // beat the server refuses, stops it
        let lost = Flag()
        let beat = beating(base, lost: lost) { Self.beat(root, device: device) }
        defer { beat.cancel() }
        let halt = { [stopped] in stopped() || lost.isSet }
        // the folder is still the one this job opened: the same disk, its marker there
        let intact: () throws -> Void = {
            guard Self.disk(root.path) == opened, FileManager.default.fileExists(atPath: root.appendingPathComponent(CopyMarker.name).path) else { throw CopyReconnect() }
        }

        do {
            if decided.write { try Self.writeMarker(decided.marker, root) }
            if o["op"] == "check" {
                Self.sweep(root, device: device)
                let gone = Self.gone(decided.marker, root: root)
                if halt() { throw CopyStopped() }
                return post(withFree(["gone": gone]))
            }
            let done = try copyOne(root: root, marker: decided.marker, device: device, intact: intact, halt: halt)
            if halt() { throw CopyStopped() }
            return post(withFree(["done": done]))
        } catch is CopyStopped {
            return .gone
        } catch is CopyReconnect {
            return post(withFree(["state": "reconnect"]))
        } catch let e as CopyRefused {
            return fail(e.why)
        } catch {
            if error is CopyFull || Self.isFull(error) { return post(withFree(["state": "full"])) }
            return fail("The file could not be written to the copy: \(error.localizedDescription)")
        }
    }

    /// The beat timer: `keep` false (the lease is not ours) or a beat the server refuses sets `lost`.
    private func beating(_ base: String, lost: Flag, keep: @escaping () -> Bool) -> DispatchSourceTimer {
        let beat = DispatchSource.makeTimerSource(queue: .global(qos: .utility))
        beat.schedule(deadline: .now() + beatEvery, repeating: beatEvery)
        beat.setEventHandler { [api] in
            guard keep() else { return lost.set() }
            if let r = try? api.call("POST", base, ["beat": true], tries: 1, timeout: 20), r.status == 404 || r.status == 401 { lost.set() }
        }
        beat.resume()
        return beat
    }

    /// One file into the folder: the `done` the server takes.
    func copyOne(root: URL, marker: CopyMarker, device: String, intact: () throws -> Void, halt: @escaping () -> Bool) throws -> [String: Any] {
        let o = step.options
        let rel = Self.clean(o["rel"] ?? ""), prev = o["prev"].map(Self.clean)
        guard let key = o["key"], let asset = o["asset"], let n = Int(o["n"] ?? ""), Self.isRel(rel),
              let size = Int64(o["size"] ?? ""), prev.map(Self.isRel) ?? true else {
            throw CopyRefused(why: "The server sent a file this Mac won't write: \(o["rel"] ?? "no path").")
        }
        let sha = o["sha256"].map { $0.lowercased() }.flatMap { $0.isEmpty ? nil : $0 }
        let paths = Self.list(o["paths"])
        let at = { (r: String) in root.appendingPathComponent(r) }
        let onDisk = { (r: String) in Self.onDisk(r, root: root) }
        let exists = { (r: String) in onDisk(r) != nil }
        let partialOf = { (r: String) in at(r).deletingLastPathComponent().appendingPathComponent(".\(at(r).lastPathComponent).\(device).partial") }
        // this computer's partials an earlier job left go; the one this job resumes stays
        Self.sweep(root, device: device, keep: partialOf(Self.free(rel, device: device, taken: exists)))

        func record(_ r: String, _ hash: String) throws -> [String: Any] {
            try Self.update(root, library: marker.library, copy: marker.copy, [key: .init(asset: asset, n: n, rel: r, size: size, sha256: hash)])
            return ["rel": r, "size": size, "sha256": hash]
        }
        /// A file already in the folder is this one only by its hash, or when it is the very file the job reads from.
        func this(_ file: URL, hash expected: String?) throws -> String? {
            guard Self.size(file) == size else { return nil }
            if let expected { let h = try Self.sha256(of: file); return h == expected ? h : nil }
            return paths.contains { Self.sameFile(file.path, $0) } ? try Self.sha256(of: file) : nil
        }

        // copied before, and the server never heard it: the file there is still what this Mac wrote
        if let had = marker.files[key], let file = onDisk(had.rel), let hash = try this(file, hash: sha ?? had.sha256) {
            return ["rel": had.rel, "size": size, "sha256": hash]
        }
        try intact()
        // the clip's older version moves into .versions/ before the new one takes its path
        if let prev, let from = onDisk(prev), var old = marker.files.first(where: { $0.key != key && $0.value.rel == prev && $0.value.asset == asset }) {
            let dest = Self.free(Self.versionRel(prev, n: old.value.n), device: device, taken: exists)
            try Self.makeDirs((dest as NSString).deletingLastPathComponent, in: root)
            try FileManager.default.moveItem(at: from, to: at(dest))
            old.value.rel = dest
            try Self.update(root, library: marker.library, copy: marker.copy, [old.key: old.value])
        }
        // a file at the path already: this very file counts as copied; anything else stays and the clip goes beside it
        if let file = onDisk(rel), let hash = try this(file, hash: sha) { return try record(rel, hash) }
        let target = Self.free(rel, device: device, taken: exists)
        try intact()
        try Self.makeDirs((target as NSString).deletingLastPathComponent, in: root)
        let partial = partialOf(target)
        if let free = Self.freeBytes(root), free < size - (Self.size(partial) ?? 0) { throw CopyFull() }

        let got = try fetch(into: partial, size: size, paths: paths, halt: halt)
        try intact()
        if halt() { throw CopyStopped() }
        // the file on disk, not the bytes counted on the way, is what gets checked
        let disk = Self.size(partial) == size ? try Self.sha256(of: partial) : nil
        guard got.size == size, let disk, disk == got.sha, sha == nil || disk == sha else {
            try? FileManager.default.removeItem(at: partial)
            throw CopyRefused(why: "The copied file is not the same as the original (\(got.size == size ? "checksum" : "size")): it is copied again later.")
        }
        // something may have taken the name meanwhile: never over it
        let final = exists(target) ? Self.free(target, device: device, taken: exists) : target
        try FileManager.default.moveItem(at: partial, to: at(final))
        return try record(final, disk)
    }

    /// The first of `paths` this app may read that has `size` bytes.
    private func source(_ paths: [String], size: Int64) -> URL? {
        paths.lazy.compactMap { [granted] p -> URL? in
            guard case .file(let real, _) = MediaFiles.gate(p, granted: granted), Self.size(URL(fileURLWithPath: real)) == size else { return nil }
            return URL(fileURLWithPath: real)
        }.first
    }

    /// Writes the file to `partial` from the first readable path of the right size, else the server's file (resumed
    /// from a partial already there). Synced; its size and SHA-256.
    func fetch(into partial: URL, size: Int64, paths: [String], halt: @escaping () -> Bool) throws -> (size: Int64, sha: String) {
        let local = source(paths, size: size)
        guard local != nil || step.options["url"] != nil else {
            throw CopyRefused(why: "This Mac can't read the file: it is in none of the folders this app was given, and the server has no copy of it.")
        }
        // App Nap and timer throttling stay off while a file copies, not longer
        let activity = ProcessInfo.processInfo.beginActivity(options: .userInitiatedAllowingIdleSystemSleep, reason: "Copying a file into a copy of the Media Library")
        defer { ProcessInfo.processInfo.endActivity(activity) }
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
        } else {
            // a connection that dropped (the Mac slept, the network changed) is opened again from where it stopped
            var tries = 0
            while sink.count < size {   // a partial already whole asks for nothing more
                do {
                    try download(o("url"), from: sink.count, into: sink, halt: halt)
                    break
                } catch let e as URLError where tries < 2 && e.code != .cancelled {
                    tries += 1
                    Thread.sleep(forTimeInterval: 5)
                }
            }
        }
        try sink.handle.synchronize()
        return (sink.count, Self.hex(sink.hasher.finalize()))
    }

    private func o(_ k: String) -> String { step.options[k] ?? "" }

    /// op "send": this Mac holds the original another computer's copy needs. Its bytes, streamed from disk, go to the
    /// server, which hashes them (409: not the original).
    private func send(_ base: String, fail: (String) -> CardJob.End) -> CardJob.End {
        guard let size = Int64(o("size")), !o("url").isEmpty else { return fail("The server sent a file this Mac can't send.") }
        guard let file = source(Self.list(step.options["paths"]), size: size) else { return fail("The original is not on this Mac any more") }
        let beat = beating(base, lost: Flag()) { true }
        defer { beat.cancel() }
        let activity = ProcessInfo.processInfo.beginActivity(options: .userInitiatedAllowingIdleSystemSleep, reason: "Sending a file for a copy of the Media Library")
        defer { ProcessInfo.processInfo.endActivity(activity) }
        guard let reply = try? api.uploadFile(o("url"), file: file, type: "application/octet-stream") else {
            return .failed("This Mac could not reach the server.")
        }
        switch reply.status {
        case 200: return .done
        case 401, 404: return .gone
        case 409: return .failed("The file on this Mac is not the original: its checksum differs.")
        default: return .failed("HTTP \(reply.status)")
        }
    }

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

/// The partial being written, and its hash so far.
private final class Sink {
    let handle: FileHandle
    let url: URL
    var hasher = SHA256()
    var count: Int64 = 0

    init(_ url: URL) throws {
        self.url = url
        handle = try FileHandle(forUpdating: url)
    }

    /// The bytes a partial already holds go into the hash; writing goes on at its end.
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

    /// Empty again; truncate(atOffset:) also puts the file pointer at 0 (checked by LibraryCopyJobTests).
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
        // a server that ignores the Range sends the whole file: start the partial over
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
        // a network error before any answer (status 0) too: the caller opens the connection again
        if self.error == nil, let error, status == 0 || status == 200 || status == 206 { self.error = error }
        done.signal()
    }
}
