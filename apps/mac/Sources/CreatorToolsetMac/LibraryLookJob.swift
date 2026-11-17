// Shot descriptions of a Media Library file that stays on this Mac, nothing of it uploaded (the server's
// api/library/mac-look.ts, its device job "library-look"). The server asks the Mac the file is on when its look waits
// for it, one at a time. The claim's options: path (the file on this Mac), version (its library version), duration
// (seconds), format (the sheets' format) and stretches (JSON [[a, b], …]; [] when the picture is still to be read).
// Then, with the device token, on POST /api/devices/relay/job/library-look/:id:
//   { beat: true }                          keeps the job this Mac's while it reads (once a minute)
//   { signal: { fps, step, cut, lag } }     the picture as numbers → { stretches: [{ seg, a, b }] }, found by the server
//                                           (+ one, many: each frame's cut odds, where the cut model ran: CutModel.swift)
//   { sheet: { segs, jpeg, ph } }           each sheet (base64 JPEG) with its stretches' picture hashes
//   { done: true, format }                  that was all: the server's AI looks at them once, and they are not kept there
//   or …/fail { error }                     with a reason a person can read
// The sheets stay on this Mac (the relay folder's looks/<version>.json), so lines written again under a new context
// send them again without reading the video. Only a video in a folder the person gave this app is read (MediaFiles.gate).
// Every claim this Mac makes lists them (`looks`: bytes by version, `kept`); its answer names those to drop (`drop`): a
// version that is gone, trashed or no longer this Mac's, or all of them after Settings → Storage → Empty. A look whose
// sheets went makes them from the video again.
// A look's sheets may come to 100 MB on the server; past that it answers 413 and fails the look for good, so this Mac
// stops it, logs why, and is not asked for it again.
// Option `watch` (frames a second, when the server has a Gemini key for the timeline): before done, this Mac makes a
// small copy of the video (480 lines at most, that many frames a second, mono sound) and posts it to …/file; the server
// sends it to Gemini and deletes it. A copy that can't be made is skipped: the look itself still finishes.
import Foundation

/// The device job kind this Mac lists for shot descriptions of its own files.
let libraryLookKind = "library-look"

/// Why the shots of a file can't be described here, in words for the person.
struct LibraryLookRefused: Error, Equatable {
    let why: String
}

/// The job is no longer this Mac's (the server gave it back, or the relay stopped): nothing more to say.
private struct LookGone: Error {}

struct LibraryLookJob {
    let api: DeviceAPI
    let step: EditorJob
    /// where this Mac keeps the sheets, a file a version
    let folder: URL
    var ffmpeg: URL? = HelperCheckJob.ffmpeg
    var stopped: @Sendable () -> Bool = { false }
    /// the folders the person gave this app (MediaFiles.swift): a file outside them is never read, whatever the server asks
    var granted: [String] = MediaFiles.granted
    /// the cut model for the picture read (CutModel.swift), nil: the server measures the cuts
    var cuts: () -> CutModel? = { CutModel.shared() }

    /// What this Mac keeps of a version: the stretches its sheets show, and the sheets.
    struct Kept: Codable, Equatable {
        struct Sheet: Codable, Equatable {
            var segs: [Int]
            var jpeg: String
            var ph: [String]
        }
        var format: String
        var stretches: [[Double]]
        var sheets: [Sheet]
    }

