import AppKit
import AVFoundation
import Foundation
import ImageIO

// The location agent (local first, P1; contracts/places.ts): this Mac tells each server it is paired with which files
// its Settings → Folders folders hold, and the server records where each version is. One agent per paired server (per
// device token), started at launch, whether or not this Mac takes AI work and whichever server the window shows. It has
// nothing to do with the AI runner (Relay.swift).
//
// A pass, on launch, a disk change (Places.changed: a mount, an unmount, a rename, a disk away or back), wake, and an
// Allow press; never on a timer that would wake a disk:
//   GET  /api/devices/relay/folders  → this Mac's folders with their workspaces: the grants of that server (MediaFiles)
//   POST /api/devices/relay/report   {reportVersion: 2, machineId, …macReport, folders: [{id, state, disk?, scan?, complete?,
//                                    files: [{path, bytes, mtime, quick?}], unreadable?}]} → {index: [{folder, path}]}
//   POST /api/devices/relay/index    {folder, name, path, size, quick, duration?, width?, height?, thumb?, sprite?, frames,
//                                     capturedAt?, tz?, location?, camera?, alpha?}
// - A folder this Mac has not been allowed to read is "needs_ok" and is not opened (no prompt opens by itself: the
//   person presses Allow on this Mac in Settings → Folders). A folder on a drive that is not connected is "disk_away"
//   with the drive's name; a folder missing on a mounted drive is "not_found".
// - A listing reads size and modified time only, one directory at a time through Places.guarded: a directory that
//   doesn't answer in time goes in `unreadable` (its rows stay unchecked, never gone). Pages of REPORT_FILES_MAX files
//   share one scan id; the last says complete.
// - Then the quick fingerprints (Imports.quickPrint: 2 MiB a file), one file at a time, for the files not printed yet
//   (kept here by path, size and time), and the listing again with them. The files the server answered get their
//   card picture, hover strip and stills made here, then are indexed where they are. No file is uploaded.

/// This Mac's own id, the same across pairings and servers: a UUID in the Keychain, made once.
enum MachineID {
    static let service = AppIdentity.keychain("machine")
    static let value: String = {
        if let id = DeviceVault.token(for: "machine-id", service: service) { return id }
        let id = UUID().uuidString.lowercased()
        DeviceVault.save(id, for: "machine-id", service: service)
        return id
    }()
}

/// The agents, one per server with a device token here. Shell gives the servers (This Mac and the added ones).
@MainActor
final class LocationAgents {
    static let shared = LocationAgents()
    private var agents: [String: LocationAgent] = [:]
    private var servers: () -> [URL] = { [] }
    /// This Mac's own server, if it runs one: its folders are scanned there, so no agent watches them.
    private var local: () -> URL? = { nil }
    private var started = false

    func start(servers: @escaping () -> [URL], local: @escaping () -> URL? = { nil }) {
        self.servers = servers
        self.local = local
        if !started {
            started = true
            NotificationCenter.default.addObserver(forName: Places.changed, object: nil, queue: .main) { _ in
                MainActor.assumeIsolated { LocationAgents.shared.poke() }
            }
            NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didWakeNotification, object: nil, queue: .main) { _ in
                MainActor.assumeIsolated { LocationAgents.shared.poke() }
            }
        }
        poke()
    }

    /// Starts an agent for each server that has a token now, stops those whose token went, and has each look again.
    func poke() {
        var next: [String: LocationAgent] = [:]
        let own = MediaFiles.serverKey(local())
        for url in servers() {
            let key = MediaFiles.serverKey(url)
            guard let host = url.host, let token = DeviceVault.token(for: host), next[key] == nil else { continue }
            let agent = agents[key].flatMap { $0.token == token && !$0.isStopped ? $0 : nil } ?? LocationAgent(base: url, token: token)
            agent.watching = key != own
            next[key] = agent
        }
        for (key, agent) in agents where next[key] !== agent { agent.stop() }
        agents = next
        for agent in next.values { agent.poke() }
    }
}

/// One file of a listing (contracts/places.ts ReportFile).
struct ListedFile: Equatable {
    let path: String
    let bytes: Int64
    /// modified time, ms
    let mtime: Int64
    var quick: String?

    var body: [String: Any] {
        var b: [String: Any] = ["path": path, "bytes": bytes, "mtime": mtime]
        if let quick { b["quick"] = quick }
        return b
    }
}

