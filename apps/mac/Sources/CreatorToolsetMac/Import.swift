import CryptoKit
import Foundation

// The Media Library's imports on this Mac, for a server here or elsewhere (the page's `import:` asks on the thisMac
// handler, TitleBar.swift; src/lib/thisMac.ts):
// - import:copy:{"id","files":[{"from","to"}]} copies dropped or picked files into the library's folder on this Mac and
//   answers when it is done with { copied:[{from,to}], failed:[{from,error}], stopped? }. `from` must lie under a recent
//   drop or pick of this window; `to` under ~/Movies/Creator Toolset or a folder chosen in this app's folder picker.
//   A file is never overwritten: the same name and size there is taken as copied already, another file gets " 2", " 3"…
//   A cancelled or failed copy removes its partial file. The destination joins the folders whose media the page may
//   play and scan (MediaFiles).
// - import:progress:<id> → { bytes, of, file? }, import:cancel:<id> → { ok }.
// - import:scan:{"path"} → { files:[{path,size,mtime}] }: the media files under a granted folder (MediaFiles), for
//   Look for new files. Hidden entries, packages and links are skipped; at most 20 000.
// - import:print:{"paths":[…]} → { prints:{ path: hex } }: each granted file's quick fingerprint, the same as the page's
//   quickPrint (src/lib/onMac.ts), which the server's duplicate check compares.
// - import:locate:{"folder"?,"files":[…]} → Locate… in the Media Library (Locate.swift).

func isImportAsk(_ ask: String) -> Bool { ask.hasPrefix("import:") }

struct ImportPair: Equatable {
    let from: String
    let to: String
}

enum ImportAsk: Equatable {
    case copy(id: String, files: [ImportPair])
    case progress(String)
    case cancel(String)
    case scan(String)
    case print([String])
    case locate(folder: String?, files: [LocateFile])
}

