// Face Blur engine (Cover.swift says what this folder is): per-frame detections into cover tracks.
import Foundation
import CoreGraphics

/// Turns per-frame detections into cover tracks.
///
/// Association, then clean-up: outliers dropped, fragments of one face joined, flickers dropped, paths smoothed.
/// Tuned for Vision's scores and for scanning every frame.
final class TrackBuilder {
    struct Sample: Hashable {
        var time: Double
        /// Cover circle, not the tight face box.
        var rect: NormRect
        var angle: Double
        var score: Double
        var followed: Bool
    }

    struct Track {
        let id: Int
        var samples: [Sample]
        var lastDetected: Double
        var peakScore: Double

        var last: Sample { samples[samples.count - 1] }
    }

    struct FrameResult {
        /// Tracks that got a detection this frame.
        var matched: Set<Int> = []
        /// Tracks started this frame.
        var spawned: [Int] = []
        /// Tracks worth following optically this frame: recently seen but not
        /// detected now.
        var lost: [Int] = []
        /// Cover circles occupied by fresh detections, so optical following
        /// never lands on another face.
        var occupied: [NormRect] = []
    }

    // Tuning. Gaps are in seconds.
    static let maxGap = 1.5
    static let followMax = 3.0
    static let spawnScore = 0.55
    static let keepScore = 0.75

    let frame: CGSize
    private(set) var tracks: [Track] = []
    private var nextID = 1
    private(set) var scannedFrames = 0

    init(frame: CGSize) {
        self.frame = frame
    }

    func track(_ id: Int) -> Track? { tracks.first { $0.id == id } }

    // MARK: Per frame

    @discardableResult
    func ingest(time: Double, detections raw: [FaceDetection]) -> FrameResult {
        scannedFrames += 1
        var result = FrameResult()
        let detections = raw
            .filter { FaceDetector.isPlausible($0.rect, in: frame) }
            .map { (cover: FaceDetector.coverRect(for: $0.rect, in: frame), det: $0) }

        // Candidate pairs with a finite cost, cheapest first.
        var pairs: [(cost: Double, track: Int, det: Int)] = []
        for (ti, track) in tracks.enumerated() {
            guard time - track.last.time <= Self.maxGap else { continue }
            let predicted = prediction(for: track, at: time)
            for (di, d) in detections.enumerated() {
                if let cost = Self.cost(predicted, d.cover) {
                    pairs.append((cost, ti, di))
                }
            }
        }
        pairs.sort { $0.cost < $1.cost }
        var usedTracks = Set<Int>(), usedDets = Set<Int>()
        for pair in pairs where !usedTracks.contains(pair.track) && !usedDets.contains(pair.det) {
            usedTracks.insert(pair.track)
            usedDets.insert(pair.det)
            let d = detections[pair.det]
            tracks[pair.track].samples.append(Sample(time: time, rect: d.cover, angle: d.det.angle, score: d.det.score, followed: false))
            tracks[pair.track].lastDetected = time
            tracks[pair.track].peakScore = max(tracks[pair.track].peakScore, d.det.score)
            result.matched.insert(tracks[pair.track].id)
            result.occupied.append(d.cover)
        }

        // New faces, most confident first, skipping duplicates of a face
        // already claimed this frame.
        let unmatched = detections.indices
            .filter { !usedDets.contains($0) }
            .sorted { detections[$0].det.score > detections[$1].det.score }
        for di in unmatched {
            let d = detections[di]
            guard d.det.score >= Self.spawnScore else { continue }
            let duplicate = result.occupied.contains { $0.iou(d.cover) >= 0.2 || $0.centreDistance(to: d.cover) < 0.7 }
            guard !duplicate else { continue }
            let id = nextID
            nextID += 1
            tracks.append(Track(
                id: id,
                samples: [Sample(time: time, rect: d.cover, angle: d.det.angle, score: d.det.score, followed: false)],
                lastDetected: time,
                peakScore: d.det.score
            ))
            result.spawned.append(id)
            result.occupied.append(d.cover)
        }

        for track in tracks where !result.matched.contains(track.id) && !result.spawned.contains(track.id) {
            let sinceSeen = time - track.lastDetected
            let sinceSample = time - track.last.time
            if sinceSeen <= Self.followMax && sinceSample <= Self.maxGap {
                result.lost.append(track.id)
            }
        }
        return result
    }

    /// Record an optically followed position for a track that wasn't
    /// detected this frame.
    func addFollowed(_ id: Int, time: Double, faceRect: NormRect, angle: Double) {
        guard let i = tracks.firstIndex(where: { $0.id == id }) else { return }
        let cover = followedCover(faceRect, like: tracks[i].last.rect)
        tracks[i].samples.append(Sample(time: time, rect: cover, angle: angle, score: 0, followed: true))
    }

