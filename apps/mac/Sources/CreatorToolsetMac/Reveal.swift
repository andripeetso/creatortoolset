import AppKit
import Foundation

// Show in Finder for a Media Library clip (the page's `reveal:{"library","asset"}` ask on the thisMac handler,
// src/pages/library/clip.ts), or for a Review version's own file on the computer that made it (`reveal:{"review","v"}`:
// its `local`, which the server gives only to the video's managers). The page names the clip, never a path: this app asks the window's server for the clip's
// file (its sourcePath, which the server gives only to its admin) and shows it only when the path is absolute, has no
// `.` or `..` parts and is an existing file. On the server on this Mac that path is the server's own word (clips kept
// on its disk, read in place from a footage folder, or added in place from the picker or a drop). On a server elsewhere
// the file must also be a video, sound or picture file (by its real path), with no folder to grant first: showing it in Finder
// reads none of it (owner, 2026-11-17: asking for a folder on Show in Finder is "ridiculous"). Missing and refused get
// the same answer.

func isRevealAsk(_ ask: String) -> Bool { ask.hasPrefix("reveal:") }

/// The library and clip ids in a reveal ask; nil when it is not one.
func revealAsk(_ ask: String) -> (library: String, asset: String)? {
    guard isRevealAsk(ask),
          let json = (try? JSONSerialization.jsonObject(with: Data(ask.dropFirst("reveal:".count).utf8))) as? [String: Any],
          let library = json["library"] as? String, let asset = json["asset"] as? String,
          [library, asset].allSatisfy({ id in !id.isEmpty && id.allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "_" || $0 == "-") } })
    else { return nil }
    return (library, asset)
}

/// The Review video and version in a reveal ask for a Review version's own file (`reveal:{"review","v"}`); nil else.
func reviewRevealAsk(_ ask: String) -> (asset: String, n: Int)? {
    guard isRevealAsk(ask),
          let json = (try? JSONSerialization.jsonObject(with: Data(ask.dropFirst("reveal:".count).utf8))) as? [String: Any],
          let asset = json["review"] as? String, let n = json["v"] as? Int, n > 0,
          !asset.isEmpty, asset.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-") })
    else { return nil }
    return (asset, n)
}

enum Reveal {
    static let problem = "That file isn't on this Mac."

    /// The real path to show, or nil when it may not be shown. `anyFile`: any existing file (the server on this Mac named
    /// it); else only a video, sound or picture file. A file on a network disk that doesn't answer is not shown.
    static func check(_ path: String, anyFile: Bool) -> String? {
        let parts = path.split(separator: "/")
        guard path.hasPrefix("/"), !parts.contains(".."), !parts.contains("."), anyFile || MediaFiles.isMedia(path) else { return nil }
        return Places.shared.guarded(path) { look(path, anyFile: anyFile) } ?? nil
    }

    private static func look(_ path: String, anyFile: Bool) -> String? {
        guard let real = realPath(path), anyFile || MediaFiles.isMedia(real) else { return nil }
        var directory: ObjCBool = false
        guard FileManager.default.fileExists(atPath: real, isDirectory: &directory), !directory.boolValue else { return nil }
        return real
    }

    /// Shows the file selected in Finder; the reply is { ok } or { problem }. The file is looked at off the main thread.
    @MainActor static func answer(_ path: String?, anyFile: Bool) async -> [String: Any] {
        let real = await withCheckedContinuation { c in
            DispatchQueue.global(qos: .userInitiated).async { c.resume(returning: path.flatMap { check($0, anyFile: anyFile) }) }
        }
        guard let real else { return ["problem": problem] }
        NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: real)])
        return ["ok": true]
    }

    private static func realPath(_ path: String) -> String? {
        guard let r = realpath(path, nil) else { return nil }
        defer { free(r) }
        return String(cString: r)
    }
}

private struct ClipFile: Decodable { let sourcePath: String? }
private struct ReviewFile: Decodable {
    struct Asset: Decodable { let versions: [Version] }
    struct Version: Decodable { let n: Int; let local: String? }
    let asset: Asset
}

extension Site {
    /// The clip's file on the server's computer, as the server tells its admin (nil for anyone else, or none).
    func clipPath(library: String, asset: String) async -> String? {
        ((try? await get("/api/library/\(library)/assets/\(asset)")) as ClipFile?)?.sourcePath
    }

    /// A Review version's own file on the computer that made it, as the server tells the video's managers (nil else).
    func reviewPath(asset: String, n: Int) async -> String? {
        ((try? await get("/api/review/assets/\(asset)")) as ReviewFile?)?.asset.versions.first { $0.n == n }?.local
    }
}
