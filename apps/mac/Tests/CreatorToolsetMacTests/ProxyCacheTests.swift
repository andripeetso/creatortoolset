import Foundation
import XCTest
@testable import CreatorToolsetMac

// The proxy cache plays (ProxyCache.swift): only the window's own account's cache, only for a page of that server, and
// with no internet the cached proxies alone.
final class ProxyCacheTests: XCTestCase {
    private var root: URL!
    private var relay: ((URL) -> URL)!

    override func setUpWithError() throws {
        let base = ProcessInfo.processInfo.environment["CT_SCRATCH_DIR"].map { URL(fileURLWithPath: $0) } ?? FileManager.default.temporaryDirectory
        // the path as realpath names it (the gate's own form): /private/var, never Foundation's /var
        let made = base.appendingPathComponent("proxy-cache-tests/\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: made, withIntermediateDirectories: true)
        root = URL(fileURLWithPath: try XCTUnwrap(MediaFiles.realPath(made.path)), isDirectory: true)
        relay = ProxyCache.relay
        let root = root!
        ProxyCache.relay = { root.appendingPathComponent(relayFolder(for: $0, localData: nil).lastPathComponent) }
    }

    override func tearDownWithError() throws {
        ProxyCache.relay = relay
        try? FileManager.default.removeItem(at: root)
    }

    /// A proxy in an account's cache for a server, as the worker leaves it.
    @discardableResult
    private func proxy(_ server: URL, _ account: String, _ version: String) throws -> String {
        let folder = try XCTUnwrap(ProxyCache.folder(server: server, account: account))
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let file = folder.appendingPathComponent("\(version).mp4")
        try Data(repeating: 7, count: 100).write(to: file)
        return file.path
    }

    private func state(_ answer: [String: Any], _ v: String) -> [String: Any]? { (answer["versions"] as? [String: Any])?[v] as? [String: Any] }

    func testAnotherAccountsCacheIsNeverServed() throws {
        let server = URL(string: "https://studio.example.com")!
        let alice = try proxy(server, "alice", "v1"), bob = try proxy(server, "bob", "v2")
        ProxyCache.remember("alice", for: server)
        let page = URL(string: "https://studio.example.com/library/lib1")!
        let allowed = try XCTUnwrap(ProxyCache.allowed(page: page))
        XCTAssertEqual(MediaFiles.gate(alice, granted: [], roots: [], cache: allowed), .file(alice, type: "video/mp4"))
        XCTAssertEqual(MediaFiles.gate(bob, granted: [], roots: [], cache: allowed), .status(403))
        // a missing file in another account's folder reads as not granted, never as missing
        XCTAssertEqual(MediaFiles.gate((bob as NSString).deletingLastPathComponent + "/v9.mp4", granted: [], roots: [], cache: allowed), .status(403))
        // no way out of the folder by name, and nothing but media
        XCTAssertEqual(MediaFiles.gate(allowed + "/../bob/v2.mp4", granted: [], roots: [], cache: allowed), .status(403))
        try Data("[]".utf8).write(to: URL(fileURLWithPath: allowed).appendingPathComponent("offline.json"))
        XCTAssertEqual(MediaFiles.gate(allowed + "/offline.json", granted: [], roots: [], cache: allowed), .status(415))
        // without the cache folder: not granted
        XCTAssertEqual(MediaFiles.gate(alice, granted: [], roots: [], cache: nil), .status(403))
        // a link in alice's folder to bob's proxy is judged by its real path: not served, and no address for it
        let link = allowed + "/v3.mp4"
        try FileManager.default.createSymbolicLink(atPath: link, withDestinationPath: bob)
        XCTAssertEqual(MediaFiles.gate(link, granted: [], roots: [], cache: allowed), .status(403))
        XCTAssertNil(ProxyCache.url("v3", in: URL(fileURLWithPath: allowed)))
        XCTAssertEqual(ProxyCache.url("v1", in: URL(fileURLWithPath: allowed)), MediaFiles.url(path: alice).absoluteString)

        // a page of another server gets none of this server's cache; signed out, none at all
        XCTAssertNil(ProxyCache.allowed(page: URL(string: "https://other.example.com/library")!))
        XCTAssertNil(ProxyCache.allowed(page: URL(string: "ctlocal://media/x")!))
        ProxyCache.remember("bob", for: server)
        XCTAssertEqual(MediaFiles.gate(alice, granted: [], roots: [], cache: ProxyCache.allowed(page: page)), .status(403))
        ProxyCache.remember(nil, for: server)
        XCTAssertNil(ProxyCache.allowed(page: page))
    }

    func testOnlyAPlainAccountNameIsAFolder() {
        let server = URL(string: "https://studio.example.com")!
        for name in ["", "..", "../bob", "a/b", ".hidden", "tïny"] { XCTAssertNil(ProxyCache.folder(server: server, account: name), name) }
        XCTAssertEqual(ProxyCache.folder(server: server, account: "tinyacrobatics")?.lastPathComponent, "tinyacrobatics")
        XCTAssertNil(ProxyCache.url("../v1", in: root))
    }

    func testTheAccountIsTheServersAnswer() throws {
        let check = { (json: String) in try JSONDecoder().decode(ProxyCache.Check.self, from: Data(json.utf8)).account }
        XCTAssertEqual(try check(#"{"authed":true,"user":{"username":"alice"},"viewedBy":null}"#), "alice")
        XCTAssertNil(try check(#"{"authed":false,"user":null}"#))
        // an admin viewing as another account plays neither's cache
        XCTAssertNil(try check(#"{"authed":true,"user":{"username":"bob"},"viewedBy":"alice"}"#))
    }

    func testTheCheckSaysWhatTheCacheHas() throws {
        let file = root.appendingPathComponent("a.mov")
        try Data(repeating: 2, count: 10).write(to: file)
        let share = VersionPlaces.Root(key: "smb://office-nas/footage", name: "footage", server: "office-nas")
        let places = Places(diskList: { [PlaceDisk(path: "/", key: "vol:A"), PlaceDisk(path: self.root.path, key: "vol:T")] })
        let cached = { (v: String) in ["v1", "v2", "v3", "v4"].contains(v) ? "ctlocal://media/\(v)" : nil }
        let checked = places.check([
            "v1": VersionPlaces(tries: [file.path], bytes: 10),
            "v2": VersionPlaces(tries: ["/Volumes/not-mounted-here/a.mov"], bytes: 10, root: share),
            "v3": VersionPlaces(tries: [root.appendingPathComponent("moved.mov").path], bytes: 10),
            "v4": VersionPlaces(tries: [], bytes: 10),
            "v5": VersionPlaces(tries: [], bytes: 10),
        ], granted: [root.path], roots: [], cached: cached)
        // the original here still plays; the cache rides beside it for when it goes away
        XCTAssertEqual(checked.answer["v1"]?["state"] as? String, "here")
        XCTAssertEqual(checked.answer["v1"]?["cached"] as? String, "ctlocal://media/v1")
        // away and gone keep what they say (the away line, Connect, the search) and carry the cache
        XCTAssertEqual(checked.answer["v2"]?["state"] as? String, "away")
        XCTAssertEqual(checked.answer["v2"]?["needs"] as? String, "connect")
        XCTAssertEqual(checked.answer["v2"]?["cached"] as? String, "ctlocal://media/v2")
        XCTAssertEqual(checked.answer["v3"]?["state"] as? String, "gone")
        XCTAssertEqual(checked.gone, ["v3"])
        XCTAssertEqual(checked.answer["v3"]?["cached"] as? String, "ctlocal://media/v3")
        // nothing else known: cached
        XCTAssertEqual(checked.answer["v4"]?["state"] as? String, "cached")
        XCTAssertEqual(checked.answer["v4"]?["url"] as? String, "ctlocal://media/v4")
        XCTAssertNil(checked.answer["v5"])
    }

    /// The W5 check: a clip kept offline, the network off, plays from the cache; another account's never does.
    func testAClipKeptOfflinePlaysFromTheCacheWithNoInternet() async throws {
        let site = FakeSite()
        let mac = Site(base: site.url, cookies: [])
        let mine = try proxy(site.url, "alice", "v1")
        try proxy(site.url, "bob", "v2")
        site.answer = { r in
            if r.path == "/api/auth/check" { return (200, #"{"authed":true,"user":{"username":"alice"},"viewedBy":null}"#) }
            if r.method == "GET" { return (200, #"{"versions":{"v1":{"tries":[],"bytes":10,"quick":null,"proxy":{"bytes":100}},"v2":{"tries":[],"bytes":10,"quick":null,"proxy":{"bytes":100}}}}"#) }
            return (200, "{}")
        }
        let places = Places(diskList: { [PlaceDisk(path: "/", key: "vol:A")] })
        let online = await places.answerCheck(library: "lib1", versions: ["v1", "v2"], site: mac, device: "dev1", cache: true)
        XCTAssertEqual(state(online, "v1")?["state"] as? String, "cached")
        XCTAssertEqual(state(online, "v1")?["url"] as? String, MediaFiles.url(path: mine).absoluteString)
        XCTAssertNil(state(online, "v2"))   // bob's proxy, in bob's folder
        XCTAssertEqual(site.requests.first?.path, "/api/auth/check")

        // the server stops answering (the internet is off): the cached proxy alone, of the account last signed in
        let away = Site(base: URL(string: "http://localhost:9")!, cookies: [])
        let there = try proxy(away.base, "alice", "v1")
        try proxy(away.base, "bob", "v2")
        ProxyCache.remember("alice", for: away.base)
        let offline = await places.answerCheck(library: "lib1", versions: ["v1", "v2", "v3"], site: away, device: "dev1", cache: true)
        XCTAssertEqual(state(offline, "v1")?["state"] as? String, "cached")
        XCTAssertEqual(state(offline, "v1")?["url"] as? String, MediaFiles.url(path: there).absoluteString)
        XCTAssertNil(state(offline, "v2"))
        XCTAssertNil(state(offline, "v3"))
        // and its page may play it
        let page = URL(string: "http://localhost:9/library/lib1")!
        XCTAssertEqual(MediaFiles.gate(there, granted: [], roots: [], cache: ProxyCache.allowed(page: page)), .file(there, type: "video/mp4"))

        // signed in as bob now: alice's answer isn't handed on, and bob's cache is the one played
        site.answer = { r in
            if r.path == "/api/auth/check" { return (200, #"{"authed":true,"user":{"username":"bob"},"viewedBy":null}"#) }
            if r.method == "GET" { return (200, #"{"versions":{"v1":{"tries":[],"bytes":10,"quick":null,"proxy":{"bytes":100}}}}"#) }
            return (200, "{}")
        }
        let switched = await places.answerCheck(library: "lib1", versions: ["v1"], site: mac, device: "dev1", cache: true)
        XCTAssertNil(state(switched, "v1"))
        XCTAssertEqual(MediaFiles.gate(mine, granted: [], roots: [], cache: ProxyCache.allowed(page: site.url)), .status(403))

        // This Mac's own server keeps no cache: nothing asked about it
        site.forget()
        _ = await places.answerCheck(library: "lib1", versions: ["v1"], site: mac, device: "dev1")
        XCTAssertFalse(site.requests.contains { $0.path == "/api/auth/check" })
    }

    /// A Download location change moves every file of the cache (kept ones too) and only onto a disk with room for them.
    func testTheCacheMovesWithItsFilesOnlyOntoADiskWithRoom() throws {
        let base = ProcessInfo.processInfo.environment["CT_SCRATCH_DIR"].map { URL(fileURLWithPath: $0) } ?? FileManager.default.temporaryDirectory
        let work = base.appendingPathComponent("proxy-move-tests/\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: work) }
        let old = work.appendingPathComponent("old/tinyacrobatics", isDirectory: true)
        try FileManager.default.createDirectory(at: old, withIntermediateDirectories: true)
        try Data("kept".utf8).write(to: old.appendingPathComponent("vk.mp4"))
        try Data("kept-list".utf8).write(to: old.appendingPathComponent("kept.json"))
        let new = work.appendingPathComponent("new", isDirectory: true)

        XCTAssertThrowsError(try ProxyCacheMove.move(from: work.appendingPathComponent("old"), to: new, free: { _ in 3 })) { error in
            XCTAssertEqual(error as? ProxyCacheMoveError, .noSpace(needed: 13, free: 3))
        }
        XCTAssertTrue(FileManager.default.fileExists(atPath: old.appendingPathComponent("vk.mp4").path))

        try ProxyCacheMove.move(from: work.appendingPathComponent("old"), to: new, free: { _ in 100 })
        XCTAssertTrue(FileManager.default.fileExists(atPath: new.appendingPathComponent("tinyacrobatics/vk.mp4").path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: new.appendingPathComponent("tinyacrobatics/kept.json").path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: old.appendingPathComponent("vk.mp4").path))
    }
}
