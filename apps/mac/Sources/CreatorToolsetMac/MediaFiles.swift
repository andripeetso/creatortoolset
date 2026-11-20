import Foundation

// An edit's original video and sound files for the page's player, as `ctlocal://media/<base64url of the path>`
// (ProjectScheme.swift serves them). The page knows the paths, but this app decides: a file is served only when it is a
// video or sound file, exists, and its real path (symlinks resolved) is inside a folder the user chose in this app's
// own open panel (the "mediaAccess" message, TitleBar.swift), dropped on its window (a dropped folder, a loose file's
// folder), picked for the page in its open panel (a picked folder, or a picked file alone: Shell.swift), chosen as the
// folder with the videos (ThisMacBridge.swift chooseFolder) or copied into by a Media Library import (Import.swift). The originals are private footage, so anything else
// gets a status and no contents, and a missing file outside the folders reads as not granted, never as missing.
// Each folder is also kept by its root (Places.swift): the disk's root key and the folder's path inside it, so a share
// mounted again at another path (/Volumes/footage-1) is still the folder that was granted. A file on a network disk
// that doesn't answer gets 503 at once (Places.guarded), never a wait; one that answers gets up to 10 s for the first read
// (a share waking up), and a slow one never marks the disk away. A granted file on a drive that is not connected
// gets 409 with the drive's name (disk_away), never 403. The proxy cache of the account the window is signed
// in to on the page's server plays without a grant (ProxyCache.swift); every other account's cache is outside.

enum MediaFiles {
    static let host = "media"
    private static let key = "mediaFolders"

    /// The file types served, by lowercased extension (camera files are often .MOV, .MP4, .WAV); pictures for a
    /// Media Library rescan's thumbnails.
    static let types: [String: String] = [
        "mov": "video/quicktime", "mp4": "video/mp4", "m4v": "video/x-m4v", "mxf": "application/mxf",
        "wav": "audio/wav", "aif": "audio/aiff", "aiff": "audio/aiff", "m4a": "audio/mp4", "mp3": "audio/mpeg",
        "flac": "audio/flac", "caf": "audio/x-caf",
        "jpg": "image/jpeg", "jpeg": "image/jpeg", "png": "image/png", "heic": "image/heic", "webp": "image/webp",
        "gif": "image/gif", "tif": "image/tiff", "tiff": "image/tiff", "heif": "image/heif",
        // camera RAW: macOS reads these (Import.thumb, MacIndex) where a web page can't
        "dng": "image/x-adobe-dng", "cr2": "image/x-canon-cr2", "cr3": "image/x-canon-cr3", "arw": "image/x-sony-arw",
        "nef": "image/x-nikon-nef", "raf": "image/x-fuji-raf", "rw2": "image/x-panasonic-rw2", "orf": "image/x-olympus-orf",
    ]

    /// A video, sound or picture file by its name.
    static func isMedia(_ path: String) -> Bool { type(of: path) != nil }

    /// A drop on the window: each dropped folder, and each loose file's folder, may be played and scanned from then on.
    static func grantDropped(_ items: [[String: Any]]) {
        for item in items {
            guard let path = item["path"] as? String else { continue }
            add(item["folder"] as? Bool == true ? path : (path as NSString).deletingLastPathComponent)
        }
    }

    /// What a person dropped on this app's window, exactly (a dropped file itself, never its folder), with the server and
    /// workspace the page it was dropped on is in, and when (import:chosen, Import.swift): the only places outside the
    /// Media folders the AI Editor's worker copies a source in from, and only for an edit of that server's workspace
    /// within a week (apps/editor worker.py dropped_here). [{path, server, workspace, at}], the newest 500.
    static let copyFromKey = "copyFrom"
    static func chosen(_ paths: [String], server: String, workspace: String, now: Date = Date()) {
        let same = { (e: [String: Any]) in paths.contains(e["path"] as? String ?? "") && e["server"] as? String == server && e["workspace"] as? String == workspace }
        // an entry from before (a bare path, no workspace) is dropped: it never let anything be copied
        let old = (defaults.array(forKey: copyFromKey) ?? []).compactMap { $0 as? [String: Any] }.filter { !same($0) }
        let new: [[String: Any]] = paths.map { ["path": $0, "server": server, "workspace": workspace, "at": now.timeIntervalSince1970] }
        defaults.set(Array((old + new).suffix(500)), forKey: copyFromKey)
    }

