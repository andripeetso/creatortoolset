import XCTest
@testable import CreatorToolsetMac

// The Download location (UNIFIED-PRD M15) and the Cache folder: read from a throwaway defaults suite, never the person's
// own; the Download location is passed to the worker as CT_PROXY_DIR only when set.
final class DownloadLocationTests: XCTestCase {
    private func suite() -> UserDefaults {
        let name = "ct-download-location-test-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: name)!
        addTeardownBlock { defaults.removePersistentDomain(forName: name) }
        return defaults
    }

    func testNoLocationIsTheDefault() {
        XCTAssertNil(DownloadLocation.path(suite()))
    }

    func testAnEmptyLocationIsNoLocation() {
        let d = suite()
        d.set("", forKey: DownloadLocation.key)
        XCTAssertNil(DownloadLocation.path(d))
    }

    func testTheChosenFolderIsReadWhileItsDiskIsConnected() {
        let d = suite()
        d.set("/Volumes/SSD/Downloads", forKey: DownloadLocation.key)
        XCTAssertEqual(DownloadLocation.path(d, mounted: ["/", "/Volumes/SSD"]), "/Volumes/SSD/Downloads")
        // unplugged: the default, never a folder made under /Volumes on the internal disk
        XCTAssertNil(DownloadLocation.path(d, mounted: ["/", "/Volumes/SSD2"]))
        d.set("/Users/sam/Downloads", forKey: DownloadLocation.key)
        XCTAssertEqual(DownloadLocation.path(d, mounted: []), "/Users/sam/Downloads")
    }

    func testTheWorkerGetsTheFolderOnlyWhenChosen() {
        let server = URL(string: "https://studio.example.com")!
        let data = URL(fileURLWithPath: "/x/relay/studio.example.com/work")
        let app = URL(fileURLWithPath: "/Applications/Creator Toolset.app/Contents/Resources/server")
        func env(_ proxyDir: String?) -> [String: String] {
            workerEnvironment(server: server, token: "ctd_abc", data: data, folder: app, inherited: [:], plugins: [:], proxyDir: proxyDir)
        }
        XCTAssertNil(env(nil)["CT_PROXY_DIR"])
        XCTAssertNil(env("")["CT_PROXY_DIR"])
        XCTAssertEqual(env("/Volumes/SSD/Downloads/studio.example.com")["CT_PROXY_DIR"], "/Volumes/SSD/Downloads/studio.example.com")
    }

    // The Cache folder (Settings → Storage › This computer): the pick while its disk is there, else the largest external
    // disk that holds a folder this app already reads (never a share or the internal disk), else none.
    func testTheCacheFolderDefaultsToTheLargestExternalDiskInUse() {
        let d = suite()
        let ssd = CacheFolder.Volume(path: "/Volumes/SSD", bytes: 2_000), card = CacheFolder.Volume(path: "/Volumes/CARD", bytes: 64)
        let nas = CacheFolder.Volume(path: "/Volumes/NAS", bytes: 90_000, external: false)
        let big = CacheFolder.Volume(path: "/Volumes/Big", bytes: 8_000)   // nothing of this app on it: macOS would ask
        let used = ["/Volumes/SSD/Footage", "/Volumes/CARD", "/Volumes/NAS/Team", "/Volumes/SSDx/a"]
        func path(_ volumes: [CacheFolder.Volume]) -> String? { CacheFolder.path(d, volumes: { volumes }, used: used, mounted: volumes.map(\.path)) }
        XCTAssertNil(path([]))
        XCTAssertNil(path([nas, big]))
        XCTAssertEqual(path([card, nas, ssd, big]), "/Volumes/SSD/Creator Toolset Cache")
        d.set("/Volumes/NAS/cache", forKey: CacheFolder.key)
        XCTAssertEqual(path([card, nas, ssd]), "/Volumes/NAS/cache")   // a share he picked himself
        XCTAssertEqual(path([card, ssd]), "/Volumes/SSD/Creator Toolset Cache")
        XCTAssertNil(path([]))
    }

