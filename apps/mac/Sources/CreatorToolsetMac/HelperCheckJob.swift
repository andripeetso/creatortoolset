// A check of this Mac for helping with heavy work (the server's lib/helper-check.ts, device job "helper-check"): setup's
// Help screen and Settings → Devices ask it. It reaches this Mac the way a folder listing does (Relay.swift: claimed by
// kind). First the disks are read now and the report goes out again, so a shared drive connected a moment ago counts;
// then, for a test (`test` "1"), part of one real file is read in each folder (`folders`: JSON, id → path on this Mac)
// and a few seconds of 720p video are encoded with the app's own ffmpeg, timed. Then, with the device token:
//   POST /api/devices/relay/job/helper-check/:id        { ffmpeg, encode?, folders: [{ id, ok, error? }] }
//   or   /api/devices/relay/job/helper-check/:id/fail   { error }
import Foundation

let helperCheckKind = "helper-check"

struct HelperCheckJob {
    let api: DeviceAPI
    let step: EditorJob
    /// posts this Mac's report (its disks just read)
    let report: () -> Void

    static let readBytes = 4 << 20
    static let encodeSeconds = 4.0
    static let media: Set<String> = ["mov", "mp4", "m4v", "mxf", "mkv", "avi", "mts", "braw", "r3d", "wav", "mp3", "aif", "aiff", "m4a", "flac", "jpg", "png", "heic"]

    /// The app's own ffmpeg (Resources/server/runtime, bundled by build-app.sh).
    static var ffmpeg: URL? {
        Bundle.main.resourceURL.map { $0.appendingPathComponent("server/runtime/ffmpeg") }
            .flatMap { FileManager.default.isExecutableFile(atPath: $0.path) ? $0 : nil }
    }

    /// One folder read: a media file in it (else any file) read in part. Nil when it went well; else why, in words.
    static func read(_ path: String) -> String? {
        let fm = FileManager.default
        var isDir: ObjCBool = false
        guard fm.fileExists(atPath: path, isDirectory: &isDir), isDir.boolValue else {
            return "\(path) is not on this Mac. Connect the shared drive again."
        }
        guard let walk = fm.enumerator(at: URL(fileURLWithPath: path), includingPropertiesForKeys: [.isRegularFileKey], options: [.skipsHiddenFiles, .skipsPackageDescendants]),
              (try? fm.contentsOfDirectory(atPath: path)) != nil else {
            return "This Mac may not read \(path). Allow Creator Toolset in System Settings → Privacy & Security → Files and Folders."
        }
        var any: URL?
        var file: URL?
        let by = Date().addingTimeInterval(5)
        for case let url as URL in walk {
            if Date() > by { break }
            guard (try? url.resourceValues(forKeys: [.isRegularFileKey]))?.isRegularFile == true else { continue }
            if any == nil { any = url }
            if media.contains(url.pathExtension.lowercased()) { file = url; break }
        }
        // an empty folder: listing it was the read
        guard let pick = file ?? any else { return nil }
        guard let h = try? FileHandle(forReadingFrom: pick) else { return "This Mac could not open \(pick.path)." }
        defer { try? h.close() }
        return (try? h.read(upToCount: readBytes)) == nil ? "This Mac could not read \(pick.path)." : nil
    }

    /// Seconds of video encoded per second, or nil when ffmpeg is missing or failed.
    static func encode() -> Double? {
        guard let ff = ffmpeg else { return nil }
        let p = Process()
        p.executableURL = ff
        p.arguments = ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=30",
                       "-t", String(encodeSeconds), "-c:v", "libx264", "-preset", "veryfast", "-f", "null", "-"]
        p.standardOutput = FileHandle.nullDevice
        p.standardError = FileHandle.nullDevice
        let start = Date()
        guard (try? p.run()) != nil else { return nil }
        p.waitUntilExit()
        let took = Date().timeIntervalSince(start)
        return p.terminationStatus == 0 && took > 0 ? (encodeSeconds / took * 100).rounded() / 100 : nil
    }

    func run() -> (end: CardJob.End, more: Bool) {
        let base = "/api/devices/relay/job/\(helperCheckKind)/\(step.id)"
        _ = DiskCache.shared.readNow()
        report()
        let folders = (step.options["folders"].flatMap { try? JSONSerialization.jsonObject(with: Data($0.utf8)) } as? [String: String]) ?? [:]
        var body: [String: Any] = ["ffmpeg": Self.ffmpeg != nil, "folders": folders.map { id, path -> [String: Any] in
            let why = Self.read(path)
            return why.map { ["id": id, "ok": false, "error": $0] } ?? ["id": id, "ok": true]
        }]
        if step.options["test"] == "1", let speed = Self.encode() { body["encode"] = speed }
        if let reply = try? api.call("POST", base, body, tries: 3) {
            if reply.status == 200 { return (.done, RelayRunner.editorWaits(reply.data)) }
            if reply.status == 404 || reply.status == 401 { return (.gone, false) }
        }
        let why = "This Mac could not send its check to the server."
        let reply = try? api.call("POST", "\(base)/fail", ["error": why], tries: 4)
        return (.failed(why), reply.map { $0.status == 200 && RelayRunner.editorWaits($0.data) } ?? false)
    }
}
