import Foundation
import XCTest
@testable import CreatorToolsetMac

final class RevealTests: XCTestCase {
    private var root: URL!

    override func setUpWithError() throws {
        let base = ProcessInfo.processInfo.environment["CT_SCRATCH_DIR"].map { URL(fileURLWithPath: $0) } ?? FileManager.default.temporaryDirectory
        root = base.appendingPathComponent("reveal-tests/\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: root.appendingPathComponent("Footage/Day 1"), withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: root.appendingPathComponent("Footagebar"), withIntermediateDirectories: true)
        for f in ["Footage/Day 1/A001.MOV", "Footagebar/B001.MOV", "secret.txt"] { try Data("x".utf8).write(to: root.appendingPathComponent(f)) }
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: root)
    }

    private func path(_ relative: String) -> String { root.appendingPathComponent(relative).path }

    func testShowsOnlyAnExistingFileInsideATrustedFolder() throws {
        let trusted = [path("Footage")]
        XCTAssertNotNil(Reveal.check(path("Footage/Day 1/A001.MOV"), trusted: trusted))
        XCTAssertNil(Reveal.check(path("Footagebar/B001.MOV"), trusted: trusted))   // a sibling sharing the name's start
        XCTAssertNil(Reveal.check(path("secret.txt"), trusted: trusted))
        XCTAssertNil(Reveal.check(path("Footage/Day 1/gone.MOV"), trusted: trusted))   // missing reads as not trusted
        XCTAssertNil(Reveal.check(path("Footage/Day 1"), trusted: trusted))   // a folder is not a clip
        XCTAssertNil(Reveal.check(path("Footage/../secret.txt"), trusted: trusted))
        XCTAssertNil(Reveal.check("Footage/Day 1/A001.MOV", trusted: trusted))   // relative
        XCTAssertNil(Reveal.check(path("secret.txt"), trusted: ["/"]))   // the whole disk is never a trusted folder
        XCTAssertNil(Reveal.check(path("Footage/Day 1/A001.MOV"), trusted: []))
    }

    func testTheServerOnThisMacNamesAnyExistingFile() {
        XCTAssertNotNil(Reveal.check(path("secret.txt"), trusted: nil))
        XCTAssertNil(Reveal.check(path("gone.MOV"), trusted: nil))
        XCTAssertNil(Reveal.check(path("Footage"), trusted: nil))
        XCTAssertNil(Reveal.check(path("Footage/../secret.txt"), trusted: nil))
    }

    func testALinkOutOfATrustedFolderIsRefused() throws {
        try FileManager.default.createSymbolicLink(atPath: path("Footage/link.MOV"), withDestinationPath: path("secret.txt"))
        XCTAssertNil(Reveal.check(path("Footage/link.MOV"), trusted: [path("Footage")]))
    }

    func testReadsTheAsk() {
        XCTAssertEqual(revealAsk(#"reveal:{"library":"lib_1","asset":"b94200d6-3321"}"#)?.asset, "b94200d6-3321")
        XCTAssertNil(revealAsk(#"reveal:{"library":"../x","asset":"a1"}"#))
        XCTAssertNil(revealAsk(#"reveal:{"library":"lib_1","asset":"a/../b"}"#))
        XCTAssertNil(revealAsk(#"reveal:{"library":"lib_1"}"#))
        XCTAssertNil(revealAsk("reveal:/a/b.MOV"))
        XCTAssertEqual(reviewRevealAsk(#"reveal:{"review":"b94200d6-3321","v":2}"#)?.n, 2)
        XCTAssertNil(reviewRevealAsk(#"reveal:{"review":"../x","v":2}"#))
        XCTAssertNil(reviewRevealAsk(#"reveal:{"review":"b94200d6","v":0}"#))
        XCTAssertNil(reviewRevealAsk(#"reveal:{"library":"lib_1","asset":"a1"}"#))
        XCTAssertNil(revealAsk(#"reveal:{"review":"b94200d6","v":2}"#))
    }
}
