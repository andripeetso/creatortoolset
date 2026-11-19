import AppKit
import Foundation
import XCTest
@testable import CreatorToolsetMac

/// The location agent's reading of a folder: its state, the listing (guarded per directory, no cap), the report pages,
/// the folder pull and the quick prints kept.
final class LocationAgentTests: XCTestCase {
    private var root: URL!

    override func setUpWithError() throws {
        let base = ProcessInfo.processInfo.environment["CT_SCRATCH_DIR"].map { URL(fileURLWithPath: $0) } ?? FileManager.default.temporaryDirectory
        root = base.appendingPathComponent("location-agent-tests/\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: root.appendingPathComponent("Footage/Day 1"), withIntermediateDirectories: true)
        try Data("one".utf8).write(to: root.appendingPathComponent("Footage/a.mov"))
        try Data("two!".utf8).write(to: root.appendingPathComponent("Footage/Day 1/b.MP4"))
        try Data("notes".utf8).write(to: root.appendingPathComponent("Footage/notes.txt"))
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: root)
    }

    private func places(lookup: @escaping (String) -> Bool = { _ in true }, network: Bool = false) -> Places {
        let parts = root.path.split(separator: "/")
        let drive = parts.first == "Volumes" && parts.count > 1 ? [PlaceDisk(path: "/Volumes/\(parts[1])", key: "drive", name: String(parts[1]))] : []
        let share = network ? [PlaceDisk(path: root.path, key: "smb://nas/footage", network: true, name: "footage")] : []
        return Places(diskList: { [PlaceDisk(path: "/", key: "system")] + drive + share }, lookup: lookup)
    }

    private var footage: String { root.appendingPathComponent("Footage").path }

    func testFolderStates() {
        let p = places()
        XCTAssertEqual(LocationAgent.state(of: footage, allowed: false, places: p).state, "needs_ok")
        XCTAssertEqual(LocationAgent.state(of: footage, allowed: true, places: p).state, "ok")
        XCTAssertEqual(LocationAgent.state(of: root.appendingPathComponent("Renamed").path, allowed: true, places: p).state, "not_found")
        let away = LocationAgent.state(of: "/Volumes/Tiny Acrobatics/raw", allowed: true, places: p)
        XCTAssertEqual(away.state, "disk_away")
        XCTAssertEqual(away.disk, "Tiny Acrobatics")
    }

    func testListingReadsMediaWithSizeAndTime() {
        let l = LocationAgent.list(footage, places: places())
        XCTAssertEqual(l.files.map(\.path), [footage + "/Day 1/b.MP4", footage + "/a.mov"])
        XCTAssertEqual(l.files.map(\.bytes), [4, 3])
        XCTAssertTrue(l.files.allSatisfy { $0.mtime > 0 && $0.quick == nil })
        XCTAssertEqual(l.unreadable, [])
    }

    /// A share that doesn't answer: nothing listed, its folder unreadable (the server leaves its rows unchecked), and
    /// the folder reads disk_away, never not_found.
    func testGuardedNilLeavesTheDirectoryUnchecked() {
        let p = places(lookup: { _ in false }, network: true)
        XCTAssertFalse(p.answers(root.path, fresh: true))
        let l = LocationAgent.list(footage, places: p)
        XCTAssertEqual(l.files, [])
        XCTAssertEqual(l.unreadable, [footage])
        XCTAssertEqual(LocationAgent.state(of: footage, allowed: true, places: p).state, "disk_away")
        let page = LocationAgent.pages(id: "f1", files: l.files, unreadable: l.unreadable, scan: "s1")
        XCTAssertEqual(page.first?["unreadable"] as? [String], [footage])
    }

    func testPagesShareAScanAndOnlyTheLastIsComplete() {
        let files = (0..<4500).map { ListedFile(path: "/f/\($0).mov", bytes: 1, mtime: 1) }
        let pages = LocationAgent.pages(id: "f1", files: files, unreadable: [], scan: "s1")
        XCTAssertEqual(pages.map { ($0["files"] as? [Any])?.count }, [2000, 2000, 500])
        XCTAssertEqual(pages.map { $0["scan"] as? String }, ["s1", "s1", "s1"])
        XCTAssertEqual(pages.map { $0["complete"] as? Bool }, [nil, nil, true])
        // an empty folder is one complete page: everything the server had there is gone
        let empty = LocationAgent.pages(id: "f1", files: [], unreadable: [], scan: "s2")
        XCTAssertEqual(empty.count, 1)
        XCTAssertEqual(empty[0]["complete"] as? Bool, true)
    }

