// Where the speaker's eyes leave the lens, for an AI Editor cut's B-roll (the server's `lookaway` step,
// apps/captions/api/editor/lookaway.ts). The claim carries the camera takes still to measure (`footage`: where each is
// on this Mac, or the server's proxy to download). Each is read four times a second with the Mac's own face finder: the
// head's turn and tilt, and where the pupils sit across the eyes. Then, with the device token:
//   POST /api/devices/relay/editor/job/:id/gaze/:version   { fps, step, samples: [[yaw, pitch, iris] | null, …] }
//   POST /api/devices/relay/editor/job/:id/done, or /fail { error }; /beat every 15 s while it works
// Nothing but those numbers leaves this Mac.
import AVFoundation
import Foundation
import Vision

let lookAwayKind = "lookaway"

/// Why a take can't be measured, in words for the person.
struct LookAwayRefused: Error, Equatable {
    let why: String
}

/// The app is stopping: the step goes back to the server as it is, no try used up.
struct LookAwayStopped: Error {}

struct LookAwayJob {
    let api: DeviceAPI
    let step: EditorJob
    /// where downloaded proxies are kept (TranscribeJob's cache)
    var proxies: URL? = nil
    var granted: [String] = MediaFiles.granted
    var stopped: () -> Bool = { false }

    private var base: String { "/api/devices/relay/editor/job/\(step.id)" }

    /// Samples a second.
    static let perSecond = 4.0

    /// The eyes' place across one eye, 0 at one corner and 1 at the other: the pupil along the line between the eye's
    /// outermost points (any one coordinate space). Nil without a usable eye.
    static func across(eye: [CGPoint], pupil: CGPoint) -> Double? {
        guard let a = eye.min(by: { $0.x < $1.x }), let b = eye.max(by: { $0.x < $1.x }) else { return nil }
        let vx = b.x - a.x, vy = b.y - a.y, l2 = vx * vx + vy * vy
        guard l2 > 0 else { return nil }
        return Double(((pupil.x - a.x) * vx + (pupil.y - a.y) * vy) / l2)
    }

    /// One sample of a picture: [yaw°, pitch°, iris] of its biggest face, or nil when no face is found.
    static func sample(_ image: CGImage) throws -> [Double]? {
        let rects = VNDetectFaceRectanglesRequest()
        rects.revision = VNDetectFaceRectanglesRequestRevision3   // turn and tilt
        let marks = VNDetectFaceLandmarksRequest()
        try VNImageRequestHandler(cgImage: image).perform([rects, marks])
        let area = { (f: VNFaceObservation) in f.boundingBox.width * f.boundingBox.height }
        guard let face = rects.results?.max(by: { area($0) < area($1) }) else { return nil }
        let deg = { (n: NSNumber?) in (n?.doubleValue ?? 0) * 180 / .pi }
        // the landmarks of the same face: the one whose box is nearest
        let lm = marks.results?.min(by: { abs($0.boundingBox.midX - face.boundingBox.midX) + abs($0.boundingBox.midY - face.boundingBox.midY) < abs($1.boundingBox.midX - face.boundingBox.midX) + abs($1.boundingBox.midY - face.boundingBox.midY) })?.landmarks
        let eyes = [(lm?.leftEye, lm?.leftPupil), (lm?.rightEye, lm?.rightPupil)].compactMap { eye, pupil -> Double? in
            guard let eye, let p = pupil?.normalizedPoints.first else { return nil }
            return across(eye: eye.normalizedPoints, pupil: p)
        }
        let iris = eyes.isEmpty ? 0.5 : eyes.reduce(0, +) / Double(eyes.count)
        return [deg(face.yaw), deg(face.pitch), iris].map { ($0 * 1000).rounded() / 1000 }
    }

