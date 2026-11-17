import Foundation

// Find missing files (apps/captions/contracts/places.ts PlacesSearchAsk; Places.swift has the check it starts from).
//
// A clip's original that this Mac found gone (its disk answered, the file wasn't at any of its paths) is looked for by
// its size and quick fingerprint, an exact match, so every match is applied without asking:
// - The list comes from the window's server (GET …/places/gone): the versions this computer last found gone, each with
//   its size, fingerprint, root and where it was. A pressed search also asks for the clips whose disk isn't connected
//   here (`away=1`), so copies on another disk (a drive taken on a trip) are found too.
// - Where to look, in order: each gone file's own folder on its disk, then one folder up at a time to the disk's top (a
//   moved folder is usually close by); the shared drives; when pressed, the other disks; the folders the page may play
//   from. Hidden files, packages, other disks' mount points and files changed in the last 60 s are passed by. A file
//   in the home folder is looked for up to the home folder, never above, and never in Desktop, Documents, Downloads or
//   Library unless a gone file was in there (macOS asks the person before an app reads those; nothing here may make it
//   ask by itself).
// - Only plain paths to the files this app serves get a file call (MediaFiles.isPlainMedia, as in Places.check), and
//   only those of a gone file's size that MediaFiles' gate lets the page play are read (2 MiB each,
//   Imports.quickPrint) or told to the server. One the gate refuses is never read and the server hears nothing of it:
//   its folder (the disk, for a share or another disk) goes to the page as one to grant (`access`), and a search after
//   the grant reads it. The first match gives the rest: the folder change it shows (derivedMove) is tried on every
//   other gone file before walking on.
// - Nothing is mounted or connected: only disks mounted now are walked, never an automount folder (/net, /Network).
// - Every file call goes through Places.guarded, so a share that stops answering costs at most one wait. At most
//   300,000 entries are listed a run; the next run starts over (listing is cheap, reading is what costs).
// - What was found goes back as confirmed with its fingerprint (POST …/places): the server moves a file that moved on
//   its own share for everybody, and keeps a copy elsewhere as this computer's.
// - One search at a time on this Mac. It starts 30 s after a check found files gone, and from Find missing files.

/// A version this computer last found gone (GET /api/library/:lib/places/gone, contracts/places.ts GoneVersion).
struct GoneFile: Decodable, Equatable {
    let versionId: String
    let bytes: Int64
    let quick: String
    let root: String?
    let rootRel: String?
    /// where this computer last looked ("" when it never had a path for it)
    let path: String
    let name: String
}

private struct GoneList: Decodable { let gone: [GoneFile] }

/// A gone file found again: where, and its fingerprint (read there).
struct SearchFound: Equatable {
    let versionId: String
    let path: String
    let quick: String
}

/// One walk for gone files. `run()` answers what it found; `looked` is how many entries it listed, `access` the folders
/// holding files that may be gone ones and that the page may not play from.
struct MissingSearch {
    var gone: [GoneFile]
    var disks: [PlaceDisk]
    /// the folders the page may play from (as granted), and the same kept by root (MediaFiles)
    var granted: [String] = []
    var roots: [MediaFiles.RootGrant] = []
    /// pressed: also every other disk connected (a disk this app never read may make macOS ask the person first)
    var everywhere = false
    var places: Places = .shared
    var budget = 300_000
    var now = Date()
    var home = NSHomeDirectory()
    var quickPrint: (String) -> String? = Imports.quickPrint
    var progress: (_ looked: Int, _ found: Int, _ left: Int) -> Void = { _, _, _ in }

    private(set) var found: [SearchFound] = []
    private(set) var looked = 0
    private(set) var access = Set<String>()
    private var left: [String: GoneFile] = [:]
    private var old: [String: String] = [:]
    private var moves: [PathMove] = []
    private var walked = Set<String>()
    private var skip = Set<String>()

