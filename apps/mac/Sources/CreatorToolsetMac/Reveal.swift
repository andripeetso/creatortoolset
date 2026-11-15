import AppKit
import Foundation

// Show in Finder for a Media Library clip (the page's `reveal:{"path","library"}` ask on the thisMac handler,
// src/pages/library/clip.ts).
// The page sends a path; this app decides. A file is shown only when the path is absolute, has no `.` or `..` parts, is
// an existing file, and its real path (symlinks resolved) is inside a folder this app already trusts: the folders the
// user granted for original media (MediaFiles), and, while the window uses the server on this Mac, that server's data
// folder (clips kept on its disk) and the footage folders the clip's library watches (clips read in place, asked of the
// server itself).
// Missing and not trusted get the same answer, so the page learns nothing about files outside those folders.

func isRevealAsk(_ ask: String) -> Bool { ask.hasPrefix("reveal:") }

/// The path and library id in a reveal ask; nil when it is not one.
func revealAsk(_ ask: String) -> (path: String, library: String)? {
    guard isRevealAsk(ask),
          let json = (try? JSONSerialization.jsonObject(with: Data(ask.dropFirst("reveal:".count).utf8))) as? [String: Any],
          let path = json["path"] as? String, let library = json["library"] as? String,
          !library.isEmpty, library.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "_" || $0 == "-") }) else { return nil }
    return (path, library)
}

enum Reveal {
    static let problem = "That file isn't on this Mac."

    /// The real path to show, or nil when the path may not be shown.
    static func check(_ path: String, trusted: [String]) -> String? {
        let parts = path.split(separator: "/")
        guard path.hasPrefix("/"), !parts.contains(".."), !parts.contains("."), let real = realPath(path) else { return nil }
        var directory: ObjCBool = false
        guard FileManager.default.fileExists(atPath: real, isDirectory: &directory), !directory.boolValue else { return nil }
        // compared in one Unicode form (a folder's name may be stored decomposed); "/" is never trusted as a whole
        let p = real.precomposedStringWithCanonicalMapping
        let inside = trusted.compactMap(realPath).filter { $0 != "/" }.map(\.precomposedStringWithCanonicalMapping)
        return inside.contains { p.hasPrefix($0 + "/") } ? real : nil
    }

    /// Shows the file selected in Finder; the reply is { ok } or { problem }.
    @MainActor static func answer(_ path: String, trusted: [String]) -> [String: Any] {
        guard let real = check(path, trusted: trusted) else { return ["problem": problem] }
        NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: real)])
        return ["ok": true]
    }

    private static func realPath(_ path: String) -> String? {
        guard let r = realpath(path, nil) else { return nil }
        defer { free(r) }
        return String(cString: r)
    }
}

private struct Watch: Decodable {
    struct Folder: Decodable { let path: String }
    let folders: [Folder]
}

extension Site {
    /// The footage folders a library watches ([] for anyone the server does not let see them).
    func watchedFolders(library: String) async -> [String] {
        ((try? await get("/api/library/\(library)/watch")) as Watch?)?.folders.map(\.path) ?? []
    }
}
