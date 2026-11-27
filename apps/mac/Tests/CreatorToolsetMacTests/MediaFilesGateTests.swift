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
        MediaFiles.add(root.path, server: "s")   // an open panel or a drop on this Mac
        MediaFiles.setServerFolders([.init(id: "f1", path: footage, workspaces: ["*"], use: "media")], server: "s")
        XCTAssertTrue(MediaFiles.isAllowed(footage, server: "s"))
    }

    func testOnlyAPanelAllowIsAReadFolderAndRemoveTakesItAllOff() {
        let dropped = root.appendingPathComponent("Card").path
        MediaFiles.add(dropped, server: "s")                 // a drop: read what was given, copied on import
        MediaFiles.allowRead(root.path, server: "s")         // Allow folder in the open panel
        MediaFiles.grantPicked([URL(fileURLWithPath: file)], server: "s")   // a picked file alone is no folder
        XCTAssertEqual(MediaFiles.readList(server: "s")["folders"], [dropped, root.path])
        XCTAssertEqual(MediaFiles.readList(server: "s")["reads"], [root.path])
        MediaFiles.setServerFolders([.init(id: "f1", path: footage, workspaces: ["*"], use: "media")], server: "s")
        MediaFiles.remove(root.path, server: "s")
        XCTAssertEqual(MediaFiles.readList(server: "s")["reads"], [])
        XCTAssertFalse(MediaFiles.picks("s").contains(root.path))
        XCTAssertFalse(MediaFiles.isAllowed(footage, server: "s"))   // its pick no longer OKs the rows under it
    }

    func testUseWhereTheyAreReadsOnlyWhatThisMacWasGiven() {
        let none = { (_: String) in false }
        let card = root.appendingPathComponent("Card").path, loose = root.appendingPathComponent("Downloads/b.mov").path
        MediaFiles.grantDropped([["path": card, "folder": true]], server: "s")
        MediaFiles.grantPicked([URL(fileURLWithPath: loose)], server: "s")
        // a dropped folder's file: that folder; a picked file alone never widens to its folder; anything else: nothing
        XCTAssertEqual(MediaFiles.allowReadGiven([card + "/sub/a.mov", loose, file, "/etc/x.mov"], server: "s", signedIn: none), [card])
        XCTAssertEqual(MediaFiles.reads("s"), [card])
        XCTAssertNil(MediaFiles.readFolder(for: card + "/../x.mov", server: "s"))
        // a whole home folder is never read from one file picked in it
        MediaFiles.grantPicked([URL(fileURLWithPath: NSHomeDirectory() + "/c.mov")], server: "s")
        XCTAssertNil(MediaFiles.readFolder(for: NSHomeDirectory() + "/c.mov", server: "s"))
    }

    func testUseWhereTheyAreKeepsTheBlurredElsewhereGuard() {
        let card = root.appendingPathComponent("Card").path
        MediaFiles.setServerFolders([.init(id: "f1", path: card + "/Media", workspaces: ["*"], use: "media", guarded: ["Tiny"])], server: "other.test")
        MediaFiles.grantDropped([["path": card, "folder": true]], server: "s")
        XCTAssertEqual(MediaFiles.allowReadGiven([card + "/a.mov"], server: "s", signedIn: { $0 == "other.test" }, reachable: { _ in false }), [])
        XCTAssertEqual(MediaFiles.reads("s"), [])
    }

    /// A pick made on server A is never read by server B's page: at the gate, the list it sees, or Import's scan.
    func testAPickMadeOnOneServerIsRefusedOnAnother() {
        MediaFiles.grantDropped([["path": footage, "folder": true]], server: "a.test")
        let onB = MediaFiles.granted(server: "b.test", workspace: nil)
        XCTAssertEqual(MediaFiles.granted(server: "a.test", workspace: nil), [footage])
        XCTAssertEqual(onB, [])
        XCTAssertEqual(MediaFiles.gate(file, granted: onB, roots: [], places: places), .status(403))
        XCTAssertEqual(MediaFiles.readList(server: "b.test")["folders"], [])
        XCTAssertEqual(MediaFiles.placeState(file, server: "b.test", places: places).state, "not_granted")
        if case .file = MediaFiles.gate(file, granted: MediaFiles.granted(server: "a.test", workspace: nil), roots: [], places: places) {} else { XCTFail("granted on A") }
        // the Media Library's scan, asked by each page for the same folder
        let answered = expectation(description: "scans answered")
        answered.expectedFulfillmentCount = 2
        Imports.shared.answer(#"import:scan:{"path":"\#(footage)"}"#, sources: [], server: "b.test") { reply in
            XCTAssertNotNil(reply["error"], "B's page must not list A's folder")
            answered.fulfill()
        }
        Imports.shared.answer(#"import:scan:{"path":"\#(footage)"}"#, sources: [], server: "a.test") { reply in
            XCTAssertNotNil(reply["files"], "A's page lists its own pick")
            answered.fulfill()
        }
        wait(for: [answered], timeout: 5)
    }

    /// Picks saved before servers were recorded (a bare list) are This Mac's own, whatever its port.
    func testPicksFromBeforeServersWereRecordedAreThisMacsOwn() {
        MediaFiles.defaults.set([footage], forKey: "mediaFolders")
        XCTAssertEqual(MediaFiles.picks("127.0.0.1:43127"), [footage])
        XCTAssertEqual(MediaFiles.picks("127.0.0.1:43999"), [footage])
        XCTAssertEqual(MediaFiles.picks("studio.example:443"), [])
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

    /// Right after the update, before any pull: a folder OK'd by path (saved before the id key) still reads as allowed.
    func testPathKeyedOKReadsBeforeMigration() throws {
        let s = "s"
        MediaFiles.defaults.set(try JSONEncoder().encode([s: [footage]]), forKey: "allowedFolders")
        MediaFiles.defaults.set(try JSONEncoder().encode([s: [MediaFiles.ServerFolder(id: "f1", path: footage, workspaces: ["*"], use: "media")]]), forKey: "serverFolders")
        XCTAssertTrue(MediaFiles.isAllowed(footage, server: s))
        XCTAssertEqual(MediaFiles.granted(server: s, workspace: nil), [footage])
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

    /// The server collapses two rows of one path into one with a new id: the OK follows the path to the id that stays.
    func testOKFollowsItsPathWhenTheIdChanges() throws {
        let s = "s"
        MediaFiles.setServerFolders([.init(id: "44919794", path: footage, workspaces: ["*"], use: "media")], server: s)
        XCTAssertTrue(MediaFiles.allow(footage, server: s))
        MediaFiles.setServerFolders([.init(id: "cd303bbd", path: footage, workspaces: ["*"], use: "media")], server: s)
        XCTAssertTrue(MediaFiles.isAllowed(footage, server: s))
        XCTAssertEqual(MediaFiles.granted(server: s, workspace: nil), [footage])
        XCTAssertEqual(try JSONDecoder().decode([String: [String]].self, from: XCTUnwrap(MediaFiles.defaults.data(forKey: "allowedFolders"))), [s: ["cd303bbd"]])
    }

    /// placeState and serving take one grant list (granted(server:workspace:) and the root grants) and answer alike: a
    /// file inside a root grant on its share mounted again elsewhere, and a file in another workspace's folder.
    func testPlaceStateAndServingAgree() throws {
        let s = "studio.example:443"
        let mount = try XCTUnwrap(MediaFiles.realPath(root.path))
        let file = mount + "/Footage/a.mov"
        let places = Places(diskList: { [PlaceDisk(path: "/", key: "system"), PlaceDisk(path: mount, key: "smb://office-nas/footage")] }, lookup: { _ in true })
        let served = { (workspace: String?, roots: [MediaFiles.RootGrant]) -> Bool in
            if case .file = MediaFiles.gate(file, granted: MediaFiles.granted(server: s, workspace: workspace), roots: roots, places: places, firstRead: true) { return true }
            return false
        }
        // granted on the share when it was mounted at /Volumes/footage (a pick of this server); it is at `mount` now
        MediaFiles.add("/Volumes/footage/Footage", server: s)
        let rootGrant = [MediaFiles.RootGrant(path: "/Volumes/footage/Footage", root: "smb://office-nas/footage", rel: "Footage")]
        XCTAssertTrue(served(nil, rootGrant))
        XCTAssertEqual(MediaFiles.placeState(file, server: s, roots: rootGrant, places: places).state, "here")
        // a folder allowed on this Mac for workspace B: here and served in B, in neither for a clip of A
        MediaFiles.setServerFolders([.init(id: "f1", path: mount + "/Footage", workspaces: ["B"], use: "media")], server: s)
        XCTAssertTrue(MediaFiles.allow(mount + "/Footage", server: s))
        XCTAssertTrue(served("B", []))
        XCTAssertEqual(MediaFiles.placeState(file, server: s, workspace: "B", roots: [], places: places).state, "here")
        XCTAssertFalse(served("A", []))
        XCTAssertEqual(MediaFiles.placeState(file, server: s, workspace: "A", roots: [], places: places).state, "not_granted")
    }
}
