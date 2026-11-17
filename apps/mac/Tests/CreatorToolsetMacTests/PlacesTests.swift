import Foundation
import XCTest
@testable import CreatorToolsetMac

/// The rows of apps/captions/contracts/places.test.ts, so the Swift port answers the same.
private let eNFC = "\u{00e9}"
private let eNFD = "e\u{0301}"

private let rootKeys: [((fs: String?, server: String?, share: String?, uuid: String?), String?)] = [
    (("smb", "office-nas", "footage", nil), "smb://office-nas/footage"),
    (("smb", "office-nas.local", "footage", nil), "smb://office-nas/footage"),
    (("smb", "office-nas._smb._tcp.local", "footage", nil), "smb://office-nas/footage"),
    (("smb", "Office-NAS.local.", "footage", nil), "smb://office-nas/footage"),
    (("afp", "office-nas._afpovertcp._tcp.local", "Footage", nil), "afp://office-nas/footage"),
    (("smb", "office-nas", "/Footage/", nil), "smb://office-nas/footage"),
    (("nfs", "office-nas", "/volume1/Footage/", nil), "nfs://office-nas/volume1/Footage"),
    (("smb", "office-nas", "Vid\(eNFD)o", nil), "smb://office-nas/vid\(eNFC)o"),
    (("smb", "office-nas", "Vid\(eNFC)o", nil), "smb://office-nas/vid\(eNFC)o"),
    ((nil, nil, nil, "5a1e0c7d-0b1f-4c2e-9a6b-3d4e5f607182"), "vol:5A1E0C7D-0B1F-4C2E-9A6B-3D4E5F607182"),
    (("smb", "office-nas", "footage", "5a1e0c7d"), "smb://office-nas/footage"),
    ((nil, "office-nas", "footage", nil), nil),
    ((nil, nil, nil, nil), nil),
]

private let moves: [(String, String, PathMove?)] = [
    ("/Volumes/footage/2025/a.mov", "/Volumes/footage-1/2025/a.mov", PathMove(from: "/Volumes/footage", to: "/Volumes/footage-1")),
    ("2025/June/C0012.MP4", "Archive/2025/June/C0012.MP4", PathMove(from: "2025", to: "Archive/2025")),
    ("Shoots/2025/a.mov", "Archive/2025/a.mov", PathMove(from: "Shoots", to: "Archive")),
    ("/Volumes/footage/2025/a.mov", "/Volumes/footage/Archive/2025/a.mov", PathMove(from: "/Volumes/footage", to: "/Volumes/footage/Archive")),
    ("/a/b.mov", "/x/a/b.mov", PathMove(from: "", to: "/x")),
    ("/x/a/b.mov", "/a/b.mov", PathMove(from: "/x", to: "")),
    ("2025/a.mov", "2025/b.mov", nil),
    ("/Volumes/footage/a.mov", "/Volumes/footage/a.mov", nil),
    ("a.mov", "2025/a.mov", nil),
    ("/Volumes/Vid\(eNFD)o/2025/a.mov", "/Volumes/Archive/Vid\(eNFC)o/2025/a.mov", PathMove(from: "/Volumes", to: "/Volumes/Archive")),
    ("/Volumes/Vid\(eNFC)o/a.mov", "/Volumes/T\(eNFD)l\(eNFD)/Vid\(eNFD)o/a.mov", PathMove(from: "/Volumes", to: "/Volumes/T\(eNFC)l\(eNFC)")),
    ("/Volumes/Vid\(eNFD)o/a.mov", "/Volumes/Clips/a.mov", PathMove(from: "/Volumes/Vid\(eNFC)o", to: "/Volumes/Clips")),
    ("Z:\\footage\\2025\\a.mov", "Z:\\footage\\Archive\\2025\\a.mov", PathMove(from: "Z:\\footage", to: "Z:\\footage\\Archive")),
    ("/Volumes/footage/2025/a.mov", "F:\\2025\\a.mov", PathMove(from: "/Volumes/footage", to: "F:")),
    ("\\\\office-nas\\footage\\2025\\a.mov", "/Volumes/footage/2025/a.mov", PathMove(from: "\\\\office-nas", to: "/Volumes")),
    ("Z:\\x\\a.mov", "Z:/x/a.mov", nil),
]