    /// Positions found by following a new track backwards in time.
    func prependFollowed(_ id: Int, samples: [(time: Double, faceRect: NormRect)]) {
        guard let i = tracks.firstIndex(where: { $0.id == id }), let first = tracks[i].samples.first else { return }
        let earlier = samples.map {
            Sample(time: $0.time, rect: followedCover($0.faceRect, like: first.rect), angle: first.angle, score: 0, followed: true)
        }
        tracks[i].samples = (earlier + tracks[i].samples).sorted { $0.time < $1.time }
    }

    /// The tracker keeps the seed's size; keep the cover's padded size and
    /// take only the new centre.
    private func followedCover(_ face: NormRect, like reference: NormRect) -> NormRect {
        NormRect(cx: face.cx, cy: face.cy, w: reference.w, h: reference.h)
    }

    /// The tight face box to seed optical tracking from a cover circle.
    func faceRect(forCover cover: NormRect) -> NormRect {
        cover.scaled(1 / 1.35)
    }

    // MARK: Association

    /// Constant-velocity prediction from detected samples in the last 0.5 s.
    private func prediction(for track: Track, at time: Double) -> NormRect {
        let anchor = track.last
        let recent = track.samples.filter { !$0.followed && anchor.time - $0.time <= 0.5 }
        guard let reference = recent.first, let latest = recent.last,
              latest.time - reference.time >= 0.15 else { return anchor.rect }
        let dt = latest.time - reference.time
        let vx = (latest.rect.cx - reference.rect.cx) / dt
        let vy = (latest.rect.cy - reference.rect.cy) / dt
        let ahead = min(1, time - anchor.time)
        return anchor.rect.offsetBy(dx: vx * ahead, dy: vy * ahead)
    }

    static func cost(_ predicted: NormRect, _ candidate: NormRect) -> Double? {
        let iou = predicted.iou(candidate)
        let dist = predicted.centreDistance(to: candidate)
        let ratio = candidate.w / max(1e-6, predicted.w)
        if iou < 0.05 && dist > 1.6 { return nil }
        if ratio < 1 / 1.8 || ratio > 1.8 { return nil }
        return 1 - iou + 0.5 * dist + 0.8 * abs(log(ratio))
    }

    // MARK: Finish

    /// Final covers for a scanned range.
    func covers(scanStart: Double, scanEnd: Double, preset: LookPreset) -> [Cover] {
        var cleaned = tracks.map { track -> Track in
            var t = track
            t.samples = Self.dropOutliers(t.samples.sorted { $0.time < $1.time })
            return t
        }
        cleaned = Self.mergeFragments(cleaned)
        cleaned = cleaned.filter { keep($0) }
        return cleaned
            .sorted { ($0.samples.first?.time ?? 0) < ($1.samples.first?.time ?? 0) }
            .map { track in
                let samples = Self.smooth(track.samples)
                let first = samples.first!.time, last = samples.last!.time
                // Faces seen right at the edges of the scan stay covered to
                // the edge: they were probably there but blurred or turning.
                let start = first - scanStart <= 0.5 ? scanStart : max(scanStart, first - Cover.leadHold)
                let end = scanEnd - last <= 1.0 ? scanEnd : min(scanEnd, last + Cover.tailHold)
                var cover = Cover(
                    path: samples.map { PathSample(time: $0.time, rect: $0.rect, angle: $0.angle, followed: $0.followed) },
                    start: start,
                    end: end
                )
                preset.apply(to: &cover)
                return cover
            }
    }

    /// Short flickers are usually false positives. Keep anything confident,
    /// and anything seen on at least three frames.
    private func keep(_ track: Track) -> Bool {
        let detected = track.samples.filter { !$0.followed }.count
        if scannedFrames < 4 { return true }
        return detected >= 3 || track.peakScore >= Self.keepScore
    }

    /// Removes detections that jump away from their neighbours.
    static func dropOutliers(_ samples: [Sample]) -> [Sample] {
        var s = samples
        var changed = true
        while changed && s.count >= 3 {
            changed = false
            for i in 1..<(s.count - 1) {
                let a = s[i - 1], b = s[i + 1], m = s[i]
                let span = b.time - a.time
                guard span > 0 else { continue }
                let f = (m.time - a.time) / span
                let expected = NormRect.lerp(a.rect, b.rect, f)
                let dx = m.rect.cx - expected.cx, dy = m.rect.cy - expected.cy
                let size = max(expected.w, expected.h)
                if (dx * dx + dy * dy).squareRoot() > 0.6 * size {
                    s.remove(at: i)
                    changed = true
                    break
                }
            }
        }
        return s
    }

