// The folder browser of a chat card (the server's GET /api/devices/:id/browse, its device job "folder-browse"): one
// level of folders on this Mac, for a phone or a browser that is not this Mac to pick one from. Claimed by kind like
// the folder list (Relay.swift). The claim's option: path ("~", "~/…" or a full path). Then, with the device token:
//   POST /api/devices/relay/job/folder-browse/:id        { path, parent, roots: [{name, path}], dirs: [{name, path}] }
//   or   /api/devices/relay/job/folder-browse/:id/fail   { error }
// Only the home folder and mounted drives under /Volumes are listed: the real path (links followed) has to stay inside
// one of them, whatever the server let through. Folders only, never files, hidden ones and packages left out.
import Foundation

let folderBrowseKind = "folder-browse"

struct FolderBrowseJob {
    let api: DeviceAPI
    let step: EditorJob

    static let outside = "Only folders in your home folder or on your drives"

    /// The places a pick may start from: the home folder, then the drives mounted under /Volumes (the startup disk's
    /// own link there is the whole disk, so it is left out).
    static func roots(home: String) -> [[String: String]] {
        let volumes = (FileManager.default.mountedVolumeURLs(includingResourceValuesForKeys: nil, options: [.skipHiddenVolumes]) ?? [])
            .map(\.path).filter { $0.hasPrefix("/Volumes/") }
        return [["name": "Home", "path": home]] + volumes.sorted().map { ["name": ($0 as NSString).lastPathComponent, "path": $0] }
    }

    /// The listing the server takes, or why not. `roots` are real paths; `given` is checked against them once its links are followed.
    static func browse(_ given: String, home: String, roots: [[String: String]]) -> (body: [String: Any]?, error: String?) {
        let expanded = given == "~" ? home : given.hasPrefix("~/") ? home + given.dropFirst() : given
        guard expanded.hasPrefix("/") else { return (nil, outside) }
        let real = URL(fileURLWithPath: expanded).resolvingSymlinksInPath().standardizedFileURL.path
        let allowed = roots.compactMap { $0["path"] }
        guard let root = allowed.first(where: { real == $0 || real.hasPrefix($0 + "/") }) else { return (nil, outside) }
        let keys: [URLResourceKey] = [.isDirectoryKey, .isSymbolicLinkKey, .isPackageKey]
        guard let found = try? FileManager.default.contentsOfDirectory(at: URL(fileURLWithPath: real, isDirectory: true), includingPropertiesForKeys: keys, options: [.skipsHiddenFiles]) else {
            return (nil, "\(real) could not be read on this Mac.")
        }
        let dirs = found.filter {
            let v = try? $0.resourceValues(forKeys: Set(keys))
            return v?.isDirectory == true && v?.isSymbolicLink != true && v?.isPackage != true
        }
        .map(\.lastPathComponent).sorted { $0.localizedStandardCompare($1) == .orderedAscending }
        .map { ["name": $0, "path": real == "/" ? "/\($0)" : "\(real)/\($0)"] }
        let parent: Any = real == root ? NSNull() : (real as NSString).deletingLastPathComponent
        return (["path": real, "parent": parent, "roots": roots, "dirs": dirs], nil)
    }

    func run() -> (end: CardJob.End, more: Bool) {
        let base = "/api/devices/relay/job/\(folderBrowseKind)/\(step.id)"
        let home = FileManager.default.homeDirectoryForCurrentUser.resolvingSymlinksInPath().path
        let (body, refused) = Self.browse(step.options["path"] ?? "~", home: home, roots: Self.roots(home: home))
        var why = refused
        if let body {
            if let reply = try? api.call("POST", base, body, tries: 3) {
                if reply.status == 200 { return (.done, RelayRunner.editorWaits(reply.data)) }
                if reply.status == 404 || reply.status == 401 { return (.gone, false) }
            }
            why = "This Mac could not send the folders to the server."
        }
        let reply = try? api.call("POST", "\(base)/fail", ["error": String(why!.prefix(500))], tries: 4)
        return (.failed(why!), reply.map { $0.status == 200 && RelayRunner.editorWaits($0.data) } ?? false)
    }
}
