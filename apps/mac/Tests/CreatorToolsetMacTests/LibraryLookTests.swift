import ImageIO
import XCTest
@testable import CreatorToolsetMac

/// Shot descriptions of a file kept on this Mac: its picture read as the server reads one, the sheets the server makes,
/// both checked against the server's own output on one clip (Fixtures/look-goldens.mts made the goldens), and a whole
/// job against a stand-in server.
final class LibraryLookTests: XCTestCase {
    static let fixtures = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("Fixtures")
    static let clip = fixtures.appendingPathComponent("look-clip.mp4")

    struct Goldens: Decodable {
        let fps: Double
        let step: [Double]
        let cut: [Double]
        let lag: [Double]
        let cuts: [Int]
        let stretches: [[Double]]
        let hashes: [String]
    }

    static let goldens = try! JSONDecoder().decode(Goldens.self, from: Data(contentsOf: fixtures.appendingPathComponent("look-goldens.json")))

    /// The ffmpeg the goldens were made with: the one on this Mac's PATH (the app uses its own). None: those tests skip.
    static let ffmpeg: URL? = (ProcessInfo.processInfo.environment["FFMPEG_PATH"].map { [$0] } ?? ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg"])
        .first { FileManager.default.isExecutableFile(atPath: $0) }.map { URL(fileURLWithPath: $0) }

    /// look.ts cutsOf, for the test only: the frames where a new shot starts.
    static func cutsOf(fps: Double, cut step: [Double]) -> [Int] {
        let w = Int(fps.rounded())
        var cuts: [Int] = []
        for i in 1..<step.count {
            let d = step[i]
            if d < 0.25 { continue }
            if (max(1, i - 2)...min(step.count - 1, i + 2)).contains(where: { $0 != i && step[$0] > d }) { continue }
            let around = (max(1, i - w)...min(step.count - 1, i + w)).filter { abs($0 - i) > 1 }.map { step[$0] }.sorted()
            if d < 3 * (around.isEmpty ? 0 : around[around.count >> 1]) + 0.08 { continue }
            if let last = cuts.last, Double(i - last) < 0.3 * fps {
                if d > step[last] { cuts[cuts.count - 1] = i }
                continue
            }
            if Double(i) < 0.3 * fps || Double(step.count - i) < 0.3 * fps { continue }
            cuts.append(i)
        }
        return cuts
    }

    private func offMain<T>(_ work: @escaping () -> T) async -> T {
        await withCheckedContinuation { done in DispatchQueue.global().async { done.resume(returning: work()) } }
    }

    func testTheSignalIsTheServersWithinASmallTolerance() async throws {
        let g = Self.goldens
        XCTAssertEqual(Self.cutsOf(fps: g.fps, cut: g.cut), g.cuts, "the test's cutsOf is the server's")
        let opened = try await LookPicture.open(Self.clip, reading: true)
        let s = try LookPicture.read(opened) {}
        XCTAssertEqual(s.fps, g.fps)
        XCTAssertEqual(s.step.count, g.step.count)
        func worst(_ a: [Double], _ b: [Double]) -> (max: Double, mean: Double) {
            let d = zip(a, b).map { abs($0 - $1) }
            return (d.max() ?? 0, d.reduce(0, +) / Double(max(1, d.count)))
        }
        let (step, cut, lag) = (worst(s.step, g.step), worst(s.cut, g.cut), worst(s.lag, g.lag))
        print("look signal vs server: step max \(step.max) mean \(step.mean); cut max \(cut.max) mean \(cut.mean); lag max \(lag.max) mean \(lag.mean)")
        // the numbers are means of |Δ grey| over 0..1: a cut is ≥ 0.25 on `cut`, a busy shot moves 0.02 to 0.1 a frame
        XCTAssertLessThan(step.max, 0.01)
        XCTAssertLessThan(lag.max, 0.01)
        XCTAssertLessThan(cut.max, 0.1)
        XCTAssertEqual(Self.cutsOf(fps: s.fps, cut: s.cut), g.cuts, "the same cut frames")
    }

    func testTheSheetsAndHashesAreTheServers() throws {
        guard let ffmpeg = Self.ffmpeg else { throw XCTSkip("no ffmpeg on this Mac") }
        let g = Self.goldens
        let dir = testFolder("look-sheets")
        addTeardownBlock { try? FileManager.default.removeItem(at: dir) }
        let out = dir.appendingPathComponent("sheet.jpg")
        try LookSheets.sheet(ffmpeg: ffmpeg, src: Self.clip, stretches: g.stretches, duration: 6, landscape: true, out: out) {}
        let mine = try XCTUnwrap(Self.grey(out)), theirs = try XCTUnwrap(Self.grey(Self.fixtures.appendingPathComponent("look-sheet.jpg")))
        // two tiles across, three frames a tile on an 8 px border, two rows
        XCTAssertEqual([mine.width, mine.height], [2 * 3 * (256 + 8), 2 * (144 + 8)])
        XCTAssertEqual([mine.width, mine.height], [theirs.width, theirs.height])
        let mean = zip(mine.pixels, theirs.pixels).map { abs(Int($0) - Int($1)) }.reduce(0, +) / mine.pixels.count
        XCTAssertLessThanOrEqual(mean, 1, "the same frames in the same places")
        XCTAssertEqual(LookSheets.hashes(ffmpeg: ffmpeg, sheet: out, count: g.stretches.count, landscape: true), g.hashes)
        XCTAssertEqual(LookSheets.times(0, 1.5, duration: 6), [0.25, 0.75, 1.25])
        XCTAssertEqual(LookSheets.times(5.9, 6, duration: 6), [5.9, 5.9, 5.9], "inside the file, a short stretch inset by a quarter")
    }

    func testAJobReadsSendsAndKeepsTheSheetsThenSendsThemAgainWithoutTheVideo() async throws {
        guard let ffmpeg = Self.ffmpeg else { throw XCTSkip("no ffmpeg on this Mac") }
        let g = Self.goldens
        let dir = testFolder("look-job")
        addTeardownBlock { try? FileManager.default.removeItem(at: dir) }
        let site = FakeSite()
        let found = #"{"stretches":["# + g.stretches.enumerated().map { #"{"seg":\#($0.offset),"a":\#($0.element[0]),"b":\#($0.element[1])}"# }.joined(separator: ",") + "]}"
        site.answer = { r in
            let body = (try? JSONSerialization.jsonObject(with: r.body)) as? [String: Any]
            return body?["signal"] != nil ? (200, found) : (200, #"{"ok":true}"#)
        }
        let api = DeviceAPI(base: site.url, token: "ctd_test")
        var options = ["path": Self.clip.path, "version": "ver-1", "duration": "6", "format": "3x16", "stretches": "[]"]
        let first = LibraryLookJob(api: api, step: EditorJob(id: 4, kind: libraryLookKind, options: options), folder: dir, ffmpeg: ffmpeg, granted: [Self.fixtures.path])
        let end = await offMain { first.run().end }
        XCTAssertEqual(end, .done)
        let bodies = site.requests.map { (try? JSONSerialization.jsonObject(with: $0.body)) as? [String: Any] ?? [:] }
        XCTAssertEqual(site.requests.map(\.path), Array(repeating: "/api/devices/relay/job/library-look/4", count: 3))
        XCTAssertEqual(bodies.map { $0.keys.sorted() }, [["signal"], ["sheet"], ["done", "format"]])
        XCTAssertEqual(((bodies[0]["signal"] as? [String: Any])?["step"] as? [Double])?.count, g.step.count)
        let sheet = try XCTUnwrap(bodies[1]["sheet"] as? [String: Any])
        XCTAssertEqual(sheet["segs"] as? [Int], [0, 1, 2, 3])
        XCTAssertEqual(sheet["ph"] as? [String], g.hashes)
        XCTAssertEqual(Data(base64Encoded: sheet["jpeg"] as! String)?.prefix(2), Data([0xff, 0xd8]))
        let kept = try XCTUnwrap(LibraryLookJob.load(dir.appendingPathComponent("ver-1.json")))
        XCTAssertEqual(kept.stretches, g.stretches)
        XCTAssertFalse(FileManager.default.fileExists(atPath: dir.appendingPathComponent("ver-1.making").path), "no scratch left")
        // written again under a new context: the server has the stretches, so the kept sheets go, the video unread
        options["stretches"] = String(decoding: try JSONSerialization.data(withJSONObject: g.stretches), as: UTF8.self)
        options["path"] = dir.appendingPathComponent("gone.mp4").path
        let again = LibraryLookJob(api: api, step: EditorJob(id: 5, kind: libraryLookKind, options: options), folder: dir, ffmpeg: ffmpeg)
        let end2 = await offMain { again.run().end }
        XCTAssertEqual(end2, .done)
        let more = site.requests.dropFirst(3).map { ((try? JSONSerialization.jsonObject(with: $0.body)) as? [String: Any] ?? [:]).keys.sorted() }
        XCTAssertEqual(more, [["sheet"], ["done", "format"]])
    }

    func testAFileThatIsGoneOrOutsideTheGivenFoldersIsNeverRead() async throws {
        let site = FakeSite()
        let given = testFolder("look-given")
        addTeardownBlock { try? FileManager.default.removeItem(at: given) }
        let run = { (path: String, id: Int) -> CardJob.End in
            let step = EditorJob(id: id, kind: libraryLookKind, options: ["path": path, "version": "ver-2", "stretches": "[]"])
            return LibraryLookJob(api: DeviceAPI(base: site.url, token: "ctd_test"), step: step, folder: given, ffmpeg: URL(fileURLWithPath: "/usr/bin/true"),
                                  granted: [given.path]).run().end
        }
        let gone = given.appendingPathComponent("clip.mov").path
        let end = await offMain { run(gone, 6) }
        XCTAssertEqual(end, .failed("The file is not on this Mac at \(gone)."))
        // the server named a file this app was never given: refused, nothing read or sent
        let outside = await offMain { run(Self.clip.path, 7) }
        XCTAssertEqual(outside, .failed("\(Self.clip.path) is not in a folder Creator Toolset was given on this Mac (dropped on its window or chosen)."))
        XCTAssertEqual(site.requests.map(\.path), ["/api/devices/relay/job/library-look/6/fail", "/api/devices/relay/job/library-look/7/fail"])
    }

    /// A JPEG as grey pixels, with its size.
    static func grey(_ url: URL) -> (width: Int, height: Int, pixels: [UInt8])? {
        guard let src = CGImageSourceCreateWithURL(url as CFURL, nil), let image = CGImageSourceCreateImageAtIndex(src, 0, nil) else { return nil }
        let (w, h) = (image.width, image.height)
        var pixels = [UInt8](repeating: 0, count: w * h)
        guard let ctx = CGContext(data: &pixels, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w, space: CGColorSpaceCreateDeviceGray(), bitmapInfo: 0) else { return nil }
        ctx.draw(image, in: CGRect(x: 0, y: 0, width: w, height: h))
        return (w, h, pixels)
    }
}
