import Foundation

// The proxy cache this Mac's worker keeps for a server elsewhere (api/work/cache.ts): <the server's relay folder>/work/
// proxies/<account>/<version>.mp4, one folder per account signed in to that server; kept until emptied. The page plays
// from it (Available offline: it plays without internet) through ctlocal://media, without a grant, as it is this app's
// own data. Only from the folder of the account the window is signed in to on that server, as that server said
// (GET /api/auth/check with the window's cookies, never anything from the page), and only for a page of that server.
// Remembered per server while the app runs, so it still plays when the server doesn't answer.

/// The Download location (UNIFIED-PRD M15): the folder workers keep their download cache in, one folder in it per server
/// (ProxyCache.root), passed as CT_PROXY_DIR (api/work/cache.ts). Nil = each server's default folder under its data, also
/// while the picked folder's disk is not connected (nothing is written under /Volumes on the internal disk).
enum DownloadLocation {
    static let key = "downloadLocation"
    static let defaultName = "Creator Toolset Downloads"

    static func path(_ defaults: UserDefaults = .standard, mounted: [String]? = nil) -> String? {
        guard let p = defaults.string(forKey: key), !p.isEmpty else { return nil }
        guard p.hasPrefix("/Volumes/") else { return p }
        return CacheFolder.connected(p, mounted ?? mountPaths()) ? p : nil
    }

    private static let lock = NSLock()
    private static var settling = false
    /// While caches move into the Download location, no worker starts (Worker.start) and no other folder is taken
    /// (chooseDownloadFolder): nothing writes into a folder being moved.
    static var isMoving: Bool { lock.withLock { settling } }

    /// Brings the caches to the Download location: with none picked yet, it becomes "Creator Toolset Downloads" on the
    /// Cache folder's default disk once every server's cache fits there; then, while it is connected, each server's cache
    /// in its default folder (every relay folder's work/proxies: all of them before, or downloaded while its disk was
    /// away) moves to its folder there. A move that fails is tried again the next time (a launch, a disk coming back), so
    /// a cache is never left where nothing reads it. Whether anything changed.
    @discardableResult
    static func settle(defaults: UserDefaults = .standard, volumes: () -> [CacheFolder.Volume] = CacheFolder.volumes,
                       used: [String] = MediaFiles.usedFolders, mounted: [String]? = nil, relays: [URL] = ProxyCache.relays(),
                       free: (URL) -> Int64? = ProxyCacheMove.freeSpace) -> Bool {
        let fm = FileManager.default
        let moves = { (location: URL) in
            relays.map { ($0.appendingPathComponent("work/proxies", isDirectory: true), location.appendingPathComponent($0.lastPathComponent, isDirectory: true)) }
                .filter { fm.fileExists(atPath: $0.0.path) }
        }
        var changed = false
        if (defaults.string(forKey: key) ?? "").isEmpty {
            guard let disk = CacheFolder.largest(volumes(), used: used) else { return false }
            let to = URL(fileURLWithPath: disk.path).appendingPathComponent(defaultName, isDirectory: true)
            // taken only once it can be written and every cache fits there
            guard (try? fm.createDirectory(at: to, withIntermediateDirectories: true)) != nil else { return false }
            let needed = moves(to).reduce(Int64(0)) { $0 + ProxyCacheMove.size($1.0) }
            guard needed == 0 || (free(to) ?? 0) >= needed else { return false }
            defaults.set(to.path, forKey: key)
            changed = true
        }
        guard let location = path(defaults, mounted: mounted) else { return changed }
        // a download still being written stays (a busy worker writes it there) and comes along the next time
        let fresh = { (f: URL) in
            f.pathExtension == "part" && ((try? f.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate).map { -$0.timeIntervalSinceNow < 600 } ?? false)
        }
        for (from, to) in moves(URL(fileURLWithPath: location)) where ProxyCacheMove.size(from) > 0 {
            if (try? ProxyCacheMove.move(from: from, to: to, free: free, busy: fresh)) != nil { changed = true }
        }
        return changed
    }

    /// settle off the main thread, workers held meanwhile; `done` on the main thread when anything changed.
    static func settleInBackground(done: @escaping @MainActor () -> Void) {
        let started = lock.withLock { () -> Bool in
            guard !settling else { return false }
            settling = true
            return true
        }
        guard started else { return }
        DispatchQueue.global(qos: .utility).async {
            let changed = settle()
            lock.withLock { settling = false }
            if changed { DispatchQueue.main.async { MainActor.assumeIsolated { done() } } }
        }
    }
}

