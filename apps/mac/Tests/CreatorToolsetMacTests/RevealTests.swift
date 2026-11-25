import Foundation
import XCTest
@testable import CreatorToolsetMac

final class RevealTests: XCTestCase {
    private var root: URL!

    override func setUpWithError() throws {
        let base = ProcessInfo.processInfo.environment["CT_SCRATCH_DIR"].map { URL(fileURLWithPath: $0) } ?? FileManager.default.temporaryDirectory
        root = base.appendingPathComponent("reveal-tests/\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: root.appendingPathComponent("Footage/Day 1"), withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: root.appendingPathComponent("Footagebar"), withIntermediateDirectories: true)
        for f in ["Footage/Day 1/A001.MOV", "Footagebar/B001.MOV", "secret.txt"] { try Data("x".utf8).write(to: root.appendingPathComponent(f)) }
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: root)
    }

    private func path(_ relative: String) -> String { root.appendingPathComponent(relative).path }

    func testACopysFolderIsShownOnlyWithItsOwnMarker() throws {
        let folder = root.appendingPathComponent("Copy of the library")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        XCTAssertNil(Reveal.copyFolder(folder.path, library: "lib", copy: "cp1"), "no marker")
        try LibraryCopyJob.writeMarker(CopyMarker(library: "lib", copy: "cp1", files: [:]), folder)
        XCTAssertNotNil(Reveal.copyFolder(folder.path, library: "lib", copy: "cp1"))
        XCTAssertNil(Reveal.copyFolder(folder.path, library: "lib", copy: "cp2"), "another copy's marker")
        XCTAssertNil(Reveal.copyFolder(path("gone"), library: "lib", copy: "cp1"))
        XCTAssertNil(Reveal.copyFolder(path("secret.txt"), library: "lib", copy: "cp1"), "a file is not a folder")
        XCTAssertNil(Reveal.copyFolder("Copy of the library", library: "lib", copy: "cp1"), "relative")

        let ask = #"reveal:{"library":"lib","copy":"cp1","path":"/Volumes/Tiny Acrobatics/Copy"}"#
        XCTAssertEqual(copyRevealAsk(ask)?.path, "/Volumes/Tiny Acrobatics/Copy")
        XCTAssertNil(revealAsk(ask), "not a clip's ask")
        XCTAssertNil(copyRevealAsk(#"reveal:{"library":"lib","asset":"a1"}"#))
    }

    func testASettingsFolderIsShownOnlyWhenTheServerListsItAsThisMacs() throws {
        let ask = #"reveal:{"folder":"/Volumes/Tiny Acrobatics/Exports/Creator Toolset"}"#
        XCTAssertEqual(folderRevealAsk(ask), "/Volumes/Tiny Acrobatics/Exports/Creator Toolset")
        XCTAssertNil(copyRevealAsk(ask), "not a copy's ask")
        XCTAssertNil(revealAsk(ask), "not a clip's ask")
        XCTAssertNil(folderRevealAsk(#"reveal:{"folder":""}"#))
        XCTAssertNil(folderRevealAsk(#"reveal:{"library":"lib","copy":"cp1","path":"/x"}"#))

        let json = #"{"folders":[{"id":"lib","role":"library","origin":{"host":"mac-1","path":"\#(path("Exports"))"}},"#
            + #"{"id":"m1","role":"footage","origin":{"host":"mac-1","path":"\#(path("Footage"))"}},"#
            + #"{"id":"m2","role":"footage","origin":{"host":"pc-2","path":"\#(path("Footagebar"))"}}]}"#
        struct List: Decodable { let folders: [ListedFolder] }
        let folders = try JSONDecoder().decode(List.self, from: Data(json.utf8)).folders
        let listed = Reveal.ownFolders(folders, hosts: ["mac-1"])
        XCTAssertEqual(listed, [path("Exports"), path("Exports/Footage"), path("Exports/Finished"), path("Footage")])

        XCTAssertNotNil(Reveal.listedFolder(path("Footage"), listed: listed))
        XCTAssertNil(Reveal.listedFolder(path("Footagebar"), listed: listed), "another computer's folder")
        XCTAssertNil(Reveal.listedFolder(path("Footage/Day 1"), listed: listed), "not a listed folder")
        XCTAssertNil(Reveal.listedFolder(path("Exports"), listed: listed), "listed, not on this Mac's disk")
        XCTAssertNil(Reveal.listedFolder(path("secret.txt"), listed: [path("secret.txt")]), "a file is not a folder")
        XCTAssertNil(Reveal.listedFolder(path("Footage/../Footagebar"), listed: [path("Footage/../Footagebar")]), "no .. parts")
        XCTAssertNil(Reveal.listedFolder("Footage", listed: ["Footage"]), "relative")
    }

    func testAServerElsewhereShowsAnExistingMediaFileWithNoFolderGranted() throws {
        XCTAssertNotNil(Reveal.check(path("Footage/Day 1/A001.MOV"), anyFile: false))
        XCTAssertNotNil(Reveal.check(path("Footagebar/B001.MOV"), anyFile: false))
        XCTAssertNil(Reveal.check(path("secret.txt"), anyFile: false))   // not a video, sound or picture file
        XCTAssertNil(Reveal.check(path("Footage/Day 1/gone.MOV"), anyFile: false))
        XCTAssertNil(Reveal.check(path("Footage/Day 1"), anyFile: false))   // a folder is not a clip
        XCTAssertNil(Reveal.check(path("Footage/../Footagebar/B001.MOV"), anyFile: false))
        XCTAssertNil(Reveal.check("Footage/Day 1/A001.MOV", anyFile: false))   // relative
    }

    func testTheServerOnThisMacNamesAnyExistingFile() {
        XCTAssertNotNil(Reveal.check(path("secret.txt"), anyFile: true))
        XCTAssertNil(Reveal.check(path("gone.MOV"), anyFile: true))
        XCTAssertNil(Reveal.check(path("Footage"), anyFile: true))
        XCTAssertNil(Reveal.check(path("Footage/../secret.txt"), anyFile: true))
    }

    func testALinkNamedLikeAVideoToAnotherFileIsRefused() throws {
        try FileManager.default.createSymbolicLink(atPath: path("Footage/link.MOV"), withDestinationPath: path("secret.txt"))
        XCTAssertNil(Reveal.check(path("Footage/link.MOV"), anyFile: false))
    }

    func testReadsTheAsk() {
        XCTAssertEqual(revealAsk(#"reveal:{"library":"lib_1","asset":"b94200d6-3321"}"#)?.asset, "b94200d6-3321")
        XCTAssertNil(revealAsk(#"reveal:{"library":"../x","asset":"a1"}"#))
        XCTAssertNil(revealAsk(#"reveal:{"library":"lib_1","asset":"a/../b"}"#))
        XCTAssertNil(revealAsk(#"reveal:{"library":"lib_1"}"#))
        XCTAssertNil(revealAsk("reveal:/a/b.MOV"))
        XCTAssertEqual(revealAsk(#"reveal:{"library":"lib_1","asset":"a1","version":"v_2"}"#)?.version, "v_2")
        XCTAssertNil(revealAsk(#"reveal:{"library":"lib_1","asset":"a1"}"#)?.version)
        XCTAssertNil(revealAsk(#"reveal:{"library":"lib_1","asset":"a1","version":"../v"}"#))
        XCTAssertEqual(reviewRevealAsk(#"reveal:{"review":"b94200d6-3321","v":2}"#)?.n, 2)
        XCTAssertNil(reviewRevealAsk(#"reveal:{"review":"../x","v":2}"#))
        XCTAssertNil(reviewRevealAsk(#"reveal:{"review":"b94200d6","v":0}"#))
        XCTAssertNil(reviewRevealAsk(#"reveal:{"library":"lib_1","asset":"a1"}"#))
        XCTAssertNil(revealAsk(#"reveal:{"review":"b94200d6","v":2}"#))
    }
}