final class LocationAgent: @unchecked Sendable {
    /// contracts/places.ts REPORT_FILES_MAX
    static let pageSize = 2000
    let base: URL
    let token: String
    private let api: DeviceAPI
    private let server: String
    private let places: Places
    private let queue = DispatchQueue(label: "creatortoolset.location", qos: .utility)
    private var events: Debounce!
    private var watchEvents: Debounce!
    private var watch: FolderWatch?
    private var watchedPaths: [String] = []
    private let lock = NSLock()
    private var stopped = false
    /// Set by LocationAgents: a server that is not this Mac's own (its own scans run there, so no watch).
    var watching = false

    init(base: URL, token: String, places: Places = .shared) {
        self.base = base
        self.token = token
        self.places = places
        server = MediaFiles.serverKey(base)
        api = DeviceAPI(base: base, token: token)
        events = Debounce(delay: 2, queue: queue) { [weak self] in self?.pass() }
        // a change in a listed folder: looked at 10 s after the last one (the copy of a big file is one change at a time)
        watchEvents = Debounce(delay: 10, queue: queue) { [weak self] in
            guard let self, !self.isStopped else { return }
            self.pass()
        }
        api.onRevoked = { [weak self] in self?.stop() }
    }

    var isStopped: Bool { lock.withLock { stopped } }
    func stop() {
        lock.withLock { stopped = true }
        queue.async { [weak self] in
            self?.watch?.stop()
            self?.watch = nil
        }
    }
    /// A pass soon (several pokes make one; one that comes during a pass makes the next).
    func poke() { if !isStopped { events.poke() } }

    // MARK: what a pass reads (the tests call these)

    /// A folder's state here: needs_ok (not allowed), disk_away (its drive not connected, or not answering), not_found
    /// (missing on a mounted drive), ok.
    static func state(of path: String, allowed: Bool, places: Places) -> (state: String, disk: String?) {
        guard allowed else { return ("needs_ok", nil) }
        let disks = places.diskList()
        if let name = MediaFiles.unmountedDisk(path, disks: disks) { return ("disk_away", name) }
        let disk = Places.disk(of: path, in: disks)
        let name = disk.map { $0.name.isEmpty ? ($0.path as NSString).lastPathComponent : $0.name }
        if let disk, disk.network, !places.answers(disk.path) { return ("disk_away", name) }
        var directory: ObjCBool = false
        guard let there = places.guarded(path, { FileManager.default.fileExists(atPath: path, isDirectory: &directory) && directory.boolValue }) else {
            return ("disk_away", name)
        }
        return there ? ("ok", nil) : ("not_found", nil)
    }