private let applied: [(String, PathMove, String?)] = [
    ("2025/July/b.mov", PathMove(from: "2025", to: "Archive/2025"), "Archive/2025/July/b.mov"),
    ("2025", PathMove(from: "2025", to: "Archive/2025"), "Archive/2025"),
    ("20251/b.mov", PathMove(from: "2025", to: "Archive/2025"), nil),
    ("/a/c.mov", PathMove(from: "", to: "/x"), "/x/a/c.mov"),
    ("/x/a/c.mov", PathMove(from: "/x", to: ""), "/a/c.mov"),
    ("/Volumes/footage/2025/b.mov", PathMove(from: "/Volumes/footage", to: "F:"), "F:\\2025\\b.mov"),
    ("Z:\\footage\\2025\\b.mov", PathMove(from: "Z:\\footage", to: "/Volumes/footage"), "/Volumes/footage/2025/b.mov"),
    ("/Volumes/Vid\(eNFD)o/b.mov", PathMove(from: "/Volumes/Vid\(eNFC)o", to: "/Volumes/Clips"), "/Volumes/Clips/b.mov"),
]

private let joined: [(String, String, String)] = [
    ("/Volumes/footage-1", "2025/June/C0012.MP4", "/Volumes/footage-1/2025/June/C0012.MP4"),
    ("/Volumes/footage/", "a.mov", "/Volumes/footage/a.mov"),
    ("/", "Users/tiny/Movies/a.mov", "/Users/tiny/Movies/a.mov"),
    ("/mnt/footage", "/2025/a.mov", "/mnt/footage/2025/a.mov"),
    ("/mnt/footage", "", "/mnt/footage"),
    ("Z:\\", "2025/a.mov", "Z:\\2025\\a.mov"),
    ("\\\\office-nas\\footage", "2025/a.mov", "\\\\office-nas\\footage\\2025\\a.mov"),
]

/// The same text in the same code units (Swift's == takes NFC and NFD as equal; the TypeScript gives NFC back).
private func units(_ s: String?) -> [UInt16]? { s.map { Array($0.utf16) } }
private func units(_ m: PathMove?) -> [[UInt16]]? { m.map { [Array($0.from.utf16), Array($0.to.utf16)] } }

final class PlacesTests: XCTestCase {
    private let share = "smb://office-nas/footage"
    private var root: URL!