    /// A renamed subfolder: the same files at new paths with the same size and time (the server relinks them by those),
    /// in a complete listing.
    func testRenamedSubfolderKeepsSizeAndTime() throws {
        let before = LocationAgent.list(footage, places: places()).files
        try FileManager.default.moveItem(at: root.appendingPathComponent("Footage/Day 1"), to: root.appendingPathComponent("Footage/Day One"))
        let after = LocationAgent.list(footage, places: places()).files
        let b = try XCTUnwrap(before.first { $0.path.hasSuffix("Day 1/b.MP4") })
        let a = try XCTUnwrap(after.first { $0.path.hasSuffix("Day One/b.MP4") })
        XCTAssertEqual([a.bytes, a.mtime], [b.bytes, b.mtime])
        XCTAssertFalse(after.contains { $0.path.contains("Day 1/") })
    }

    func testFolderPull() {
        let data = Data(#"{"folders":[{"id":"f1","path":"/a","hostPath":"/host/a","mountPath":"/a","workspaces":"*","use":"media"},{"id":"f2","path":"/b","hostPath":"/b","mountPath":"/b","workspaces":["w1"],"use":"exports"}]}"#.utf8)
        XCTAssertEqual(LocationAgent.folders(data), [
            .init(id: "f1", path: "/host/a", workspaces: ["*"], use: "media"),
            .init(id: "f2", path: "/b", workspaces: ["w1"], use: "exports"),
        ])
        XCTAssertNil(LocationAgent.folders(Data("{}".utf8)))
    }

    func testQuickPrintsAreKeptBySizeAndTime() throws {
        let cache = QuickCache(file: root.appendingPathComponent("quick.json"))
        let f = try XCTUnwrap(LocationAgent.list(footage, places: places()).files.first { $0.path.hasSuffix("a.mov") })
        XCTAssertNil(cache.quick(f))
        let q = cache.read(f, places: places())
        XCTAssertEqual(q, Imports.quickPrint(f.path))
        cache.save()
        let again = QuickCache(file: root.appendingPathComponent("quick.json"))
        XCTAssertEqual(again.quick(f), q)
        XCTAssertNil(again.quick(ListedFile(path: f.path, bytes: f.bytes, mtime: f.mtime + 1)))   // changed since: read again
    }

    /// A file copied into a watched folder is seen by its FSEvents watch (the agent then looks again, 10 s after the last).
    func testAFileCopiedIntoAWatchedFolderIsSeen() throws {
        let seen = expectation(description: "a change in the folder")
        let watch = FolderWatch(paths: [footage], queue: .global()) { seen.fulfill() }
        XCTAssertNotNil(watch)
        try Data("copied".utf8).write(to: URL(fileURLWithPath: footage).appendingPathComponent("copied.mov"))
        wait(for: [seen], timeout: 30)
        watch?.stop()
        XCTAssertNil(FolderWatch(paths: [], queue: .global()) {})   // nothing listed, nothing watched
    }

    /// The index says when and where a file was filmed (the server files it into its shoot): the offset from the file's own text.
    func testFilmedOffsetAndAPictureWithoutEXIF() throws {
        XCTAssertEqual(MacIndex.offset("2026-11-12T08:00:00-0600"), -360)
        XCTAssertEqual(MacIndex.offset("+05:30"), 330)
        XCTAssertNil(MacIndex.offset("2026-11-12T08:00:00Z"))
        XCTAssertNil(MacIndex.offset(nil))
        // a picture no camera made (here a PNG drawn on this Mac): camera false, and no time or place made up
        let url = root.appendingPathComponent("drawn.png")
        let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 4, pixelsHigh: 4, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true,
                                   isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
        try rep.representation(using: .png, properties: [:])!.write(to: url)
        let f = MacIndex.photoFilmed(url)
        XCTAssertEqual(f["camera"] as? Bool, false)
        XCTAssertEqual(f["alpha"] as? Bool, true)
        XCTAssertNil(f["capturedAt"])
        XCTAssertNil(f["location"])
    }
}