    /// Folders macOS mounts something on when they are read (automount): never entered, so nothing is connected here.
    private static let automount = ["/net", "/Network", "/home", "/automount"]

    init(gone: [GoneFile], disks: [PlaceDisk]) {
        self.gone = gone
        self.disks = disks
    }

    var stillGone: Int { left.count }

    mutating func run() -> [SearchFound] {
        for g in gone where !g.quick.isEmpty && g.bytes > 0 {
            left[g.versionId] = g
            old[g.versionId] = oldPath(g)
        }
        // back where it was (a disk reconnected since, or a copy this Mac has after all): confirmed as it is
        for g in left.values.sorted(by: { $0.versionId < $1.versionId }) {
            if let p = old[g.versionId], !p.isEmpty, let real = matches(p, g) { take(g, at: real) }
        }
        let starts = startFolders()
        for dir in starts {
            if left.isEmpty || looked >= budget { break }
            walk(dir)
        }
        progress(looked, found.count, left.count)
        return found
    }

    /// Where the file was on this Mac: its root path on the disk with its root mounted here, else where it last looked.
    private func oldPath(_ g: GoneFile) -> String {
        if let root = g.root, let rel = g.rootRel, let d = disks.first(where: { $0.key == root }) { return joinRoot(d.path, rel) }
        return g.path
    }

    private static func parent(_ p: String) -> String {
        let d = (p as NSString).deletingLastPathComponent
        return d.isEmpty ? "/" : d
    }

    private static func inside(_ p: String, _ dir: String) -> Bool { p == dir || p.hasPrefix(dir == "/" ? "/" : dir + "/") }

    /// The folders to walk, best first (see the top of this file), and the folders never entered.
    private mutating func startFolders() -> [String] {
        let nfc = { (s: String) in s.precomposedStringWithCanonicalMapping }
        let home = nfc(home)
        // where they were: the server's paths, walked from only when plain (absolute, no `.` or `..`)
        let olds = left.keys.compactMap { old[$0] }.filter(MediaFiles.isPlain).map(nfc)
        // folders macOS guards with a question to the person: kept out of unless a gone file was in one
        let guarded = ["Desktop", "Documents", "Downloads", "Library"].map { home + "/" + $0 }
        skip = Set(guarded.filter { g in !olds.contains { Self.inside($0, g) } } + ["/Volumes"] + Self.automount)
        skip.formUnion(disks.map { nfc($0.path) }.filter { $0 != "/" })

        var out: [String] = []
        var count: [String: Int] = [:]
        for p in olds { count[Self.parent(p), default: 0] += 1 }
        for (dir, _) in count.sorted(by: { $0.value != $1.value ? $0.value > $1.value : $0.key < $1.key }) {
            guard let disk = Places.disk(of: dir, in: disks) else { continue }   // its disk isn't here: away
            let mount = nfc(disk.path)
            // the top: the home folder for a file in it, else the disk's own, on the system disk the first folder under /
            let top = Self.inside(dir, home) ? home : mount != "/" ? mount : "/" + (dir.split(separator: "/").first.map(String.init) ?? "")
            guard top != "/" else { continue }
            var d = dir
            while Self.inside(d, top) {
                out.append(d)
                if d == top { break }
                d = Self.parent(d)
            }
        }
        out += disks.filter(\.network).map { nfc($0.path) }
        if everywhere { out += disks.filter { !$0.network && $0.path != "/" }.map { nfc($0.path) } }
        out += granted.map(nfc)
        // only folders on a disk mounted now, and never an automount
        return out.filter { d in MediaFiles.isPlain(d) && Places.disk(of: d, in: disks) != nil && !Self.automount.contains { Self.inside(d, $0) } }
    }

    private static let keys: [URLResourceKey] = [.isDirectoryKey, .isRegularFileKey, .isPackageKey, .isSymbolicLinkKey, .fileSizeKey, .contentModificationDateKey]

