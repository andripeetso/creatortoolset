// Face Blur engine (Cover.swift says what this folder is): scanning a video for faces.
import AVFoundation
import Vision

struct AnalysisUpdate: Sendable {
    var fraction: Double
    /// Scanned up to this source time.
    var analyzedUntil: Double
    /// Covers found so far, when they changed.
    var covers: [Cover]?
}

struct AnalysisResult: Sendable {
    var covers: [Cover]
    var analyzedUntil: Double
    var completed: Bool
}

/// Scans a video for faces: Vision detection on every frame (up to 30 fps),
/// Vision object tracking to bridge moments a face can't be detected
/// (turning away, motion blur), and a short backward pass so a face entering
/// the frame is covered from its first frames.
final class VideoAnalyzer {
    static let analysisLongSide: CGFloat = 1280
    /// Follow a newly found face back this far.
    static let backfill = 0.3
    static let followConfidence: Float = 0.45

    private let asset: AVAsset
    private let range: ClosedRange<Double>
    private let preset: LookPreset

    init(asset: AVAsset, range: ClosedRange<Double>, preset: LookPreset) {
        self.asset = asset
        self.range = range
        self.preset = preset
    }

    /// Runs until done or cancelled. Cancelling returns the covers found so far with `completed` false: never write
    /// those.
    func run(update: @escaping @Sendable (AnalysisUpdate) -> Void) async throws -> AnalysisResult {
        let reader = try await FrameReader(asset: asset, range: range, longSide: Self.analysisLongSide)
        let builder = TrackBuilder(frame: reader.size)
        let copier = PixelBufferCopier()
        let span = max(0.001, range.upperBound - range.lowerBound)
        // Long clips scan at 15 fps to keep the wait reasonable.
        let minInterval = span > 180 ? 1.0 / 15 - 0.002 : 1.0 / 30 - 0.002

        var recent: [FrameReader.Frame] = []  // copies, oldest first
        var followers: [Int: Follower] = [:]
        var givenUp = Set<Int>()
        var lastProcessed = -Double.infinity
        var analyzedUntil = range.lowerBound
        var lastReport = Date.distantPast
        var lastCoverReport = Date()
        var completed = true

        while let frame = try reader.next() {
            if Task.isCancelled {
                completed = false
                reader.cancel()
                break
            }
            guard frame.time - lastProcessed >= minInterval else { continue }
            lastProcessed = frame.time

            try autoreleasepool {
                let detections = try FaceDetector.detect(in: frame.buffer)
                let result = builder.ingest(time: frame.time, detections: detections)

                // Detected again: drop any optical follower.
                for id in result.matched {
                    followers[id]?.finish()
                    followers[id] = nil
                    givenUp.remove(id)
                }

                // Follow faces that detection lost this frame.
                let previous = recent.last
                for id in result.lost where !givenUp.contains(id) {
                    guard let track = builder.track(id) else { continue }
                    if followers[id] == nil {
                        // Seed on the frame where we last knew the position.
                        guard let previous, abs(previous.time - track.last.time) < 1e-3 else {
                            givenUp.insert(id)
                            continue
                        }
                        let seed = builder.faceRect(forCover: track.last.rect)
                        let follower = Follower(seed: seed)
                        _ = follower.step(previous.buffer)
                        followers[id] = follower
                    }
                    guard let follower = followers[id],
                          let found = follower.step(frame.buffer),
                          found.confidence >= Self.followConfidence,
                          !result.occupied.contains(where: { $0.iou(found.rect) > 0.35 && $0.centreDistance(to: found.rect) < 0.6 })
                    else {
                        followers[id]?.finish()
                        followers[id] = nil
                        givenUp.insert(id)
                        continue
                    }
                    builder.addFollowed(id, time: frame.time, faceRect: found.rect, angle: track.last.angle)
                }
                // Release followers for tracks that expired.
                for id in followers.keys where !result.lost.contains(id) {
                    followers[id]?.finish()
                    followers[id] = nil
                }

                // New face: follow it backwards through recent frames.
                for id in result.spawned {
                    guard let track = builder.track(id), !recent.isEmpty else { continue }
                    let back = Follower(seed: builder.faceRect(forCover: track.last.rect))
                    _ = back.step(frame.buffer)
                    var found: [(time: Double, faceRect: NormRect)] = []
                    for old in recent.reversed() {
                        guard frame.time - old.time <= Self.backfill,
                              let hit = back.step(old.buffer),
                              hit.confidence >= Self.followConfidence else { break }
                        found.append((old.time, hit.rect))
                    }
                    back.finish()
                    if !found.isEmpty { builder.prependFollowed(id, samples: found) }
                }

                if let copy = copier.copy(frame.buffer) {
                    recent.append(FrameReader.Frame(time: frame.time, buffer: copy))
                    recent.removeAll { frame.time - $0.time > Self.backfill + 0.05 }
                }
            }

            analyzedUntil = frame.time
            let now = Date()
            if now.timeIntervalSince(lastReport) > 0.15 {
                lastReport = now
                var covers: [Cover]?
                if now.timeIntervalSince(lastCoverReport) > 0.8 {
                    lastCoverReport = now
                    covers = builder.covers(scanStart: range.lowerBound, scanEnd: frame.time, preset: preset)
                }
                update(AnalysisUpdate(
                    fraction: min(1, (frame.time - range.lowerBound) / span),
                    analyzedUntil: frame.time,
                    covers: covers
                ))
            }
        }
        followers.values.forEach { $0.finish() }

        let scanEnd = completed ? range.upperBound : analyzedUntil
        let covers = builder.covers(scanStart: range.lowerBound, scanEnd: scanEnd, preset: preset)
        return AnalysisResult(covers: covers, analyzedUntil: scanEnd, completed: completed)
    }
}

/// One Vision object tracker following a face box from frame to frame.
final class Follower {
    private let handler = VNSequenceRequestHandler()
    private let request: VNTrackObjectRequest

    init(seed: NormRect) {
        let observation = VNDetectedObjectObservation(boundingBox: FaceDetector.visionRect(from: seed).standardized)
        request = VNTrackObjectRequest(detectedObjectObservation: observation)
        request.trackingLevel = .accurate
    }

    func step(_ buffer: CVPixelBuffer) -> (rect: NormRect, confidence: Float)? {
        do {
            try handler.perform([request], on: buffer, orientation: .up)
        } catch {
            return nil
        }
        guard let observation = request.results?.first as? VNDetectedObjectObservation else { return nil }
        request.inputObservation = observation
        return (FaceDetector.normRect(fromVision: observation.boundingBox), observation.confidence)
    }

    /// Frees the tracker; Vision limits how many can run at once.
    func finish() {
        request.isLastFrame = true
    }
}