    func run() -> (end: CardJob.End, more: Bool) {
        let base = "/api/devices/relay/job/\(libraryLookKind)/\(step.id)"
        let why: String
        do {
            let version = step.options["version"] ?? ""
            guard version.range(of: "^[A-Za-z0-9_-]{1,100}$", options: .regularExpression) != nil else { throw LibraryLookRefused(why: "The server named no version.") }
            guard (step.options["format"] ?? LookSheets.format) == LookSheets.format else {
                throw LibraryLookRefused(why: "The server asks for sheets this Mac app does not make: update Creator Toolset.")
            }
            let file = folder.appendingPathComponent("\(version).json")
            var stretches = Self.stretches(step.options["stretches"])
            var kept = Self.load(file)
            let same = { kept?.format == LookSheets.format && kept?.stretches == stretches }
            let beat = Beat(api: api, path: base, stopped: stopped)
            // the sheets this Mac kept show the stretches the server has: sent again, the video unread
            if stretches.isEmpty || !same() {
                guard let ffmpeg else {
                    throw LibraryLookRefused(why: "This copy of the Mac app has no ffmpeg to make the sheets with.")
                }
                let path = step.options["path"] ?? ""
                let src: URL
                switch MediaFiles.gate(path, granted: granted) {
                case .file(let real, _): src = URL(fileURLWithPath: real)
                case .status(404): throw LibraryLookRefused(why: "The file is not on this Mac at \(path).")
                case .status(415): throw LibraryLookRefused(why: "\(path) is not a video this Mac reads.")
                case .diskAway(let disk): throw LibraryLookRefused(why: "\(disk) isn't connected")
                case .status: throw LibraryLookRefused(why: "\(path) is not in a folder Creator Toolset was given on this Mac (dropped on its window or chosen).")
                }
                let reading = stretches.isEmpty
                let opened = try waitAsync { try await LookPicture.open(src, reading: reading) }
                if reading {
                    let signal = try LookPicture.read(opened, cuts: cuts(), beat: beat.check)
                    stretches = Self.found(try send(base, ["signal": signal.body], timeout: 300).data)
                    guard !stretches.isEmpty else { throw LibraryLookRefused(why: "The server found no stretches in the picture.") }
                }
                if !same() {
                    let seconds = Double(step.options["duration"] ?? "").flatMap { $0 > 0 ? $0 : nil } ?? opened.duration
                    kept = try Self.make(ffmpeg: ffmpeg, src: src, stretches: stretches, duration: seconds, landscape: opened.landscape,
                                         scratch: folder.appendingPathComponent("\(version).making"), beat: beat.check)
                    try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
                    try JSONEncoder().encode(kept).write(to: file, options: .atomic)
                }
            }
            for sheet in kept!.sheets {
                if stopped() { throw LookGone() }
                try send(base, ["sheet": ["segs": sheet.segs, "jpeg": sheet.jpeg, "ph": sheet.ph]], timeout: 120)
            }
            if let fps = Double(step.options["watch"] ?? ""), fps > 0, let ffmpeg,
               case .file(let real, _) = MediaFiles.gate(step.options["path"] ?? "", granted: granted) {
                let copy = folder.appendingPathComponent("\(version).watch.mp4")
                defer { try? FileManager.default.removeItem(at: copy) }
                try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
                do {
                    try Self.watchCopy(ffmpeg: ffmpeg, src: URL(fileURLWithPath: real), fps: fps, out: copy, beat: beat.check)
                } catch is LookGone {
                    throw LookGone()
                } catch {
                    AppLog.write("library look: no copy to watch of \(version): \(error.localizedDescription)")
                }
                if FileManager.default.fileExists(atPath: copy.path) {
                    let reply = try api.uploadFile("\(base)/file?name=watch.mp4", file: copy, type: "video/mp4")
                    if reply.status == 404 || reply.status == 401 { throw LookGone() }
                }
            }
            return (.done, RelayRunner.editorWaits(try send(base, ["done": true, "format": LookSheets.format]).data))
        } catch is LookGone {
            return (.gone, false)
        } catch let refused as LibraryLookRefused {
            why = refused.why
        } catch let media as MediaError {
            why = media.localizedDescription
        } catch {
            why = "This Mac could not read the file's picture: \(error.localizedDescription)."
        }
        let reply = try? api.call("POST", "\(base)/fail", ["error": String(why.prefix(500))], tries: 4)
        return (.failed(why), reply.map { $0.status == 200 && RelayRunner.editorWaits($0.data) } ?? false)
    }

    /// A POST on the job; its answer when the server took it. Gone when the job is no longer this Mac's.
    @discardableResult
    private func send(_ path: String, _ body: [String: Any], timeout: TimeInterval = 60) throws -> DeviceReply {
        let reply = try api.call("POST", path, body, tries: 3, timeout: timeout)
        if reply.status == 404 || reply.status == 401 { throw LookGone() }
        // 413: the look's sheets came to more than the server takes, its own words say so; the look failed there for good
        guard reply.status == 200 else {
            let problem = FaceBlurAutoJob.problem(reply)
            throw LibraryLookRefused(why: reply.status == 413 ? problem : "The server refused it: \(problem)")
        }
        return reply
    }