    /// The granted folders, as chosen in the open panel.
    /// A pick in this app's open panel for the page (a file input: the Media Library's Add, an edit's footage): each
    /// picked folder, and each picked file by itself, never the folder it is in (that holds files nobody picked). A
    /// file indexed in the Media Library from there is read on this Mac later (its shot descriptions, its transcript,
    /// playing its original), so the pick is the grant. `gate` takes a granted path that is the file itself.
    static func grantPicked(_ urls: [URL], grant: (String) -> Void = add) {
        for url in urls { grant(url.path) }
    }

    static var granted: [String] { defaults.stringArray(forKey: key) ?? [] }

    static func add(_ folder: String) {
        if !granted.contains(folder) { defaults.set(granted + [folder], forKey: key) }
        // picked or dropped here: a Settings → Folders folder at or under it needs no OK (LocationAgent.swift)
        let picked = defaults.stringArray(forKey: pickedKey) ?? []
        if !picked.contains(folder) { defaults.set(picked + [folder], forKey: pickedKey) }
        addRootGrants(disks: Places.shared.diskList())
    }

    // MARK: per server (local first): the Settings → Folders folders each server lists for this Mac

    /// One Settings → Folders folder of this Mac, as its server lists it (GET /api/devices/relay/folders, RelayFolder).
    struct ServerFolder: Codable, Equatable {
        let id: String
        /// the path on this Mac (hostPath)
        let path: String
        /// workspace ids; ["*"] for every workspace
        let workspaces: [String]
        let use: String
        /// a Media folder's workspaces whose footage leaves only blurred, by name (RelayFolder.guarded); nil: the server
        /// didn't say (an older one), read as guarded (blurredElsewhere fails closed)
        var guarded: [String]? = nil
    }

    /// The store; the tests give their own.
    static var defaults = UserDefaults.standard
    private static let serversKey = "serverFolders"     // [server: [ServerFolder]], replaced on each pull
    private static let allowedKey = "allowedFolders"    // [server: [folder id]], "Allow on this Mac" pressed (paths before: migrated in setServerFolders)
    private static let pickedKey = "pickedFolders"      // [path], chosen in an open panel or dropped since this list began

    /// A server by its address as the grants key it: host and port (the window's page, or an agent's base).
    static func serverKey(_ url: URL?) -> String {
        guard let url, let host = url.host else { return "" }
        return url.port.map { "\(host):\($0)" } ?? host
    }

    private static func decoded<T: Decodable>(_ key: String) -> [String: T] {
        defaults.data(forKey: key).flatMap { try? JSONDecoder().decode([String: T].self, from: $0) } ?? [:]
    }
    private static func encode<T: Encodable>(_ value: [String: T], _ key: String) { defaults.set(try? JSONEncoder().encode(value), forKey: key) }

    static func serverFolders(_ server: String) -> [ServerFolder] { (decoded(serversKey) as [String: [ServerFolder]])[server] ?? [] }

    /// The pull replaces the server's list: a folder it no longer lists loses its grant (its OK goes with it). An empty
    /// list is not an answer to trust (a failed or half-made one): the last good list and its OKs stay. Returns the list in effect.
    @discardableResult
    static func setServerFolders(_ list: [ServerFolder], server: String) -> [ServerFolder] {
        guard !list.isEmpty else { return serverFolders(server) }
        let before = serverFolders(server)
        var all: [String: [ServerFolder]] = decoded(serversKey)
        all[server] = list
        encode(all, serversKey)
        var ok: [String: [String]] = decoded(allowedKey)
        // OKs are keyed by folder id: one saved by path (before) becomes the id of the listed folder at that path, and one
        // whose id changed for the same path (a server collapsing duplicate rows) follows its path to the new id
        if let was = ok[server] {
            ok[server] = Array(Set(was.compactMap { x in
                list.first { $0.id == x || $0.path == x }?.id
                    ?? before.first { $0.id == x }.flatMap { old in list.first { $0.path == old.path }?.id }
            }))
        }
        encode(ok, allowedKey)
        return list
    }