    /// Walks `start` and below, depth first in name order, until nothing is left to find or the budget is spent.
    private mutating func walk(_ start: String) {
        guard !walked.contains(start), places.reachable(start) else { return }
        let keySet = Set(Self.keys)
        var stack = [start]
        while let dir = stack.popLast() {
            if left.isEmpty || looked >= budget { return }
            guard walked.insert(dir).inserted else { continue }
            let url = URL(fileURLWithPath: dir, isDirectory: true)
            guard let entries = places.guarded(dir, deadline: 10, {
                try? FileManager.default.contentsOfDirectory(at: url, includingPropertiesForKeys: Self.keys, options: [.skipsHiddenFiles])
            }) ?? nil else { continue }
            looked += entries.count
            let sizes = Set(left.values.map(\.bytes))
            var below: [String] = []
            for e in entries.sorted(by: { $0.lastPathComponent < $1.lastPathComponent }) {
                guard let v = try? e.resourceValues(forKeys: keySet) else { continue }
                // the folder as given and the entry's name (a listing may hand back the folder with its links resolved)
                let path = (dir == "/" ? "/" : dir + "/") + e.lastPathComponent.precomposedStringWithCanonicalMapping
                if v.isDirectory == true {
                    if v.isPackage != true && v.isSymbolicLink != true && !skip.contains(path) { below.append(path) }
                } else if v.isRegularFile == true, let bytes = v.fileSize.map(Int64.init), sizes.contains(bytes), MediaFiles.isPlainMedia(path),
                          (v.contentModificationDate ?? .distantPast) < now.addingTimeInterval(-60) {
                    consider(path, bytes)
                    if left.isEmpty { return }
                }
            }
            stack += below.reversed()
            progress(looked, found.count, left.count)
        }
    }

    /// A file of a gone file's size: read when the page may play it, and taken for each gone file with its fingerprint;
    /// else none of it is read and its folder is one to grant.
    private mutating func consider(_ path: String, _ bytes: Int64) {
        let same = left.values.filter { $0.bytes == bytes }.sorted { $0.versionId < $1.versionId }
        guard !same.isEmpty, let real = readable(path), let quick = fingerprint(real) else { return }
        for g in same where g.quick == quick { take(g, at: real, quick: quick) }
    }

    /// `g` is at `path` (granted, real); the folder change from where it was is tried on every other gone file.
    private mutating func take(_ g: GoneFile, at path: String, quick: String? = nil) {
        guard left.removeValue(forKey: g.versionId) != nil else { return }
        found.append(SearchFound(versionId: g.versionId, path: path, quick: quick ?? g.quick))
        guard let was = old[g.versionId], !was.isEmpty, let m = derivedMove(was, path), !moves.contains(m) else { return }
        moves.append(m)
        for other in left.values.sorted(by: { $0.versionId < $1.versionId }) {
            guard left[other.versionId] != nil, let p = old[other.versionId], let q = applyMove(p, m), let real = matches(q, other) else { continue }
            take(other, at: real)
        }
    }

    /// The real path of the file at `path` when it is `g` (its size, not changed in the last minute, and, when the page
    /// may play it, its fingerprint); nil else. One the page may not play is not read: its folder is one to grant.
    private mutating func matches(_ path: String, _ g: GoneFile) -> String? {
        // only a plain path to a file this app serves gets a file call (the same as Places.check)
        guard MediaFiles.isPlainMedia(path) else { return nil }
        let at = places.guarded(path) { () -> (Int64, Date)? in
            guard let a = try? FileManager.default.attributesOfItem(atPath: path), a[.type] as? FileAttributeType == .typeRegular,
                  let size = (a[.size] as? NSNumber)?.int64Value else { return nil }
            return (size, a[.modificationDate] as? Date ?? .distantPast)
        } ?? nil
        guard let at, at.0 == g.bytes, at.1 < now.addingTimeInterval(-60), let real = readable(path) else { return nil }
        return fingerprint(real) == g.quick ? real : nil
    }

