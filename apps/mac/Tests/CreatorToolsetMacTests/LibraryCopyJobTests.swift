import CryptoKit
import Foundation
import XCTest
@testable import CreatorToolsetMac

final class LibraryCopyJobTests: XCTestCase {
    private func folder() throws -> URL {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("copy-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: root) }
        return root.resolvingSymlinksInPath()
    }

    private func offMain<T>(_ work: @escaping () -> T) async -> T {
        await withCheckedContinuation { done in DispatchQueue.global().async { done.resume(returning: work()) } }
    }

    private func sha(_ d: Data) -> String { SHA256.hash(data: d).map { String(format: "%02x", $0) }.joined() }

    private func marker(_ root: URL) throws -> CopyMarker {
        try JSONDecoder().decode(CopyMarker.self, from: Data(contentsOf: root.appendingPathComponent(CopyMarker.name)))
    }

    private func body(_ r: FakeSite.Request) -> [String: Any] {
        (try? JSONSerialization.jsonObject(with: r.body)) as? [String: Any] ?? [:]
    }

    private func exists(_ url: URL) -> Bool { FileManager.default.fileExists(atPath: url.path) }

    /// A lock exactly as the Linux helper writes it, its time on the share `age` seconds ago.
    private func helperLock(_ root: URL, age: TimeInterval = 0) throws {
        let file = root.appendingPathComponent(LibraryCopyJob.lockName)
        try Data("{\"device\": \"dev-helper\", \"at\": \(Int(Date().timeIntervalSince1970 - age))}".utf8).write(to: file)
        try FileManager.default.setAttributes([.modificationDate: Date().addingTimeInterval(-age)], ofItemAtPath: file.path)
    }

    // MARK: the layout

    func testNamesBesideAndOlderVersions() {
        let free = { (rel: String, taken: (String) -> Bool) in LibraryCopyJob.free(rel, device: "dev-mac", taken: taken) }
        XCTAssertEqual(free("Interviews/Kitchen take 3.mov", { _ in false }), "Interviews/Kitchen take 3.mov")
        let taken: Set = ["Interviews/Kitchen take 3.mov", "Interviews/Kitchen take 3 2.mov"]
        XCTAssertEqual(free("Interviews/Kitchen take 3.mov", taken.contains), "Interviews/Kitchen take 3 3.mov")
        XCTAssertEqual(free("Unsorted", { $0 == "Unsorted" }), "Unsorted 2")
        XCTAssertEqual(LibraryCopyJob.versionRel("Interviews/Kitchen take 3.mov", n: 1), ".versions/Interviews/Kitchen take 3 v1.mov")
        XCTAssertEqual(LibraryCopyJob.versionRel("Unsorted clip.mov", n: 2), ".versions/Unsorted clip v2.mov")
        XCTAssertTrue(LibraryCopyJob.isRel("Interviews/Kitchen take 3.mov"))
        for bad in ["", "/etc/x", "a/../b", "a//b", "./a", "a/"] { XCTAssertFalse(LibraryCopyJob.isRel(bad), bad) }
    }

    func testNamesFitAndAreClean() {
        let long = "a/" + String(repeating: "ä", count: 200) + ".mov"   // 400 bytes of stem
        let first = LibraryCopyJob.free(long, device: "dev-mac", taken: { _ in false })
        let second = LibraryCopyJob.free(long, device: "dev-mac", taken: { $0 == first })
        for rel in [first, second] {
            let name = (rel as NSString).lastPathComponent
            XCTAssertLessThanOrEqual(".\(name).dev-mac.partial".utf8.count, 255, name)
            XCTAssertGreaterThan(".\(name).dev-mac.partial".utf8.count, 250, "trimmed no more than it must")
        }
        XCTAssertTrue(second.hasSuffix(" 2.mov"))
        XCTAssertEqual(LibraryCopyJob.clean("Takes\\one.mov"), "Takes_one.mov")
        XCTAssertEqual(LibraryCopyJob.clean("Cafe\u{301}.mov").unicodeScalars.map(\.value), "Caf\u{e9}.mov".unicodeScalars.map(\.value))
    }

    func testTheMarkerDecidesWhoseFolderItIs() {
        let mine = CopyMarker(library: "lib", copy: "cp1", files: ["v1": .init(asset: "a", n: 1, rel: "x.mov", size: 3, sha256: "")])
        let d = { (m: CopyMarker?, unreadable: Bool, present: Bool, initial: Bool) in
            LibraryCopyJob.decide(found: m, unreadable: unreadable, present: present, library: "lib", copy: "cp1", initial: initial)
        }
        XCTAssertNil(d(nil, false, false, true), "a disk not mounted: reconnect, never a folder made in its place")
        XCTAssertNil(d(nil, false, true, false), "no marker and not the first job")
        XCTAssertEqual(d(nil, false, true, true)?.write, true)
        XCTAssertEqual(d(mine, false, true, false)?.write, false)
        XCTAssertNil(d(nil, true, true, true), "an unreadable marker is never written over")
        var other = mine
        other.copy = "cp0"
        XCTAssertNil(d(other, false, true, false), "another copy's marker")
        XCTAssertEqual(d(other, false, true, true)?.marker, CopyMarker(library: "lib", copy: "cp1", files: mine.files), "the same library's: its files kept")
        other.library = "lib2"
        XCTAssertNil(d(other, false, true, true), "another library's folder")
    }

    func testOneWriterAFolder() throws {
        let root = try folder()
        let lockFile = root.appendingPathComponent(LibraryCopyJob.lockName)
        XCTAssertTrue(LibraryCopyJob.lease(root, device: "dev-mac"))
        XCTAssertTrue(LibraryCopyJob.lease(root, device: "dev-mac"))
        let written = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: lockFile)) as? [String: Any])
        XCTAssertEqual(Set(written.keys), ["device", "at"], "the helper reads exactly these")
        XCTAssertEqual(written["device"] as? String, "dev-mac")
        XCTAssertEqual(Double(written["at"] as? Int ?? 0), Date().timeIntervalSince1970, accuracy: 5)
        XCTAssertFalse(LibraryCopyJob.lease(root, device: "dev-other"))
        LibraryCopyJob.unlease(root, device: "dev-other")
        XCTAssertTrue(exists(lockFile), "only its own lease is let go")
        LibraryCopyJob.unlease(root, device: "dev-mac")
        XCTAssertFalse(exists(lockFile))

        // the helper's lock: fresh by its time on the share, whatever its `at`
        try helperLock(root)
        XCTAssertFalse(LibraryCopyJob.lease(root, device: "dev-mac"))
        XCTAssertFalse(LibraryCopyJob.beat(root, device: "dev-mac"), "a beat never takes someone else's lock")
        try helperLock(root, age: 11 * 60)
        XCTAssertTrue(LibraryCopyJob.lease(root, device: "dev-mac"), "stale after 10 minutes on the share")
        XCTAssertTrue(LibraryCopyJob.beat(root, device: "dev-mac"))
        // a lock that is not { device, at } is another writer's
        try Data("helper 1234\n".utf8).write(to: lockFile)
        XCTAssertFalse(LibraryCopyJob.lease(root, device: "dev-mac"))
        XCTAssertFalse(LibraryCopyJob.beat(root, device: "dev-mac"))
    }

    // MARK: jobs against a stand-in server

    private func job(_ site: FakeSite, _ options: [String: String], id: Int = 7, granted: [String] = []) -> LibraryCopyJob {
        LibraryCopyJob(api: DeviceAPI(base: site.url, token: "ctd_test"), step: EditorJob(id: id, kind: libraryCopyKind, options: options), granted: granted)
    }

    private func copyOptions(_ root: URL, _ data: Data, rel: String = "Interviews/Kitchen take 3.mov", key: String = "ver2", n: Int = 2) -> [String: String] {
        ["op": "copy", "device": "dev-mac", "copy": "cp1", "library": "lib", "root": root.path, "key": key, "asset": "a1", "n": String(n), "rel": rel,
         "size": String(data.count), "sha256": sha(data), "paths": "[]", "url": "/api/devices/relay/job/copy/7/file"]
    }

    private func done(_ site: FakeSite) -> [String: Any]? { site.requests.compactMap { body($0)["done"] as? [String: Any] }.first }

    func testAFirstCheckWritesTheMarkerSweepsOwnPartialsAndReportsGoneFiles() async throws {
        let root = try folder()
        try FileManager.default.createDirectory(at: root.appendingPathComponent("Interviews"), withIntermediateDirectories: true)
        try Data("half".utf8).write(to: root.appendingPathComponent("Interviews/.take.mov.dev-mac.partial"))
        try Data("theirs".utf8).write(to: root.appendingPathComponent("Interviews/.take.mov.dev-helper.partial"))
        try Data("abc".utf8).write(to: root.appendingPathComponent("Interviews/kept.mov"))
        let old = CopyMarker(library: "lib", copy: "cp0", files: [
            "v1": .init(asset: "a1", n: 1, rel: "Interviews/kept.mov", size: 3, sha256: ""),
            "v2": .init(asset: "a2", n: 1, rel: "Interviews/gone.mov", size: 3, sha256: ""),
        ])
        try LibraryCopyJob.writeMarker(old, root)
        let site = FakeSite()
        let check = ["op": "check", "device": "dev-mac", "copy": "cp1", "library": "lib", "root": root.path, "init": "1"]
        let end = await offMain { [self] in job(site, check).run() }
        XCTAssertEqual(end, .done)
        XCTAssertEqual(try marker(root).copy, "cp1")
        XCTAssertFalse(exists(root.appendingPathComponent("Interviews/.take.mov.dev-mac.partial")))
        XCTAssertTrue(exists(root.appendingPathComponent("Interviews/.take.mov.dev-helper.partial")), "another computer's partial is never touched")
        XCTAssertTrue(exists(root.appendingPathComponent("Interviews/kept.mov")))
        XCTAssertEqual(body(site.requests[0])["gone"] as? [String], ["v2"])
        XCTAssertNotNil(body(site.requests[0])["free"])
        XCTAssertFalse(exists(root.appendingPathComponent(LibraryCopyJob.lockName)), "the lease is let go")

        // a later check of another copy id finds the folder is not its own
        var wrong = check
        wrong["copy"] = "cp9"
        wrong["init"] = nil
        _ = await offMain { [self] in job(site, wrong, id: 8).run() }
        XCTAssertEqual(body(site.requests[1])["state"] as? String, "reconnect")
        // and a folder that is not there (a disk not mounted) is never made
        var away = check
        away["root"] = root.appendingPathComponent("not mounted").path
        _ = await offMain { [self] in job(site, away, id: 9).run() }
        XCTAssertEqual(body(site.requests[2])["state"] as? String, "reconnect")
        XCTAssertFalse(FileManager.default.fileExists(atPath: away["root"]!))
    }

    func testAJobFromAnOlderServerFails() async throws {
        let root = try folder()
        let site = FakeSite()
        var options = copyOptions(root, Data("x".utf8))
        options["device"] = nil
        let end = await offMain { [self] in job(site, options).run() }
        guard case .failed(let why) = end else { return XCTFail("\(end)") }
        XCTAssertTrue(why.contains("older"), why)
        XCTAssertEqual(site.requests.map(\.path), ["/api/devices/relay/job/copy/7/fail"])
    }

    func testANewerVersionMovesTheOlderOneAndTakesItsPath() async throws {
        let root = try folder()
        let v1 = Data("first take".utf8), v2 = Data("second, longer take".utf8)
        try FileManager.default.createDirectory(at: root.appendingPathComponent("Interviews"), withIntermediateDirectories: true)
        try v1.write(to: root.appendingPathComponent("Interviews/Kitchen take 3.mov"))
        try LibraryCopyJob.writeMarker(CopyMarker(library: "lib", copy: "cp1", files: [
            "ver1": .init(asset: "a1", n: 1, rel: "Interviews/Kitchen take 3.mov", size: Int64(v1.count), sha256: sha(v1)),
        ]), root)
        let site = FakeSite()
        // another computer adds a file to the marker while this job runs: it is kept
        site.bytes = { [self] r in
            guard r.method == "GET" else { return nil }
            var m = try! marker(root)
            m.files["other"] = .init(asset: "a9", n: 1, rel: "Other.mov", size: 1, sha256: "")
            try! LibraryCopyJob.writeMarker(m, root)
            return v2
        }
        var options = copyOptions(root, v2)
        options["prev"] = "Interviews/Kitchen take 3.mov"
        let end = await offMain { [self] in job(site, options).run() }
        XCTAssertEqual(end, .done)
        XCTAssertEqual(try Data(contentsOf: root.appendingPathComponent("Interviews/Kitchen take 3.mov")), v2)
        XCTAssertEqual(try Data(contentsOf: root.appendingPathComponent(".versions/Interviews/Kitchen take 3 v1.mov")), v1)
        let m = try marker(root)
        XCTAssertEqual(m.files["ver1"]?.rel, ".versions/Interviews/Kitchen take 3 v1.mov")
        XCTAssertEqual(m.files["ver2"], .init(asset: "a1", n: 2, rel: "Interviews/Kitchen take 3.mov", size: Int64(v2.count), sha256: sha(v2)))
        XCTAssertNotNil(m.files["other"], "the marker is read again before each write")
        let get = try XCTUnwrap(site.requests.first { $0.method == "GET" })
        XCTAssertEqual(get.headers["authorization"], "Bearer ctd_test")
        let d = try XCTUnwrap(done(site))
        XCTAssertEqual(d["rel"] as? String, "Interviews/Kitchen take 3.mov")
        XCTAssertEqual(d["sha256"] as? String, sha(v2))
        XCTAssertEqual(d["size"] as? Int, v2.count)
    }

    func testAPersonsOwnFileStaysAndTheSameFileCountsAsCopied() async throws {
        let root = try folder()
        let clip = Data("the clip".utf8)
        try LibraryCopyJob.writeMarker(CopyMarker(library: "lib", copy: "cp1", files: [:]), root)
        try Data("their own".utf8).write(to: root.appendingPathComponent("Unsorted clip.mov"))
        try clip.write(to: root.appendingPathComponent("Same.mov"))
        let site = FakeSite()
        site.bytes = { $0.method == "GET" ? clip : nil }

        _ = await offMain { [self] in job(site, copyOptions(root, clip, rel: "Unsorted clip.mov", key: "k1", n: 1)).run() }
        XCTAssertEqual(try Data(contentsOf: root.appendingPathComponent("Unsorted clip.mov")), Data("their own".utf8))
        XCTAssertEqual(try Data(contentsOf: root.appendingPathComponent("Unsorted clip 2.mov")), clip)
        XCTAssertEqual(try marker(root).files["k1"]?.rel, "Unsorted clip 2.mov")

        site.forget()
        _ = await offMain { [self] in job(site, copyOptions(root, clip, rel: "Same.mov", key: "k2", n: 1), id: 8).run() }
        XCTAssertFalse(site.requests.contains { $0.method == "GET" }, "nothing fetched for a file already there")
        XCTAssertEqual(done(site)?["rel"] as? String, "Same.mov")
        XCTAssertFalse(exists(root.appendingPathComponent("Same 2.mov")))
    }

    func testNoHashNoAdoption() async throws {
        let root = try folder()
        let clip = Data("the clip".utf8)
        try LibraryCopyJob.writeMarker(CopyMarker(library: "lib", copy: "cp1", files: [:]), root)
        try Data("same len".utf8).write(to: root.appendingPathComponent("a.mov"))   // a person's file, the clip's size
        let site = FakeSite()
        site.bytes = { $0.method == "GET" ? clip : nil }
        var options = copyOptions(root, clip, rel: "a.mov", key: "k", n: 1)
        options["sha256"] = nil
        _ = await offMain { [self] in job(site, options).run() }
        XCTAssertEqual(try Data(contentsOf: root.appendingPathComponent("a.mov")), Data("same len".utf8))
        XCTAssertEqual(try Data(contentsOf: root.appendingPathComponent("a 2.mov")), clip)
        XCTAssertEqual(done(site)?["rel"] as? String, "a 2.mov")

        // with no hash, the source itself (a path in `paths`) is taken as copied
        site.forget()
        var source = copyOptions(root, clip, rel: "a 2.mov", key: "k3", n: 1)
        source["sha256"] = nil
        source["paths"] = String(data: try JSONSerialization.data(withJSONObject: [root.appendingPathComponent("a 2.mov").path]), encoding: .utf8)
        _ = await offMain { [self] in job(site, source, id: 8).run() }
        XCTAssertFalse(site.requests.contains { $0.method == "GET" })
        XCTAssertEqual(done(site)?["rel"] as? String, "a 2.mov")
    }

    func testAnNFDNameOnDiskIsTheSameName() async throws {
        let root = try folder()
        let clip = Data("the clip".utf8)
        try LibraryCopyJob.writeMarker(CopyMarker(library: "lib", copy: "cp1", files: [:]), root)
        try clip.write(to: root.appendingPathComponent("Cafe\u{301}.mov"))
        let site = FakeSite()
        site.bytes = { $0.method == "GET" ? clip : nil }
        _ = await offMain { [self] in job(site, copyOptions(root, clip, rel: "Caf\u{e9}.mov", key: "k", n: 1)).run() }
        XCTAssertFalse(site.requests.contains { $0.method == "GET" })
        XCTAssertEqual(done(site)?["rel"] as? String, "Caf\u{e9}.mov")
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: root.path).filter { $0.hasSuffix(".mov") }.count, 1)
    }

    func testAPartialIsResumedWithARange() async throws {
        let root = try folder()
        let clip = Data((0..<5000).map { UInt8($0 % 251) })
        try LibraryCopyJob.writeMarker(CopyMarker(library: "lib", copy: "cp1", files: [:]), root)
        try clip.prefix(2000).write(to: root.appendingPathComponent(".a.mov.dev-mac.partial"))
        let site = FakeSite()
        site.answer = { $0.headers["range"] == "bytes=2000-" ? (206, "") : (200, "{}") }
        site.bytes = { $0.method != "GET" ? nil : $0.headers["range"] == "bytes=2000-" ? clip.suffix(from: 2000) : clip }
        let end = await offMain { [self] in job(site, copyOptions(root, clip, rel: "a.mov", key: "k", n: 1)).run() }
        XCTAssertEqual(end, .done)
        XCTAssertEqual(try Data(contentsOf: root.appendingPathComponent("a.mov")), clip)
        XCTAssertFalse(exists(root.appendingPathComponent(".a.mov.dev-mac.partial")))
    }

    func testAServerThatIgnoresTheRangeStartsThePartialOver() async throws {
        let root = try folder()
        let clip = Data((0..<5000).map { UInt8($0 % 251) })
        try LibraryCopyJob.writeMarker(CopyMarker(library: "lib", copy: "cp1", files: [:]), root)
        try clip.prefix(2000).write(to: root.appendingPathComponent(".a.mov.dev-mac.partial"))
        let site = FakeSite()
        site.bytes = { $0.method == "GET" ? clip : nil }   // 200 and the whole file, Range or not
        let end = await offMain { [self] in job(site, copyOptions(root, clip, rel: "a.mov", key: "k", n: 1)).run() }
        XCTAssertEqual(site.requests.first { $0.method == "GET" }?.headers["range"], "bytes=2000-")
        XCTAssertEqual(end, .done)
        XCTAssertEqual(try Data(contentsOf: root.appendingPathComponent("a.mov")), clip)
    }

    func testAFolderGoneMidJobAnswersReconnect() async throws {
        let root = try folder()
        let clip = Data("the clip".utf8)
        try LibraryCopyJob.writeMarker(CopyMarker(library: "lib", copy: "cp1", files: [:]), root)
        let site = FakeSite()
        // the disk goes away while the file downloads
        site.bytes = { $0.method == "GET" ? { try? FileManager.default.removeItem(at: root); return clip }() : nil }
        _ = await offMain { [self] in job(site, copyOptions(root, clip, rel: "Interviews/a.mov", key: "k", n: 1)).run() }
        XCTAssertEqual(site.requests.compactMap { body($0)["state"] as? String }, ["reconnect"])
        XCTAssertNil(done(site))
        XCTAssertFalse(exists(root), "the folder itself is never made again")

        // and between jobs: nothing is made at its path
        site.forget()
        _ = await offMain { [self] in job(site, copyOptions(root, clip, rel: "Interviews/a.mov", key: "k", n: 1), id: 8).run() }
        XCTAssertEqual(site.requests.compactMap { body($0)["state"] as? String }, ["reconnect"])
        XCTAssertFalse(exists(root))
    }

    func testAMarkerGoneBeforeTheRenameAnswersReconnect() async throws {
        let root = try folder()
        let clip = Data("the clip".utf8)
        try LibraryCopyJob.writeMarker(CopyMarker(library: "lib", copy: "cp1", files: [:]), root)
        let site = FakeSite()
        site.bytes = { $0.method == "GET" ? { try? FileManager.default.removeItem(at: root.appendingPathComponent(CopyMarker.name)); return clip }() : nil }
        _ = await offMain { [self] in job(site, copyOptions(root, clip, rel: "a.mov", key: "k", n: 1)).run() }
        XCTAssertEqual(site.requests.compactMap { body($0)["state"] as? String }, ["reconnect"])
        XCTAssertFalse(exists(root.appendingPathComponent("a.mov")))
    }

    func testABeatThatFindsAnotherComputersLockStopsTheJob() async throws {
        let root = try folder()
        let clip = Data("the clip".utf8)
        try LibraryCopyJob.writeMarker(CopyMarker(library: "lib", copy: "cp1", files: [:]), root)
        let site = FakeSite()
        site.bytes = { [self] r in
            guard r.method == "GET" else { return nil }
            try? helperLock(root)   // the helper took the folder (this Mac slept past its lease)
            Thread.sleep(forTimeInterval: 1)
            return clip
        }
        var j = job(site, copyOptions(root, clip, rel: "a.mov", key: "k", n: 1))
        j.beatEvery = 0.2
        let end = await offMain { j.run() }
        XCTAssertEqual(end, .gone)
        XCTAssertNil(done(site), "never reported as done")
        XCTAssertFalse(exists(root.appendingPathComponent("a.mov")))
        XCTAssertEqual(LibraryCopyJob.lock(root)?.device, "dev-helper", "its lock is left alone")
    }

    func testAWrongFileIsNeverKept() async throws {
        let root = try folder()
        let clip = Data("the clip".utf8)
        try LibraryCopyJob.writeMarker(CopyMarker(library: "lib", copy: "cp1", files: [:]), root)
        let site = FakeSite()
        site.bytes = { $0.method == "GET" ? Data("the clop".utf8) : nil }
        let end = await offMain { [self] in job(site, copyOptions(root, clip, rel: "a.mov", key: "k", n: 1)).run() }
        guard case .failed = end else { return XCTFail("\(end)") }
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: root.path).sorted(), [CopyMarker.name])
        XCTAssertTrue(site.requests.contains { $0.path == "/api/devices/relay/job/copy/7/fail" })
    }

    // MARK: send

    func testASendPostsTheOriginalsBytes() async throws {
        let root = try folder()
        let clip = Data((0..<70_000).map { UInt8($0 % 253) })
        let original = root.appendingPathComponent("Footage/A001.mov")
        try FileManager.default.createDirectory(at: original.deletingLastPathComponent(), withIntermediateDirectories: true)
        try clip.write(to: original)
        let site = FakeSite()
        let paths = String(data: try JSONSerialization.data(withJSONObject: ["/nowhere/A001.mov", original.path]), encoding: .utf8)!
        let send = ["op": "send", "device": "dev-mac", "key": "ver2", "size": String(clip.count), "paths": paths, "url": "/api/devices/relay/job/copy/7/file"]
        let end = await offMain { [self] in job(site, send, granted: [root.path]).run() }
        XCTAssertEqual(end, .done)
        let post = try XCTUnwrap(site.requests.first { $0.path == "/api/devices/relay/job/copy/7/file" })
        XCTAssertEqual(post.method, "POST")
        XCTAssertEqual(post.headers["authorization"], "Bearer ctd_test")
        XCTAssertEqual(post.body, clip)

        // not at that size any more: the server hears why
        site.forget()
        var moved = send
        moved["size"] = "1"
        _ = await offMain { [self] in job(site, moved, id: 8, granted: [root.path]).run() }
        XCTAssertEqual(site.requests.map(\.path), ["/api/devices/relay/job/copy/8/fail"])
        XCTAssertEqual(body(site.requests[0])["error"] as? String, "The original is not on this Mac any more")
    }
}
