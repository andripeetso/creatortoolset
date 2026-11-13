import Foundation
import XCTest
@testable import CreatorToolsetMac

final class MediaFilesTests: XCTestCase {
    private var root: URL!
    private var granted: URL!

    override func setUpWithError() throws {
        let base = ProcessInfo.processInfo.environment["CT_SCRATCH_DIR"].map { URL(fileURLWithPath: $0) } ?? FileManager.default.temporaryDirectory
        root = base.appendingPathComponent("media-files-tests/\(UUID().uuidString)", isDirectory: true)
        granted = root.appendingPathComponent("Footage", isDirectory: true)
        try FileManager.default.createDirectory(at: granted.appendingPathComponent("Day 1"), withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: root.appendingPathComponent("Footagebar"), withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: root)
    }

    private func write(_ relative: String) throws -> String {
        let file = root.appendingPathComponent(relative)
        try Data("x".utf8).write(to: file)
        return file.path
    }

    private func isFile(_ gate: MediaFiles.Gate) -> Bool {
        if case .file = gate { return true }
        return false
    }

    /// The same vector as src/lib/local-files.test.ts, so both sides agree on the encoding.
    func testURLRoundTrip() {
        let path = "/Volumes/Footage/Põhja rannik/A001 õhtu.MOV"
        let url = MediaFiles.url(path: path)
        XCTAssertEqual(url.absoluteString, "ctlocal://media/L1ZvbHVtZXMvRm9vdGFnZS9Qw7VoamEgcmFubmlrL0EwMDEgw7VodHUuTU9W")
        XCTAssertEqual(MediaFiles.path(from: url), path)
        XCTAssertEqual(MediaFiles.path(from: MediaFiles.url(path: "/a/b.wav")), "/a/b.wav")   // padding dropped and put back
        XCTAssertNil(MediaFiles.path(from: URL(string: "ctlocal://media/")!))
        XCTAssertNil(MediaFiles.path(from: URL(string: "ctlocal://media/a+b=")!))   // plain base64, not base64url
        XCTAssertNil(MediaFiles.path(from: URL(string: "ctlocal://0123456789ab/screen.mp4")!))
        XCTAssertNil(MediaFiles.path(from: MediaFiles.url(path: "relative/a.mov")))
    }

    func testOnlyMediaInsideAGrantedFolder() throws {
        let inside = try write("Footage/Day 1/A001.MOV")
        let outside = try write("Footagebar/A002.mov")   // shares the granted folder's name as a prefix
        let folders = [granted.path]
        XCTAssertTrue(isFile(MediaFiles.gate(inside, granted: folders)))
        if case .file(_, let type) = MediaFiles.gate(inside, granted: folders) { XCTAssertEqual(type, "video/quicktime") }
        XCTAssertEqual(MediaFiles.gate(outside, granted: folders), .status(403))
        XCTAssertEqual(MediaFiles.gate(inside, granted: []), .status(403))
        XCTAssertTrue(isFile(MediaFiles.gate(inside, granted: [root.path])), "a higher folder covers more")
        let notes = try write("Footage/notes.txt")
        XCTAssertEqual(MediaFiles.gate(notes, granted: folders), .status(415))
    }

    func testMissingFileIsNotFoundOnlyInsideAGrantedFolder() {
        let folders = [granted.path]
        XCTAssertEqual(MediaFiles.gate(granted.appendingPathComponent("Day 1/gone.wav").path, granted: folders), .status(404))
        XCTAssertEqual(MediaFiles.gate(granted.appendingPathComponent("No such/gone.wav").path, granted: folders), .status(404))
        XCTAssertEqual(MediaFiles.gate(root.appendingPathComponent("Footagebar/gone.wav").path, granted: folders), .status(403))
        XCTAssertEqual(MediaFiles.gate("/no/such/place.mov", granted: folders), .status(403))
    }

    func testSymlinksAndDotsCannotLeaveTheFolder() throws {
        let secret = try write("Footagebar/secret.mov")
        let folders = [granted.path]
        let link = granted.appendingPathComponent("link.mov")
        try FileManager.default.createSymbolicLink(atPath: link.path, withDestinationPath: secret)
        XCTAssertEqual(MediaFiles.gate(link.path, granted: folders), .status(403))
        let dirLink = granted.appendingPathComponent("elsewhere")
        try FileManager.default.createSymbolicLink(atPath: dirLink.path, withDestinationPath: root.appendingPathComponent("Footagebar").path)
        XCTAssertEqual(MediaFiles.gate(dirLink.appendingPathComponent("secret.mov").path, granted: folders), .status(403))
        XCTAssertEqual(MediaFiles.gate(granted.path + "/../Footagebar/secret.mov", granted: folders), .status(403))
        XCTAssertEqual(MediaFiles.gate(granted.path + "/./Day 1/../../Footagebar/secret.mov", granted: folders), .status(403))
        // a media name linking to a file that is not one
        let notes = try write("Footage/notes.txt")
        let disguised = granted.appendingPathComponent("disguised.mp4")
        try FileManager.default.createSymbolicLink(atPath: disguised.path, withDestinationPath: notes)
        XCTAssertEqual(MediaFiles.gate(disguised.path, granted: folders), .status(415))
        // a folder named like a video
        try FileManager.default.createDirectory(at: granted.appendingPathComponent("Clip.mov"), withIntermediateDirectories: true)
        XCTAssertEqual(MediaFiles.gate(granted.appendingPathComponent("Clip.mov").path, granted: folders), .status(404))
    }

    func testUnicodeFormsMatch() throws {
        let decomposed = "Po\u{0303}hja"   // õ as o + combining tilde, as some disks store it
        try FileManager.default.createDirectory(at: root.appendingPathComponent(decomposed), withIntermediateDirectories: true)
        let file = root.appendingPathComponent(decomposed).appendingPathComponent("a.wav")
        try Data("x".utf8).write(to: file)
        let composed = root.path + "/P\u{00F5}hja"
        XCTAssertTrue(isFile(MediaFiles.gate(composed + "/a.wav", granted: [root.path + "/" + decomposed])))
        XCTAssertTrue(isFile(MediaFiles.gate(file.path, granted: [composed])))
    }

    func testNearestExisting() {
        XCTAssertEqual(MediaFiles.nearestExisting(granted.path + "/No such/deeper"), granted.path)
        XCTAssertEqual(MediaFiles.nearestExisting("/no/such/place"), "/")
    }
}
