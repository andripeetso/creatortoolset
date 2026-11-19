import XCTest
@testable import CreatorToolsetMac

/// A chat card's folder browser on this Mac: folders only, inside the home folder or a drive, links followed before the check.
final class FolderBrowseJobTests: XCTestCase {
    private func home() throws -> (home: String, outside: String) {
        let dir = testFolder("folder-browse").resolvingSymlinksInPath()
        addTeardownBlock { try? FileManager.default.removeItem(at: dir) }
        let fm = FileManager.default
        for p in ["home/Movies/Shoots", "home/.hidden", "home/Old.photoslibrary", "outside/secret"] {
            try fm.createDirectory(at: dir.appendingPathComponent(p), withIntermediateDirectories: true)
        }
        try Data("abc".utf8).write(to: dir.appendingPathComponent("home/notes.txt"))
        try fm.createSymbolicLink(at: dir.appendingPathComponent("home/escape"), withDestinationURL: dir.appendingPathComponent("outside"))
        return (dir.appendingPathComponent("home").path, dir.appendingPathComponent("outside").path)
    }

    func testListsFoldersOnlyWithoutHiddenOnesPackagesOrLinks() throws {
        let (home, _) = try home()
        let roots = [["name": "Home", "path": home]]
        let got = FolderBrowseJob.browse("~", home: home, roots: roots)
        XCTAssertNil(got.error)
        XCTAssertEqual((got.body?["dirs"] as? [[String: String]])?.map { $0["name"]! }, ["Movies"])
        XCTAssertTrue(got.body?["parent"] is NSNull, "the home folder is a root: nothing above it")
        let inner = FolderBrowseJob.browse("~/Movies", home: home, roots: roots)
        XCTAssertEqual(inner.body?["parent"] as? String, home)
        XCTAssertEqual((inner.body?["dirs"] as? [[String: String]])?.first?["path"], "\(home)/Movies/Shoots")
    }

    func testALinkOutOfTheHomeFolderIsRefusedOnceFollowed() throws {
        let (home, outside) = try home()
        let roots = [["name": "Home", "path": home]]
        XCTAssertEqual(FolderBrowseJob.browse("~/escape", home: home, roots: roots).error, FolderBrowseJob.outside)
        XCTAssertEqual(FolderBrowseJob.browse("\(home)/../outside", home: home, roots: roots).error, FolderBrowseJob.outside)
        XCTAssertEqual(FolderBrowseJob.browse(outside, home: home, roots: roots).error, FolderBrowseJob.outside)
        XCTAssertEqual(FolderBrowseJob.browse("/etc", home: home, roots: roots).error, FolderBrowseJob.outside)
    }
}
