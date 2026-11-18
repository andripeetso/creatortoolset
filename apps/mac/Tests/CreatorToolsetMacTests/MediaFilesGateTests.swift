import Foundation
import XCTest
@testable import CreatorToolsetMac

/// The gate's local-first cases: a drive not connected (409 disk_away), not granted (403), grants per server and
/// workspace from the folder pull, and a server's folder not granted until Allow on this Mac.
final class MediaFilesGateTests: XCTestCase {
    private var root: URL!
    private var suite: String!
    private var was: UserDefaults!

    override func setUpWithError() throws {
        let base = ProcessInfo.processInfo.environment["CT_SCRATCH_DIR"].map { URL(fileURLWithPath: $0) } ?? FileManager.default.temporaryDirectory
        root = base.appendingPathComponent("media-gate-tests/\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: root.appendingPathComponent("Footage"), withIntermediateDirectories: true)
        try Data("x".utf8).write(to: root.appendingPathComponent("Footage/a.mov"))
        suite = "media-gate-tests-\(UUID().uuidString)"
        was = MediaFiles.defaults
        MediaFiles.defaults = UserDefaults(suiteName: suite)!
    }

    override func tearDownWithError() throws {
        MediaFiles.defaults = was
        UserDefaults().removePersistentDomain(forName: suite)
        try? FileManager.default.removeItem(at: root)
    }

    /// The system disk and, for a scratch folder on an external drive, that drive.
    private var places: Places {
        let parts = root.path.split(separator: "/")
        let drive = parts.first == "Volumes" && parts.count > 1 ? [PlaceDisk(path: "/Volumes/\(parts[1])", key: "drive", name: String(parts[1]))] : []
        return Places(diskList: { [PlaceDisk(path: "/", key: "system")] + drive }, lookup: { _ in true })
    }

    private var footage: String { root.appendingPathComponent("Footage").path }
    private var file: String { root.appendingPathComponent("Footage/a.mov").path }

    func testDriveNotConnectedIs409WithItsName() {
        let away = Places(diskList: { [PlaceDisk(path: "/", key: "system")] }, lookup: { _ in true })
        let gate = MediaFiles.gate("/Volumes/Tiny Acrobatics/raw/a.mov", granted: ["/Volumes/Tiny Acrobatics/raw"], roots: [], places: away)
        XCTAssertEqual(gate, .diskAway("Tiny Acrobatics"))
    }

    func testNotGrantedIs403EvenWithItsDriveAway() {
        let away = Places(diskList: { [PlaceDisk(path: "/", key: "system")] }, lookup: { _ in true })
        XCTAssertEqual(MediaFiles.gate("/Volumes/Tiny Acrobatics/raw/a.mov", granted: ["/Volumes/Tiny Acrobatics/other"], roots: [], places: away), .status(403))
        XCTAssertEqual(MediaFiles.gate(file, granted: [], roots: [], places: places), .status(403))
    }

    func testGrantIsCheckedAgainstTheClipsWorkspace() {
        let s = "studio.example:443"
        MediaFiles.setServerFolders([.init(id: "f1", path: footage, workspaces: ["B"], use: "media")], server: s)
        XCTAssertTrue(MediaFiles.allow(footage, server: s))
        XCTAssertEqual(MediaFiles.gate(file, granted: MediaFiles.granted(server: s, workspace: "A"), roots: [], places: places), .status(403))
        if case .file = MediaFiles.gate(file, granted: MediaFiles.granted(server: s, workspace: "B"), roots: [], places: places) {} else { XCTFail("granted in B") }
        // "*": every workspace
        MediaFiles.setServerFolders([.init(id: "f1", path: footage, workspaces: ["*"], use: "media")], server: s)
        XCTAssertEqual(MediaFiles.granted(server: s, workspace: "A"), [footage])
        // another server's grant is not this one's
        XCTAssertEqual(MediaFiles.granted(server: "other.example", workspace: "A"), [])
    }

    func testServerFolderIsNotGrantedUntilAllowed() {
        let s = "127.0.0.1:43128"
        MediaFiles.setServerFolders([.init(id: "f1", path: footage, workspaces: ["*"], use: "media")], server: s)
        XCTAssertEqual(MediaFiles.granted(server: s, workspace: nil), [])
        XCTAssertEqual(MediaFiles.placeState(file, server: s, places: places).state, "needs_ok")
        XCTAssertEqual(MediaFiles.placeState(root.appendingPathComponent("elsewhere.mov").path, server: s, places: places).state, "not_granted")
        XCTAssertFalse(MediaFiles.allow(root.path, server: s))   // only a folder the server lists
        XCTAssertTrue(MediaFiles.allow(footage, server: s))
        XCTAssertEqual(MediaFiles.granted(server: s, workspace: nil), [footage])
        XCTAssertEqual(MediaFiles.placeState(file, server: s, places: places).state, "here")
        XCTAssertEqual(MediaFiles.placeState(root.appendingPathComponent("Footage/b.mov").path, server: s, places: places).state, "not_here")
    }

    func testPickedFolderNeedsNoOK() {
        MediaFiles.add(root.path)   // an open panel or a drop on this Mac
        MediaFiles.setServerFolders([.init(id: "f1", path: footage, workspaces: ["*"], use: "media")], server: "s")
        XCTAssertTrue(MediaFiles.isAllowed(footage, server: "s"))
    }

    func testGrantsAreReplacedOnPull() {
        let s = "s"
        let other = root.appendingPathComponent("Other").path
        MediaFiles.setServerFolders([.init(id: "f1", path: footage, workspaces: ["*"], use: "media"), .init(id: "f2", path: other, workspaces: ["*"], use: "media")], server: s)
        MediaFiles.allow(footage, server: s)
        MediaFiles.allow(other, server: s)
        MediaFiles.setServerFolders([.init(id: "f2", path: other, workspaces: ["*"], use: "media")], server: s)
        XCTAssertEqual(MediaFiles.granted(server: s, workspace: nil), [other])
        XCTAssertFalse(MediaFiles.isAllowed(footage, server: s))
        // listed again later: it needs the OK again
        MediaFiles.setServerFolders([.init(id: "f1", path: footage, workspaces: ["*"], use: "media")], server: s)
        XCTAssertEqual(MediaFiles.granted(server: s, workspace: nil), [])
    }

    func testPlaceStateDriveAway() {
        let s = "s"
        let path = "/Volumes/Tiny Acrobatics/raw"
        MediaFiles.setServerFolders([.init(id: "f1", path: path, workspaces: ["*"], use: "media")], server: s)
        MediaFiles.allow(path, server: s)
        let away = Places(diskList: { [PlaceDisk(path: "/", key: "system")] }, lookup: { _ in true })
        let r = MediaFiles.placeState(path + "/a.mov", server: s, places: away)
        XCTAssertEqual(r.state, "disk_away")
        XCTAssertEqual(r.disk, "Tiny Acrobatics")
    }

    /// A3: an empty answer ({"folders":[]}) keeps the last good list and every OK; a folder really removed still loses its OK.
    func testEmptyAnswerKeepsTheOKs() throws {
        let s = "studio.example:443"
        let listed = MediaFiles.ServerFolder(id: "f1", path: footage, workspaces: ["*"], use: "media")
        MediaFiles.setServerFolders([listed], server: s)
        XCTAssertTrue(MediaFiles.allow(footage, server: s))
        let empty = try XCTUnwrap(LocationAgent.folders(Data(#"{"folders":[]}"#.utf8)))
        XCTAssertEqual(MediaFiles.setServerFolders(empty, server: s), [listed])
        XCTAssertTrue(MediaFiles.isAllowed(footage, server: s))
        XCTAssertEqual(MediaFiles.granted(server: s, workspace: nil), [footage])
        MediaFiles.setServerFolders([.init(id: "f2", path: root.appendingPathComponent("Other").path, workspaces: ["*"], use: "media")], server: s)
        XCTAssertFalse(MediaFiles.isAllowed(footage, server: s))
    }

    /// OKs are keyed by folder id: a re-pull that changes the folder's workspaces keeps its OK; the store holds ids.
    func testOKsAreKeyedByFolderId() throws {
        let s = "s"
        MediaFiles.setServerFolders([.init(id: "f1", path: footage, workspaces: ["B"], use: "media")], server: s)
        XCTAssertTrue(MediaFiles.allow(footage, server: s))
        MediaFiles.setServerFolders([.init(id: "f1", path: footage, workspaces: ["*"], use: "media")], server: s)
        XCTAssertTrue(MediaFiles.isAllowed(footage, server: s))
        let stored = try JSONDecoder().decode([String: [String]].self, from: XCTUnwrap(MediaFiles.defaults.data(forKey: "allowedFolders")))
        XCTAssertEqual(stored, [s: ["f1"]])
    }

    /// The OKs saved by path before the change become the folders' ids, once; a second pull changes nothing.
    func testPathKeyedOKsMigrateOnce() throws {
        let s = "s"
        let other = root.appendingPathComponent("Other").path
        MediaFiles.defaults.set(try JSONEncoder().encode([s: [footage]]), forKey: "allowedFolders")
        let list: [MediaFiles.ServerFolder] = [.init(id: "f1", path: footage, workspaces: ["*"], use: "media"), .init(id: "f2", path: other, workspaces: ["*"], use: "media")]
        MediaFiles.setServerFolders(list, server: s)
        XCTAssertTrue(MediaFiles.isAllowed(footage, server: s))
        XCTAssertFalse(MediaFiles.isAllowed(other, server: s))
        let once = MediaFiles.defaults.data(forKey: "allowedFolders")
        MediaFiles.setServerFolders(list, server: s)
        XCTAssertEqual(MediaFiles.defaults.data(forKey: "allowedFolders"), once)
        XCTAssertEqual(try JSONDecoder().decode([String: [String]].self, from: XCTUnwrap(once)), [s: ["f1"]])
    }
}
