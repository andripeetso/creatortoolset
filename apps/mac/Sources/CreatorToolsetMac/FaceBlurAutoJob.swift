// Face Blur at intake (the plug-in blur-faces, its device job "faceblur-intake"; apps/captions/docs/face-blur-intake-prd.md
// §3a): a Media Library file marked Blur faces, covered on the Mac that has it, read where it is. It reaches this Mac the
// way a cut-out does (Relay.swift: claimed by kind). Options: media, path (the original here), out (the folder to write
// the copy into), the style. Then, with the device token:
//   POST /api/devices/relay/job/faceblur-intake/:id   { back: why }               the file can't be read here: put back
//                                                     { nothing: why, sha256 }    no face found
//                                                     { faces, sha256 } → { blur: [ids] } (empty: none matched, done),
//                                                       or 409 { error, back: true }: the AI provider could not answer,
//                                                       the file is back in the queue (not a failure)
//                                                     { made: { path, size, quick, sha256, duration?, width?, height?, thumb? } }
//   POST /api/devices/relay/job/faceblur-intake/:id/fail   { error } with a reason a person can read
// The original is never downloaded or uploaded; only the copy's record is sent.
import Foundation

/// The device job kind this Mac lists for Face Blur at intake (the plug-in's AUTO_KIND).
let faceBlurAutoKind = "faceblur-intake"

/// Why a file can't be covered, in words for the person.
struct FaceBlurAutoRefused: Error, Equatable {
    let why: String
}

/// Runs async work from a thread that may wait (a relay step's), and gives its result or throws its error.
func waitAsync<T: Sendable>(_ work: @escaping @Sendable () async throws -> T) throws -> T {
    let done = DispatchSemaphore(value: 0)
    nonisolated(unsafe) var result: Result<T, Error>?
    Task.detached {
        do { result = .success(try await work()) } catch { result = .failure(error) }
        done.signal()
    }
    done.wait()
    return try result!.get()
}

/// One file covered at intake, from reading the original where it is to the copy's record (or no copy) or why not.
/// Runs on the caller's thread.
struct FaceBlurAutoJob {
    let api: DeviceAPI
    let step: EditorJob
    /// the folders this Mac reads media from for this server (MediaFiles.granted): the only originals a job may open
    var granted: [String] = MediaFiles.granted

    var isVideo: Bool { step.options["media"] != "photo" }
    /// the style from the job's options (look, strength, softness, size, color)
    var preset: LookPreset { LookPreset(values: step.options) }
    /// the size and bitrate from the job's options (Settings → Face Blur)
    var output: CoverOutput { Self.output(step.options) }

    /// `longSide` "1920", "3840" or "0" (as filmed) and `bitrate` in bits per second (1–100 Mbps); anything else: the
    /// engine's own (1920, 20 Mbps).
    static func output(_ options: [String: String]) -> CoverOutput {
        var out = CoverOutput()
        if let side = options["longSide"], ["1920", "3840", "0"].contains(side) { out.longSide = CGFloat(Int(side)!) }
        if let bits = options["bitrate"].flatMap(Int.init), (1_000_000...100_000_000).contains(bits) { out.bitrate = bits }
        return out
    }

    /// The ids `faces` lists in the server's answer, or nil when it lists none.
    static func chosen(_ data: Data) -> Set<String>? {
        (((try? JSONSerialization.jsonObject(with: data)) as? [String: Any])?["blur"] as? [String]).map { Set($0) }
    }

    /// The server's own sentence in an error answer, or the status.
    static func problem(_ reply: DeviceReply) -> String {
        (((try? JSONSerialization.jsonObject(with: reply.data)) as? [String: Any])?["error"] as? String) ?? "HTTP \(reply.status)"
    }

    /// The server put the file back (its AI provider could not answer): not this Mac's failure.
    static func putBack(_ reply: DeviceReply) -> Bool {
        reply.status == 409 && ((try? JSONSerialization.jsonObject(with: reply.data)) as? [String: Any])?["back"] as? Bool == true
    }

