import XCTest
@testable import CreatorToolsetMac

/// The cut model's windows (as the server's cuts.ts modelWindows), what the read sends of it, and, where
/// CT_CUT_MODEL_TEST names a folder holding a compiled TransNetV2.mlmodelc (scripts/transnetv2-coreml.py), the model
/// itself on the look clip.
final class CutModelTests: XCTestCase {
    func testWindowsShowTheModelAHundredFramesAtATimePaddedAndKeepEveryFramesAnswer() throws {
        var seen: [[Int]] = []
        // a stand-in model whose answer for each frame is that frame's own value (frames are filled with their number)
        var w = CutModel.Windows { frames in
            let vals = frames.map { Int($0[0]) }
            seen.append(vals)
            return (vals.map(Double.init), vals.map { -Double($0) })
        }
        let n = 137
        for i in 0..<n { try w.push([UInt8](repeating: UInt8(i), count: CutModel.frameBytes)) }
        let (one, many) = try w.end()
        XCTAssertEqual(one, (0..<n).map(Double.init))
        XCTAssertEqual(many[10], -10)
        XCTAssertEqual(seen.count, 3)
        XCTAssertEqual(Array(seen[0].prefix(26)), Array(repeating: 0, count: 26))
        XCTAssertEqual(seen[1].first, 25)
        XCTAssertEqual(seen[2].last, n - 1)
    }

    func testTheModelComesFromTheReleasesOfTheRepositoryTheAppUpdatesFrom() {
        XCTAssertEqual(CutModel.modelURL(feed: "https://github.com/tiny/acrobatics/releases/latest/download/appcast.xml")?.absoluteString,
                       "https://github.com/tiny/acrobatics/releases/download/transnetv2-coreml-1/TransNetV2.mlpackage.zip")
        XCTAssertNil(CutModel.modelURL(feed: "https://updates.example.com/appcast.xml"))
        XCTAssertNil(CutModel.modelURL(feed: nil))
    }

    func testAFailedWindowIsThrown() {
        struct OutOfMemory: Error {}
        var w = CutModel.Windows { _ in throw OutOfMemory() }
        for _ in 0..<120 { try? w.push([UInt8](repeating: 0, count: CutModel.frameBytes)) }
        XCTAssertThrowsError(try w.end()) { XCTAssertTrue($0 is OutOfMemory) }
    }

    func testTheSignalSendsTheOddsOnlyWhenEveryFrameHasThem() {
        var s = LookPicture.Signal(fps: 10)
        for v: UInt8 in [0, 50, 100] { s.add([UInt8](repeating: v, count: LookPicture.width * LookPicture.height)) }
        XCTAssertNil(s.body["one"])
        s.odds = ([0.1, 0.9, 0.1], [0.1, 0.8, 0.1])
        XCTAssertEqual(s.body["one"] as? [Double], [0.1, 0.9, 0.1])
        XCTAssertEqual(s.body["many"] as? [Double], [0.1, 0.8, 0.1])
        s.odds = ([0.1], [0.1])
        XCTAssertNil(s.body["many"])
    }

    func testTheModelFindsTheClipsCutsOnTheGraphicsCard() async throws {
        guard let dir = ProcessInfo.processInfo.environment["CT_CUT_MODEL_TEST"] else { throw XCTSkip("CT_CUT_MODEL_TEST names no model") }
        let model = CutModel(model: try CutModel.load(URL(fileURLWithPath: dir)))
        let opened = try await LookPicture.open(LibraryLookTests.clip, reading: true)
        let s = try LookPicture.read(opened, cuts: model) {}
        let odds = try XCTUnwrap(s.odds)
        XCTAssertEqual(odds.one.count, s.step.count)
        // the frames the model marks (a cut is on the frame after): the clip's three cuts, as the server's cutsOf finds them
        let marked = odds.one.indices.filter { max(odds.one[$0], odds.many[$0]) > 0.5 && ($0 == 0 || max(odds.one[$0 - 1], odds.many[$0 - 1]) <= 0.5) }
        XCTAssertEqual(marked.map { $0 + 1 }, LibraryLookTests.goldens.cuts)
    }
}
