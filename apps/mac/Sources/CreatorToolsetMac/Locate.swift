import Foundation

// Locate… in the Media Library (src/pages/library/Locate.tsx; api/library/locate.ts): an original that moved is found
// again by its quick fingerprint. The page asks through the import handler (Import.swift):
// import:locate:{"folder"?, "files":[{"id","path","bytes"}]} → { gone:[id], files:[{path,size,quick}] }
// - gone: the asked files that are not on this Mac where the library has them (no file there, or another size).
// - files: with a folder (picked in this app's own folder picker, or one the page may play from), its media files whose
//   size is one of the gone files' sizes, each with Imports.quickPrint. Only those are read, 2 MiB each; the folder
//   joins the ones the page may play from once one of its files could be a match.
// The server matches them to the person's own versions; nothing here decides which clip a file is.
// A file on a network disk that doesn't answer is neither gone nor found (Places.swift): it is away.

struct LocateFile: Equatable {
    let id: String
    let path: String
    let bytes: Int64
}

enum Locate {
    static func answer(folder: String?, files: [LocateFile], allowed: [String], grant: (String) -> Void = MediaFiles.add) -> [String: Any] {
        let size = { (p: String) in ((try? FileManager.default.attributesOfItem(atPath: p))?[.size] as? NSNumber)?.int64Value }
        let gone = files.filter { f in Places.shared.guarded(f.path, { size(f.path) }).map { $0 != f.bytes } ?? false }
        guard let folder else { return ["gone": gone.map(\.id), "files": [Any]()] }
        guard Places.shared.reachable(folder) else { return ["error": "That folder's disk isn't connected."] }
        guard Imports.inside(folder, allowed) != nil else { return ["error": "This app may not read that folder. Choose it again."] }
        let sizes = Set(gone.map(\.bytes))
        var found: [[String: Any]] = []
        if !sizes.isEmpty, let walk = FileManager.default.enumerator(at: URL(fileURLWithPath: folder, isDirectory: true),
                                                                    includingPropertiesForKeys: [.isRegularFileKey, .fileSizeKey],
                                                                    options: [.skipsHiddenFiles, .skipsPackageDescendants]) {
            for case let url as URL in walk {
                guard let v = try? url.resourceValues(forKeys: [.isRegularFileKey, .fileSizeKey]), v.isRegularFile == true,
                      let bytes = v.fileSize, sizes.contains(Int64(bytes)), MediaFiles.isMedia(url.path),
                      let quick = Imports.quickPrint(url.path) else { continue }
                found.append(["path": url.path, "size": bytes, "quick": quick])
            }
        }
        if !found.isEmpty { grant(folder) }
        return ["gone": gone.map(\.id), "files": found]
    }
}