/// The Cache folder (Settings → Storage › This computer): where this Mac keeps disposable working files every workspace
/// shares, reported to the server (contracts/providers.ts Machine.cacheFolder) for the AI Editor worker's work folder.
/// The person's pick, else a folder on the largest external disk that holds a folder this app already reads (so macOS
/// asks nobody about a new disk), else nil: the internal disk's own defaults. `path()` (what this Mac uses) falls back the
/// same way for a pick whose disk is not connected; `reported()` (the device report and the Settings row) keeps the pick,
/// so the editor worker waits for its disk instead of moving elsewhere. Changing it moves nothing.
enum CacheFolder {
    static let key = "cacheFolder"
    static let folderName = "Creator Toolset Cache"

    struct Volume: Equatable {
        var path: String
        var bytes: Int64
        /// a disk of its own attached to this Mac: not a share, a cloud drive or another program's mount, nor a volume or
        /// partition of the internal disk
        var external = true
    }

    static func chosen(_ defaults: UserDefaults = .standard) -> String? {
        guard let p = defaults.string(forKey: key), !p.isEmpty else { return nil }
        return p
    }

    static func path(_ defaults: UserDefaults = .standard, volumes: () -> [Volume] = volumes, used: [String] = MediaFiles.usedFolders,
                     mounted: [String]? = nil) -> String? {
        if let p = chosen(defaults), connected(p, mounted ?? mountPaths()) { return p }
        return largest(volumes(), used: used).map { ($0.path as NSString).appendingPathComponent(folderName) }
    }

    /// What the device report says (Machine.cacheFolder): the pick even while its disk is away (a missing disk is not "no
    /// choice": the editor worker waits for it rather than moving onto another disk), else the default, else "" (none).
    static func reported(_ defaults: UserDefaults = .standard, volumes: () -> [Volume] = volumes, used: [String] = MediaFiles.usedFolders) -> String {
        chosen(defaults) ?? path(defaults, volumes: volumes, used: used, mounted: []) ?? ""
    }

    /// The device report's fields: the folder (reported) and whether the person picked it in Settings. The editor worker
    /// follows only a pick: the automatic default moves by itself as disks come and go.
    static func reportFields(_ defaults: UserDefaults = .standard, volumes: () -> [Volume] = volumes, used: [String] = MediaFiles.usedFolders) -> [String: Any] {
        ["cacheFolder": reported(defaults, volumes: volumes, used: used), "cacheFolderPicked": chosen(defaults) != nil]
    }

    /// The largest external disk holding one of `used` (folders this app already reads).
    static func largest(_ volumes: [Volume], used: [String]) -> Volume? {
        volumes.filter { v in v.external && used.contains { $0 == v.path || $0.hasPrefix(v.path + "/") } }.max { $0.bytes < $1.bytes }
    }

    /// The internal disk always is; a folder under /Volumes only while its volume is mounted (`mounted`: the mount points).
    static func connected(_ p: String, _ mounted: [String]) -> Bool {
        !p.hasPrefix("/Volumes/") || mounted.contains { $0.hasPrefix("/Volumes/") && (p == $0 || p.hasPrefix($0 + "/")) }
    }

    /// The mounted volumes under /Volumes that files are kept on (diskReport's rules), never waiting on a share; whether
    /// a local one is external comes from Disk Arbitration, never from the volume (asking it counts as reading it).
    static func volumes() -> [Volume] {
        mountedFileSystems().compactMap { st in
            let block = Int64(st.f_bsize)
            let facts = VolumeFacts(path: cField(st.f_mntonname), freeBytes: Int64(st.f_bavail) * block, totalBytes: Int64(st.f_blocks) * block,
                                    fstype: cField(st.f_fstypename), source: cField(st.f_mntfromname),
                                    readOnly: st.f_flags & UInt32(MNT_RDONLY) != 0, browsable: st.f_flags & UInt32(MNT_DONTBROWSE) == 0)
            guard facts.path.hasPrefix("/Volumes/"), let report = diskReport(facts) else { return nil }
            let local = st.f_flags & UInt32(MNT_LOCAL) != 0 && report["network"] as? Bool != true
            return Volume(path: facts.path, bytes: facts.totalBytes, external: local && volumeIsInternal(at: facts.path) == false)
        }
    }
}

