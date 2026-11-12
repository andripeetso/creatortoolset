import XCTest
@testable import CreatorToolset

/// The cases of apps/captions/src/lib/story-split.test.ts: the app must cut
/// where the website cuts.
final class StorySplitTests: XCTestCase {
    private let hz = StorySplit.hz

    private func loud(_ seconds: Int, _ level: Float = 0.9) -> [Float] {
        Array(repeating: level, count: seconds * hz)
    }

    private func clip(_ duration: Int, _ spots: [StorySplit.Spot], energy: [Float]? = nil) -> StorySplit.Analysis {
        StorySplit.Analysis(duration: Double(duration), energy: energy ?? loud(duration), spots: spots,
                            shots: 0, pauses: 0, bpm: nil)
    }

    private func fill(_ xs: inout [Float], _ value: Float, _ from: Int, _ to: Int) {
        for i in from..<min(to, xs.count) { xs[i] = value }
    }

    func testFindsHardCutsPausesAndABeat() {
        let frames = (0..<(30 * 30)).map { StorySplit.Frame(t: Double($0) / 30, diff: $0 == 300 ? 0.2 : 0.004) }
        // speech: short, irregular gaps between words, and one 0.6 s pause
        var db = [Float](repeating: -20, count: 30 * hz)
        var i = 0, seed = 7
        while i < db.count {
            fill(&db, -50, i, i + 8)
            seed = (seed * 48271) % 2_147_483_647
            i += 25 + seed % 40
        }
        fill(&db, -50, 20 * hz, 2060)
        let a = StorySplit.analyse(.init(duration: 30, frames: frames, db: db))
        XCTAssertEqual(a.spots.first { $0.why == .shot }?.t, 10)
        XCTAssertEqual(a.spots.first { $0.why == .pause }?.t ?? 0, 20.3, accuracy: 0.05)
        XCTAssertNil(a.bpm)

        var beat = [Float](repeating: -40, count: 30 * hz)
        for i in stride(from: 0, to: beat.count, by: 50) { fill(&beat, -10, i, i + 5) }
        XCTAssertEqual(StorySplit.analyse(.init(duration: 30, frames: frames, db: beat)).bpm, 120)
    }

    func testCutsAtTheBestSpotsNearTheTargetThroughTheOwnersCuts() {
        let a = clip(60, [
            .init(t: 19, score: 1, why: .pause),
            .init(t: 30, score: 0.8, why: .shot),
            .init(t: 41, score: 1, why: .pause),
        ])
        XCTAssertEqual(StorySplit.planCuts(a, target: 20), [19, 41])
        XCTAssertEqual(StorySplit.planCuts(a, target: 20, pinned: [30]), [19, 30, 41])
        XCTAssertEqual(StorySplit.planCuts(clip(25, []), target: 20), [])
        XCTAssertEqual(StorySplit.snapCut(a, 17.5), 19)
        XCTAssertEqual(StorySplit.snapCut(a, 25), 25) // nothing good within reach: stays where asked

        let long = StorySplit.planCuts(clip(200, [], energy: loud(200, 0)), target: 20)
        let bounds = [0] + long + [200]
        let lengths = zip(bounds.dropFirst(), bounds).map { $0 - $1 }
        XCTAssertLessThanOrEqual(lengths.max() ?? 0, 21)
        XCTAssertGreaterThanOrEqual(lengths.min() ?? 0, 19)
    }
}
