// The assistant's folder_list for a folder on this Mac when the server runs elsewhere (the server's lib/folder-list.ts,
// its device job "folder-list"). It reaches this Mac the way a cut-out does (Relay.swift: claimed by kind). The claim's
// options: path (on this Mac), depth (levels, 1 to 6), disk ("1": the folder may be a drive's own top folder). Then,
// with the device token:
//   POST /api/devices/relay/job/folder-list/:id        { entries: [{ path, dir?, size? }], deeper, unreadable?, stopped? }
//   or   /api/devices/relay/job/folder-list/:id/fail   { error } with a reason a person can read
// The walk is the server's own walkFolder's: level by level, never into hidden entries, links or packages, at most
// `most` entries and `seconds`. Matching and the cap of what the AI reads are the server's.
import Foundation

/// The device job kind this Mac lists for the assistant's folder listings.
let folderListKind = "folder-list"

struct FolderListJob {
    let api: DeviceAPI
    let step: EditorJob

    static let most = 20_000
    static let seconds: TimeInterval = 10

    /// Why this folder is not walked, in words for the person; nil when it may be. `drive`: a drive's own top folder is fine.
    /// `browse`: one level of folders for Add copy's folder browser, so "/", "/Volumes" and the home folder are fine too.
    static func refused(_ given: String, drive: Bool, browse: Bool = false) -> String? {
        guard given.hasPrefix("/") else { return "Not a full path: \(given)" }
        // a folder macOS keeps private (Desktop, Documents, a removable drive) is said to be unreadable, never shown empty
        if (try? FileManager.default.contentsOfDirectory(atPath: given)) == nil, FileManager.default.fileExists(atPath: given) {
            return "\(given) could not be read on this Mac (no permission to read it)."
        }
        let url = URL(fileURLWithPath: given).resolvingSymlinksInPath()
        var isDir: ObjCBool = false
        guard FileManager.default.fileExists(atPath: url.path, isDirectory: &isDir), isDir.boolValue else { return "No such folder on this Mac: \(given)" }
        let home = FileManager.default.homeDirectoryForCurrentUser.resolvingSymlinksInPath().path
        let volume = (try? url.resourceValues(forKeys: [.isVolumeKey]))?.isVolume ?? false
        if !browse, url.path == "/" || url.path == home || url.deletingLastPathComponent().path == "/" || (volume && !drive) {
            return "\(url.path) is a whole disk or home folder: name the folder the files are in."
        }
        return nil
    }

    /// What is inside `root`, `depth` levels down: the body the server takes.
    static func walk(_ root: URL, depth: Int) -> [String: Any] {
        let by = Date().addingTimeInterval(seconds)
        let keys: [URLResourceKey] = [.isDirectoryKey, .isSymbolicLinkKey, .isPackageKey, .isRegularFileKey, .fileSizeKey]
        var entries: [[String: Any]] = []
        var deeper = 0
        var unreadable = 0
        func done(_ stopped: Bool) -> [String: Any] {
            var body: [String: Any] = ["entries": entries, "deeper": deeper]
            if unreadable > 0 { body["unreadable"] = unreadable }
            if stopped { body["stopped"] = true }
            return body
        }
        var level = [""]
        var d = 1
        while !level.isEmpty {
            var next: [String] = []
            for rel in level {
                if entries.count >= most || Date() > by { return done(true) }
                let dir = rel.isEmpty ? root : root.appendingPathComponent(rel, isDirectory: true)
                guard let found = try? FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: keys, options: [.skipsHiddenFiles]) else {
                    unreadable += 1
                    continue
                }
                for url in found.sorted(by: { $0.lastPathComponent.localizedStandardCompare($1.lastPathComponent) == .orderedAscending }) {
                    guard let v = try? url.resourceValues(forKeys: Set(keys)), v.isSymbolicLink != true else { continue }
                    let path = rel.isEmpty ? url.lastPathComponent : "\(rel)/\(url.lastPathComponent)"
                    if v.isDirectory == true {
                        entries.append(["path": path, "dir": true])
                        if v.isPackage == true { continue }
                        if d < depth { next.append(path) } else { deeper += 1 }
                    } else if v.isRegularFile == true {
                        entries.append(["path": path, "size": v.fileSize ?? 0])
                    }
                }
            }
            level = next
            d += 1
        }
        return done(false)
    }

    func run() -> (end: CardJob.End, more: Bool) {
        let base = "/api/devices/relay/job/\(folderListKind)/\(step.id)"
        // "~/…" is this Mac's home folder
        let given = ((step.options["path"] ?? "") as NSString).expandingTildeInPath
        let depth = min(6, max(1, Int(step.options["depth"] ?? "") ?? 6))
        let drive = step.options["disk"] == "1"
        var why = Self.refused(given, drive: drive, browse: drive && depth == 1)
        if why == nil {
            let body = Self.walk(URL(fileURLWithPath: given).resolvingSymlinksInPath(), depth: depth)
            if let reply = try? api.call("POST", base, body, tries: 3) {
                if reply.status == 200 { return (.done, RelayRunner.editorWaits(reply.data)) }
                if reply.status == 404 || reply.status == 401 { return (.gone, false) }
            }
            why = "This Mac could not send the folder's list to the server."
        }
        let reply = try? api.call("POST", "\(base)/fail", ["error": String(why!.prefix(500))], tries: 4)
        return (.failed(why!), reply.map { $0.status == 200 && RelayRunner.editorWaits($0.data) } ?? false)
    }
}
