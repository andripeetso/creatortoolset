// Face Blur's automatic covers (the plug-in blur-faces, its device job "faceblur"): a photo or video that came into the
// account's Media Library, covered on this Mac with the FaceBlur engine. It reaches this Mac the way a cut-out does
// (Relay.swift: claimed by kind). Then, with the device token:
//   GET  /api/devices/relay/job/faceblur/:id              the original
//   POST /api/devices/relay/job/faceblur/:id              { faces: [{ id, picture, note }] } → { blur: [ids] }, the ones the
//                                                         person's AI chose ("Only some faces"), or { nothing: why } → done
//   POST /api/devices/relay/job/faceblur/:id/file         the covered copy (MP4 or JPEG), streamed
//   or   /api/devices/relay/job/faceblur/:id/fail         { error } with a reason a person can read
// A file with no face covered sends `nothing`, and no copy.
import Foundation

/// The device job kind this Mac lists for Face Blur's automatic covers (the plug-in's AUTO_KIND).
let faceBlurAutoKind = "faceblur"

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

/// One automatic cover, from fetching the original to the copy (or no copy) or why not. Runs on the caller's thread.
struct FaceBlurAutoJob {
    let api: DeviceAPI
    let step: EditorJob
    /// where this job's files are kept while it runs; removed after
    let folder: URL

    var isVideo: Bool { step.options["media"] != "photo" }
    /// the style from the job's options (look, strength, softness, size, color)
    var preset: LookPreset { LookPreset(values: step.options) }

    /// The ids `faces` lists in the server's answer, or nil when it lists none.
    static func chosen(_ data: Data) -> Set<String>? {
        (((try? JSONSerialization.jsonObject(with: data)) as? [String: Any])?["blur"] as? [String]).map { Set($0) }
    }

    /// The server's own sentence in an error answer, or the status.
    static func problem(_ reply: DeviceReply) -> String {
        (((try? JSONSerialization.jsonObject(with: reply.data)) as? [String: Any])?["error"] as? String) ?? "HTTP \(reply.status)"
    }

    func run() -> (end: CardJob.End, more: Bool) {
        let base = "/api/devices/relay/job/\(faceBlurAutoKind)/\(step.id)"
        let files = FileManager.default
        defer { try? files.removeItem(at: folder) }
        let why: String
        do {
            try files.createDirectory(at: folder, withIntermediateDirectories: true)
            // the engine reads a file's kind from its extension; AVFoundation and ImageIO read the content whatever it is
            let source = folder.appendingPathComponent(isVideo ? "original.mov" : "original.jpg")
            let status = try api.download(base, to: source)
            if status == 404 || status == 401 { return (.gone, false) }
            guard status == 200 else { throw FaceBlurAutoRefused(why: "The file could not be read from the server (HTTP \(status)).") }
            let preset = self.preset
            let scan = try waitAsync { try await CoverPipeline.scan(source, preset: preset) { _ in } }
            var blur = Set(scan.faces.map(\.id))
            if step.options["mode"] == "some" && !scan.faces.isEmpty {
                let faces = scan.faces.map { ["id": $0.id, "picture": $0.picture, "note": $0.note] }
                let reply = try api.call("POST", base, ["faces": faces], tries: 2, timeout: 600)
                if reply.status == 404 || reply.status == 401 { return (.gone, false) }
                guard reply.status == 200, let ids = Self.chosen(reply.data) else { throw FaceBlurAutoRefused(why: Self.problem(reply)) }
                blur = ids
            }
            let out = folder.appendingPathComponent(isVideo ? "covered.mp4" : "covered.jpg")
            let chosen = blur
            do {
                try waitAsync { try await CoverPipeline.write(scan, from: source, blur: chosen, style: preset, to: out) { _ in } }
            } catch let nothing as CoverPipeline.NothingToCover {
                let reply = try api.call("POST", base, ["nothing": nothing.why], tries: 3)
                return reply.status == 200 ? (.done, RelayRunner.editorWaits(reply.data)) : (.gone, false)
            }
            let reply = try api.uploadFile("\(base)/file?name=\(out.lastPathComponent)", file: out, type: isVideo ? "video/mp4" : "image/jpeg")
            if reply.status == 200 { return (.done, RelayRunner.editorWaits(reply.data)) }
            if reply.status == 404 || reply.status == 401 { return (.gone, false) }
            throw FaceBlurAutoRefused(why: "The server refused the covered copy: \(Self.problem(reply))")
        } catch let refused as FaceBlurAutoRefused {
            why = refused.why
        } catch let media as MediaError {
            why = media.localizedDescription
        } catch {
            why = "This Mac could not cover the faces: \(error.localizedDescription)."
        }
        let reply = try? api.call("POST", "\(base)/fail", ["error": String(why.prefix(500))], tries: 4)
        return (.failed(why), reply.map { $0.status == 200 && RelayRunner.editorWaits($0.data) } ?? false)
    }
}