    // The caches go to the Download location: its default once every cache fits, and anything left in a default folder
    // (a move that failed, downloads while its disk was away) the next time.
    func testTheCachesSettleInTheDownloadLocation() throws {
        let base = ProcessInfo.processInfo.environment["CT_SCRATCH_DIR"].map { URL(fileURLWithPath: $0) } ?? FileManager.default.temporaryDirectory
        let root = base.appendingPathComponent("download-location-tests/\(UUID().uuidString)", isDirectory: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: root) }
        let relay = ProxyCache.relay
        ProxyCache.relay = { root.appendingPathComponent("relay").appendingPathComponent(relayFolder(for: $0, localData: nil).lastPathComponent) }
        addTeardownBlock { ProxyCache.relay = relay }
        let studio = URL(string: "https://studio.example.com")!, other = URL(string: "http://10.0.0.5:3000")!
        func file(_ server: URL, _ name: String) throws -> URL {
            let f = ProxyCache.root(server: server, location: nil).appendingPathComponent("tiny/\(name)")
            try FileManager.default.createDirectory(at: f.deletingLastPathComponent(), withIntermediateDirectories: true)
            try Data(repeating: 7, count: 100).write(to: f)
            return f
        }
        let fm = FileManager.default
        let a = try file(studio, "v1.mp4"), b = try file(other, "v2.original")
        let relays = [ProxyCache.relay(studio), ProxyCache.relay(other)]
        let disk = root.appendingPathComponent("SSD", isDirectory: true)
        let ssd = CacheFolder.Volume(path: disk.path, bytes: 2_000)
        let used = [disk.appendingPathComponent("Footage").path]
        let to = disk.appendingPathComponent("Creator Toolset Downloads")

        let d = suite()
        func settle(volumes: [CacheFolder.Volume] = [ssd], used: [String] = used, free: @escaping (URL) -> Int64?) -> Bool {
            DownloadLocation.settle(defaults: d, volumes: { volumes }, used: used, mounted: [], relays: relays, free: free)
        }
        XCTAssertFalse(settle(volumes: [], free: { _ in 1 << 40 }))
        XCTAssertFalse(settle(used: [], free: { _ in 1 << 40 }))   // a disk this app doesn't read yet: never picked
        XCTAssertFalse(settle(free: { _ in 150 }))   // each fits, both don't: nothing taken, nothing moved
        XCTAssertNil(d.string(forKey: DownloadLocation.key))
        XCTAssertTrue(fm.fileExists(atPath: a.path) && fm.fileExists(atPath: b.path))

        // taken; the second server's move fails (its disk filled meanwhile): the first is there, the second stays put
        XCTAssertTrue(settle(free: { $0.lastPathComponent == "10.0.0.5-3000" ? 10 : 1 << 40 }))
        XCTAssertEqual(d.string(forKey: DownloadLocation.key), to.path)
        let movedA = ProxyCache.root(server: studio, location: to.path).appendingPathComponent("tiny/v1.mp4")
        let movedB = ProxyCache.root(server: other, location: to.path).appendingPathComponent("tiny/v2.original")
        XCTAssertTrue(fm.fileExists(atPath: movedA.path) && !fm.fileExists(atPath: a.path))
        XCTAssertTrue(fm.fileExists(atPath: b.path) && !fm.fileExists(atPath: movedB.path))
        // the next time it joins the others, each server in its own folder
        XCTAssertTrue(settle(free: { _ in 1 << 40 }))
        XCTAssertTrue(fm.fileExists(atPath: movedB.path) && !fm.fileExists(atPath: b.path))
        XCTAssertEqual(ProxyCache.root(server: other, location: to.path).path, "\(to.path)/10.0.0.5-3000")
        // a download made in a default folder later (its disk was away) joins too; never another disk once one is taken
        let c = try file(studio, "v3.mp4")
        XCTAssertTrue(settle(volumes: [.init(path: "/Volumes/Bigger", bytes: 9_000)], used: ["/Volumes/Bigger/x"], free: { _ in 1 << 40 }))
        XCTAssertEqual(d.string(forKey: DownloadLocation.key), to.path)
        XCTAssertFalse(fm.fileExists(atPath: c.path))
        XCTAssertFalse(settle(free: { _ in 1 << 40 }))   // nothing left to move
    }
}
