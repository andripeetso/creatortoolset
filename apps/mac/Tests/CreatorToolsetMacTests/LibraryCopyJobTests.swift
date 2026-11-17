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

    // MARK: the layout

    func testNamesBesideAndOlderVersions() {
        XCTAssertEqual(LibraryCopyJob.free("Interviews/Kitchen take 3.mov", taken: { _ in false }), "Interviews/Kitchen take 3.mov")
        let taken: Set = ["Interviews/Kitchen take 3.mov", "Interviews/Kitchen take 3 2.mov"]
        XCTAssertEqual(LibraryCopyJob.free("Interviews/Kitchen take 3.mov", taken: taken.contains), "Interviews/Kitchen take 3 3.mov")
        XCTAssertEqual(LibraryCopyJob.free("Unsorted", taken: { $0 == "Unsorted" }), "Unsorted 2")
        XCTAssertEqual(LibraryCopyJob.versionRel("Interviews/Kitchen take 3.mov", n: 1), ".versions/Interviews/Kitchen take 3 v1.mov")
        XCTAssertEqual(LibraryCopyJob.versionRel("Unsorted clip.mov", n: 2), ".versions/Unsorted clip v2.mov")
        XCTAssertTrue(LibraryCopyJob.isRel("Interviews/Kitchen take 3.mov"))
        for bad in ["", "/etc/x", "a/../b", "a//b", "./a", "a/"] { XCTAssertFalse(LibraryCopyJob.isRel(bad), bad) }
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
        XCTAssertTrue(LibraryCopyJob.lease(root, me: "a 1"))
        XCTAssertTrue(LibraryCopyJob.lease(root, me: "a 1"))
        XCTAssertFalse(LibraryCopyJob.lease(root, me: "b 2"))
        XCTAssertTrue(LibraryCopyJob.lease(root, now: Date().addingTimeInterval(121), me: "b 2"), "stale after two minutes")
        LibraryCopyJob.unlease(root, me: "a 1")
        XCTAssertTrue(FileManager.default.fileExists(atPath: root.appendingPathComponent(LibraryCopyJob.lockName).path), "only its own lease is let go")
        LibraryCopyJob.unlease(root, me: "b 2")
        XCTAssertFalse(FileManager.default.fileExists(atPath: root.appendingPathComponent(LibraryCopyJob.lockName).path))
    }

    // MARK: jobs against a stand-in server

    private func job(_ site: FakeSite, _ options: [String: String], id: Int = 7) -> LibraryCopyJob {
        LibraryCopyJob(api: DeviceAPI(base: site.url, token: "ctd_test"), step: EditorJob(id: id, kind: libraryCopyKind, options: options), granted: [])
    }

    private func copyOptions(_ root: URL, _ data: Data, rel: String = "Interviews/Kitchen take 3.mov", key: String = "ver2", n: Int = 2) -> [String: String] {
        ["op": "copy", "copy": "cp1", "library": "lib", "root": root.path, "key": key, "asset": "a1", "n": String(n), "rel": rel,
         "size": String(data.count), "sha256": sha(data), "paths": "[]", "url": "/api/devices/relay/job/copy/7/file"]
    }

    func testAFirstCheckWritesTheMarkerSweepsPartialsAndReportsGoneFiles() async throws {
        let root = try folder()
        try FileManager.default.createDirectory(at: root.appendingPathComponent("Interviews"), withIntermediateDirectories: true)
        try Data("half".utf8).write(to: root.appendingPathComponent("Interviews/.take.mov.partial"))
        try Data("abc".utf8).write(to: root.appendingPathComponent("Interviews/kept.mov"))
        let old = CopyMarker(library: "lib", copy: "cp0", files: [
            "v1": .init(asset: "a1", n: 1, rel: "Interviews/kept.mov", size: 3, sha256: ""),
            "v2": .init(asset: "a2", n: 1, rel: "Interviews/gone.mov", size: 3, sha256: ""),
        ])
        try LibraryCopyJob.writeMarker(old, root)
        let site = FakeSite()
        let check = ["op": "check", "copy": "cp1", "library": "lib", "root": root.path, "init": "1"]
        let end = await offMain { [self] in job(site, check).run() }
        XCTAssertEqual(end, .done)
        XCTAssertEqual(try marker(root).copy, "cp1")
        XCTAssertFalse(FileManager.default.fileExists(atPath: root.appendingPathComponent("Interviews/.take.mov.partial").path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: root.appendingPathComponent("Interviews/kept.mov").path))
        XCTAssertEqual(body(site.requests[0])["gone"] as? [String], ["v2"])
        XCTAssertNotNil(body(site.requests[0])["free"])

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

    func testANewerVersionMovesTheOlderOneAndTakesItsPath() async throws {
        let root = try folder()
        let v1 = Data("first take".utf8), v2 = Data("second, longer take".utf8)
        try FileManager.default.createDirectory(at: root.appendingPathComponent("Interviews"), withIntermediateDirectories: true)
        try v1.write(to: root.appendingPathComponent("Interviews/Kitchen take 3.mov"))
        try LibraryCopyJob.writeMarker(CopyMarker(library: "lib", copy: "cp1", files: [
            "ver1": .init(asset: "a1", n: 1, rel: "Interviews/Kitchen take 3.mov", size: Int64(v1.count), sha256: sha(v1)),
        ]), root)
        let site = FakeSite()
        site.bytes = { $0.method == "GET" ? v2 : nil }
        var options = copyOptions(root, v2)
        options["prev"] = "Interviews/Kitchen take 3.mov"
        let end = await offMain { [self] in job(site, options).run() }
        XCTAssertEqual(end, .done)
        XCTAssertEqual(try Data(contentsOf: root.appendingPathComponent("Interviews/Kitchen take 3.mov")), v2)
        XCTAssertEqual(try Data(contentsOf: root.appendingPathComponent(".versions/Interviews/Kitchen take 3 v1.mov")), v1)
        let m = try marker(root)
        XCTAssertEqual(m.files["ver1"]?.rel, ".versions/Interviews/Kitchen take 3 v1.mov")
        XCTAssertEqual(m.files["ver2"], .init(asset: "a1", n: 2, rel: "Interviews/Kitchen take 3.mov", size: Int64(v2.count), sha256: sha(v2)))
        let get = try XCTUnwrap(site.requests.first { $0.method == "GET" })
        XCTAssertEqual(get.headers["authorization"], "Bearer ctd_test")
        let done = try XCTUnwrap(site.requests.compactMap { body($0)["done"] as? [String: Any] }.first)
        XCTAssertEqual(done["rel"] as? String, "Interviews/Kitchen take 3.mov")
        XCTAssertEqual(done["sha256"] as? String, sha(v2))
        XCTAssertEqual(done["size"] as? Int, v2.count)
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
        XCTAssertEqual((site.requests.compactMap { body($0)["done"] as? [String: Any] }.first)?["rel"] as? String, "Same.mov")
        XCTAssertFalse(FileManager.default.fileExists(atPath: root.appendingPathComponent("Same 2.mov").path))
    }

    func testAPartialIsResumedWithARange() async throws {
        let root = try folder()
        let clip = Data((0..<5000).map { UInt8($0 % 251) })
        try LibraryCopyJob.writeMarker(CopyMarker(library: "lib", copy: "cp1", files: [:]), root)
        try clip.prefix(2000).write(to: root.appendingPathComponent(".a.mov.partial"))
        let site = FakeSite()
        site.answer = { $0.headers["range"] == "bytes=2000-" ? (206, "") : (200, "{}") }
        site.bytes = { $0.method != "GET" ? nil : $0.headers["range"] == "bytes=2000-" ? clip.suffix(from: 2000) : clip }
        let end = await offMain { [self] in job(site, copyOptions(root, clip, rel: "a.mov", key: "k", n: 1)).run() }
        XCTAssertEqual(end, .done)
        XCTAssertEqual(try Data(contentsOf: root.appendingPathComponent("a.mov")), clip)
        XCTAssertFalse(FileManager.default.fileExists(atPath: root.appendingPathComponent(".a.mov.partial").path))
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
}
