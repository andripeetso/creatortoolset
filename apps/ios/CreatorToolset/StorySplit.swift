import Foundation

/// Story Splitter's thinking, ported one to one from the website
/// (apps/captions/src/lib/story-split.ts: same constants, same scoring), so
/// the app and the page cut a video in the same places.
///
/// Three signals become scored spots: hard cuts in the edit (frame
/// differences), pauses (quiet runs in the audio) and beats (a steady pulse in
/// the loudness onsets). `planCuts` picks the spots that keep every story near
/// the target length. Reading the signals from a file: `StorySignals` in
/// StorySplitterView.swift.
enum StorySplit {
    /// Audio envelope rate: values per second.
    static let hz = 100
    /// Instagram's longest story.
    static let maxStory = 60.0

    struct Frame: Equatable {
        var t: Double
        /// How much it differs from the frame before (0...1).
        var diff: Double
    }

    struct Signals {
        var duration: Double
        /// Every decoded frame, in order.
        var frames: [Frame]
        /// Loudness in dB, `hz` values per second; empty without audio.
        var db: [Float]
    }

    enum Why: Equatable {
        case shot, shotPause, shotBeat, pause, beat, quiet, speech

        /// Read as "ends …" in the list of stories.
        var text: String {
            switch self {
            case .shot: "on a cut"
            case .shotPause: "on a cut, in a pause"
            case .shotBeat: "on a cut, on the beat"
            case .pause: "in a pause"
            case .beat: "on the beat"
            case .quiet: "in a quiet moment"
            case .speech: "mid-sound"
            }
        }

        var isShot: Bool { self == .shot || self == .shotPause || self == .shotBeat }
    }

    struct Spot: Equatable {
        var t: Double
        /// Higher = a better place to cut; below 0 = it cuts through sound.
        var score: Double
        var why: Why
    }

    struct Analysis {
        var duration: Double
        /// Loudness 0...1, `hz` values per second.
        var energy: [Float]
        var spots: [Spot]
        var shots: Int
        var pauses: Int
        var bpm: Int?
    }

    // MARK: Analysis

    static func analyse(_ sig: Signals) -> Analysis {
        let db = sig.db, duration = sig.duration, rate = Double(hz)
        let sorted = db.sorted()
        let lo = sorted.isEmpty ? 0 : Double(sorted[Int(Double(sorted.count) * 0.1)])
        let hi = sorted.isEmpty ? 0 : Double(sorted[Int(Double(sorted.count) * 0.9)])
        // Under 6 dB of range there is nothing to tell speech from silence.
        let flat = hi - lo < 6
        let energy: [Float] = flat
            ? Array(repeating: 0, count: db.count)
            : db.map { Float(min(1, max(0, (Double($0) - lo) / (hi - lo)))) }
        func penalty(_ t: Double, _ before: Double = 0.05, _ after: Double = 0.05) -> Double {
            0.8 * loudness(energy, t - before, t + after)
        }

        var pauses: [(start: Double, end: Double)] = []
        if !flat {
            let quiet = lo + 0.35 * (hi - lo)
            var i = 0
            while i < db.count {
                if Double(db[i]) >= quiet { i += 1; continue }
                var j = i
                while j < db.count && Double(db[j]) < quiet { j += 1 }
                if Double(j - i) >= 0.15 * rate { pauses.append((Double(i) / rate, Double(j) / rate)) }
                i = j
            }
        }

        let flux: [Float] = db.indices.map { i in
            i < 2 || flat ? 0 : Float(min(20, max(0, Double(db[i]) - Double(db[i - 2]))))
        }
        let period = pulse(flux)
        var beats: [Double] = []
        if let period {
            var phase = 0, top = -1.0
            for p in 0..<period {
                var s = 0.0
                for i in stride(from: p, to: flux.count, by: period) { s += Double(flux[i]) }
                if s > top { top = s; phase = p }
            }
            for i in stride(from: phase, to: flux.count, by: period) {
                var at = i
                for k in max(0, i - 3)...min(flux.count - 1, i + 3) where flux[k] > flux[at] { at = k }
                beats.append(Double(max(0, at - 2)) / rate) // the start of the rise
            }
        }

        let shots = shotCuts(sig.frames)
        var spots: [Spot] = []
        var usedPause = Set<Int>(), usedBeat = Set<Int>()
        for s in shots {
            var spot = Spot(t: s.t, score: 0.6 + 0.4 * s.strength - penalty(s.t), why: .shot)
            if let p = pauses.firstIndex(where: { s.t >= $0.start - 0.1 && s.t <= $0.end + 0.1 }) {
                usedPause.insert(p)
                spot.score = max(spot.score, pauseScore(pauses[p])) + 0.3
                spot.why = .shotPause
            } else if let b = beats.firstIndex(where: { abs($0 - s.t) <= 0.08 }) {
                usedBeat.insert(b)
                spot.score += 0.15
                spot.why = .shotBeat
            }
            spots.append(spot)
        }
        for (i, p) in pauses.enumerated() where !usedPause.contains(i) {
            spots.append(Spot(t: (p.start + p.end) / 2, score: pauseScore(p), why: .pause))
        }
        for (i, t) in beats.enumerated() where !usedBeat.contains(i) {
            spots.append(Spot(t: t, score: 0.35 - penalty(t, 0.08, 0), why: .beat))
        }
        return Analysis(
            duration: duration,
            energy: energy,
            spots: spots.filter { $0.t > 0.3 && $0.t < duration - 0.3 }.sorted { $0.t < $1.t },
            shots: shots.count,
            pauses: pauses.count,
            bpm: period.map { Int((60 * rate / Double($0)).rounded()) }
        )
    }