    /// Each Settings → Folders Media folder of `server` this Mac may read, with "Imports" after it: where that server's
    /// page copies a file from outside the Media folders (the import rule, contracts/storage.ts importTarget). Never
    /// another server's: a page from one server never fills another's library.
    static func importsFolders(server: String, allowed: Bool = true) -> [String] {
        serverFolders(server).filter { $0.use == "media" && isAllowed($0.path, server: server) == allowed }.map { ($0.path as NSString).appendingPathComponent("Imports") }
    }

    /// Every Settings → Folders Media folder of every server this Mac is signed in to (a device token for its host), of
    /// every workspace, allowed here or not: a file inside one is never copied into any library (Import.swift copy), so
    /// one server's footage never lands in another's. A server with no sign-in left never blocks a drop.
    static func signedInMediaFolders(signedIn: (String) -> Bool = { DeviceVault.token(for: $0) != nil }) -> [String] {
        signedInServers(signedIn).values.flatMap { $0.filter { $0.use == "media" }.map(\.path) }
    }

    /// Each stored server's folder list, of the servers this Mac has a sign-in for (a device token for the host). The key
    /// is host or host:port; an IPv6 host has colons of its own, so both readings are asked (never fails open).
    static func signedInServers(_ signedIn: (String) -> Bool) -> [String: [ServerFolder]] {
        (decoded(serversKey) as [String: [ServerFolder]]).filter { key, _ in signedIn(key) || key.lastIndex(of: ":").map { signedIn(String(key[..<$0])) } == true }
    }

    /// Why a drop or pick of `paths` on a page of `server` is refused: one of them lies in (or holds) a Media folder of a
    /// workspace whose footage leaves only blurred (Blur faces, or a plug-in serves its media) on ANOTHER server this Mac
    /// is signed in to: the page would upload it there unblurred. Nil when none does. A drag into that workspace's own
    /// server is its own gate's (P2). A server that doesn't say which of its workspaces blur counts as all of them. Real
    /// paths for a folder whose disk answers; by name for one that doesn't (a NAS away never holds the window up).
    static func blurredElsewhere(_ paths: [String], server: String, signedIn: (String) -> Bool = { DeviceVault.token(for: $0) != nil },
                                 reachable: (String) -> Bool = { Places.shared.reachable($0) }) -> String? {
        let page = server.lowercased()
        // each dropped path resolved once (links followed); "/" (the whole disk) holds everything
        let mine = paths.map { (given: $0, real: Imports.resolved($0)) }
        let under = { (p: String, root: String) in root == "/" || p == root || p.hasPrefix(root + "/") }
        for (key, folders) in signedInServers(signedIn) where key.lowercased() != page {
            for f in folders where f.use == "media" && f.guarded != [] {
                // a folder whose disk answers by its real path, resolved once; one that doesn't by name, never waited on
                let root = reachable(f.path) ? Imports.resolved(f.path) : f.path.precomposedStringWithCanonicalMapping
                let workspace = f.guarded?.first
                for (p, real) in mine {
                    let at = reachable(f.path) ? real : p.precomposedStringWithCanonicalMapping
                    let into = under(at, root), holds = !into && under(root, at)
                    guard into || holds else { continue }
                    let what = holds ? "\(p) holds" : "\(p) is in"
                    guard let workspace else { return "\(what) a Media folder on \(key) that hasn't said whether it must be blurred: add it from that server's own page" }
                    return "\(what) \(workspace)'s Media folder on \(key): blurred footage only leaves through \(workspace)"
                }
            }
        }
        return nil
    }