    /// The media files under `folder` with their size and modified time, and the directories that did not answer in
    /// time. Hidden files, packages and symbolic links are skipped. No cap: the report goes in pages.
    static func list(_ folder: String, places: Places) -> (files: [ListedFile], unreadable: [String]) {
        let keys: [URLResourceKey] = [.isRegularFileKey, .isDirectoryKey, .isSymbolicLinkKey, .isPackageKey, .fileSizeKey, .contentModificationDateKey]
        var files: [ListedFile] = [], unreadable: [String] = []
        var dirs = [URL(fileURLWithPath: folder, isDirectory: true)]
        while let dir = dirs.popLast() {
            guard let read = places.guarded(dir.path, { try? FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: keys, options: [.skipsHiddenFiles]) }),
                  let entries = read else {
                unreadable.append(dir.path)
                continue
            }
            for url in entries {
                guard let v = try? url.resourceValues(forKeys: Set(keys)), v.isSymbolicLink != true, v.isPackage != true else { continue }
                // under the folder's own path as the person added it: the system may hand back the real path of a
                // folder reached through a link (/var → /private/var), which the server would not find inside the folder
                let child = dir.appendingPathComponent(url.lastPathComponent, isDirectory: v.isDirectory == true)
                if v.isDirectory == true { dirs.append(child); continue }
                guard v.isRegularFile == true, MediaFiles.isMedia(child.path), let size = v.fileSize else { continue }
                files.append(ListedFile(path: child.path, bytes: Int64(size), mtime: Int64(((v.contentModificationDate?.timeIntervalSince1970 ?? 0) * 1000).rounded())))
            }
        }
        return (files.sorted { $0.path < $1.path }, unreadable.sorted())
    }

    /// One folder's listing as report folders: pages of `pageSize` files with one scan id, numbered from 0 (`page`, so the
    /// server knows the listing came whole), the last `complete`.
    /// A directory that didn't answer makes the listing incomplete in part only: its rows stay as they were (unchecked).
    static func pages(id: String, files: [ListedFile], unreadable: [String], scan: String, size: Int = pageSize) -> [[String: Any]] {
        let count = max(1, (files.count + size - 1) / size)
        return (0..<count).map { i in
            var page: [String: Any] = ["id": id, "state": "ok", "scan": scan, "page": i,
                                       "files": files[min(files.count, i * size)..<min(files.count, (i + 1) * size)].map(\.body)]
            if i == 0, !unreadable.isEmpty { page["unreadable"] = unreadable }
            if i == count - 1 { page["complete"] = true }
            return page
        }
    }

    /// GET /api/devices/relay/folders's answer as grants.
    static func folders(_ data: Data) -> [MediaFiles.ServerFolder]? {
        guard let o = try? JSONSerialization.jsonObject(with: data) as? [String: Any], let list = o["folders"] as? [[String: Any]] else { return nil }
        return list.compactMap { f in
            guard let id = f["id"] as? String, let path = (f["hostPath"] ?? f["path"]) as? String else { return nil }
            let ws = (f["workspaces"] as? [String]) ?? ((f["workspaces"] as? String) == "*" ? ["*"] : [])
            return MediaFiles.ServerFolder(id: id, path: path, workspaces: ws, use: f["use"] as? String ?? "media")
        }
    }

    // MARK: a pass

    /// the wait before asking a server that didn't answer again (1, 2, 4… up to 16 minutes); a network call, no disk
    private var retry: TimeInterval = 60

    private func pass() {
        guard !isStopped else { return }
        guard let reply = try? api.get("/api/devices/relay/folders", timeout: 30), reply.status == 200, let answered = Self.folders(reply.data) else {
            if !isStopped {
                queue.asyncAfter(deadline: .now() + retry) { [weak self] in self?.poke() }
                retry = min(retry * 2, 960)
            }
            return
        }
        retry = 60
        let folders = MediaFiles.setServerFolders(answered, server: server)   // an empty answer keeps the last good list
        // the listed media folders are watched (FSEvents) while this Mac is on a server that is not its own
        let paths = watching ? folders.filter { $0.use == "media" }.map(\.path) : []
        if paths != watchedPaths {
            watch?.stop()
            watch = FolderWatch(paths: paths, queue: queue) { [weak self] in self?.watchEvents.poke() }
            watchedPaths = paths
        }
        var head = macReport()
        head["reportVersion"] = 2
        head["machineId"] = MachineID.value
        head["version"] = appVersion
        head["filmed"] = true   // this app reads when known files were filmed (the answer's `filmed`)
        filmedAsked = []
        let cache = QuickCache.shared
        var listed: [(id: String, files: [ListedFile], unreadable: [String])] = []
        var index: [(folder: String, path: String, blur: Bool)] = []
        for f in folders where f.use == "media" {
            if isStopped { return }
            let (state, disk) = Self.state(of: f.path, allowed: MediaFiles.isAllowed(f.path, server: server), places: places)
            guard state == "ok" else {
                var r: [String: Any] = ["id": f.id, "state": state]
                if let disk { r["disk"] = disk }
                index += report(head, r)
                continue
            }
            let l = Self.list(f.path, places: places)
            let files = l.files.map { var x = $0; x.quick = cache.quick(x); return x }
            for page in Self.pages(id: f.id, files: files, unreadable: l.unreadable, scan: UUID().uuidString) { index += report(head, page) }
            listed.append((f.id, files, l.unreadable))
        }
        // the files no version matched: indexed where they are
        for i in index {
            if isStopped { break }
            indexFile(folder: i.folder, path: i.path, blur: i.blur, cache: cache)
        }
        // known files the server has no filming date for: when and where each was filmed, read once
        for i in filmedAsked {
            if isStopped { break }
            sendFilmed(folder: i.folder, path: i.path)
        }
        // the quick pass: one file at a time, then the listing again with what was read
        for (id, files, unreadable) in listed {
            var printed = files, any = false
            for (n, f) in files.enumerated() where f.quick == nil {
                if isStopped { cache.save(); return }
                printed[n].quick = cache.read(f, places: places)
                any = any || printed[n].quick != nil
                Thread.sleep(forTimeInterval: 0.05)
            }
            cache.save()
            if any { for page in Self.pages(id: id, files: printed, unreadable: unreadable, scan: UUID().uuidString) { _ = report(head, page) } }
        }
    }

    /// One report call with one folder; the files the server wants indexed.
    private func report(_ head: [String: Any], _ folder: [String: Any]) -> [(folder: String, path: String, blur: Bool)] {
        var body = head
        body["folders"] = [folder]
        guard let r = try? api.call("POST", "/api/devices/relay/report", body, tries: 2, timeout: 60), r.status == 200,
              let o = try? JSONSerialization.jsonObject(with: r.data) as? [String: Any], let list = o["index"] as? [[String: Any]] else { return [] }
        let pairs = { (l: [[String: Any]]) in l.compactMap { x in (x["folder"] as? String).flatMap { f in (x["path"] as? String).map { (folder: f, path: $0, blur: x["blur"] as? Bool ?? false) } } } }
        filmedAsked += pairs(o["filmed"] as? [[String: Any]] ?? []).map { (folder: $0.folder, path: $0.path) }
        return pairs(list)
    }

    /// The known files a report asked when they were filmed (ReportAnswer.filmed), answered after the scan.
    private var filmedAsked: [(folder: String, path: String)] = []

    private func sendFilmed(folder: String, path: String) {
        guard let size = places.guarded(path, { Places.size(path) }) ?? nil,
              let read = places.guarded(path, deadline: 30, { MacIndex.filmed(path) }) else { return }
        var body = read
        body["folder"] = folder
        body["path"] = path
        body["size"] = size
        _ = try? api.call("POST", "/api/devices/relay/filmed", body, tries: 2, timeout: 60)
    }

    /// `blur`: the server's library has Blur faces on (contracts/places.ts ReportAnswer): the whole file's SHA-256 goes with it
    /// (the key its blurred render links on) and no card picture or strip, which the server would not keep anyway.
    private func indexFile(folder: String, path: String, blur: Bool, cache: QuickCache) {
        guard let size = places.guarded(path, { Places.size(path) }) ?? nil,
              let quick = cache.read(ListedFile(path: path, bytes: size, mtime: Self.mtime(path)), places: places) else { return }
        var body = MacIndex.read(path)
        if blur {
            body["thumb"] = nil
            body["sprite"] = nil
            // a whole read of a big file on a network disk: an hour at most, else it is indexed without it
            if let sha = places.guarded(path, deadline: 3600, { try? LibraryCopyJob.sha256(of: URL(fileURLWithPath: path)) }) ?? nil { body["sha256"] = sha }
        }
        body["folder"] = folder
        body["name"] = (path as NSString).lastPathComponent
        body["path"] = path
        body["size"] = size
        body["quick"] = quick
        _ = try? api.call("POST", "/api/devices/relay/index", body, tries: 2, timeout: 120)
    }

    static func mtime(_ path: String) -> Int64 {
        let at = (try? FileManager.default.attributesOfItem(atPath: path))?[.modificationDate] as? Date
        return Int64(((at?.timeIntervalSince1970 ?? 0) * 1000).rounded())
    }
}

