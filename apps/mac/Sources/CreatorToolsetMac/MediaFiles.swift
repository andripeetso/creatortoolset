import Foundation

// An edit's original video and sound files for the page's player, as `ctlocal://media/<base64url of the path>`
// (ProjectScheme.swift serves them). The page knows the paths, but this app decides: a file is served only when it is a
// video or sound file, exists, and its real path (symlinks resolved) is inside a folder the user chose in this app's
// own open panel (the "mediaAccess" message, TitleBar.swift). The originals are private footage, so anything else
// gets a status and no contents, and a missing file outside the folders reads as not granted, never as missing.

enum MediaFiles {
    static let host = "media"
    private static let key = "mediaFolders"

    /// The file types served, by lowercased extension (camera files are often .MOV, .MP4, .WAV).
    static let types: [String: String] = [
        "mov": "video/quicktime", "mp4": "video/mp4", "m4v": "video/x-m4v", "mxf": "application/mxf",
        "wav": "audio/wav", "aif": "audio/aiff", "aiff": "audio/aiff", "m4a": "audio/mp4", "mp3": "audio/mpeg",
        "flac": "audio/flac", "caf": "audio/x-caf",
    ]

    /// The granted folders, as chosen in the open panel.
    static var granted: [String] { UserDefaults.standard.stringArray(forKey: key) ?? [] }

    static func add(_ folder: String) {
        guard !granted.contains(folder) else { return }
        UserDefaults.standard.set(granted + [folder], forKey: key)
    }

    static func remove(_ folder: String) {
        UserDefaults.standard.set(granted.filter { $0 != folder }, forKey: key)
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
        case status(Int)                  // 403 not granted, 404 missing, 415 not a media file
    }

    static func gate(_ path: String, granted: [String]) -> Gate {
        let parts = path.split(separator: "/")
        guard path.hasPrefix("/"), !parts.contains(".."), !parts.contains(".") else { return .status(403) }
        guard type(of: path) != nil else { return .status(415) }
        let folders = granted.compactMap(realPath)
        let inside = { (p: String) in folders.contains { p == $0 || p.hasPrefix($0 == "/" ? "/" : $0 + "/") } }
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

    /// Symlinks and `/private` resolved, in one Unicode form (a folder's name may be stored decomposed); nil when missing.
    private static func realPath(_ path: String) -> String? {
        guard let r = realpath(path, nil) else { return nil }
        defer { free(r) }
        return String(cString: r).precomposedStringWithCanonicalMapping
    }
}