    /// What the server records of the copy: its own size, prints and card picture.
    static func record(of copy: URL) throws -> [String: Any] {
        guard let size = (try FileManager.default.attributesOfItem(atPath: copy.path)[.size] as? NSNumber)?.intValue,
              let quick = Imports.quickPrint(copy.path) else { throw FaceBlurAutoRefused(why: "The blurred copy could not be read back.") }
        var made: [String: Any] = ["path": copy.path, "size": size, "quick": quick, "sha256": try LibraryCopyJob.sha256(of: copy)]
        let read = MacIndex.read(copy.path)
        for key in ["duration", "width", "height", "thumb"] { made[key] = read[key] }
        return made
    }

    func run() -> (end: CardJob.End, more: Bool) {
        let base = "/api/devices/relay/job/\(faceBlurAutoKind)/\(step.id)"
        let post = { (body: [String: Any]) throws -> DeviceReply in try self.api.call("POST", base, body, tries: 3, timeout: 600) }
        let ended = { (reply: DeviceReply) -> (end: CardJob.End, more: Bool) in
            reply.status == 200 ? (.done, RelayRunner.editorWaits(reply.data)) : (.gone, false)
        }
        let why: String
        do {
            guard let path = step.options["path"], let out = step.options["out"] else {
                throw FaceBlurAutoRefused(why: "This Mac app is newer than the server: update the server.")
            }
            let real: String
            switch MediaFiles.gate(path, granted: granted) {
            case .file(let p, _): real = p
            case .status(403), .status(415): throw FaceBlurAutoRefused(why: "The file is not in a folder this Mac shares with the Media Library.")
            default:
                // a disk not connected, or a file moved: back in the queue for a while, not a failure
                _ = try? post(["back": "The file is not on this Mac now."])
                return (.gone, false)
            }
            let source = URL(fileURLWithPath: real)
            let sha256 = try LibraryCopyJob.sha256(of: source)
            let preset = self.preset, output = self.output
            let scan = try waitAsync { try await CoverPipeline.scan(source, preset: preset) { _ in } }
            if scan.faces.isEmpty { return ended(try post(["nothing": "No face found", "sha256": sha256])) }
            let faces = scan.faces.map { ["id": $0.id, "picture": $0.picture, "note": $0.note] }
            let reply = try post(["faces": faces, "sha256": sha256])
            if reply.status == 404 || reply.status == 401 || Self.putBack(reply) { return (.gone, false) }
            guard reply.status == 200, let blur = Self.chosen(reply.data) else { throw FaceBlurAutoRefused(why: Self.problem(reply)) }
            // none matched: the server has kept the file as filmed and ended the job
            if blur.isEmpty { return (.done, RelayRunner.editorWaits(reply.data)) }
            let folder = URL(fileURLWithPath: out, isDirectory: true)
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            // "<name> blurred.mp4" in `out`, numbered when taken; the engine writes a hidden partial file and renames it
            let copy = CoverPipeline.outputURL(for: folder.appendingPathComponent(source.lastPathComponent), kind: scan.kind)
            try waitAsync { try await CoverPipeline.write(scan, from: source, blur: blur, style: preset, to: copy, output: output) { _ in } }
            let made = try post(["made": try Self.record(of: copy)])
            if made.status == 200 || made.status == 404 || made.status == 401 { return ended(made) }
            throw FaceBlurAutoRefused(why: "The server did not take the blurred copy: \(Self.problem(made))")
        } catch let refused as FaceBlurAutoRefused {
            why = refused.why
        } catch let nothing as CoverPipeline.NothingToCover {
            why = nothing.why
        } catch let media as MediaError {
            why = media.localizedDescription
        } catch {
            why = "This Mac could not cover the faces: \(error.localizedDescription)."
        }
        let reply = try? api.call("POST", "\(base)/fail", ["error": String(why.prefix(500))], tries: 4)
        return (.failed(why), reply.map { $0.status == 200 && RelayRunner.editorWaits($0.data) } ?? false)
    }
}