/// FSEvents on folders: `onChange` on `queue` when anything in them changes (a file copied in, renamed or removed).
final class FolderWatch {
    private var stream: FSEventStreamRef?

    init?(paths: [String], queue: DispatchQueue, onChange: @escaping () -> Void) {
        guard !paths.isEmpty else { return nil }
        let box = Unmanaged.passRetained(FolderWatchBox(onChange))
        var context = FSEventStreamContext(version: 0, info: box.toOpaque(), retain: nil,
                                           release: { info in if let info { Unmanaged<FolderWatchBox>.fromOpaque(info).release() } },
                                           copyDescription: nil)
        let callback: FSEventStreamCallback = { _, info, _, _, _, _ in
            guard let info else { return }
            Unmanaged<FolderWatchBox>.fromOpaque(info).takeUnretainedValue().onChange()
        }
        guard let s = FSEventStreamCreate(nil, callback, &context, paths as CFArray, FSEventStreamEventId(kFSEventStreamEventIdSinceNow), 2,
                                          UInt32(kFSEventStreamCreateFlagFileEvents | kFSEventStreamCreateFlagNoDefer)) else {
            box.release()   // the stream never took the box, so nothing else will
            return nil
        }
        FSEventStreamSetDispatchQueue(s, queue)
        FSEventStreamStart(s)
        stream = s
    }