enum ProxyCacheMoveError: Error, Equatable {
    case noSpace(needed: Int64, free: Int64)
    /// the new folder is inside the one it moves from: it would sink a level deeper on every move
    case inside
}

/// A Download location change (UNIFIED-PRD M15): the cache's files move to the new folder, kept ones too (a kept proxy
/// may be the only copy). Nothing is moved unless the new disk has room for all of them.
enum ProxyCacheMove {
    static func freeSpace(_ folder: URL) -> Int64? {
        (try? folder.resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey]))?.volumeAvailableCapacityForImportantUsage
    }

    /// Every file in a folder, at any depth.
    private static func files(_ root: URL) -> [URL] {
        (FileManager.default.enumerator(at: root, includingPropertiesForKeys: [.isRegularFileKey, .fileSizeKey])?.allObjects as? [URL] ?? [])
            .filter { (try? $0.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile) == true }
    }

    /// The bytes of every file in a folder.
    static func size(_ folder: URL) -> Int64 {
        files(folder.resolvingSymlinksInPath()).reduce(Int64(0)) { $0 + Int64((try? $1.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0) }
    }

    /// The worker's lists beside its files (api/work/cache.ts): two folders' lists are merged, never one dropped, or a proxy
    /// made here (kept.json: the only copy) would lose its protection from the size limit.
    static let lists = ["kept.json", "offline.json", "made.json"]

    /// `busy`: a file left where it is this time (a download still being written).
    static func move(from: URL, to: URL, free: (URL) -> Int64? = freeSpace, busy: (URL) -> Bool = { _ in false }) throws {
        guard from.standardizedFileURL.path != to.standardizedFileURL.path else { return }
        guard !to.resolvingSymlinksInPath().path.hasPrefix(from.resolvingSymlinksInPath().path + "/") else { throw ProxyCacheMoveError.inside }
        let fm = FileManager.default
        // the enumerator returns real paths (/var → /private/var), so the base is resolved too, or the relative paths come out wrong
        let root = from.resolvingSymlinksInPath()
        let files = files(root).filter { !busy($0) }
        let needed = files.reduce(Int64(0)) { $0 + Int64((try? $1.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0) }
        try fm.createDirectory(at: to, withIntermediateDirectories: true)
        let have = free(to) ?? 0
        guard needed == 0 || have >= needed else { throw ProxyCacheMoveError.noSpace(needed: needed, free: have) }
        for file in files {
            let rel = String(file.resolvingSymlinksInPath().path.dropFirst(root.path.count)).trimmingCharacters(in: CharacterSet(charactersIn: "/"))
            let target = to.appendingPathComponent(rel)
            try fm.createDirectory(at: target.deletingLastPathComponent(), withIntermediateDirectories: true)
            if !fm.fileExists(atPath: target.path) {
                try fm.moveItem(at: file, to: target)
            } else if lists.contains(file.lastPathComponent) {
                try merge(file, into: target)
                try fm.removeItem(at: file)
            } else {
                // the same version is already there (the target's copy wins, never overwritten): this one goes
                try fm.removeItem(at: file)
            }
        }
    }

    /// A list (ids) or made.json (id → size) joined into the target's: the target's entries win.
    static func merge(_ file: URL, into target: URL) throws {
        let read = { (u: URL) in (try? Data(contentsOf: u)).flatMap { try? JSONSerialization.jsonObject(with: $0) } }
        let merged: Any
        switch (read(file), read(target)) {
        case let (a as [String], b as [String]): merged = b + a.filter { !b.contains($0) }
        case let (a as [String: Any], b as [String: Any]): merged = a.merging(b) { _, theirs in theirs }
        case let (a?, nil): merged = a
        default: return
        }
        try JSONSerialization.data(withJSONObject: merged).write(to: target, options: .atomic)
    }
}

enum ProxyCache {
    /// Where this server's cache is when no Download location is chosen (api/work/cache.ts: DATA_DIR/proxies).
    static func defaultRoot(server: URL, localData: URL?) -> URL {
        relayFolder(for: server, localData: localData).appendingPathComponent("work/proxies", isDirectory: true)
    }

    /// A server's relay folder (ClaudeRequest.swift relayFolder); the tests give their own.
    static var relay: (URL) -> URL = { relayFolder(for: $0, localData: nil) }
    /// Every server's relay folder on this Mac (not This Mac's own server's: its worker never runs); the tests give their own.
    static var relays: () -> [URL] = {
        (try? FileManager.default.contentsOfDirectory(at: appSupport.appendingPathComponent("relay"), includingPropertiesForKeys: nil)) ?? []
    }

    /// Where a server's worker keeps its cache (CT_PROXY_DIR) and the page plays it from: its folder in the Download
    /// location, named as its relay folder (two servers' accounts of one name never share one), else its default folder.
    /// The worker's CT_PROXY_DIR for `server`: its folder in the Download location; nil for its default (DATA_DIR/proxies).
    static func workerDir(server: URL) -> String? { DownloadLocation.path().map { root(server: server, location: $0).path } }

    static func root(server: URL, location: String? = DownloadLocation.path()) -> URL {
        guard let location else { return relay(server).appendingPathComponent("work/proxies", isDirectory: true) }
        return URL(fileURLWithPath: location).appendingPathComponent(relay(server).lastPathComponent, isDirectory: true)
    }

    private static let lock = NSLock()
    /// per server (its relay folder's path): the account the window was last signed in to there
    private static var accounts: [String: String] = [:]

    private static func key(_ server: URL) -> String { relay(server).path }

    /// What GET /api/auth/check says: the account signed in; none while an admin views as another account.
    struct Check: Decodable {
        let authed: Bool
        let user: User?
        let viewedBy: String?
        struct User: Decodable { let username: String }
        var account: String? { authed && viewedBy == nil ? user?.username : nil }
    }

    static func remember(_ account: String?, for server: URL) {
        lock.withLock { accounts[key(server)] = account }
    }

    /// The window's account on `site`'s server, asked of the server and remembered; when the server doesn't answer
    /// (`offline`), the one remembered. Nil when signed out or the answer is not one.
    static func account(_ site: Site) async -> (name: String?, offline: Bool) {
        do {
            let check: Check = try await site.get("/api/auth/check", timeout: 4)
            remember(check.account, for: site.base)
            return (check.account, false)
        } catch is URLError {
            return (lock.withLock { accounts[key(site.base)] }, true)
        } catch {
            remember(nil, for: site.base)
            return (nil, false)
        }
    }

    /// An account's cache folder on a server; nil for a name that isn't a plain account name (api/users.ts USERNAME_RE,
    /// which its folder name, encodeURIComponent of it, leaves as it is).
    static func folder(server: URL, account: String) -> URL? {
        guard !account.isEmpty, account.count <= 100,
              account.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-" || $0 == "_") }) else { return nil }
        return root(server: server).appendingPathComponent(account, isDirectory: true)
    }

    /// The cache folder a page at `page` may play from: its server's, of the account last said signed in there.
    static func allowed(page: URL?) -> String? {
        guard let page, page.scheme == "http" || page.scheme == "https" else { return nil }
        guard let account = lock.withLock({ accounts[key(page)] }) else { return nil }
        return folder(server: page, account: account)?.path
    }

    /// per server: the account check under way, so the many first requests of a page make one
    private static var asking: [String: Task<Void, Never>] = [:]

    /// `allowed(page:)`, with the page's server asked for the window's account first when none is known yet (a page
    /// that plays proxies before any places check, such as the editor). Nil when signed out.
    static func allowed(page: URL?, site: @escaping () async -> Site) async -> String? {
        if let known = allowed(page: page) { return known }
        guard let page, page.scheme == "http" || page.scheme == "https" else { return nil }
        let k = key(page)
        let check = lock.withLock {
            if let running = asking[k] { return running }
            let running = Task { _ = await account(await site()); lock.withLock { asking[k] = nil } }
            asking[k] = running
            return running
        }
        await check.value
        return allowed(page: page)
    }

    /// The ctlocal://media address of a version's proxy in `folder`, only when the media gate serves it from there (its
    /// real path inside the folder); nil when it isn't there (a download still going is a .part).
    static func url(_ version: String, in folder: URL) -> String? {
        guard !version.isEmpty, !version.contains("/"), !version.hasPrefix(".") else { return nil }
        let file = folder.appendingPathComponent("\(version).mp4").path
        guard case .file = MediaFiles.gate(file, granted: [], roots: [], cache: folder.path) else { return nil }
        return MediaFiles.url(path: file).absoluteString
    }
}