/// An `import:` ask as its parts; nil when it is malformed.
func importAsk(_ ask: String) -> ImportAsk? {
    guard isImportAsk(ask) else { return nil }
    let rest = ask.dropFirst("import:".count)
    let isID = { (s: Substring) in !s.isEmpty && s.count <= 100 && s.allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-" || $0 == "_") } }
    for (verb, make) in [("progress:", ImportAsk.progress), ("cancel:", ImportAsk.cancel)] where rest.hasPrefix(verb) {
        let id = rest.dropFirst(verb.count)
        return isID(id) ? make(String(id)) : nil
    }
    guard let colon = rest.firstIndex(of: ":"),
          let json = (try? JSONSerialization.jsonObject(with: Data(rest[rest.index(after: colon)...].utf8))) as? [String: Any] else { return nil }
    switch rest[..<colon] {
    case "copy":
        guard let id = json["id"] as? String, isID(Substring(id)), let list = json["files"] as? [[String: Any]] else { return nil }
        let files = list.compactMap { f in (f["from"] as? String).flatMap { from in (f["to"] as? String).map { ImportPair(from: from, to: ($0 as NSString).expandingTildeInPath) } } }
        return files.count == list.count ? .copy(id: id, files: files) : nil
    case "scan": return (json["path"] as? String).map(ImportAsk.scan)
    case "print": return (json["paths"] as? [String]).map { ImportAsk.print(Array($0.prefix(5000))) }
    case "locate":
        guard let list = json["files"] as? [[String: Any]] else { return nil }
        let files = list.compactMap { f in
            (f["id"] as? String).flatMap { id in (f["path"] as? String).flatMap { path in (f["bytes"] as? NSNumber).map { LocateFile(id: id, path: path, bytes: $0.int64Value) } } }
        }
        return files.count == list.count ? .locate(folder: json["folder"] as? String, files: files) : nil
    default: return nil
    }
}

final class Imports: @unchecked Sendable {
    static let shared = Imports()
    static let maxScan = 20_000
    private static let chosenKey = "importFolders"

    /// The library's default folder on this Mac: every copy destination under it is allowed.
    static var home = FileManager.default.homeDirectoryForCurrentUser
    static var defaultRoot: String { home.appendingPathComponent("Movies/Creator Toolset").path }
    /// The folders a copy may write into: the default and each one chosen in this app's folder picker.
    static var destinations: [String] { [defaultRoot] + (UserDefaults.standard.stringArray(forKey: chosenKey) ?? []) }
    static func chose(_ folder: String) {
        let old = UserDefaults.standard.stringArray(forKey: chosenKey) ?? []
        if !old.contains(folder) { UserDefaults.standard.set(old + [folder], forKey: chosenKey) }
    }

    private struct Job {
        var bytes: Int64 = 0
        var of: Int64 = 0
        var file: String?
        var cancelled = false
    }

    private let lock = NSLock()
    private var jobs: [String: Job] = [:]

    private func with<T>(_ id: String, _ change: (inout Job) -> T) -> T? {
        lock.lock()
        defer { lock.unlock() }
        guard var job = jobs[id] else { return nil }
        let out = change(&job)
        jobs[id] = job
        return out
    }

    /// One ask answered: `sources` are this window's recent drops and picks. A copy, a scan and prints run off the
    /// main thread, and `done` is called on the main thread.
    func answer(_ ask: String, sources: [String], done: @escaping ([String: Any]) -> Void) {
        let main = { (reply: [String: Any]) in DispatchQueue.main.async { done(reply) } }
        switch importAsk(ask) {
        case .copy(let id, let files)?:
            lock.lock()
            let taken = jobs[id] != nil
            if !taken { jobs[id] = Job() }
            lock.unlock()
            if taken { return done(["error": "That copy is running already."]) }
            DispatchQueue.global(qos: .userInitiated).async { main(self.copy(id: id, files, sources: sources, destinations: Self.destinations)) }
        case .progress(let id)?:
            done(with(id) { j in ["bytes": j.bytes, "of": j.of, "file": j.file ?? NSNull()] as [String: Any] } ?? ["bytes": 0, "of": 0])
        case .cancel(let id)?:
            _ = with(id) { $0.cancelled = true }
            done(["ok": true])
        case .scan(let path)?:
            DispatchQueue.global(qos: .userInitiated).async { main(Self.scan(path, granted: MediaFiles.granted)) }
        case .print(let paths)?:
            DispatchQueue.global(qos: .userInitiated).async {
                let granted = MediaFiles.granted
                var prints: [String: String] = [:]
                for p in paths where Self.inside(p, granted) != nil { prints[p] = Self.quickPrint(p) }
                main(["prints": prints])
            }
        case .locate(let folder, let files)?:
            DispatchQueue.global(qos: .userInitiated).async { main(Locate.answer(folder: folder, files: files, allowed: MediaFiles.granted + Self.destinations)) }
        case nil: done(["error": "Not an import this app knows."])
        }
    }

    /// Copies `files` (see the top of this file), keeping the job's progress; the reply when it ends. Each destination
    /// folder written into is granted (`grant`) for playing and scanning.
    func copy(id: String, _ files: [ImportPair], sources: [String], destinations: [String], grant: (String) -> Void = MediaFiles.add) -> [String: Any] {
        defer { lock.lock(); jobs[id] = nil; lock.unlock() }
        let size = { (p: String) in ((try? FileManager.default.attributesOfItem(atPath: p))?[.size] as? NSNumber)?.int64Value }
        _ = with(id) { $0.of = files.compactMap { size($0.from) }.reduce(0, +) }
        var copied: [[String: String]] = []
        var failed: [[String: String]] = []
        var stopped = false
        for f in files {
            if with(id, { $0.cancelled }) == true { stopped = true; break }
            guard Self.inside(f.from, sources) != nil, let bytes = size(f.from) else {
                failed.append(["from": f.from, "error": "Not a file from a drop or a pick in this window."]); continue
            }
            guard let root = Self.destination(f.to, destinations) else {
                failed.append(["from": f.from, "error": "Not a folder this app copies into."]); continue
            }
            let name = Self.freeName(f.to, size: bytes) { size($0) }
            _ = with(id) { $0.file = f.from }
            if !name.copied {
                do {
                    try FileManager.default.createDirectory(atPath: (name.path as NSString).deletingLastPathComponent, withIntermediateDirectories: true)
                    try copyFile(f.from, to: name.path, id: id)
                } catch is CancellationError {
                    stopped = true
                    break
                } catch {
                    failed.append(["from": f.from, "error": error.localizedDescription]); continue
                }
            } else {
                _ = with(id) { $0.bytes += bytes }
            }
            grant(root)
            copied.append(["from": f.from, "to": name.path])
        }
        var reply: [String: Any] = ["copied": copied, "failed": failed]
        if stopped { reply["stopped"] = true }
        return reply
    }

    /// One file, 8 MB at a time, into a new file that must not exist yet (O_EXCL: nothing is overwritten, a link there is
    /// refused). Cancelled or failed: the partial file is removed. The copy keeps the original's modification date.
    private func copyFile(_ from: String, to: String, id: String) throws {
        let input = try FileHandle(forReadingFrom: URL(fileURLWithPath: from))
        defer { try? input.close() }
        let fd = open(to, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o644)
        guard fd >= 0 else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
        let output = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
        do {
            while true {
                if with(id, { $0.cancelled }) == true { throw CancellationError() }
                guard let chunk = try input.read(upToCount: 8 << 20), !chunk.isEmpty else { break }
                try output.write(contentsOf: chunk)
                _ = with(id) { $0.bytes += Int64(chunk.count) }
            }
            try output.close()
        } catch {
            try? output.close()
            unlink(to)
            throw error
        }
        if let date = (try? FileManager.default.attributesOfItem(atPath: from))?[.modificationDate] {
            try? FileManager.default.setAttributes([.modificationDate: date], ofItemAtPath: to)
        }
    }

    /// Where a file of `size` bytes meant for `to` goes: `to` when nothing is there; `copied` when a file of that size is
    /// there already (under `to` or a numbered name, a copy made before); else the first free "name 2.ext", "name 3.ext"…
    static func freeName(_ to: String, size: Int64, sizeAt: (String) -> Int64?) -> (path: String, copied: Bool) {
        let url = URL(fileURLWithPath: to)
        let ext = url.pathExtension
        let base = url.deletingPathExtension().path
        for n in 1... {
            let p = n == 1 ? to : "\(base) \(n)" + (ext.isEmpty ? "" : ".\(ext)")
            guard let there = sizeAt(p) else { return (p, false) }
            if there == size { return (p, true) }
        }
        return (to, false)
    }

    /// The root of `roots` that `path` lies in (or is), comparing real paths (links resolved) in one Unicode form; nil
    /// when it lies in none or is not a plain absolute path. A path that does not exist yet is resolved from its nearest
    /// existing folder, so a link inside a root never leads a copy out of it.
    static func inside(_ path: String, _ roots: [String]) -> String? {
        let parts = path.split(separator: "/")
        guard path.hasPrefix("/"), !parts.contains(".."), !parts.contains(".") else { return nil }
        let p = resolved(path)
        return roots.first { root in
            let r = resolved(root)
            return r != "/" && (p == r || p.hasPrefix(r + "/"))
        }
    }

    /// The copy destination root `to` lies under (never a root itself), or nil.
    static func destination(_ to: String, _ roots: [String]) -> String? {
        guard let root = inside(to, roots), resolved(to) != resolved(root) else { return nil }
        return root
    }

    private static func resolved(_ path: String) -> String {
        let near = MediaFiles.nearestExisting(path)
        guard let r = realpath(near, nil) else { return path.precomposedStringWithCanonicalMapping }
        defer { free(r) }
        let rest = path.dropFirst(near == "/" ? 0 : near.count)
        let joined = String(cString: r) + (rest.hasPrefix("/") || rest.isEmpty ? "" : "/") + rest
        return (joined.hasPrefix("//") ? String(joined.dropFirst()) : joined).precomposedStringWithCanonicalMapping
    }

    /// The media files under `path` when it is a granted folder (or inside one): { files } or { error }.
    static func scan(_ path: String, granted: [String], max: Int = maxScan) -> [String: Any] {
        var directory: ObjCBool = false
        guard inside(path, granted) != nil, FileManager.default.fileExists(atPath: path, isDirectory: &directory), directory.boolValue else {
            return ["error": "This app may not read that folder. Drop it on the window first."]
        }
        let keys: [URLResourceKey] = [.isRegularFileKey, .isSymbolicLinkKey, .isPackageKey, .fileSizeKey, .contentModificationDateKey]
        guard let walk = FileManager.default.enumerator(at: URL(fileURLWithPath: path, isDirectory: true), includingPropertiesForKeys: keys,
                                                        options: [.skipsHiddenFiles, .skipsPackageDescendants]) else { return ["files": []] }
        // each file named under `path` as given: the walk answers real paths (/private/var for /var), and the page
        // matches what it already has by the path it gave
        let real = URL(fileURLWithPath: path).resolvingSymlinksInPath().path
        let given = path.hasSuffix("/") && path.count > 1 ? String(path.dropLast()) : path
        var files: [[String: Any]] = []
        for case let url as URL in walk {
            guard let v = try? url.resourceValues(forKeys: Set(keys)), v.isSymbolicLink != true else { continue }
            if v.isPackage == true { walk.skipDescendants(); continue }
            guard v.isRegularFile == true, MediaFiles.isMedia(url.path), let size = v.fileSize else { continue }
            let found = url.resolvingSymlinksInPath().path
            let named = found.hasPrefix(real + "/") ? given + found.dropFirst(real.count) : url.path
            files.append(["path": named, "size": size, "mtime": ((v.contentModificationDate?.timeIntervalSince1970 ?? 0) * 1000).rounded()])
            if files.count >= max { break }
        }
        return ["files": files.sorted { ($0["path"] as? String ?? "") < ($1["path"] as? String ?? "") }]
    }

    /// SHA-256 over the size as decimal text, the first MiB, and the last MiB when the file is over 2 MiB: the page's
    /// quickPrint, byte for byte. Nil when the file can't be read.
    static func quickPrint(_ path: String) -> String? {
        let mib: UInt64 = 1 << 20
        guard let file = FileHandle(forReadingAtPath: path), let size = try? file.seekToEnd() else { return nil }
        defer { try? file.close() }
        var hash = SHA256()
        hash.update(data: Data(String(size).utf8))
        do {
            try file.seek(toOffset: 0)
            hash.update(data: try file.read(upToCount: Int(mib)) ?? Data())
            if size > 2 * mib {
                try file.seek(toOffset: size - mib)
                hash.update(data: try file.read(upToCount: Int(mib)) ?? Data())
            }
        } catch { return nil }
        return hash.finalize().map { String(format: "%02x", $0) }.joined()
    }
}
