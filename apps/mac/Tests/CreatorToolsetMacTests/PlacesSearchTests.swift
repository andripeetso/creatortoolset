import Foundation
import XCTest
@testable import CreatorToolsetMac

/// Find missing files on a temp folder tree standing in for a disk ("vol:TEST", mounted at the tree's top).
final class PlacesSearchTests: XCTestCase {
    private var top = ""
    private var prints: [String] = []

    override func setUpWithError() throws {
        let base = ProcessInfo.processInfo.environment["CT_SCRATCH_DIR"] ?? NSTemporaryDirectory()
        let made = (base as NSString).appendingPathComponent("places-search-\(UUID().uuidString)")
        try FileManager.default.createDirectory(atPath: made, withIntermediateDirectories: true)
        // the real path: what the gate reads, and what the search answers
        top = MediaFiles.realPath(made) ?? made
        prints = []
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(atPath: top)
    }

    /// A file of `bytes` bytes (its content from `seed`, so equal sizes can differ), changed `age` seconds ago.
    @discardableResult
    private func file(_ rel: String, _ bytes: Int, seed: UInt8 = 1, age: TimeInterval = 600) throws -> String {
        let path = (top as NSString).appendingPathComponent(rel)
        try FileManager.default.createDirectory(atPath: (path as NSString).deletingLastPathComponent, withIntermediateDirectories: true)
        try Data((0..<bytes).map { UInt8(truncatingIfNeeded: $0 &+ Int(seed)) }).write(to: URL(fileURLWithPath: path))
        try FileManager.default.setAttributes([.modificationDate: Date().addingTimeInterval(-age)], ofItemAtPath: path)
        return path
    }

    private func gone(_ id: String, _ rel: String, _ bytes: Int, seed: UInt8 = 1) -> GoneFile {
        // the fingerprint the file had: the same bytes file() writes
        let probe = (top as NSString).appendingPathComponent("probe-\(UUID().uuidString)")
        try? Data((0..<bytes).map { UInt8(truncatingIfNeeded: $0 &+ Int(seed)) }).write(to: URL(fileURLWithPath: probe))
        defer { try? FileManager.default.removeItem(atPath: probe) }
        return GoneFile(versionId: id, bytes: Int64(bytes), quick: Imports.quickPrint(probe)!, root: "vol:TEST", rootRel: rel, path: "/elsewhere/\(rel)", name: (rel as NSString).lastPathComponent)
    }

    private func search(_ list: [GoneFile], budget: Int = 300_000, home: String? = nil, granted: [String]? = nil) -> MissingSearch {
        let disks = [PlaceDisk(path: top, key: "vol:TEST")]
        var s = MissingSearch(gone: list, disks: disks)
        s.granted = granted ?? [top]
        s.places = Places(diskList: { disks }, lookup: { _ in true })
        s.budget = budget
        s.home = home ?? "/nobody-home"
        s.quickPrint = { [unowned self] path in
            prints.append((path as NSString).lastPathComponent)
            return Imports.quickPrint(path)
        }
        return s
    }

    func testAMovedFolderIsFoundThroughTheFirstMatchWithoutWalkingTheRest() throws {
        try file("Archive/2025/a.mov", 100, seed: 1)
        try file("Archive/2025/b.mov", 200, seed: 2)
        try file("Archive/2025/c.mov", 300, seed: 3)
        // after Archive in name order, the same size as a.mov: never listed, never read
        try file("Other/z.mov", 100, seed: 9)
        var s = search([gone("a", "2025/a.mov", 100, seed: 1), gone("b", "2025/b.mov", 200, seed: 2), gone("c", "2025/c.mov", 300, seed: 3)])
        let found = s.run()
        XCTAssertEqual(found.map(\.versionId).sorted(), ["a", "b", "c"])
        XCTAssertEqual(found.first { $0.versionId == "c" }?.path, (top as NSString).appendingPathComponent("Archive/2025/c.mov"))
        // a.mov read in the walk, b and c at the folder change's paths
        XCTAssertEqual(prints.sorted(), ["a.mov", "b.mov", "c.mov"])
        // the top (Archive, Other), Archive (2025), Archive/2025 (stops at a.mov's match: the rest are found)
        XCTAssertEqual(s.looked, 2 + 1 + 3)
        XCTAssertEqual(s.stillGone, 0)
    }