    /// The sheets of `stretches`, `perSheet` a sheet, with their stretches' picture hashes. `scratch` is removed after.
    static func make(ffmpeg: URL, src: URL, stretches: [[Double]], duration: Double, landscape: Bool, scratch: URL, beat: () throws -> Void) throws -> Kept {
        try FileManager.default.createDirectory(at: scratch, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: scratch) }
        var sheets: [Kept.Sheet] = []
        for i in stride(from: 0, to: stretches.count, by: LookSheets.perSheet) {
            let these = Array(stretches[i..<min(stretches.count, i + LookSheets.perSheet)])
            let out = scratch.appendingPathComponent("\(i).jpg")
            try LookSheets.sheet(ffmpeg: ffmpeg, src: src, stretches: these, duration: duration, landscape: landscape, out: out, beat: beat)
            sheets.append(.init(segs: Array(i..<i + these.count), jpeg: try Data(contentsOf: out).base64EncodedString(),
                                ph: LookSheets.hashes(ffmpeg: ffmpeg, sheet: out, count: these.count, landscape: landscape)))
        }
        return Kept(format: LookSheets.format, stretches: stretches, sheets: sheets)
    }

    /// A small copy of `src` for the server's timeline: `fps` frames a second (one at least), 480 lines at most, mono AAC.
    /// Beats while ffmpeg runs, so a long video keeps the job this Mac's; stops ffmpeg when the job went elsewhere.
    static func watchCopy(ffmpeg: URL, src: URL, fps: Double, out: URL, beat: () throws -> Void) throws {
        let p = Process()
        p.executableURL = ffmpeg
        p.arguments = ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-i", src.path,
                       "-vf", "fps=\(max(fps, 1)),scale=-2:'min(480,ih)'", "-c:v", "libx264", "-preset", "veryfast", "-crf", "30",
                       "-pix_fmt", "yuv420p", "-c:a", "aac", "-ac", "1", "-b:a", "48k", "-movflags", "+faststart", out.path]
        p.standardInput = FileHandle.nullDevice
        p.standardOutput = FileHandle.nullDevice
        p.standardError = FileHandle.nullDevice
        try p.run()
        while p.isRunning {
            do { try beat() } catch {
                p.terminate()
                p.waitUntilExit()
                try? FileManager.default.removeItem(at: out)
                throw error
            }
            Thread.sleep(forTimeInterval: 1)
        }
        guard p.terminationStatus == 0 else {
            try? FileManager.default.removeItem(at: out)
            throw LibraryLookRefused(why: "ffmpeg could not make the copy to watch.")
        }
    }

    /// The sheets kept in `folder`: each version's file size, by version id.
    static func kept(in folder: URL) -> [String: Int] {
        let files = (try? FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: [.fileSizeKey])) ?? []
        var out: [String: Int] = [:]
        for f in files where f.pathExtension == "json" {
            out[f.deletingPathExtension().lastPathComponent] = (try? f.resourceValues(forKeys: [.fileSizeKey]))?.fileSize ?? 0
        }
        return out
    }

    /// Drops what a claim's answer says (`looks: { gone: [versions], clear? }`): those versions' sheets, or all of them.
    static func drop(_ answer: Data, in folder: URL) {
        guard let looks = ((try? JSONSerialization.jsonObject(with: answer)) as? [String: Any])?["looks"] as? [String: Any] else { return }
        if looks["clear"] as? Bool == true {
            for v in kept(in: folder).keys { try? FileManager.default.removeItem(at: folder.appendingPathComponent("\(v).json")) }
            return
        }
        for v in looks["gone"] as? [String] ?? [] where v.range(of: "^[A-Za-z0-9_-]{1,100}$", options: .regularExpression) != nil {
            try? FileManager.default.removeItem(at: folder.appendingPathComponent("\(v).json"))
        }
    }

    static func load(_ file: URL) -> Kept? {
        (try? Data(contentsOf: file)).flatMap { try? JSONDecoder().decode(Kept.self, from: $0) }
    }

    /// The claim's stretches, `[[a, b], …]`; empty when there are none or they can't be read.
    static func stretches(_ json: String?) -> [[Double]] {
        guard let data = json?.data(using: .utf8), let list = (try? JSONSerialization.jsonObject(with: data)) as? [[Double]] else { return [] }
        return list.allSatisfy { $0.count == 2 } ? list : []
    }

    /// The stretches the server found in the picture: `{ stretches: [{ seg, a, b }] }`, in order.
    static func found(_ data: Data) -> [[Double]] {
        let list = ((try? JSONSerialization.jsonObject(with: data)) as? [String: Any])?["stretches"] as? [[String: Any]] ?? []
        return list.compactMap { s in (s["a"] as? Double).flatMap { a in (s["b"] as? Double).map { [a, $0] } } }
    }
}

/// Keeps a job this Mac's while it works: a beat once a minute at most. Throws LookGone when the job went elsewhere or
/// the relay stopped.
private final class Beat: @unchecked Sendable {
    let api: DeviceAPI
    let path: String
    let stopped: @Sendable () -> Bool
    private var last = Date()

    init(api: DeviceAPI, path: String, stopped: @escaping @Sendable () -> Bool) {
        self.api = api
        self.path = path
        self.stopped = stopped
    }

    func check() throws {
        if stopped() { throw LookGone() }
        guard Date().timeIntervalSince(last) >= 60 else { return }
        last = Date()
        let reply = try api.call("POST", path, ["beat": true], tries: 3)
        if reply.status == 404 || reply.status == 401 { throw LookGone() }
    }
}