    /// Hard cuts: one frame far more different than the frames around it.
    private static func shotCuts(_ frames: [Frame]) -> [(t: Double, strength: Double)] {
        var out: [(t: Double, strength: Double)] = []
        guard frames.count > 1 else { return out }
        for i in 1..<frames.count {
            let d = frames[i].diff
            let next = i + 1 < frames.count ? frames[i + 1].diff : 0
            if d < 0.025 || d <= frames[i - 1].diff || d < next { continue }
            let around = (max(1, i - 6)..<min(frames.count, i + 7)).filter { $0 != i }.map { frames[$0].diff }
            if d >= 4 * median(around) { out.append((frames[i].t, min(1, d / 0.25))) }
        }
        return out
    }

    private static func median(_ xs: [Double]) -> Double {
        let s = xs.sorted()
        return s.isEmpty ? 0 : s[s.count / 2]
    }

    /// A steady pulse in the loudness onsets: its period in envelope steps, or nil.
    private static func pulse(_ flux: [Float]) -> Int? {
        let mean = flux.reduce(0.0) { $0 + Double($1) } / Double(max(1, flux.count))
        let f = flux.map { Float(Double($0) - mean) }
        let energy = f.reduce(0.0) { $0 + Double($1) * Double($1) }
        if energy == 0 || f.count < 8 * hz { return nil }
        var best = 0.0, period = 0
        // ponytail: plain autocorrelation over 60–200 BPM, as on the website; a real beat tracker if cuts drift off the beat
        f.withUnsafeBufferPointer { f in
            for lag in 30...100 {
                var r = 0.0
                for i in 0..<(f.count - lag) { r += Double(f[i]) * Double(f[i + lag]) }
                if r / energy > best { best = r / energy; period = lag }
            }
        }
        return best >= 0.25 ? period : nil
    }

    /// A breath scores 0.5, a sentence end (1 s+) 1.
    private static func pauseScore(_ p: (start: Double, end: Double)) -> Double {
        0.4 + 0.6 * min(1, p.end - p.start)
    }

    /// Mean loudness (0...1) from `from` to `to` seconds.
    private static func loudness(_ energy: [Float], _ from: Double, _ to: Double) -> Double {
        let a = max(0, Int((from * Double(hz)).rounded(.down)))
        let b = min(energy.count, Int((to * Double(hz)).rounded(.up)))
        guard b > a else { return 0 }
        var sum = 0.0
        for i in a..<b { sum += Double(energy[i]) }
        return sum / Double(b - a)
    }

    // MARK: Cuts

    /// What cutting at `t` does: the spot there, else how loud it is.
    static func spotAt(_ a: Analysis, _ t: Double) -> Spot {
        if let near = a.spots.first(where: { abs($0.t - t) < 0.02 }) { return near }
        let loud = loudness(a.energy, t - 0.05, t + 0.05)
        return Spot(t: t, score: -0.8 * loud, why: loud > 0.4 ? .speech : .quiet)
    }

    /// Where to cut when asked for "about here": the best spot within 2.5 s, else here.
    static func snapCut(_ a: Analysis, _ t: Double) -> Double {
        var best = spotAt(a, t), value = best.score
        for s in a.spots where abs(s.t - t) <= 2.5 {
            let v = s.score - 0.2 * abs(s.t - t)
            if v > value { best = s; value = v }
        }
        return best.t
    }

    /// The cuts that make stories of about `target` seconds, through the
    /// `pinned` cuts (added by hand). Per stretch between pinned cuts: shortest
    /// path over the spots plus a 0.25 s grid (so there is always a way),
    /// paying ((length − target) / 30% of target)² per story and earning each
    /// cut's score.
    static func planCuts(_ a: Analysis, target: Double, pinned: [Double] = []) -> [Double] {
        let bounds = [0] + pinned.filter { $0 > 0 && $0 < a.duration }.sorted() + [a.duration]
        var cuts: [Double] = []
        for k in 0..<(bounds.count - 1) {
            cuts += planStretch(a, from: bounds[k], to: bounds[k + 1], target: target)
            if k + 2 < bounds.count { cuts.append(bounds[k + 1]) }
        }
        return cuts
    }

    private static func planStretch(_ a: Analysis, from: Double, to: Double, target: Double) -> [Double] {
        let minLen = max(2, 0.3 * target), maxLen = min(maxStory, 2 * target), tol = 0.3 * target
        let inside = a.spots.filter { $0.t > from && $0.t < to }
        var grid: [Spot] = []
        var t = (from * 4 + 1e-9).rounded(.up) / 4
        while t < to {
            if !inside.contains(where: { abs($0.t - t) < 0.1 }) { grid.append(spotAt(a, t)) }
            t += 0.25
        }
        let nodes = [Spot(t: from, score: 0, why: .quiet)]
            + (inside + grid).sorted { $0.t < $1.t }
            + [Spot(t: to, score: 0, why: .quiet)]
        let n = nodes.count
        var cost = [Double](repeating: .infinity, count: n), prev = [Int](repeating: -1, count: n)
        cost[0] = 0
        for j in 1..<n {
            for i in stride(from: j - 1, through: 0, by: -1) {
                let len = nodes[j].t - nodes[i].t
                if len > maxLen { break }
                // A stretch shorter than a story (between two pinned cuts) stays whole.
                if len < minLen && !(i == 0 && j == n - 1) { continue }
                let off = (len - target) / tol
                let c = cost[i] + off * off - (j < n - 1 ? nodes[j].score : 0)
                if c < cost[j] { cost[j] = c; prev[j] = i }
            }
        }
        var cuts: [Double] = []
        var j = prev[n - 1]
        while j > 0 {
            cuts.insert(nodes[j].t, at: 0)
            j = prev[j]
        }
        return cuts
    }
}