    /// "Allow on this Mac" (the page's folderGrant, a press): only a folder the server lists for this Mac.
    @discardableResult
    static func allow(_ path: String, server: String) -> Bool {
        guard let folder = serverFolders(server).first(where: { $0.path == path }) else { return false }
        var ok: [String: [String]] = decoded(allowedKey)
        if ok[server]?.contains(folder.id) != true { ok[server, default: []].append(folder.id) }
        encode(ok, allowedKey)
        return true
    }

    /// Whether this Mac may read a server's folder: OK'd for that server, or at or under a folder picked or dropped here.
    static func isAllowed(_ path: String, server: String) -> Bool {
        let ok: [String: [String]] = decoded(allowedKey)
        // an OK saved by path before the id key still counts until a pull migrates it (setServerFolders)
        if serverFolders(server).contains(where: { $0.path == path && (ok[server]?.contains($0.id) == true || ok[server]?.contains($0.path) == true) }) { return true }
        return Imports.inside(path, defaults.stringArray(forKey: pickedKey) ?? []) != nil
    }

    /// The folders of `folders` this Mac may read for a clip of `workspace` (nil: any workspace of that server).
    static func folderGrants(_ folders: [ServerFolder], workspace: String?, allowed: (String) -> Bool) -> [String] {
        folders.filter { f in (workspace == nil || f.workspaces.contains("*") || f.workspaces.contains(workspace!)) && allowed(f.path) }.map(\.path)
    }

    /// What the page of `server` may play for a clip of `workspace`: the open-panel and drop grants (kept as they were,
    /// DM10) and that server's allowed folders in that workspace. With `rootGrants` (the gate's `roots`), the one grant
    /// list: serving, the places check and placeState all take it.
    static func granted(server: String, workspace: String?) -> [String] {
        granted + folderGrants(serverFolders(server), workspace: workspace, allowed: { isAllowed($0, server: server) })
    }

    /// The drive of a path on a disk that is not mounted ("/Volumes/Footage/a.mov" with no Footage): its name. The
    /// disk list can lag (empty before its first read), so the mount table has the last word; reading it never waits.
    static func unmountedDisk(_ path: String, disks: [PlaceDisk], mounted: () -> [String] = mountPaths) -> String? {
        guard Places.disk(of: path, in: disks) == nil, path.hasPrefix("/Volumes/"),
              let name = path.split(separator: "/").dropFirst().first.map(String.init) else { return nil }
        let mount = "/Volumes/" + name
        return mounted().contains { $0.precomposedStringWithCanonicalMapping == mount.precomposedStringWithCanonicalMapping } ? nil : name
    }

    /// Whether `path` is at or under one of `folders`, by name alone (no file call: its disk may be gone).
    static func underByName(_ path: String, _ folders: [String]) -> Bool {
        let p = path.precomposedStringWithCanonicalMapping
        return folders.map(\.precomposedStringWithCanonicalMapping).contains { p == $0 || p.hasPrefix($0 == "/" ? "/" : $0 + "/") }
    }

    /// Granted by name, with no file call (its disk may be gone): at or under a granted folder or a root grant's folder,
    /// or inside a root grant on the disk mounted now with that root (a share mounted again at /Volumes/footage-1).
    static func grantedByName(_ path: String, granted: [String], roots: [RootGrant], disks: [PlaceDisk]) -> Bool {
        underByName(path, granted + roots.map(\.path)) || isGranted(path, folders: [], roots: roots, disks: disks)
    }