    /// A take's samples: its frame rate, the frames between two samples, and a sample every `step` frames from frame 0.
    func measure(_ url: URL) throws -> (fps: Double, step: Int, samples: [[Double]?]) {
        let asset = AVURLAsset(url: url)
        let (tracks, duration) = try waitAsync { (try await asset.loadTracks(withMediaType: .video), try await asset.load(.duration)) }
        guard let track = tracks.first else { throw LookAwayRefused(why: "A take has no picture.") }
        let rate = Double(try waitAsync { try await track.load(.nominalFrameRate) })
        let fps = rate > 0 ? rate : 30
        let every = max(1, Int((fps / Self.perSecond).rounded()))
        let make = AVAssetImageGenerator(asset: asset)
        make.appliesPreferredTrackTransform = true
        make.maximumSize = CGSize(width: 640, height: 640)
        let tolerance = CMTime(seconds: Double(every) / fps / 2, preferredTimescale: 600)
        make.requestedTimeToleranceBefore = tolerance
        make.requestedTimeToleranceAfter = tolerance
        var samples: [[Double]?] = []
        let count = Int(duration.seconds * fps) / every + 1
        for k in 0..<count {
            if stopped() { throw LookAwayStopped() }
            let at = CMTime(seconds: Double(k * every) / fps, preferredTimescale: 600)
            // a frame that can't be read counts as no face, as one with nobody in it does
            let image = try? waitAsync { try await make.image(at: at).image }
            samples.append(try image.flatMap { try Self.sample($0) })
        }
        return (fps, every, samples)
    }

    /// The take's file on this Mac: where the server says it is (in a folder the person gave this app), else the
    /// server's proxy, downloaded into the cache once.
    func file(_ f: EditorJob.Footage) throws -> URL {
        if let path = f.path {
            guard case .file(let real, _) = MediaFiles.gate(path, granted: granted) else { throw LookAwayRefused(why: "A take is not in a folder this Mac may read.") }
            return URL(fileURLWithPath: real)
        }
        guard let proxies, f.id.range(of: "^[A-Za-z0-9_-]{1,100}$", options: .regularExpression) != nil else { throw LookAwayRefused(why: "A take could not be read from the server.") }
        let cached = proxies.appendingPathComponent("\(f.id).mp4")
        if FileManager.default.fileExists(atPath: cached.path) { return cached }
        try FileManager.default.createDirectory(at: proxies, withIntermediateDirectories: true)
        let part = proxies.appendingPathComponent("\(f.id).mp4.part")
        let status = try api.download("\(base)/footage/\(f.id)", to: part, timeout: 1800)
        guard status == 200 else {
            try? FileManager.default.removeItem(at: part)
            throw LookAwayRefused(why: "A take could not be read from the server (HTTP \(status)).")
        }
        try? FileManager.default.removeItem(at: cached)
        try FileManager.default.moveItem(at: part, to: cached)
        return cached
    }

    func run() -> (end: CardJob.End, more: Bool) {
        let lease = Lease()
        Thread { [api, base] in CardJob.keep(lease, api: api, base: base) }.start()
        defer { lease.end() }
        // a take that can't be read is left out (its look-aways are not covered); the step fails only when none could be
        var failed: [String] = []
        for f in step.footage {
            if lease.isLost { return (.gone, false) }
            do {
                let m = try measure(try file(f))
                let reply = try api.call("POST", "\(base)/gaze/\(f.id)", ["fps": m.fps, "step": m.step, "samples": m.samples.map { $0 ?? NSNull() as Any }], tries: 3, timeout: 120)
                if reply.status == 404 || reply.status == 401 { return (.gone, false) }
                guard reply.status == 200 else { throw LookAwayRefused(why: "The server refused a take's look-aways (HTTP \(reply.status)).") }
            } catch is LookAwayStopped {
                return (.gone, false)
            } catch let refused as LookAwayRefused {
                failed.append(refused.why)
            } catch {
                failed.append("This Mac could not find where the eyes leave the lens: \(error.localizedDescription).")
            }
        }
        let end: CardJob.End = !failed.isEmpty && failed.count == step.footage.count ? .failed(failed[0]) : .done
        let reply = end == .done ? try? api.call("POST", "\(base)/done", tries: 4) : try? api.call("POST", "\(base)/fail", ["error": String((end.why ?? "").prefix(500))], tries: 4)
        return (end, reply.map { $0.status == 200 && RelayRunner.editorWaits($0.data) } ?? false)
    }
}

extension CardJob.End {
    /// the failure's words, nil for any other end
    var why: String? { if case .failed(let w) = self { return w }; return nil }
}
