import Foundation

// An edit's original video and sound files for the page's player, as `ctlocal://media/<base64url of the path>`
// (ProjectScheme.swift serves them). The page knows the paths, but this app decides: a file is served only when it is a
// video or sound file, exists, and its real path (symlinks resolved) is inside a folder the user chose in this app's
// own open panel (the "mediaAccess" message, TitleBar.swift), dropped on its window (a dropped folder, a loose file's
// folder) or copied into by a Media Library import (Import.swift). The originals are private footage, so anything else
// gets a status and no contents, and a missing file outside the folders reads as not granted, never as missing.
// Each folder is also kept by its root (Places.swift): the disk's root key and the folder's path inside it, so a share
// mounted again at another path (/Volumes/footage-1) is still the folder that was granted. A file on a network disk
// that doesn't answer gets 503 at once (Places.guarded), never a wait. The proxy cache of the account the window is signed
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
        "gif": "image/gif", "tif": "image/tiff", "tiff": "image/tiff",
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

    /// The granted folders, as chosen in the open panel.
    static var granted: [String] { UserDefaults.standard.stringArray(forKey: key) ?? [] }

    static func add(_ folder: String) {
        if !granted.contains(folder) { UserDefaults.standard.set(granted + [folder], forKey: key) }
        addRootGrants(disks: Places.shared.diskList())
    }

    static func remove(_ folder: String) {
        UserDefaults.standard.set(granted.filter { $0 != folder }, forKey: key)
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
        UserDefaults.standard.data(forKey: rootsKey).flatMap { try? JSONDecoder().decode([RootGrant].self, from: $0) } ?? []
    }
    private static func saveRoots(_ list: [RootGrant]) { UserDefaults.standard.set(try? JSONEncoder().encode(list), forKey: rootsKey) }

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
    }

    /// `cache`: the proxy cache folder this page may play from (ProxyCache.allowed), nil for none.
    static func gate(_ path: String, granted: [String], roots: [RootGrant] = rootGrants, cache: String? = nil, places: Places = .shared) -> Gate {
        let parts = path.split(separator: "/")
        guard path.hasPrefix("/"), !parts.contains(".."), !parts.contains(".") else { return .status(403) }
        guard type(of: path) != nil else { return .status(415) }
        let disks = places.diskList()
        let allowed = granted + (cache.map { [$0] } ?? [])
        return places.guarded(path) { look(path, granted: allowed, roots: roots, disks: disks) } ?? .status(503)
    }

    private static func look(_ path: String, granted: [String], roots: [RootGrant], disks: [PlaceDisk]) -> Gate {
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
