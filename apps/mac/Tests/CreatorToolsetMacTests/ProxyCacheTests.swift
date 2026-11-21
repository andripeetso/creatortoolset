import Foundation
import WebKit
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

    /// A picked Download location: the page plays from where the worker downloads to, its folder for that server (it
    /// looked in the default folder, so nothing downloaded there played).
    func testAPickedDownloadLocationPlaysFromWhereTheWorkerDownloads() throws {
        let location = root.appendingPathComponent("picked", isDirectory: true)
        UserDefaults.standard.set(location.path, forKey: DownloadLocation.key)
        defer { UserDefaults.standard.removeObject(forKey: DownloadLocation.key) }
        let server = URL(string: "https://studio.example.com")!
        let file = try proxy(server, "tinyacrobatics", "v1")
        let worker = try XCTUnwrap(ProxyCache.workerDir(server: server))
        XCTAssertEqual(file, "\(worker)/tinyacrobatics/v1.mp4")
        XCTAssertTrue(file.hasPrefix(location.path + "/"))
        XCTAssertNotNil(ProxyCache.url("v1", in: try XCTUnwrap(ProxyCache.folder(server: server, account: "tinyacrobatics"))))
        // another server's worker gets its own folder: two accounts of one name never share one
        XCTAssertNotEqual(ProxyCache.workerDir(server: URL(string: "http://10.0.0.5:3000")!), worker)
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

    /// A page that plays proxies before any places check (the editor on a fresh launch): its server is asked for the
    /// account on the first request, once for all the requests that come together, and signed out nothing is served.
    func testTheFirstProxyRequestAsksForTheAccountOnce() async throws {
        let site = FakeSite()
        let mine = try proxy(site.url, "alice", "v1")
        site.answer = { r in
            if r.path == "/api/auth/check" {
                Thread.sleep(forTimeInterval: 0.3)   // still asking while the others arrive
                return (200, #"{"authed":true,"user":{"username":"alice"},"viewedBy":null}"#)
            }
            return (404, "{}")
        }
        let page = site.url.appendingPathComponent("editor/p1")
        XCTAssertNil(ProxyCache.allowed(page: page))
        let answers = await withTaskGroup(of: String?.self) { group in
            for _ in 0..<22 { group.addTask { await ProxyCache.allowed(page: page) { Site(base: page, cookies: []) } } }
            return await group.reduce(into: [String?]()) { $0.append($1) }
        }
        XCTAssertEqual(answers.count, 22)
        for cache in answers { XCTAssertEqual(MediaFiles.gate(mine, granted: [], roots: [], cache: cache), .file(mine, type: "video/mp4")) }
        XCTAssertEqual(site.requests.filter { $0.path == "/api/auth/check" }.count, 1)
        // known now, so the first try is served; one asked later (a file refused) asks again, once
        site.forget()
        let again = await ProxyCache.allowed(page: page) { Site(base: page, cookies: []) }
        XCTAssertNotNil(again)
        XCTAssertEqual(site.requests.filter { $0.path == "/api/auth/check" }.count, 1)

        // signed out: still refused
        let out = FakeSite()
        let theirs = try proxy(out.url, "alice", "v1")
        out.answer = { _ in (200, #"{"authed":false,"user":null}"#) }
        let outPage = out.url.appendingPathComponent("editor/p1")
        let cache = await ProxyCache.allowed(page: outPage) { Site(base: outPage, cookies: []) }
        XCTAssertNil(cache)
        XCTAssertEqual(MediaFiles.gate(theirs, granted: [], roots: [], cache: cache), .status(403))
    }

    /// The scheme's side: a proxy refused with the folder of the account known before (alice) asks the server, which
    /// says bob now, and is served from bob's cache; the second try never asks again, so a file still refused is a 403.
    func testARefusedProxyIsServedOnceTheAccountIsAsked() throws {
        let site = FakeSite()
        site.answer = { _ in (200, #"{"authed":true,"user":{"username":"bob"},"viewedBy":null}"#) }
        try proxy(site.url, "alice", "v1")
        let bobs = try proxy(site.url, "bob", "v2")
        let page = site.url.appendingPathComponent("editor/p1")
        ProxyCache.remember("alice", for: site.url)
        let scheme = ProjectScheme(root: { self.root })
        var asks = 0
        let served = run(scheme, bobs, cache: ProxyCache.allowed(page: page)) {
            asks += 1
            return await ProxyCache.allowed(page: page) { Site(base: page, cookies: []) }
        }
        XCTAssertEqual(served.status, 200)
        XCTAssertEqual(served.bytes, 100)
        XCTAssertTrue(served.finished)
        XCTAssertEqual(asks, 1)
        XCTAssertEqual(ProxyCache.allowed(page: page), ProxyCache.folder(server: site.url, account: "bob")?.path)

        // still refused after asking (the answer kept alice): one ask, then 403, never a loop
        ProxyCache.remember("alice", for: site.url)
        let alices = ProxyCache.allowed(page: page)
        asks = 0
        let refused = run(scheme, bobs, cache: alices) { asks += 1; return alices }
        XCTAssertEqual(refused.status, 403)
        XCTAssertTrue(refused.finished)
        XCTAssertEqual(asks, 1)
    }

    /// A request WebKit stops while the account is being asked gets nothing more.
    func testARequestStoppedDuringTheAskGetsNothing() throws {
        let server = URL(string: "https://studio.example.com")!
        let bobs = try proxy(server, "bob", "v2")
        let scheme = ProjectScheme(root: { self.root })
        let asked = expectation(description: "asked")
        let task = FakeTask(MediaFiles.url(path: bobs))
        let got = run(scheme, bobs, cache: nil, task: task, settle: 0.5) {
            await MainActor.run { scheme.webView(WKWebView(), stop: task) }
            asked.fulfill()
            return ProxyCache.folder(server: server, account: "bob")?.path
        }
        wait(for: [asked], timeout: 1)
        XCTAssertNil(got.status)
        XCTAssertEqual(got.bytes, 0)
        XCTAssertFalse(got.finished)
    }

    /// `path` asked of `scheme` as WebKit would, with the page's cache folder `cache`; waits for the answer to end, or
    /// `settle` seconds when none is expected.
    private func run(_ scheme: ProjectScheme, _ path: String, cache: String?, task: FakeTask? = nil, settle: TimeInterval? = nil,
                     ask: @escaping () async -> String?) -> FakeTask {
        let task = task ?? FakeTask(MediaFiles.url(path: path))
        scheme.live[ObjectIdentifier(task)] = task
        let done = expectation(description: "answered")
        if settle != nil { done.isInverted = true }
        task.ended = { done.fulfill() }
        DispatchQueue.global().async {
            scheme.serve(task.request.url!, method: "GET", range: nil, root: self.root, granted: [], cache: cache, ask: ask, task: task)
        }
        wait(for: [done], timeout: settle ?? 5)
        return task
    }

    /// A server that answers but can't check now (a restart's 502, a 503, a 429) keeps the account, as one with no
    /// answer does, so its cached proxies go on playing; a refusal (401) forgets it.
    func testAServerErrorKeepsTheAccount() async throws {
        let site = FakeSite()
        let mine = try proxy(site.url, "alice", "v1")
        let page = site.url.appendingPathComponent("editor/p1")
        ProxyCache.remember("alice", for: site.url)
        for code in [502, 503, 429] {
            site.answer = { _ in (code, "{}") }
            let (name, offline) = await ProxyCache.account(Site(base: site.url, cookies: []))
            XCTAssertEqual(name, "alice", "\(code)")
            XCTAssertTrue(offline)
            XCTAssertEqual(MediaFiles.gate(mine, granted: [], roots: [], cache: ProxyCache.allowed(page: page)), .file(mine, type: "video/mp4"))
        }
        site.answer = { _ in (401, "{}") }
        let refused = await ProxyCache.account(Site(base: site.url, cookies: []))
        XCTAssertNil(refused.name)
        XCTAssertNil(ProxyCache.allowed(page: page))
    }

    /// Only a file in the page's server's proxy cache asks for the account: footage that isn't granted is refused at once.
    func testOnlyAFileInTheProxyCacheAsks() throws {
        let server = URL(string: "https://studio.example.com")!
        let page = server.appendingPathComponent("editor/p1")
        XCTAssertTrue(ProxyCache.holds(try proxy(server, "bob", "v2"), page: page))
        XCTAssertFalse(ProxyCache.holds(root.appendingPathComponent("footage/a.mp4").path, page: page))
        XCTAssertFalse(ProxyCache.holds(ProxyCache.root(server: server).path + "-other/bob/v2.mp4", page: page))
        // another server's cache, and a page that is no server's
        XCTAssertFalse(ProxyCache.holds(try proxy(URL(string: "https://other.example.com")!, "bob", "v2"), page: page))
        XCTAssertFalse(ProxyCache.holds(try proxy(server, "bob", "v3"), page: URL(string: "ctlocal://media/x")!))
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

    /// Moving into a folder that has its own cache (its disk came back): the worker's lists are joined, never one dropped
    /// (kept.json protects proxies made here from the size limit), a version already there wins and its copy goes, a
    /// download still being written stays, and a folder inside the one it moves from is refused.
    func testAMoveIntoAFolderWithItsOwnCacheJoinsTheLists() throws {
        let base = ProcessInfo.processInfo.environment["CT_SCRATCH_DIR"].map { URL(fileURLWithPath: $0) } ?? FileManager.default.temporaryDirectory
        let work = base.appendingPathComponent("proxy-move-tests/\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: work) }
        let fm = FileManager.default
        let from = work.appendingPathComponent("default/tiny", isDirectory: true), to = work.appendingPathComponent("ssd/tiny", isDirectory: true)
        for d in [from, to] { try fm.createDirectory(at: d, withIntermediateDirectories: true) }
        try Data(#"["v_new"]"#.utf8).write(to: from.appendingPathComponent("kept.json"))
        try Data(#"["v_old"]"#.utf8).write(to: to.appendingPathComponent("kept.json"))
        try Data(#"{"a":{"w":1,"h":1},"b":{"skip":true}}"#.utf8).write(to: from.appendingPathComponent("made.json"))
        try Data(#"{"a":{"w":2,"h":2}}"#.utf8).write(to: to.appendingPathComponent("made.json"))
        try Data("new".utf8).write(to: from.appendingPathComponent("v_new.mp4"))
        try Data("dup".utf8).write(to: from.appendingPathComponent("v_old.mp4"))
        try Data("old".utf8).write(to: to.appendingPathComponent("v_old.mp4"))
        try Data("going".utf8).write(to: from.appendingPathComponent("v_live.mp4.part"))

        try ProxyCacheMove.move(from: from.deletingLastPathComponent(), to: to.deletingLastPathComponent(), free: { _ in 1 << 30 },
                                busy: { $0.lastPathComponent == "v_live.mp4.part" })
        let json = { (name: String) in try JSONSerialization.jsonObject(with: Data(contentsOf: to.appendingPathComponent(name))) }
        XCTAssertEqual(try json("kept.json") as? [String], ["v_old", "v_new"])
        let made = try XCTUnwrap(try json("made.json") as? [String: [String: Any]])
        XCTAssertEqual(made["a"]?["w"] as? Int, 2)   // the target's entry wins
        XCTAssertEqual(made["b"]?["skip"] as? Bool, true)
        XCTAssertEqual(try String(contentsOf: to.appendingPathComponent("v_old.mp4"), encoding: .utf8), "old")
        XCTAssertEqual(try String(contentsOf: to.appendingPathComponent("v_new.mp4"), encoding: .utf8), "new")
        XCTAssertEqual(try fm.contentsOfDirectory(atPath: from.path), ["v_live.mp4.part"])

        XCTAssertThrowsError(try ProxyCacheMove.move(from: work, to: work.appendingPathComponent("ssd/deeper"))) { error in
            XCTAssertEqual(error as? ProxyCacheMoveError, .inside)
        }
    }
}

/// WebKit's side of one ctlocal request, as the tests see it (answered on the main thread, ProjectScheme.deliver).
final class FakeTask: NSObject, WKURLSchemeTask {
    let request: URLRequest
    var status: Int?
    var bytes = 0
    var finished = false
    var ended: () -> Void = {}
    init(_ url: URL) { request = URLRequest(url: url) }
    func didReceive(_ response: URLResponse) { status = (response as? HTTPURLResponse)?.statusCode }
    func didReceive(_ data: Data) { bytes += data.count }
    func didFinish() { finished = true; ended() }
    func didFailWithError(_ error: Error) { ended() }
}
