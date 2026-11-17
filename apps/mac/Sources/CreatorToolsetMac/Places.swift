import AppKit
import Foundation
import NetFS
import Network

// Here or away (apps/captions/contracts/places.ts): whether this Mac can read a clip's original right now.
//
// - A root is the disk a file lives on, named the same from every computer (`rootKey`): a share by its server and name,
//   a volume by its UUID. The server keeps a version's root and its path inside it; this Mac reaches the root at its own
//   mount path (/Volumes/footage, or /Volumes/footage-1 when a stale folder was in the way).
// - A network disk answers when a lookup of a name nobody has comes back from its server. A stat of a known file is no
//   test: smbfs served one from its cache at once with the server gone. This app opens no socket of its own to the
//   server: one to a local address makes macOS ask for Local Network access, and a refusal would leave every share away.
// - The guard: a file call on a network disk goes through `guarded`. A disk whose last check had no answer is never
//   touched; any other call waits at most 2 s, and one that takes longer marks the disk away. Measured on macOS 26
//   against a test share: with its server silent, a lookup blocks about 2 min 45 s before macOS drops the mount; with
//   its server refusing, about 12 s, and the mount goes some seconds later.
// - Mounts, unmounts, renames, wake and any network change are collapsed for 1.5 s, then the disks are read again, each
//   network disk is checked, and the shares this Mac had are connected again with the saved sign-in (never a panel;
//   Settings → Computers → Shared drives turns it off). When a disk came, went, went away or came back, the server gets
//   this Mac's report at once and the page a `mac-places` event. A share the person ejected (macOS says it will unmount
//   it, outside sleep) is not connected again until they connect it themselves.
// - The page's asks (Shell.swift → `answerCheck`, `connect`): `places:check:{library, versions}` and
//   `places:connect:{root}`. The paths to try come from the window's server, never from the page.
// - Find missing files (`places:search:{library}`, `places:search:state`) is PlacesSearch.swift: a check that finds files
//   gone starts it 30 s later.

// MARK: roots and paths, the same as contracts/places.ts (PlacesTests.swift has its test rows)

