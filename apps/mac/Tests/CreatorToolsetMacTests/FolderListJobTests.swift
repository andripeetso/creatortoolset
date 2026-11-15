import XCTest
@testable import CreatorToolsetMac

/// The assistant's folder listing on this Mac: the walk (levels, hidden entries, packages, the depth), what is refused,
/// and a whole job against a stand-in server.
final class FolderListJobTests: XCTestCase {
    private func folder() throws -> URL {
        let dir = testFolder("folder-list")
        addTeardownBlock { try? FileManager.default.removeItem(at: dir) }
        for p in ["SHOOT/clip.mov", "SHOOT/FOOTAGE/MUSIC/theme.m4a", "SHOOT/.hidden", "SHOOT/Old.photoslibrary/inside.jpg"] {
            let url = dir.appendingPathComponent(p)
            try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            try Data("abc".utf8).write(to: url)
        }
        return dir.appendingPathComponent("SHOOT")
    }

    private func offMain<T>(_ work: @escaping () -> T) async -> T {
        await withCheckedContinuation { done in DispatchQueue.global().async { done.resume(returning: work()) } }
    }

    func testTheWalkSeesSubfoldersButNotHiddenEntriesOrInsidePackages() throws {
        let root = try folder()
        let walk = FolderListJob.walk(root.resolvingSymlinksInPath(), depth: 6)
        let paths = (walk["entries"] as! [[String: Any]]).map { $0["path"] as! String }
        XCTAssertEqual(Set(paths), ["FOOTAGE", "Old.photoslibrary", "clip.mov", "FOOTAGE/MUSIC", "FOOTAGE/MUSIC/theme.m4a"])
        let shallow = FolderListJob.walk(root.resolvingSymlinksInPath(), depth: 2)
        XCTAssertEqual(shallow["deeper"] as? Int, 1, "MUSIC is past two levels")
    }

    func testAWholeDiskOrHomeFolderIsRefused() {
        XCTAssertNotNil(FolderListJob.refused("/", drive: true))
        XCTAssertNotNil(FolderListJob.refused(FileManager.default.homeDirectoryForCurrentUser.path, drive: true))
        XCTAssertNotNil(FolderListJob.refused("/Users", drive: true))
        XCTAssertNotNil(FolderListJob.refused("relative/path", drive: false))
    }

    func testALockedFolderIsSaidToBeUnreadableNeverShownEmpty() throws {
        let root = try folder()
        let locked = root.appendingPathComponent("FOOTAGE")
        try FileManager.default.setAttributes([.posixPermissions: 0], ofItemAtPath: locked.path)
        addTeardownBlock { try? FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: locked.path) }
        XCTAssertEqual(FolderListJob.walk(root.resolvingSymlinksInPath(), depth: 6)["unreadable"] as? Int, 1)
        XCTAssertEqual(FolderListJob.refused(locked.path, drive: false), "\(locked.path) could not be read on this Mac (no permission to read it).")
    }

    func testAJobSendsTheWalk() async throws {
        let root = try folder()
        let site = FakeSite()
        site.answer = { _ in (200, #"{"ok":true}"#) }
        let job = FolderListJob(api: DeviceAPI(base: site.url, token: "ctd_test"), step: EditorJob(id: 2, kind: folderListKind, options: ["path": root.path, "depth": "6"]))
        let end = await offMain { job.run().end }
        XCTAssertEqual(end, .done)
        let post = site.requests.first { $0.method == "POST" }
        XCTAssertEqual(post?.path, "/api/devices/relay/job/folder-list/2")
        let body = try JSONSerialization.jsonObject(with: post!.body) as? [String: Any]
        XCTAssertTrue((body?["entries"] as? [[String: Any]])?.contains { $0["path"] as? String == "FOOTAGE/MUSIC/theme.m4a" } ?? false)
    }
}