    func testNoFileIsReadWhenNoSizeMatches() throws {
        try file("2026/x.mov", 150)
        try file("2026/y.mov", 250)
        var s = search([gone("a", "2025/a.mov", 999)])
        XCTAssertEqual(s.run(), [])
        XCTAssertEqual(prints, [])
        XCTAssertEqual(s.stillGone, 1)
    }

    func testTheBudgetStopsTheWalkCleanly() throws {
        for i in 0..<20 { try file("A/\(i).mov", 10 + i) }
        try file("B/a.mov", 100)
        var s = search([gone("a", "2025/a.mov", 100)], budget: 15)
        XCTAssertEqual(s.run(), [])
        // the top (A, B) and A's 20: over the budget, so B is never listed
        XCTAssertEqual(s.looked, 22)
        XCTAssertEqual(s.stillGone, 1)
    }

    func testAFileChangedInTheLastMinuteIsPassedBy() throws {
        try file("Archive/a.mov", 100, age: 5)
        var s = search([gone("a", "2025/a.mov", 100)])
        XCTAssertEqual(s.run(), [])
        XCTAssertEqual(prints, [])
    }

    func testAnotherFileOfTheSameSizeIsNotTaken() throws {
        try file("Archive/a.mov", 100, seed: 7)
        var s = search([gone("a", "2025/a.mov", 100, seed: 1)])
        XCTAssertEqual(s.run(), [])
        XCTAssertEqual(prints, ["a.mov"])
    }

    func testAHomeFolderIsWalkedUpToItselfAndNotIntoDocumentsUnlessTheFileWasThere() throws {
        // home/Documents is never walked into by itself, and nothing above home is walked
        try file("home/Documents/a.mov", 100)
        try file("home/Movies/Old/keep.txt", 1)
        try file("above.mov", 100)
        let quick = gone("x", "a.mov", 100).quick
        let at = { (rel: String) in GoneFile(versionId: rel, bytes: 100, quick: quick, root: nil, rootRel: nil, path: (self.top as NSString).appendingPathComponent(rel), name: "a.mov") }
        let home = (top as NSString).appendingPathComponent("home")
        var s = search([at("home/Movies/2025/a.mov")], home: home, granted: [home])
        XCTAssertEqual(s.run(), [])
        XCTAssertEqual(prints, [])
        // a file that was in Documents is looked for there
        var t = search([at("home/Documents/2025/a.mov")], home: home, granted: [home])
        XCTAssertEqual(t.run().map(\.path), [(top as NSString).appendingPathComponent("home/Documents/a.mov")])
    }

    func testAFileOutsideTheGrantedFoldersIsNeverReadAndItsDiskIsOneToGrant() throws {
        try file("Granted/other.mov", 50)
        try file("Archive/2025/a.mov", 100)
        var s = search([gone("a", "2025/a.mov", 100)], granted: [(top as NSString).appendingPathComponent("Granted")])
        XCTAssertEqual(s.run(), [])
        XCTAssertEqual(prints, [])
        XCTAssertEqual(s.access, [top])
        // granted: read and found
        var t = search([gone("a", "2025/a.mov", 100)])
        XCTAssertEqual(t.run().map(\.versionId), ["a"])
        XCTAssertEqual(t.access, [])
    }

    func testAPathFromTheServerWithDotsIsNeverTouched() throws {
        try file("outside/a.mov", 100)
        let inner = (top as NSString).appendingPathComponent("inner")
        try FileManager.default.createDirectory(atPath: inner, withIntermediateDirectories: true)
        let disks = [PlaceDisk(path: inner, key: "vol:TEST")]
        var s = MissingSearch(gone: [gone("a", "../outside/a.mov", 100)], disks: disks)
        s.places = Places(diskList: { disks }, lookup: { _ in true })
        s.home = "/nobody-home"
        s.quickPrint = { [unowned self] path in prints.append(path); return Imports.quickPrint(path) }
        XCTAssertEqual(s.run(), [])
        XCTAssertEqual(prints, [])
        XCTAssertEqual(s.access, [])
        XCTAssertEqual(s.looked, 0)
    }

    func testTheSearchAsksParse() {
        XCTAssertEqual(placesAsk("places:search:state"), .searchState)
        XCTAssertEqual(placesAsk(#"places:search:{"library":"lib_1"}"#), .search(library: "lib_1"))
        XCTAssertNil(placesAsk(#"places:search:{"library":"../x"}"#))
    }
}