    /// The page's placesState for one path on `server`: here | not_here | disk_away | not_granted | needs_ok, and the
    /// drive's name for disk_away. The grants are serving's (`granted(server:workspace:)` and `roots`). Reads the file
    /// only when it is granted and its disk is here.
    static func placeState(_ path: String, server: String, workspace: String? = nil, roots: [RootGrant] = rootGrants,
                           places: Places = .shared) -> (state: String, disk: String?) {
        guard isPlain(path) else { return ("not_granted", nil) }
        let disks = places.diskList()
        guard grantedByName(path, granted: granted(server: server, workspace: workspace), roots: roots, disks: disks) else {
            let listed = folderGrants(serverFolders(server), workspace: workspace, allowed: { _ in true })
            return underByName(path, listed) ? ("needs_ok", nil) : ("not_granted", nil)
        }
        if let name = unmountedDisk(path, disks: disks) { return ("disk_away", name) }
        if let disk = Places.disk(of: path, in: disks), disk.network, !places.answers(disk.path) {
            return ("disk_away", disk.name.isEmpty ? (disk.path as NSString).lastPathComponent : disk.name)
        }
        guard let there = places.guarded(path, { FileManager.default.fileExists(atPath: path) }) else {
            return ("disk_away", Places.disk(of: path, in: disks)?.name)
        }
        return (there ? "here" : "not_here", nil)
    }

    static func remove(_ folder: String) {
        defaults.set(granted.filter { $0 != folder }, forKey: key)
        saveRoots(rootGrants.filter { $0.path != folder })
    }

    /// A granted folder by its root: the folder as granted, its disk's root key, and the folder inside that disk.
    struct RootGrant: Codable, Equatable {
        let path: String
        let root: String
        let rel: String
    }

    private static let rootsKey = "mediaRoots"
    static var rootGrants: [RootGrant] {
        defaults.data(forKey: rootsKey).flatMap { try? JSONDecoder().decode([RootGrant].self, from: $0) } ?? []
    }
    private static func saveRoots(_ list: [RootGrant]) { defaults.set(try? JSONEncoder().encode(list), forKey: rootsKey) }

    /// Each granted folder without a root grant gets one once its disk is mounted (the grants made before roots
    /// existed, on the first launch that sees their disk). Reads no file: the disk comes from the mount paths.
    static func addRootGrants(disks: [PlaceDisk]) {
        let old = rootGrants
        let new = rootGrants(for: granted.filter { f in !old.contains { $0.path == f } }, disks: disks)
        if !new.isEmpty { saveRoots(old + new) }
    }

    /// The root grants of these folders whose disk is mounted (a folder on no mounted disk has none yet).
    static func rootGrants(for folders: [String], disks: [PlaceDisk]) -> [RootGrant] {
        folders.compactMap { f in
            guard let disk = Places.disk(of: f, in: disks), let root = disk.key else { return nil }
            return RootGrant(path: f, root: root, rel: Places.rel(f, in: disk.path))
        }
    }

    /// The granted folders as real paths in NFC; one on a network disk as it is (resolving it could wait on its server).
    static func realFolders(_ folders: [String], disks: [PlaceDisk]) -> [String] {
        folders.compactMap { f in Places.disk(of: f, in: disks)?.network == true ? f : realPath(f) }.map(\.precomposedStringWithCanonicalMapping)
    }

    /// Whether a real path lies in a granted folder: under one of `folders` (real, NFC), or on a disk with a granted
    /// root, inside the granted folder's path there.
    static func isGranted(_ path: String, folders: [String], roots: [RootGrant], disks: [PlaceDisk]) -> Bool {
        let p = path.precomposedStringWithCanonicalMapping
        if folders.contains(where: { p == $0 || p.hasPrefix($0 == "/" ? "/" : $0 + "/") }) { return true }
        guard let disk = Places.disk(of: path, in: disks), let key = disk.key else { return false }
        let rel = Places.rel(p, in: disk.path)
        return roots.contains { g in
            let r = g.rel.precomposedStringWithCanonicalMapping
            return g.root == key && (r.isEmpty || rel == r || rel.hasPrefix(r + "/"))
        }
    }

    static func url(path: String) -> URL {
        let b64 = Data(path.utf8).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
        return URL(string: "\(ProjectScheme.scheme)://\(host)/\(b64)")!
    }