    func stop() {
        guard let s = stream else { return }
        stream = nil
        FSEventStreamStop(s)
        FSEventStreamInvalidate(s)
        FSEventStreamRelease(s)
    }

    deinit { stop() }
}

/// The callback's box: the context keeps it alive until the stream is released.
private final class FolderWatchBox {
    let onChange: () -> Void
    init(_ onChange: @escaping () -> Void) { self.onChange = onChange }
}

/// The quick fingerprints read on this Mac, by path, size and modified time (a small file under Application Support).
final class QuickCache: @unchecked Sendable {
    static let shared = QuickCache(file: appSupport.appendingPathComponent("location-quick.json"))
    private let file: URL
    private let lock = NSLock()
    private var prints: [String: String]
    private var dirty = false

    init(file: URL) {
        self.file = file
        prints = (try? Data(contentsOf: file)).flatMap { try? JSONDecoder().decode([String: String].self, from: $0) } ?? [:]
    }

    private static func key(_ f: ListedFile) -> String { "\(f.bytes)|\(f.mtime)" }

    /// The print kept for this file as it is now (same size and time), else nil.
    func quick(_ f: ListedFile) -> String? {
        lock.withLock { prints[f.path].flatMap { $0.hasPrefix(Self.key(f) + "|") ? String($0.dropFirst(Self.key(f).count + 1)) : nil } }
    }

    /// The kept print, or one read now (2 MiB; at most 30 s on a network drive) and kept.
    func read(_ f: ListedFile, places: Places) -> String? {
        if let q = quick(f) { return q }
        guard let q = places.guarded(f.path, deadline: 30, { Imports.quickPrint(f.path) }) ?? nil else { return nil }
        lock.withLock {
            prints[f.path] = Self.key(f) + "|" + q
            dirty = true
        }
        return q
    }

    func save() {
        let data: Data? = lock.withLock {
            guard dirty else { return nil }
            dirty = false
            return try? JSONEncoder().encode(prints)
        }
        guard let data else { return }
        try? FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        try? data.write(to: file, options: .atomic)
    }
}

/// What the server lists a file by, made on this Mac (as the page's src/lib/onMac.ts readIndex does): its length and
/// size, a card picture (480 wide, at a tenth), the hover strip (20 frames in the clip's own shape, at most 256 on the
/// longer side: the server's media/sprite.ts SPRITE_SIDE, so an upright clip's strip is never remade) and four stills (512 wide).
/// A file AVFoundation can't read is indexed by its name and size only.
enum MacIndex {
    private static let pictures: Set<String> = Set(MediaFiles.types.filter { $0.value.hasPrefix("image/") }.keys)
    static let spriteFrames = 20
    /// The longer side of a strip frame (contracts/library.ts SPRITE_SIDE).
    static let spriteSide = 256

    /// One strip frame's size for a clip of `size`: its shape, the longer side `spriteSide`, both even (as ffmpeg's
    /// force_original_aspect_ratio=decrease:force_divisible_by=2 makes them on the server).
    static func spriteCell(_ size: CGSize) -> (width: Int, height: Int) {
        guard size.width > 0, size.height > 0 else { return (spriteSide, spriteSide * 9 / 16 / 2 * 2) }
        let even = { (v: Double) in max(2, Int(v / 2) * 2) }
        return size.width >= size.height
            ? (spriteSide, even(Double(spriteSide) * size.height / size.width))
            : (even(Double(spriteSide) * size.width / size.height), spriteSide)
    }
    static let stills = 4