    /// The real path to read when MediaFiles' gate lets the page play `path`; nil else, and a file it refuses for its folder
    /// (not granted) gives that folder to grant: the disk for a share or another disk, else the file's own folder.
    private mutating func readable(_ path: String) -> String? {
        switch MediaFiles.gate(path, granted: granted, roots: roots, places: places) {
        case .file(let real, _): return real
        case .status(403):
            let disk = Places.disk(of: path, in: disks)
            access.insert(disk.map { $0.path != "/" } == true ? disk!.path : Self.parent(path))
            return nil
        case .status, .diskAway: return nil
        }
    }

    private func fingerprint(_ path: String) -> String? {
        let quickPrint = self.quickPrint
        return places.guarded(path, deadline: 10) { quickPrint(path) } ?? nil
    }
}

/// Find missing files on this Mac: one search at a time, its state for the page (contracts/places.ts PlacesSearchState).
final class PlacesSearch: @unchecked Sendable {
    static let shared = PlacesSearch()

    private let lock = NSLock()
    private var running = false
    private var library = ""
    private var looked = 0, found = 0, left = 0
    private var access: [String] = []
    private var soonItem: DispatchWorkItem?
    private let queue = DispatchQueue(label: "creatortoolset.places.search", qos: .utility)

    /// `places:search:state` (and every start's answer).
    var state: [String: Any] {
        lock.withLock { ["library": library, "running": running, "looked": looked, "found": found, "left": left, "access": access] }
    }

    /// A check found files gone: a search 30 s later (another one in the meantime moves it on), unless one runs then.
    func soon(library: String, site: Site, device: String) {
        let item = DispatchWorkItem { [self] in _ = start(library: library, site: site, device: device, pressed: false) }
        lock.withLock {
            soonItem?.cancel()
            soonItem = item
        }
        queue.asyncAfter(deadline: .now() + 30, execute: item)
    }

    /// `places:search:{library}` (pressed) or the one after a check: starts unless one runs. The state.
    func start(library: String, site: Site, device: String?, pressed: Bool) -> [String: Any] {
        guard let device, let encoded = device.addingPercentEncoding(withAllowedCharacters: .alphanumerics) else { return state }
        let begin = lock.withLock { () -> Bool in
            guard !running else { return false }
            (running, looked, found, left, access) = (true, 0, 0, 0, [])
            self.library = library
            return true
        }
        guard begin else { return state }
        Task.detached { [self] in
            let gone: GoneList? = try? await site.get("/api/library/\(library)/places/gone?device=\(encoded)\(pressed ? "&away=1" : "")")
            let list = gone?.gone ?? []
            lock.withLock { left = list.count }
            let hits = list.isEmpty ? [] : await withCheckedContinuation { (c: CheckedContinuation<[SearchFound], Never>) in
                queue.async { [self] in
                    let disks = Places.shared.diskList()
                    var search = MissingSearch(gone: list, disks: disks)
                    search.granted = MediaFiles.granted
                    search.roots = MediaFiles.rootGrants
                    search.everywhere = pressed
                    search.progress = { [self] l, f, n in lock.withLock { (looked, found, left) = (l, f, n) } }
                    let hits = search.run()
                    lock.withLock { access = search.access.sorted() }
                    c.resume(returning: hits)
                }
            }
            // ponytail: one POST per 200 found, one after another; a search that finds thousands waits on each
            for i in stride(from: 0, to: hits.count, by: placesMax) {
                let confirmed = hits[i..<min(i + placesMax, hits.count)].map { ["versionId": $0.versionId, "path": $0.path, "quick": $0.quick] }
                try? await site.post("/api/library/\(library)/places", ["device": device, "confirmed": confirmed, "gone": [String]()])
            }
            lock.withLock { running = false }
            // the page checks again (mac-places): what was found plays from here
            if !hits.isEmpty {
                Places.shared.dropAnswers()
                DispatchQueue.main.async { Places.shared.onChange?() }
            }
        }
        return state
    }
}