    /// The absolute path in a ctlocal://media/<base64url, no padding> URL; nil for anything else.
    static func path(from url: URL) -> String? {
        guard url.host == host else { return nil }
        var b64 = String(url.path.dropFirst())
        guard !b64.isEmpty, b64.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-" || $0 == "_") }) else { return nil }
        b64 = b64.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        b64 += String(repeating: "=", count: (4 - b64.count % 4) % 4)
        guard let data = Data(base64Encoded: b64), let path = String(data: data, encoding: .utf8), path.hasPrefix("/") else { return nil }
        return path
    }

    enum Gate: Equatable {
        case file(String, type: String)   // the real path to read, and its type
        case status(Int)                  // 403 not granted, 404 missing, 415 not a media file, 503 its disk doesn't answer
        case diskAway(String)             // 409 {"state":"disk_away","disk"}: granted, on a drive that is not connected
    }

    /// An absolute path with no `.` or `..` part.
    static func isPlain(_ path: String) -> Bool {
        let parts = path.split(separator: "/")
        return path.hasPrefix("/") && !parts.contains("..") && !parts.contains(".")
    }

    /// A plain path named as a file this app serves: the only paths the places check looks at (Places.swift).
    static func isPlainMedia(_ path: String) -> Bool { isPlain(path) && isMedia(path) }

    /// `cache`: the proxy cache folder this page may play from (ProxyCache.allowed), nil for none. `firstRead`: serving
    /// the file (Places.guarded); `look` the file call, the tests give their own.
    static func gate(_ path: String, granted: [String], roots: [RootGrant] = rootGrants, cache: String? = nil, places: Places = .shared,
                     firstRead: Bool = false, look: @escaping (String, [String], [RootGrant], [PlaceDisk]) -> Gate = MediaFiles.look(_:granted:roots:disks:)) -> Gate {
        guard isPlain(path) else { return .status(403) }
        guard type(of: path) != nil else { return .status(415) }
        let disks = places.diskList()
        let allowed = granted + (cache.map { [$0] } ?? [])
        // a drive that is not connected: granted is told by the folder's name (nothing on it can be resolved)
        if let disk = unmountedDisk(path, disks: disks) {
            return grantedByName(path, granted: allowed, roots: roots, disks: disks) ? .diskAway(disk) : .status(403)
        }
        return places.guarded(path, firstRead: firstRead) { look(path, allowed, roots, disks) } ?? .status(503)
    }

    static func look(_ path: String, granted: [String], roots: [RootGrant], disks: [PlaceDisk]) -> Gate {
        // compared in one Unicode form (a folder's name may be stored decomposed); the file is opened as realpath named it
        let folders = realFolders(granted, disks: disks)
        let inside = { (p: String) in isGranted(p, folders: folders, roots: roots, disks: disks) }
        guard let real = realPath(path) else {
            return .status(realPath(nearestExisting(path)).map(inside) == true ? 404 : 403)
        }
        guard inside(real) else { return .status(403) }
        guard let type = type(of: real) else { return .status(415) }   // a media name linking to another file
        var directory: ObjCBool = false
        guard FileManager.default.fileExists(atPath: real, isDirectory: &directory), !directory.boolValue else { return .status(404) }
        return .file(real, type: type)
    }

    /// The path, or its nearest parent that exists ("/" at worst).
    static func nearestExisting(_ path: String) -> String {
        var p = path
        while p != "/", !FileManager.default.fileExists(atPath: p) { p = (p as NSString).deletingLastPathComponent }
        return p.isEmpty ? "/" : p
    }

    private static func type(of path: String) -> String? { types[(path as NSString).pathExtension.lowercased()] }

    /// Symlinks, `..` and `/private` resolved; nil when missing.
    static func realPath(_ path: String) -> String? {
        guard let r = realpath(path, nil) else { return nil }
        defer { free(r) }
        return String(cString: r)
    }
}