    override func setUpWithError() throws {
        let base = ProcessInfo.processInfo.environment["CT_SCRATCH_DIR"].map { URL(fileURLWithPath: $0) } ?? FileManager.default.temporaryDirectory
        // the path as realpath names it (the gate's own form): /private/var, never Foundation's /var
        let made = base.appendingPathComponent("places-tests/\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: made, withIntermediateDirectories: true)
        root = URL(fileURLWithPath: try XCTUnwrap(MediaFiles.realPath(made.path)), isDirectory: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: root)
    }

    func testTheContractRows() {
        for (d, key) in rootKeys { XCTAssertEqual(units(rootKey(fs: d.fs, server: d.server, share: d.share, uuid: d.uuid)), units(key), "\(d)") }
        for (old, new, move) in moves { XCTAssertEqual(units(derivedMove(old, new)), units(move), "\(old) → \(new)") }
        for (path, move, to) in applied { XCTAssertEqual(units(applyMove(path, move)), units(to), path) }
        for (dir, rel, path) in joined { XCTAssertEqual(joinRoot(dir, rel), path) }
        let m = derivedMove("/Volumes/footage/2025/June/a.mov", "/Volumes/footage-1/Archive/2025/June/a.mov")!
        XCTAssertEqual(applyMove("/Volumes/footage/2025/July/b.mov", m), "/Volumes/footage-1/Archive/2025/July/b.mov")
    }

    func testAGrantByRootCoversTheShareMountedAgainElsewhere() {
        let grants = MediaFiles.rootGrants(for: ["/Volumes/footage/2025", "/Volumes/gone/x"],
                                           disks: [PlaceDisk(path: "/Volumes/footage", key: share, network: true)])
        // the folder on a disk not mounted stays a plain path
        XCTAssertEqual(grants, [MediaFiles.RootGrant(path: "/Volumes/footage/2025", root: share, rel: "2025")])
        let now = [PlaceDisk(path: "/Volumes/footage", key: "smb://other-nas/footage", network: true),
                   PlaceDisk(path: "/Volumes/footage-1", key: share, network: true)]
        let granted = { (p: String) in MediaFiles.isGranted(p, folders: [], roots: grants, disks: now) }
        XCTAssertTrue(granted("/Volumes/footage-1/2025/June/a.mov"))
        XCTAssertFalse(granted("/Volumes/footage-1/20251/a.mov"))   // a sibling sharing the name's start
        XCTAssertFalse(granted("/Volumes/footage-1/2024/a.mov"))
        XCTAssertFalse(granted("/Volumes/footage/2025/a.mov"))      // another share now mounted at the old path
    }

    func testAPlainGrantStillWorks() {
        let disks = [PlaceDisk(path: "/", key: "vol:A")]
        XCTAssertTrue(MediaFiles.isGranted("/Users/tiny/Movies/a.mov", folders: ["/Users/tiny/Movies"], roots: [], disks: disks))
        XCTAssertFalse(MediaFiles.isGranted("/Users/tiny/Moviesx/a.mov", folders: ["/Users/tiny/Movies"], roots: [], disks: disks))
    }

    func testTheGuardGivesUpOnABlockedCallAndMarksTheDiskAway() {
        let places = Places(diskList: { [PlaceDisk(path: "/Volumes/footage", key: self.share, network: true)] }, lookup: { _ in true })
        let start = Date()
        let answer = places.guarded("/Volumes/footage/2025/a.mov") { () -> Int in Thread.sleep(forTimeInterval: 10); return 1 }
        XCTAssertNil(answer)
        XCTAssertLessThan(Date().timeIntervalSince(start), 2.1)
        XCTAssertTrue(places.isAway(mount: "/Volumes/footage"))
        // a local path is not guarded
        XCTAssertEqual(places.guarded("/Users/tiny/a.mov") { 7 }, 7)
    }

    func testADiskAwayIsNeverTouched() {
        var calls = 0
        let places = Places(diskList: { [PlaceDisk(path: "/Volumes/footage", key: self.share, network: true, name: "footage", server: "office-nas")] },
                            lookup: { _ in false })
        XCTAssertFalse(places.answers("/Volumes/footage", fresh: true))
        let v = VersionPlaces(tries: ["/Volumes/footage/2025/a.mov"], bytes: 10, root: .init(key: share, name: "footage", server: "office-nas"))
        let checked = places.check(["v1": v], granted: [], roots: []) { _ in calls += 1; return 10 }
        XCTAssertEqual(calls, 0)
        XCTAssertEqual(checked.answer["v1"]?["state"] as? String, "away")
        XCTAssertEqual((checked.answer["v1"]?["root"] as? [String: Any])?["server"] as? String, "office-nas")
        XCTAssertNil(places.guarded("/Volumes/footage/2025/a.mov") { () -> Int in calls += 1; return 1 })
        XCTAssertEqual(calls, 0)
    }

    func testTheFirstTryWithTheRightSizeWins() throws {
        let write = { (name: String, bytes: Int) -> String in
            let file = self.root.appendingPathComponent(name)
            try? Data(repeating: 1, count: bytes).write(to: file)
            return file.path
        }
        let missing = root.appendingPathComponent("missing.mov").path
        let wrong = write("wrong.mov", 5), right = write("right.mov", 10), also = write("also.mov", 10)
        let places = Places(diskList: { [PlaceDisk(path: "/", key: "vol:A"), PlaceDisk(path: self.root.path, key: "vol:T", name: "Travel SSD")] })
        let checked = places.check([
            "v1": VersionPlaces(tries: [missing, wrong, right, also], bytes: 10),
            "v2": VersionPlaces(tries: [missing, wrong], bytes: 10),
            "v3": VersionPlaces(tries: ["/Volumes/not-mounted-here/a.mov"], bytes: 10, root: .init(key: share, name: "footage", server: "office-nas")),
            "v4": VersionPlaces(tries: [], bytes: 10),
        ], granted: [root.path], roots: [])
        XCTAssertEqual(checked.answer["v1"]?["state"] as? String, "here")
        XCTAssertEqual(checked.answer["v1"]?["path"] as? String, right)
        XCTAssertEqual(checked.answer["v1"]?["url"] as? String, MediaFiles.url(path: right).absoluteString)
        XCTAssertEqual(checked.confirmed, ["v1": right])
        // a file of another size is not it, and every try's disk answered: gone
        XCTAssertEqual(checked.answer["v2"]?["state"] as? String, "gone")
        XCTAssertEqual(checked.gone, ["v2"])
        // its share isn't connected here (and this Mac never had it): away, with Connect
        XCTAssertEqual(checked.answer["v3"]?["state"] as? String, "away")
        XCTAssertEqual(checked.answer["v3"]?["needs"] as? String, "connect")
        // nothing to try and no root: left out, the page plays the server's proxy
        XCTAssertNil(checked.answer["v4"])

        // a file on the system disk is here even when no disk is listed for it (the sealed system volume is read-only)
        let ping = "/System/Library/Sounds/Ping.aiff"
        let system = Places(diskList: { [] }).check(["v1": VersionPlaces(tries: [ping], bytes: try XCTUnwrap(Places.size(ping)))], granted: [], roots: [])
        XCTAssertEqual(system.answer["v1"]?["state"] as? String, "here")
        XCTAssertEqual(system.answer["v1"]?["folder"] as? String, "/System/Library/Sounds")

        // outside the folders the page may play from: here, and the access button opens at the disk
        let outside = places.check(["v1": VersionPlaces(tries: [right], bytes: 10)], granted: [], roots: [])
        XCTAssertEqual(outside.answer["v1"]?["needs"] as? String, "access")
        XCTAssertEqual(outside.answer["v1"]?["folder"] as? String, root.path)
        XCTAssertNil(outside.answer["v1"]?["url"])
    }

    func testTheTriesComeFromTheServerAndWhatWasFoundGoesBack() async throws {
        let file = root.appendingPathComponent("a.mov")
        try Data(repeating: 2, count: 3000).write(to: file)
        let site = FakeSite()
        let places = Places(diskList: { [PlaceDisk(path: "/", key: "vol:A"), PlaceDisk(path: self.root.path, key: "vol:T")] })
        let mac = Site(base: site.url, cookies: [])

        // a server without the places routes: no tries, nothing answered, nothing sent back
        site.answer = { _ in (404, "{}") }
        let none = await places.answerCheck(library: "lib1", versions: ["v1"], site: mac, device: "dev1")
        XCTAssertEqual((none["versions"] as? [String: Any])?.count, 0)
        let unpaired = await places.answerCheck(library: "lib1", versions: ["v1"], site: mac, device: nil)   // this Mac not on the server
        XCTAssertEqual((unpaired["versions"] as? [String: Any])?.count, 0)

        site.answer = { r in r.method == "GET" ? (200, #"{"versions":{"v1":{"tries":["\#(file.path)"],"bytes":3000,"quick":null,"proxy":null}}}"#) : (200, "{}") }
        let found = await places.answerCheck(library: "lib1", versions: ["v1"], site: mac, device: "dev1", granted: [root.path], roots: [])
        XCTAssertEqual(((found["versions"] as? [String: Any])?["v1"] as? [String: Any])?["state"] as? String, "here")
        XCTAssertEqual(site.requests.last { $0.method == "GET" }?.path, "/api/library/lib1/places?device=dev1&versions=v1")
        for _ in 0..<50 where !site.requests.contains(where: { $0.method == "POST" }) { try await Task.sleep(nanoseconds: 50_000_000) }
        let post = try XCTUnwrap(site.requests.first { $0.method == "POST" })
        XCTAssertEqual(post.path, "/api/library/lib1/places")
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: post.body) as? [String: Any])
        let confirmed = try XCTUnwrap((body["confirmed"] as? [[String: Any]])?.first)
        XCTAssertEqual(body["device"] as? String, "dev1")
        XCTAssertEqual(confirmed["path"] as? String, file.path)
        XCTAssertEqual(confirmed["quick"] as? String, Imports.quickPrint(file.path))   // the server had none

        // asked again within 10 s: the kept answer, no new request
        let before = site.requests.count
        _ = await places.answerCheck(library: "lib1", versions: ["v1"], site: mac, device: "dev1", granted: [root.path], roots: [])
        XCTAssertEqual(site.requests.count, before)
    }

    // review fix 1: a server elsewhere names the tries; only video and sound files by a plain path are looked at
    func testOnlyMediaFilesAreLookedAt() throws {
        try FileManager.default.createDirectory(at: root.appendingPathComponent(".ssh"), withIntermediateDirectories: true)
        let key = root.appendingPathComponent(".ssh/id_ed25519")
        try Data(repeating: 3, count: 411).write(to: key)
        let clip = root.appendingPathComponent("a.mov")
        try Data(repeating: 3, count: 411).write(to: clip)
        var asked: [String] = []
        let places = Places(diskList: { [PlaceDisk(path: "/", key: "vol:A"), PlaceDisk(path: self.root.path, key: "vol:T")] })
        let checked = places.check([
            "key": VersionPlaces(tries: [key.path, "/Users/tiny/.ssh/known_hosts"], bytes: 411),
            "dots": VersionPlaces(tries: [root.path + "/x/../a.mov", root.path + "/./a.mov", "a.mov"], bytes: 411),
            "clip": VersionPlaces(tries: [key.path, clip.path], bytes: 411),
        ], granted: [root.path], roots: []) { path in asked.append(path); return Places.size(path) }
        XCTAssertNil(checked.answer["key"])    // no answer at all: not here, not gone
        XCTAssertNil(checked.answer["dots"])
        XCTAssertEqual(checked.answer["clip"]?["path"] as? String, clip.path)
        XCTAssertEqual(asked, [clip.path])
        XCTAssertEqual(checked.confirmed, ["clip": clip.path])
        XCTAssertEqual(checked.gone, [])
    }

    // review fix 2: granted is the gate's answer on the real path; an ungranted file is here + needs access, never
    // read and never told to the server
    func testOnlyAFileTheGateServesIsToldToTheServer() async throws {
        let fm = FileManager.default
        let grantedDir = root.appendingPathComponent("granted"), other = root.appendingPathComponent("other")
        try fm.createDirectory(at: grantedDir, withIntermediateDirectories: true)
        try fm.createDirectory(at: other, withIntermediateDirectories: true)
        try Data(repeating: 1, count: 2000).write(to: grantedDir.appendingPathComponent("a.mov"))
        try Data(repeating: 2, count: 3000).write(to: other.appendingPathComponent("secret.mov"))
        try fm.createSymbolicLink(at: grantedDir.appendingPathComponent("link"), withDestinationURL: other)   // a folder link out
        let g = grantedDir.appendingPathComponent("a.mov").path
        let viaLink = grantedDir.appendingPathComponent("link/secret.mov").path
        let tries: [String: (tries: [String], bytes: Int)] = [
            "g": ([g], 2000),
            "u": ([viaLink], 3000),                                                   // real path outside the grant
            "d": ([grantedDir.path + "/../other/secret.mov"], 3000),                   // a prefix match only
            "x": ([other.appendingPathComponent("missing.mov").path], 10),             // outside, not there
            "y": ([grantedDir.appendingPathComponent("missing.mov").path], 10),        // inside, not there
        ]
        let json = tries.map { id, t in "\"\(id)\":{\"tries\":[\(t.tries.map { "\"\($0)\"" }.joined(separator: ","))],\"bytes\":\(t.bytes),\"quick\":null,\"proxy\":null}" }
        let site = FakeSite()
        site.answer = { r in r.method == "GET" ? (200, "{\"versions\":{\(json.joined(separator: ","))}}") : (200, "{}") }
        let places = Places(diskList: { [PlaceDisk(path: "/", key: "vol:A"), PlaceDisk(path: self.root.path, key: "vol:T")] })
        let out = await places.answerCheck(library: "lib1", versions: ["g", "u", "d", "x", "y"], site: Site(base: site.url, cookies: []),
                                           device: "dev1", granted: [grantedDir.path], roots: [])
        let versions = try XCTUnwrap(out["versions"] as? [String: [String: Any]])
        XCTAssertNotNil(versions["g"]?["url"])
        XCTAssertEqual(versions["u"]?["state"] as? String, "here")
        XCTAssertEqual(versions["u"]?["needs"] as? String, "access")
        XCTAssertEqual(versions["u"]?["path"] as? String, viaLink)
        XCTAssertNil(versions["u"]?["url"])
        XCTAssertNil(versions["d"])
        XCTAssertEqual(versions["x"]?["state"] as? String, "gone")
        XCTAssertEqual(versions["y"]?["state"] as? String, "gone")

        for _ in 0..<50 where !site.requests.contains(where: { $0.method == "POST" }) { try await Task.sleep(nanoseconds: 50_000_000) }
        try await Task.sleep(nanoseconds: 200_000_000)
        let posts = site.requests.filter { $0.method == "POST" }
        XCTAssertEqual(posts.count, 1)
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: try XCTUnwrap(posts.first).body) as? [String: Any])
        let confirmed = try XCTUnwrap(body["confirmed"] as? [[String: Any]])
        XCTAssertEqual(confirmed.map { $0["versionId"] as? String }, ["g"])
        XCTAssertEqual(confirmed.first?["quick"] as? String, Imports.quickPrint(g))
        XCTAssertEqual(body["gone"] as? [String], ["y"])
    }

    // review fix 3: Connect on a share this Mac never had asks in this app's own confirm first
    func testConnectAsksFirstForAShareThisMacNeverHad() async {
        defer { UserDefaults.standard.removeObject(forKey: "sharedDrives") }
        UserDefaults.standard.removeObject(forKey: "sharedDrives")
        var mounted: [(String, Bool)] = []
        var asked: [(String, String)] = []
        let places = Places(diskList: { [] })
        places.mountShare = { url, ui, done in mounted.append((url, ui)); done(0) }

        let declined = await places.connect(root: share, server: "studio.example.com") { server, address in asked.append((server, address)); return false }
        XCTAssertEqual(declined["problem"] as? String, "Not connected")
        XCTAssertTrue(mounted.isEmpty)
        XCTAssertEqual(asked.first?.0, "studio.example.com")
        XCTAssertEqual(asked.first?.1, "smb://office-nas.local/footage")

        let accepted = await places.connect(root: share, server: "studio.example.com") { _, _ in true }
        XCTAssertEqual(accepted["ok"] as? Bool, true)
        XCTAssertEqual(mounted.map { $0.0 }, ["smb://office-nas.local/footage"])
        XCTAssertEqual(mounted.map { $0.1 }, [true])

        // a share this Mac had connects as before, with no confirm
        places.shares = [Places.Share(key: share, url: "smb://tiny@office-nas.local/footage")]
        mounted = []
        _ = await places.connect(root: share, server: "studio.example.com") { _, _ in XCTFail("asked for a share this Mac had"); return false }
        XCTAssertEqual(mounted.map { $0.0 }, ["smb://tiny@office-nas.local/footage"])
    }

    func testFiveEventsMakeOneLook() {
        var count = 0
        let done = expectation(description: "looked")
        let debounce = Debounce(delay: 0.1, queue: .main) {
            count += 1
            done.fulfill()
        }
        for _ in 0..<5 { debounce.poke() }
        wait(for: [done], timeout: 2)
        RunLoop.main.run(until: Date().addingTimeInterval(0.3))
        XCTAssertEqual(count, 1)
    }

    func testTheAsks() {
        XCTAssertEqual(placesAsk(#"places:check:{"library":"lib_1","versions":["v-1","v2"]}"#), .check(library: "lib_1", versions: ["v-1", "v2"]))
        XCTAssertNil(placesAsk(#"places:check:{"library":"../x","versions":["v1"]}"#))
        XCTAssertNil(placesAsk(#"places:check:{"library":"lib","versions":["/Volumes/footage/a.mov"]}"#))   // ids, never paths
        XCTAssertNil(placesAsk("places:check:{\"library\":\"lib\",\"versions\":[\(Array(repeating: "\"v\"", count: 201).joined(separator: ","))]}"))
        XCTAssertEqual(placesAsk(#"places:connect:{"root":"smb://office-nas/footage"}"#), .connect(root: "smb://office-nas/footage"))
        XCTAssertNil(placesAsk(#"places:connect:{"root":"vol:5A1E0C7D"}"#))   // a volume is not connected
        XCTAssertNil(placesAsk("places:search:{}"))
    }

    func testAShareIsConnectedAgainByTheAddressItWasMountedWith() {
        XCTAssertEqual(shareURL(source: "//tiny@office-nas.local/footage", fstype: "smbfs"), "smb://tiny@office-nas.local/footage")
        // review fix 4: never a password in the address kept
        XCTAssertEqual(shareURL(source: "//tiny:secret@office-nas.local/footage", fstype: "smbfs"), "smb://tiny@office-nas.local/footage")
        XCTAssertEqual(shareURL(source: "//guest:@office-nas.local/footage", fstype: "smbfs"), "smb://guest@office-nas.local/footage")
        XCTAssertEqual(shareURL(source: "//STUDIO;tiny:p%40ss@office-nas/footage", fstype: "smbfs"), "smb://STUDIO;tiny@office-nas/footage")
        XCTAssertEqual(shareURL(source: "//tiny:secret@office-nas/Footage", fstype: "afpfs"), "afp://tiny@office-nas/Footage")
        XCTAssertEqual(shareURL(source: "//office-nas/footage", fstype: "smbfs"), "smb://office-nas/footage")
        XCTAssertEqual(shareURL(source: "office-nas:/volume1/footage", fstype: "nfs"), "nfs://office-nas/volume1/footage")
        XCTAssertNil(shareURL(source: "/dev/disk3s1", fstype: "apfs"))
        XCTAssertEqual(Places.shareParts("smb://office-nas/footage")?.host, "office-nas")
        XCTAssertNil(Places.shareParts("vol:5A1E0C7D"))
    }

    func testALocalVolumeReportsItsUUIDAndAShareDoesNot() {
        let local = VolumeFacts(path: "/Volumes/Travel SSD", freeBytes: 1 << 40, totalBytes: 2 << 40, fstype: "apfs", source: "/dev/disk4s1",
                                readOnly: false, browsable: true, uuid: "5A1E0C7D")
        XCTAssertEqual(diskReport(local)?["uuid"] as? String, "5A1E0C7D")
        let share = VolumeFacts(path: "/Volumes/footage", freeBytes: 1 << 40, totalBytes: 2 << 40, fstype: "smbfs", source: "//tiny@office-nas/footage",
                                readOnly: false, browsable: true, uuid: "5A1E0C7D")
        XCTAssertNil(diskReport(share)?["uuid"])
    }
}