/// A Windows path ("Z:\…", "\\server\share\…").
func isWindowsPath(_ p: String) -> Bool {
    p.range(of: #"^[A-Za-z]:([\\/]|$)"#, options: .regularExpression) != nil || p.hasPrefix("\\\\")
}

/// A disk's root key: a share is `fs://host/share` (host in lower case without ".local", a Bonjour service name or a
/// trailing dot; an SMB or AFP share's name in lower case, an NFS export as it is; slashes trimmed), a volume
/// `vol:UUID`. Text is NFC. Nil for a disk that says neither.
func rootKey(fs: String?, server: String?, share: String?, uuid: String?) -> String? {
    if let fs, let server, let share, !fs.isEmpty, !server.isEmpty, !share.isEmpty {
        var host = server.precomposedStringWithCanonicalMapping.lowercased()
        if host.hasSuffix(".") { host.removeLast() }
        host = host.replacingOccurrences(of: #"(\._[a-z0-9-]+\._tcp)?\.local$"#, with: "", options: .regularExpression)
        let name = share.precomposedStringWithCanonicalMapping.replacingOccurrences(of: #"^/+|/+$"#, with: "", options: .regularExpression)
        return "\(fs)://\(host)/\(fs == "nfs" ? name : name.lowercased())"
    }
    guard let uuid, !uuid.isEmpty else { return nil }
    return "vol:\(uuid.uppercased())"
}

/// `rel` ("/"-separated) inside the folder `dir`, written with dir's own separator.
func joinRoot(_ dir: String, _ rel: String) -> String {
    let rest = rel.replacingOccurrences(of: #"^/+"#, with: "", options: .regularExpression)
    if rest.isEmpty { return dir }
    let sep = isWindowsPath(dir) ? "\\" : "/"
    let base = dir.replacingOccurrences(of: #"[\\/]+$"#, with: "", options: .regularExpression)
    return base + sep + rest.split(separator: "/", omittingEmptySubsequences: false).joined(separator: sep)
}

/// A folder change: what started with `from` now starts with `to`.
struct PathMove: Equatable {
    let from: String
    let to: String
}

private let slashUnit = UInt16(UInt8(ascii: "/")), backslashUnit = UInt16(UInt8(ascii: "\\"))
private func isSeparator(_ c: UInt16) -> Bool { c == slashUnit || c == backslashUnit }

/// The folder change that took `oldPath` to `newPath`: the end both share, from a separator, dropped. Nil when the
/// file's own name changed, the paths are the same, or the shared end has no folder in it. Compared in NFC UTF-16
/// units, as the TypeScript does.
func derivedMove(_ oldPath: String, _ newPath: String) -> PathMove? {
    let a = Array(oldPath.precomposedStringWithCanonicalMapping.utf16), b = Array(newPath.precomposedStringWithCanonicalMapping.utf16)
    var k = 0
    while k < min(a.count, b.count) {
        let x = a[a.count - 1 - k], y = b[b.count - 1 - k]
        if x != y && !(isSeparator(x) && isSeparator(y)) { break }
        k += 1
    }
    guard let cut = a[(a.count - k)...].firstIndex(where: isSeparator).map({ $0 - (a.count - k) }) else { return nil }
    let from = String(decoding: a[..<(a.count - k + cut)], as: UTF16.self)
    let to = String(decoding: b[..<(b.count - k + cut)], as: UTF16.self)
    return from == to ? nil : PathMove(from: from, to: to)
}

/// `path` after the folder change (with the new folder's separator, NFC); nil when it isn't inside `from`.
func applyMove(_ path: String, _ m: PathMove) -> String? {
    let p = Array(path.precomposedStringWithCanonicalMapping.replacingOccurrences(of: "\\", with: "/").utf16)
    let f = Array(m.from.precomposedStringWithCanonicalMapping.replacingOccurrences(of: "\\", with: "/").utf16)
    guard p == f || p.starts(with: f.last == slashUnit ? f : f + [slashUnit]) else { return nil }
    return joinRoot(m.to, String(decoding: p[f.count...], as: UTF16.self))
}

// MARK: disks

/// One mounted disk as the places checks see it (from DiskCache's last read).
struct PlaceDisk: Equatable {
    let path: String
    let key: String?
    var network = false
    var name = ""
    var server: String?
    /// a share: how to connect it again (smb://user@host/share, as it was mounted)
    var url: String?

    init(path: String, key: String?, network: Bool = false, name: String = "", server: String? = nil, url: String? = nil) {
        (self.path, self.key, self.network, self.name, self.server, self.url) = (path, key, network, name, server, url)
    }

    init?(_ d: ReadDisk) {
        guard let path = d.report["path"] as? String else { return nil }
        let r = d.report
        self.init(path: path, key: rootKey(fs: r["fs"] as? String, server: r["server"] as? String, share: r["share"] as? String, uuid: r["uuid"] as? String),
                  network: r["network"] as? Bool == true, name: (r["share"] ?? r["name"]) as? String ?? "", server: r["server"] as? String, url: d.url)
    }

    var label: [String: Any] {
        var l: [String: Any] = ["key": key ?? "", "name": name]
        if let server { l["server"] = server }
        return l
    }
}

/// A share's address to connect it again, from its mount source ("//me@office-nas.local/footage" on smbfs →
/// "smb://me@office-nas.local/footage"); nil for a disk that isn't a share. The user name stays, a password never
/// ("//me:pw@…" → "smb://me@…"): macOS takes the password from its keychain.
func shareURL(source: String, fstype: String) -> String? {
    let withoutPassword = { (rest: Substring) -> String in
        let authority = rest.prefix { $0 != "/" }
        guard let at = authority.lastIndex(of: "@") else { return String(rest) }
        return String(authority[..<at].prefix { $0 != ":" } + rest[at...])
    }
    switch fstype {
    case "smbfs", "cifs", "smb3": return source.hasPrefix("//") ? "smb://" + withoutPassword(source.dropFirst(2)) : nil
    case "afpfs": return source.hasPrefix("//") ? "afp://" + withoutPassword(source.dropFirst(2)) : nil
    case "nfs", "nfs4":
        guard let colon = source.firstIndex(of: ":") else { return nil }
        let path = source[source.index(after: colon)...]
        return "nfs://\(source[..<colon])" + (path.hasPrefix("/") ? path : "/" + path)
    default: return nil
    }
}

/// Calls `action` once, `delay` after the last of a burst of pokes.
final class Debounce: @unchecked Sendable {
    private let delay: TimeInterval
    private let queue: DispatchQueue
    private let action: () -> Void
    private let lock = NSLock()
    private var item: DispatchWorkItem?

    init(delay: TimeInterval, queue: DispatchQueue, action: @escaping () -> Void) {
        (self.delay, self.queue, self.action) = (delay, queue, action)
    }

    func poke() {
        let next = DispatchWorkItem(block: action)
        lock.lock()
        item?.cancel()
        item = next
        lock.unlock()
        queue.asyncAfter(deadline: .now() + delay, execute: next)
    }
}

/// What the server lists for one version (GET /api/library/:lib/places, contracts/places.ts VersionPlaces).
struct VersionPlaces: Decodable {
    let tries: [String]
    let bytes: Int64
    let quick: String?
    let root: Root?
    let cached: Bool?

    struct Root: Decodable {
        let key: String
        let name: String
        let server: String?
        var label: [String: Any] { server.map { ["key": key, "name": name, "server": $0] } ?? ["key": key, "name": name] }
    }

    init(tries: [String], bytes: Int64, quick: String? = nil, root: Root? = nil, cached: Bool? = nil) {
        (self.tries, self.bytes, self.quick, self.root, self.cached) = (tries, bytes, quick, root, cached)
    }
}

private struct PlacesList: Decodable { let versions: [String: VersionPlaces] }

/// A page's places ask, as its parts; nil when it is not one or malformed.
enum PlacesAsk: Equatable {
    case check(library: String, versions: [String])
    case connect(root: String)
    /// Find missing files (PlacesSearch.swift): start one, and how far it is
    case search(library: String)
    case searchState
}

/// The most versions in one ask (contracts/places.ts PLACES_MAX).
let placesMax = 200

func isPlacesAsk(_ ask: String) -> Bool { ask.hasPrefix("places:") }

func placesAsk(_ ask: String) -> PlacesAsk? {
    let isID = { (s: String) in !s.isEmpty && s.count <= 100 && s.allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-" || $0 == "_") } }
    let json = { (prefix: String) -> [String: Any]? in
        guard ask.hasPrefix(prefix) else { return nil }
        return (try? JSONSerialization.jsonObject(with: Data(ask.dropFirst(prefix.count).utf8))) as? [String: Any]
    }
    if let o = json("places:check:"), let library = o["library"] as? String, isID(library), let versions = o["versions"] as? [String],
       versions.count <= placesMax, versions.allSatisfy(isID) {
        return .check(library: library, versions: versions)
    }
    if let o = json("places:connect:"), let root = o["root"] as? String, Places.shareParts(root) != nil { return .connect(root: root) }
    if ask == "places:search:state" { return .searchState }
    if let o = json("places:search:"), let library = o["library"] as? String, isID(library) { return .search(library: library) }
    return nil
}

// MARK: here and away

/// A call's answer handed from the thread that ran it.
private final class Box<T>: @unchecked Sendable { var value: T? }

final class Places: @unchecked Sendable {
    static let shared = Places()
    /// Posted on the main thread when a disk came, went, went away or came back.
    static let changed = Notification.Name("creatortoolset.places.changed")

    /// Settings → Computers → Shared drives: connect the shares this Mac had when they answer (on unless turned off).
    private static let connectKey = "connectSharedDrives"
    static var connectOn: Bool {
        get { UserDefaults.standard.object(forKey: connectKey) as? Bool ?? true }
        set { UserDefaults.standard.set(newValue, forKey: connectKey) }
    }

    /// The mounted disks; the tests give their own.
    var diskList: () -> [PlaceDisk]
    /// Whether the network disk mounted at the path answers (blocks while its server is silent); the tests give their own.
    var lookup: (String) -> Bool
    /// Mounts a share (Places.mount); the tests give their own.
    var mountShare: (_ url: String, _ ui: Bool, _ done: @escaping (Int32) -> Void) -> Void = Places.mount
    /// Called on the main thread when a disk came, went, went away or came back: the report now, and the page's event.
    var onChange: (() -> Void)?

    private let lock = NSLock()
    /// mount paths whose last check had no answer, when each was checked, and the checks still waiting (one per disk)
    private var away = Set<String>()
    private var checkedAt: [String: Date] = [:]
    private var inflight: [String: DispatchGroup] = [:]
    private var lastNotified = ""
    /// the check answers kept 10 s (by server, library and version), and what was told to the server this run
    private var kept: [String: (at: Date, check: [String: Any])] = [:]
    private var told = Set<String>()
    /// shares being connected; the next try and the tries that failed; those that need a password
    private var connecting = Set<String>()
    private var nextTry: [String: (at: Date, failed: Int)] = [:]
    private var needsLogin = Set<String>()
    /// on `work`: the shares mounted at the last look (one that appears again clears its eject)
    private var mountedKeys = Set<String>()
    private var asleep = false
    private var wokeAt = Date.distantPast
    private var started = false

    private let calls = DispatchQueue(label: "creatortoolset.places.calls", qos: .userInitiated, attributes: .concurrent)
    private let work = DispatchQueue(label: "creatortoolset.places", qos: .utility)
    private var events: Debounce!
    private var monitor: NWPathMonitor?
    private var timer: DispatchSourceTimer?

    init(diskList: @escaping () -> [PlaceDisk] = { DiskCache.shared.placeDisks() }, lookup: @escaping (String) -> Bool = Places.lookup) {
        self.diskList = diskList
        self.lookup = lookup
        events = Debounce(delay: 1.5, queue: work) { [weak self] in self?.refresh() }
    }

    /// The disk `path` is on: the mounted disk with the longest mount path holding it. A path under /Volumes/<name> with
    /// nothing mounted there is on none (not a folder of the system disk).
    static func disk(of path: String, in disks: [PlaceDisk]) -> PlaceDisk? {
        let p = path.precomposedStringWithCanonicalMapping
        let best = disks.filter { d in
            let m = d.path.precomposedStringWithCanonicalMapping
            return m == "/" || p == m || p.hasPrefix(m + "/")
        }.max { $0.path.count < $1.path.count }
        if best?.path == "/", p.hasPrefix("/Volumes/") { return nil }
        return best
    }

    /// `path` inside the disk mounted at `mount` ("2025/a.mov"; "" for the disk itself), NFC.
    static func rel(_ path: String, in mount: String) -> String {
        let p = path.precomposedStringWithCanonicalMapping, m = mount.precomposedStringWithCanonicalMapping
        return String(p.dropFirst(m == "/" ? 1 : m.count).drop { $0 == "/" })
    }

    /// A lookup of a name nobody has on the disk mounted at `mount`: true when its server answered (the name isn't there)
    /// and the disk is still mounted.
    static func lookup(_ mount: String) -> Bool {
        var st = stat()
        guard lstat(mount + "/.creator-toolset-" + UUID().uuidString, &st) != 0, errno == ENOENT else { return false }
        return mountPaths().contains(mount)
    }

    func isAway(mount: String) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        return away.contains(mount)
    }

    /// Whether the network disk at `mount` answers. A disk away answers no at once, until a `fresh` check (the 5 s
    /// look) says otherwise; else the last check while under 5 s old, or a new one waited for at most `deadline`. One
    /// check at a time per disk: a caller waits for the one running.
    func answers(_ mount: String, fresh: Bool = false, deadline: TimeInterval = 2) -> Bool {
        lock.lock()
        let wasAway = away.contains(mount)
        if let running = inflight[mount] {
            lock.unlock()
            if wasAway { return false }
            guard running.wait(timeout: .now() + deadline) == .success else { markAway(mount); return false }
            return !isAway(mount: mount)
        }
        if !fresh && (wasAway || checkedAt[mount].map { Date().timeIntervalSince($0) < 5 } == true) {
            lock.unlock()
            return !wasAway
        }
        let running = DispatchGroup()
        running.enter()
        inflight[mount] = running
        lock.unlock()
        let lookup = self.lookup
        calls.async { [self] in
            let ok = lookup(mount)
            lock.lock()
            inflight[mount] = nil
            checkedAt[mount] = Date()
            let was = away.contains(mount)
            if ok { away.remove(mount) } else { away.insert(mount) }
            lock.unlock()
            running.leave()
            if was == ok { notify() }   // also an answer that came after the deadline: back
        }
        guard running.wait(timeout: .now() + deadline) == .success else { markAway(mount); return false }
        return !isAway(mount: mount)
    }

    private func markAway(_ mount: String) {
        lock.lock()
        let was = away.contains(mount)
        away.insert(mount)
        checkedAt[mount] = Date()
        lock.unlock()
        if !was { notify() }
    }

    /// Whether `path`'s disk may be read now: a local disk always; a network disk when it answers.
    func reachable(_ path: String) -> Bool {
        guard let disk = Self.disk(of: path, in: diskList()), disk.network else { return true }
        return answers(disk.path)
    }

    /// Runs `body`, a file call on `path`. On a network disk: nil at once when the disk is away; else nil when the call
    /// takes longer than `deadline`, which marks the disk away (the call ends on its own; its answer is dropped).
    func guarded<T>(_ path: String, deadline: TimeInterval = 2, _ body: @escaping () -> T) -> T? {
        guard let disk = Self.disk(of: path, in: diskList()), disk.network else { return body() }
        if isAway(mount: disk.path) { return nil }
        let box = Box<T>()
        let done = DispatchSemaphore(value: 0)
        calls.async {
            box.value = body()
            done.signal()
        }
        if done.wait(timeout: .now() + deadline) == .timedOut {
            markAway(disk.path)
            return nil
        }
        return box.value
    }

    // MARK: the check

    /// A file's size, nil when it isn't a file there.
    static func size(_ path: String) -> Int64? {
        guard let a = try? FileManager.default.attributesOfItem(atPath: path), a[.type] as? FileAttributeType == .typeRegular else { return nil }
        return (a[.size] as? NSNumber)?.int64Value
    }

    struct Checked {
        /// per version, a PlaceCheck (contracts/places.ts) as JSON, for the page
        var answer: [String: [String: Any]] = [:]
        /// for the server: version → path of a file read here inside the granted folders (none other is told, read or
        /// fingerprinted)
        var confirmed: [String: String] = [:]
        /// for the server: versions whose every try is inside the granted folders, answered, and has no such file
        var gone: [String] = []
    }

    /// What this Mac finds at each version's tries, best first. Only plain paths to the video and sound files this app
    /// serves are looked at (MediaFiles.isPlainMedia); any other try gets no file call, and a version with none left gets
    /// no answer. Granted is the gate's own answer (the real path inside a granted folder or root): such a file of the
    /// version's size is here with a `url`, and goes back to the server. A file of that size outside them is here and
    /// needs access (path and folder, so the person can grant it); only its size is read. A try whose disk isn't mounted
    /// or doesn't answer makes it `away` (unless another try is here); `gone` when every try's disk answered and none had
    /// it. A version with no tries is away on its root, when the server named one. A version whose proxy is in this
    /// Mac's cache (`cached`: its ctlocal address, ProxyCache.url) says so beside that, or is `cached` when nothing else is
    /// known.
    func check(_ versions: [String: VersionPlaces], granted: [String] = MediaFiles.granted, roots: [MediaFiles.RootGrant] = MediaFiles.rootGrants,
               size: @escaping (String) -> Int64? = Places.size, cached: (String) -> String? = { _ in nil }) -> Checked {
        let disks = diskList()
        let known = shares
        var out = Checked()
        for (id, v) in versions {
            let tries = v.tries.filter(MediaFiles.isPlainMedia)
            if tries.isEmpty && !v.tries.isEmpty { continue }
            var found: (path: String, disk: PlaceDisk, granted: Bool)?
            var sawAway = false
            var allGranted = true
            for path in tries {
                // a volume not mounted here is away; a path elsewhere is on the system disk
                let disk = Self.disk(of: path, in: disks)
                if disk == nil && path.hasPrefix("/Volumes/") { sawAway = true; continue }
                if let disk, disk.network && !answers(disk.path) { sawAway = true; continue }
                let place = disk ?? PlaceDisk(path: "/", key: nil, name: "System disk")
                switch MediaFiles.gate(path, granted: granted, roots: roots, places: self) {
                case .file(let real, _):
                    guard let bytes = guarded(real, { size(real) }) else { sawAway = true; continue }
                    if bytes == v.bytes { found = (path, place, true) }
                case .status(503), .diskAway: sawAway = true
                case .status(404): break   // inside the granted folders, not there
                case .status(403):
                    allGranted = false
                    guard let bytes = guarded(path, { size(path) }) else { sawAway = true; continue }
                    if bytes == v.bytes { found = (path, place, false) }
                case .status: break   // 415: a media name for another kind of file
                }
                if found != nil { break }
            }
            if let found {
                let (path, disk, granted) = found
                if granted {
                    out.confirmed[id] = path
                    out.answer[id] = ["state": "here", "path": path, "url": MediaFiles.url(path: path).absoluteString]
                } else {
                    // the access panel opens at the disk (one grant covers the share), or the file's folder on the system disk
                    let folder = disk.path == "/" ? (path as NSString).deletingLastPathComponent : disk.path
                    out.answer[id] = ["state": "here", "path": path, "needs": "access", "folder": folder, "root": v.root?.label ?? disk.label]
                }
            } else if sawAway || (v.tries.isEmpty && v.root != nil) {
                var away: [String: Any] = ["state": "away"]
                if let root = v.root {
                    away["root"] = root.label
                    if needsConnect(root.key, disks: disks, shares: known) { away["needs"] = "connect" }
                }
                out.answer[id] = away
            } else if !tries.isEmpty {
                if allGranted { out.gone.append(id) }
                out.answer[id] = ["state": "gone"]
            }
            if let url = cached(id) {
                if out.answer[id] == nil { out.answer[id] = ["state": "cached", "url": url] } else { out.answer[id]?["cached"] = url }
            }
        }
        return out
    }

    /// A share not connected here that only the person can connect: automatic connecting is off, this Mac never had it,
    /// it was ejected, or its server asked for a password.
    func needsConnect(_ key: String, disks: [PlaceDisk], shares: [Share]) -> Bool {
        guard Self.shareParts(key) != nil, !disks.contains(where: { $0.key == key }) else { return false }
        guard Self.connectOn, let share = shares.first(where: { $0.key == key }), !share.ejected else { return true }
        lock.lock()
        defer { lock.unlock() }
        return needsLogin.contains(key)
    }

    /// `places:check`: the tries from the window's server (a server without the route lists none, so the page plays as
    /// before), checked off the main thread; each answer kept 10 s. What was read here and what is gone goes back to the
    /// server afterwards (POST …/places), each once per run, with the quick fingerprint when the server has none.
    /// With `cache` (a server elsewhere), each version's proxy in the cache of the window's account there (ProxyCache);
    /// when the server doesn't answer (no internet), those alone.
    func answerCheck(library: String, versions: [String], site: Site, device: String?, cache: Bool = false,
                     granted: [String] = MediaFiles.granted, roots: [MediaFiles.RootGrant] = MediaFiles.rootGrants) async -> [String: Any] {
        guard let device, let encoded = device.addingPercentEncoding(withAllowedCharacters: .alphanumerics) else { return ["versions": [String: Any]()] }
        // asked first: an answer kept for one account is never handed to the next
        let (account, offline) = cache ? await ProxyCache.account(site) : (nil, false)
        let folder = account.flatMap { ProxyCache.folder(server: site.base, account: $0) }
        let cached = { (v: String) in folder.flatMap { ProxyCache.url(v, in: $0) } }
        let alone = { (vs: [String]) -> [String: Any] in
            ["versions": vs.reduce(into: [String: Any]()) { out, v in if let url = cached(v) { out[v] = ["state": "cached", "url": url] } }]
        }
        if offline { return alone(versions) }
        let server = site.base.absoluteString + "|" + (account ?? "")
        var out: [String: Any] = [:]
        var ask: [String] = []
        lock.withLock {
            for v in Set(versions) {
                if let k = kept["\(server)|\(library)|\(v)"], Date().timeIntervalSince(k.at) < 10 { out[v] = k.check } else { ask.append(v) }
            }
        }
        guard !ask.isEmpty else { return ["versions": out] }
        let list: PlacesList?
        do {
            list = try await site.get("/api/library/\(library)/places?device=\(encoded)&versions=\(ask.joined(separator: ","))", timeout: 4)
        } catch is URLError {
            return alone(versions)
        } catch {
            list = nil
        }
        let tries = list?.versions ?? [:]
        let checked = await withCheckedContinuation { c in
            calls.async { c.resume(returning: self.check(tries, granted: granted, roots: roots, cached: cached)) }
        }
        lock.withLock {
            for (v, check) in checked.answer {
                kept["\(server)|\(library)|\(v)"] = (Date(), check)
                out[v] = check
            }
        }
        calls.async { self.tell(checked, tries: tries, library: library, device: device, site: site) }
        return ["versions": out]
    }

    /// POST …/places with what this check learnt that the server wasn't told this run: granted files only (`check`).
    /// ponytail: at most 20 quick
    /// fingerprints per check (2 MiB read each); the rest are filled by later checks.
    private func tell(_ checked: Checked, tries: [String: VersionPlaces], library: String, device: String, site: Site) {
        let server = site.base.absoluteString
        var confirmed: [[String: Any]] = []
        var gone: [String] = []
        var prints = 20
        for (v, path) in checked.confirmed {
            lock.lock()
            let fresh = told.insert("\(server)|\(library)|\(v)|\(path)").inserted
            lock.unlock()
            guard fresh else { continue }
            var c: [String: Any] = ["versionId": v, "path": path]
            if tries[v]?.quick == nil, prints > 0, let quick = guarded(path, deadline: 10, { Imports.quickPrint(path) }) ?? nil {
                c["quick"] = quick
                prints -= 1
            }
            confirmed.append(c)
        }
        for v in checked.gone {
            lock.lock()
            if told.insert("\(server)|\(library)|\(v)|gone").inserted { gone.append(v) }
            lock.unlock()
        }
        guard !confirmed.isEmpty || !gone.isEmpty else { return }
        Task {
            try? await site.post("/api/library/\(library)/places", ["device": device, "confirmed": confirmed, "gone": gone])
            if !gone.isEmpty { PlacesSearch.shared.soon(library: library, site: site, device: device) }
        }
    }

    // MARK: shares this Mac had, connected again

    struct Share: Codable, Equatable {
        let key: String
        var url: String
        var ejected = false
    }

    private static let sharesKey = "sharedDrives"
    var shares: [Share] {
        get { UserDefaults.standard.data(forKey: Self.sharesKey).flatMap { try? JSONDecoder().decode([Share].self, from: $0) } ?? [] }
        set { UserDefaults.standard.set(try? JSONEncoder().encode(Array(newValue.suffix(50))), forKey: Self.sharesKey) }
    }

    /// The fs, host and share name in a share's root key ("smb://office-nas/footage"); nil for a volume's.
    static func shareParts(_ key: String) -> (fs: String, host: String, share: String)? {
        guard let scheme = key.range(of: "://"), ["smb", "afp", "nfs"].contains(String(key[..<scheme.lowerBound])) else { return nil }
        let rest = key[scheme.upperBound...]
        guard let slash = rest.firstIndex(of: "/"), slash != rest.startIndex, rest.index(after: slash) != rest.endIndex else { return nil }
        return (String(key[..<scheme.lowerBound]), String(rest[..<slash]), String(rest[rest.index(after: slash)...]))
    }

    /// Mounts a share with NetFS: `ui` false never shows a panel (the saved sign-in or nothing). `done` gets 0 or the error.
    static func mount(_ url: String, ui: Bool, done: @escaping (Int32) -> Void) {
        guard let u = URL(string: url) else { return done(EINVAL) }
        let options = NSMutableDictionary()
        options[kNAUIOptionKey] = ui ? kNAUIOptionAllowUI : kNAUIOptionNoUI
        var request: AsyncRequestID?
        let err = NetFSMountURLAsync(u as CFURL, nil, nil, nil, options, nil, &request, DispatchQueue.global()) { status, _, _ in done(status) }
        if err != 0 { done(err) }
    }

    /// `places:connect:{root}` (the person pressed Connect on a page of `server`): the share mounted, the login panel
    /// allowed. { ok } or { problem }. A share this Mac never had is connected only after this app's own confirm, which
    /// names the server asking and the share's address: a page can't make this Mac reach a server of its choosing.
    func connect(root key: String, server: String,
                 confirm: @escaping @MainActor (_ server: String, _ address: String) -> Bool = Places.askToConnect) async -> [String: Any] {
        guard let parts = Self.shareParts(key) else { return ["problem": "Could not connect that drive"] }
        let name = (parts.share as NSString).lastPathComponent
        // the address it was mounted with; else from the key (a name without a dot is a Bonjour one: name.local)
        let had = shares.first { $0.key == key }?.url
        let url = had
            ?? "\(parts.fs)://\(parts.host.contains(".") ? parts.host : parts.host + ".local")/\(parts.share.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? parts.share)"
        if had == nil {
            guard await MainActor.run(body: { confirm(server, url) }) else { return ["problem": "Not connected"] }
        }
        let status = await withCheckedContinuation { c in mountShare(url, true) { c.resume(returning: $0) } }
        if status == 0 {
            events.poke()
            return ["ok": true]
        }
        return ["problem": status == ECANCELED || status == -128 ? "Not connected" : "Could not connect \(name)"]
    }

    /// This app's confirm before connecting a share this Mac never had.
    @MainActor static func askToConnect(server: String, address: String) -> Bool {
        let alert = NSAlert()
        alert.messageText = "Connect \(address)?"
        alert.informativeText = "Asked by the server \(server). This Mac hasn't connected this shared drive before."
        alert.addButton(withTitle: "Connect")
        alert.addButton(withTitle: "Cancel")
        return alert.runModal() == .alertFirstButtonReturn
    }

    /// Notes the shares mounted now (and that an ejected one was connected again), then connects the missing ones
    /// that answer: one try at a time per share, every 10 s for a minute after it went, then every minute.
    private func connectMissing(_ disks: [PlaceDisk]) {
        var list = shares
        let before = list
        let mounted = Set(disks.filter(\.network).compactMap(\.key))
        for d in disks where d.network {
            guard let key = d.key, let url = d.url else { continue }
            if let i = list.firstIndex(where: { $0.key == key }) {
                list[i].url = url
                if !mountedKeys.contains(key) { list[i].ejected = false }
            } else {
                list.append(Share(key: key, url: url))
            }
        }
        mountedKeys = mounted
        if list != before { shares = list }
        guard Self.connectOn else { return }
        for share in list where !share.ejected && !mounted.contains(share.key) {
            lock.lock()
            let wait = connecting.contains(share.key) || (nextTry[share.key]?.at ?? .distantPast) > Date()
            if !wait { connecting.insert(share.key) }
            lock.unlock()
            if wait { continue }
            mountShare(share.url, false) { [self] status in
                lock.lock()
                connecting.remove(share.key)
                let failed = (nextTry[share.key]?.failed ?? 0) + 1
                nextTry[share.key] = status == 0 ? nil : (Date().addingTimeInterval(failed < 6 ? 10 : 60), failed)
                let login = [EAUTH, EACCES, EPERM].contains(status)
                let changed = login != needsLogin.contains(share.key)
                if login { needsLogin.insert(share.key) } else { needsLogin.remove(share.key) }
                lock.unlock()
                if changed { dropAnswers(); DispatchQueue.main.async { self.onChange?() } }
            }
        }
    }

    // MARK: events

    /// Starts watching (once): mounts, unmounts, renames, wake, the network, and a look every 5 s.
    func start() {
        lock.lock()
        let first = !started
        started = true
        lock.unlock()
        guard first else { return }
        let center = NSWorkspace.shared.notificationCenter
        for name in [NSWorkspace.didMountNotification, NSWorkspace.didUnmountNotification, NSWorkspace.didRenameVolumeNotification] {
            center.addObserver(forName: name, object: nil, queue: nil) { [weak self] _ in self?.events.poke() }
        }
        center.addObserver(forName: NSWorkspace.willSleepNotification, object: nil, queue: nil) { [weak self] _ in self?.sleeping(true) }
        center.addObserver(forName: NSWorkspace.didWakeNotification, object: nil, queue: nil) { [weak self] _ in self?.sleeping(false); self?.networkChanged() }
        // macOS says it will unmount a disk when someone ejects it; a share it drops itself only goes
        center.addObserver(forName: NSWorkspace.willUnmountNotification, object: nil, queue: nil) { [weak self] n in
            guard let self, let path = (n.userInfo?[NSWorkspace.volumeURLUserInfoKey] as? URL)?.path else { return }
            self.work.async { self.ejecting(path) }
        }
        let monitor = NWPathMonitor()
        monitor.pathUpdateHandler = { [weak self] _ in self?.networkChanged() }
        monitor.start(queue: work)
        self.monitor = monitor
        let timer = DispatchSource.makeTimerSource(queue: work)
        timer.schedule(deadline: .now() + 5, repeating: 5)
        timer.setEventHandler { [weak self] in self?.refresh() }
        timer.resume()
        self.timer = timer
        events.poke()
    }

    /// Looks at the disks again soon (a setting changed).
    func lookAgain() { events.poke() }

    private func sleeping(_ now: Bool) {
        lock.lock()
        asleep = now
        if !now { wokeAt = Date() }
        lock.unlock()
    }

    /// On `work`, so a look can't clear it while the share is still mounted.
    private func ejecting(_ path: String) {
        lock.lock()
        let ejected = !asleep && Date().timeIntervalSince(wokeAt) > 10
        lock.unlock()
        guard ejected, let key = diskList().first(where: { $0.path == path && $0.network })?.key else { return }
        var list = shares
        guard let i = list.firstIndex(where: { $0.key == key }) else { return }
        list[i].ejected = true
        shares = list
    }

    /// The network changed or this Mac woke: shares are tried again at once, and looked at again after 5 and 30 s (a
    /// share reconnects late).
    private func networkChanged() {
        lock.lock()
        nextTry = [:]
        lock.unlock()
        events.poke()
        for after in [5.0, 30.0] { work.asyncAfter(deadline: .now() + after) { [weak self] in self?.events.poke() } }
    }

    /// The disks read again, each network disk checked, missing shares connected; the server and the page told when
    /// something changed.
    private func refresh() {
        DiskCache.shared.readNow()
        let disks = diskList()
        // a disk mounted again at the same path starts afresh
        let mounted = Set(disks.filter(\.network).map(\.path))
        lock.withLock {
            away.formIntersection(mounted)
            checkedAt = checkedAt.filter { mounted.contains($0.key) }
        }
        MediaFiles.addRootGrants(disks: disks)
        let group = DispatchGroup()
        for d in disks where d.network {
            group.enter()
            calls.async { _ = self.answers(d.path, fresh: true); group.leave() }
        }
        group.wait()
        connectMissing(disks)
        notify()
    }

    /// Tells the server and the page when the disks or which of them are away changed since the last time.
    private func notify() {
        let disks = diskList()
        lock.lock()
        let now = disks.map(\.path).sorted().joined(separator: "\n") + "|" + away.filter { a in disks.contains { $0.path == a } }.sorted().joined(separator: "\n")
        let same = now == lastNotified
        lastNotified = now
        lock.unlock()
        guard !same else { return }
        dropAnswers()
        DispatchQueue.main.async {
            self.onChange?()
            NotificationCenter.default.post(name: Places.changed, object: nil)   // the location agents scan (LocationAgent.swift)
        }
    }

    /// The check answers kept are stale (a disk changed, or Find missing files found some).
    func dropAnswers() {
        lock.lock()
        kept = [:]
        lock.unlock()
    }

    /// A disk report with `away` on a network disk whose last check had no answer.
    func withAway(_ report: [String: Any]) -> [String: Any] {
        guard report["network"] as? Bool == true, let path = report["path"] as? String, isAway(mount: path) else { return report }
        var r = report
        r["away"] = true
        return r
    }
}