    static func read(_ path: String) -> [String: Any] {
        let url = URL(fileURLWithPath: path)
        if pictures.contains(url.pathExtension.lowercased()) {
            guard let image = NSImage(contentsOf: url)?.cgImage(forProposedRect: nil, context: nil, hints: nil) else { return ["frames": [String]()] }
            return ["width": image.width, "height": image.height, "thumb": jpeg(scaled(image, width: 480), 0.8) as Any, "frames": [String]()]
                .merging(photoFilmed(url)) { a, _ in a }
        }
        let asset = AVURLAsset(url: url)
        guard let (duration, size) = wait({ () async throws -> (Double, CGSize?) in
            let d = try await asset.load(.duration).seconds
            guard let track = try await asset.loadTracks(withMediaType: .video).first else { return (d, nil) }
            let (natural, transform) = try await track.load(.naturalSize, .preferredTransform)
            let r = natural.applying(transform)
            return (d, CGSize(width: abs(r.width), height: abs(r.height)))
        }), duration.isFinite else { return ["frames": [String]()] }
        guard let size, size.width > 0 else { return duration > 0 ? ["duration": duration, "frames": [String]()] : ["frames": [String]()] }
        let generator = AVAssetImageGenerator(asset: asset)
        generator.appliesPreferredTrackTransform = true
        generator.maximumSize = CGSize(width: 640, height: 640) // above spriteSide, so a strip frame is never scaled up
        let at = { (t: Double) in wait { try await generator.image(at: CMTime(seconds: min(max(0, t), max(0, duration - 0.05)), preferredTimescale: 600)).image } }
        let frameAt = { (i: Int, n: Int) in (Double(i) + 0.5) * duration / Double(n) }
        var out: [String: Any] = ["duration": duration, "width": Int(size.width), "height": Int(size.height)].merging(videoFilmed(asset)) { a, _ in a }
        if let first = at(duration * 0.1) { out["thumb"] = jpeg(scaled(first, width: 480), 0.8) }
        let (cw, ch) = spriteCell(size)
        let strip = CGContext(data: nil, width: cw * spriteFrames, height: ch, bitsPerComponent: 8, bytesPerRow: 0,
                              space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)
        strip?.interpolationQuality = .high
        for i in 0..<spriteFrames {
            guard let f = at(frameAt(i, spriteFrames)) else { continue }
            // the frame fills its cell, cut to it where a frame's shape differs from the clip's (a turned or odd frame)
            let s = max(CGFloat(cw) / CGFloat(f.width), CGFloat(ch) / CGFloat(f.height))
            let w = CGFloat(f.width) * s, h = CGFloat(f.height) * s
            strip?.saveGState()
            strip?.clip(to: CGRect(x: CGFloat(i * cw), y: 0, width: CGFloat(cw), height: CGFloat(ch)))
            strip?.draw(f, in: CGRect(x: CGFloat(i * cw) + (CGFloat(cw) - w) / 2, y: (CGFloat(ch) - h) / 2, width: w, height: h))
            strip?.restoreGState()
        }
        if let image = strip?.makeImage() { out["sprite"] = jpeg(image, 0.7) }
        out["frames"] = (0..<stills).compactMap { i in at(frameAt(i, stills)).flatMap { jpeg(scaled($0, width: 512), 0.7) } }
        return out
    }

    /// When, where and by what a file was filmed, without its pictures (a known file the server asks about). `camera`
    /// is always there, so the server never asks again.
    static func filmed(_ path: String) -> [String: Any] {
        let url = URL(fileURLWithPath: path)
        if pictures.contains(url.pathExtension.lowercased()) { return ["camera": false].merging(photoFilmed(url)) { _, b in b } }
        return videoFilmed(AVURLAsset(url: url))
    }

    /// When and where a video was filmed, as its file says: the server files it into its shoot (library/shoots.ts). The
    /// minutes east of UTC are the file's own (an iPhone writes "…-0600"), else this Mac's at that date.
    static func videoFilmed(_ asset: AVURLAsset) -> [String: Any] {
        var out: [String: Any] = ["camera": false]   // a photo's EXIF only: a video is never a graphic
        if let (date, text) = wait({ () async throws -> (Date?, String?) in
            guard let item = try await asset.load(.creationDate) else { return (nil, nil) }
            return (try await item.load(.dateValue), try await item.load(.stringValue))
        }), let date {
            out["capturedAt"] = Int64((date.timeIntervalSince1970 * 1000).rounded())
            out["tz"] = offset(text) ?? TimeZone.current.secondsFromGMT(for: date) / 60
        }
        if let place = wait({ () async throws -> String? in
            let items = try await asset.load(.metadata)
            let found = AVMetadataItem.metadataItems(from: items, filteredByIdentifier: .quickTimeMetadataLocationISO6709).first
                ?? AVMetadataItem.metadataItems(from: items, filteredByIdentifier: .commonIdentifierLocation).first
            return try await found?.load(.stringValue)
        }) ?? nil, place.count <= 64 { out["location"] = place }
        return out
    }