    /// Joins pieces of the same face that detection split apart.
    static func mergeFragments(_ input: [Track]) -> [Track] {
        var tracks = input.filter { !$0.samples.isEmpty }.sorted { $0.samples[0].time < $1.samples[0].time }
        var merged = true
        while merged {
            merged = false
            outer: for i in tracks.indices {
                for j in tracks.indices where j != i {
                    let a = tracks[i], b = tracks[j]
                    guard a.samples[0].time <= b.samples[0].time else { continue }
                    if sameFace(a, b) {
                        var joined = a
                        joined.samples = mergeSamples(a.samples, b.samples)
                        joined.lastDetected = max(a.lastDetected, b.lastDetected)
                        joined.peakScore = max(a.peakScore, b.peakScore)
                        tracks[i] = joined
                        tracks.remove(at: j)
                        merged = true
                        break outer
                    }
                }
            }
        }
        return tracks
    }

    private static func sameFace(_ a: Track, _ b: Track) -> Bool {
        let aEnd = a.last.time, bStart = b.samples[0].time
        if bStart > aEnd {
            // Sequential pieces with a short gap.
            guard bStart - aEnd <= maxGap else { return false }
            let x = a.last.rect, y = b.samples[0].rect
            let ratio = y.w / max(1e-6, x.w)
            return x.iou(y) >= 0.25 || (x.centreDistance(to: y) <= 0.9 && ratio >= 0.6 && ratio <= 1.6)
        }
        // Overlapping in time: the same face at two of three probe times.
        let overlapEnd = min(aEnd, b.last.time)
        let probes = [bStart, (bStart + overlapEnd) / 2, overlapEnd]
        let hits = probes.filter { t in
            let pa = Cover.pathSample(a.samples.map(pathSample), at: t).rect
            let pb = Cover.pathSample(b.samples.map(pathSample), at: t).rect
            return pa.iou(pb) >= 0.3 || pa.centreDistance(to: pb) < 0.35
        }
        return hits.count >= 2
    }

    private static func pathSample(_ s: Sample) -> PathSample {
        PathSample(time: s.time, rect: s.rect, angle: s.angle, followed: s.followed)
    }

    /// Union of two sample lists; at the same moment a detection beats a
    /// followed position, then the higher score wins.
    private static func mergeSamples(_ a: [Sample], _ b: [Sample]) -> [Sample] {
        var byTime: [Int: Sample] = [:]
        for s in a + b {
            let bucket = Int((s.time * 60).rounded())
            if let existing = byTime[bucket] {
                let better = (existing.followed && !s.followed) || (existing.followed == s.followed && s.score > existing.score)
                if better { byTime[bucket] = s }
            } else {
                byTime[bucket] = s
            }
        }
        return byTime.values.sorted { $0.time < $1.time }
    }

    /// 1-2-1 smoothing of centre, size and roll with neighbours within 0.9 s.
    static func smooth(_ samples: [Sample]) -> [Sample] {
        guard samples.count >= 3 else { return samples }
        var out = samples
        for i in 1..<(samples.count - 1) {
            let a = samples[i - 1], m = samples[i], b = samples[i + 1]
            guard m.time - a.time <= Cover.interpolateMax, b.time - m.time <= Cover.interpolateMax else { continue }
            out[i].rect = NormRect(
                cx: (a.rect.cx + 2 * m.rect.cx + b.rect.cx) / 4,
                cy: (a.rect.cy + 2 * m.rect.cy + b.rect.cy) / 4,
                w: (a.rect.w + 2 * m.rect.w + b.rect.w) / 4,
                h: (a.rect.h + 2 * m.rect.h + b.rect.h) / 4
            )
            let da = Cover.lerpAngle(m.angle, a.angle, 1) - m.angle
            let db = Cover.lerpAngle(m.angle, b.angle, 1) - m.angle
            out[i].angle = m.angle + (da + db) / 4
        }
        return out
    }
}

extension TrackBuilder {
    /// Covers for a photo: one detection pass, one sample per face.
    static func photoCovers(_ detections: [FaceDetection], frame: CGSize, preset: LookPreset) -> [Cover] {
        let builder = TrackBuilder(frame: frame)
        builder.ingest(time: 0, detections: detections)
        return builder.tracks.map { track in
            let s = track.samples[0]
            var cover = Cover(
                path: [PathSample(time: 0, rect: s.rect, angle: s.angle)],
                start: 0,
                end: 0
            )
            preset.apply(to: &cover)
            return cover
        }
    }
}