    /// A picture's EXIF: whether a camera made it (make or model), its alpha channel, when (its own offset, else this
    /// Mac's) and where (as ISO 6709; the server keeps only the country).
    static func photoFilmed(_ url: URL) -> [String: Any] {
        guard let src = CGImageSourceCreateWithURL(url as CFURL, nil),
              let p = CGImageSourceCopyPropertiesAtIndex(src, 0, nil) as? [CFString: Any] else { return [:] }
        let tiff = p[kCGImagePropertyTIFFDictionary] as? [CFString: Any] ?? [:]
        let exif = p[kCGImagePropertyExifDictionary] as? [CFString: Any] ?? [:]
        let gps = p[kCGImagePropertyGPSDictionary] as? [CFString: Any] ?? [:]
        let named = { (k: CFString) in !((tiff[k] as? String) ?? "").trimmingCharacters(in: .whitespaces).isEmpty }
        var out: [String: Any] = ["camera": named(kCGImagePropertyTIFFMake) || named(kCGImagePropertyTIFFModel),
                                  "alpha": (p[kCGImagePropertyHasAlpha] as? Bool) ?? false]
        if let taken = exif[kCGImagePropertyExifDateTimeOriginal] as? String {
            let tz = offset(exif[kCGImagePropertyExifOffsetTimeOriginal] as? String)
            let f = DateFormatter()
            f.locale = Locale(identifier: "en_US_POSIX")
            f.dateFormat = "yyyy:MM:dd HH:mm:ss"
            f.timeZone = tz.map { TimeZone(secondsFromGMT: $0 * 60) } ?? TimeZone.current
            if let date = f.date(from: String(taken.prefix(19))) {
                out["capturedAt"] = Int64((date.timeIntervalSince1970 * 1000).rounded())
                out["tz"] = tz ?? TimeZone.current.secondsFromGMT(for: date) / 60
            }
        }
        if let lat = gps[kCGImagePropertyGPSLatitude] as? Double, let lon = gps[kCGImagePropertyGPSLongitude] as? Double {
            let s = (gps[kCGImagePropertyGPSLatitudeRef] as? String) == "S" ? -1.0 : 1.0
            let w = (gps[kCGImagePropertyGPSLongitudeRef] as? String) == "W" ? -1.0 : 1.0
            out["location"] = String(format: "%+08.4f%+09.4f/", lat * s, lon * w)
        }
        return out
    }

    /// Minutes east of UTC from "-06:00" or "-0600" at the end of a string; nil when it has none.
    static func offset(_ text: String?) -> Int? {
        guard let text, let r = text.range(of: #"[+-]\d\d:?\d\d$"#, options: .regularExpression) else { return nil }
        let digits = text[r].filter(\.isNumber)
        guard digits.count == 4, let h = Int(digits.prefix(2)), let m = Int(digits.suffix(2)) else { return nil }
        let minutes = (h * 60 + m) * (text[r].first == "-" ? -1 : 1)
        return abs(minutes) <= 14 * 60 ? minutes : nil
    }

    private static func scaled(_ image: CGImage, width: Int) -> CGImage {
        let height = max(2, Int((Double(width) * Double(image.height) / Double(image.width) / 2).rounded()) * 2)
        guard let c = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
                                space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { return image }
        c.interpolationQuality = .high
        c.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
        return c.makeImage() ?? image
    }

    private static func jpeg(_ image: CGImage, _ quality: Double) -> String? {
        NSBitmapImageRep(cgImage: image).representation(using: .jpeg, properties: [.compressionFactor: quality])?.base64EncodedString()
    }

    private final class Box<T>: @unchecked Sendable { var value: T? }

    /// An async AVFoundation call waited for on this (background) thread.
    private static func wait<T>(_ body: @escaping () async throws -> T) -> T? {
        let box = Box<T>(), done = DispatchSemaphore(value: 0)
        Task.detached {
            box.value = try? await body()
            done.signal()
        }
        done.wait()
        return box.value
    }
}
