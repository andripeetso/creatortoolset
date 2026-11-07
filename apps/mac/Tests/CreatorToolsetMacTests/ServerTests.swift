import Foundation
import XCTest
@testable import CreatorToolsetMac

final class ServerTests: XCTestCase {
    func testRestartBacksOffThenGivesUpAfterFiveCrashesInFiveMinutes() {
        let now = Date()
        let ago = { (s: TimeInterval) in now.addingTimeInterval(-s) }
        XCTAssertEqual(restartDelay(crashes: [now], now: now), 1)
        XCTAssertEqual(restartDelay(crashes: [ago(10), now], now: now), 2)
        XCTAssertEqual(restartDelay(crashes: [ago(30), ago(10), now], now: now), 4)
        XCTAssertNil(restartDelay(crashes: [ago(200), ago(100), ago(30), ago(10), now], now: now))
        // crashes older than five minutes no longer count
        XCTAssertEqual(restartDelay(crashes: [ago(900), ago(800), ago(700), ago(600), now], now: now), 1)
    }

    func testServerLogRotatesPastItsLimit() throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        let log = folder.appendingPathComponent("server.log").path
        AppLog.append(Data("small\n".utf8), to: log)
        ServerLog.rotate(log, over: 100)
        XCTAssertFalse(FileManager.default.fileExists(atPath: log + ".1"))
        AppLog.append(Data(repeating: 65, count: 200), to: log)
        ServerLog.rotate(log, over: 100)
        XCTAssertTrue(FileManager.default.fileExists(atPath: log + ".1"))
        XCTAssertFalse(FileManager.default.fileExists(atPath: log))
    }

    func testProcessPathNamesThisProcess() {
        XCTAssertEqual(processPath(getpid()), Bundle.main.executablePath.map { URL(fileURLWithPath: $0).resolvingSymlinksInPath().path })
    }

    // MARK: data location

    private func scratch() throws -> URL {
        let root = ProcessInfo.processInfo.environment["CT_SCRATCH_DIR"].map { URL(fileURLWithPath: $0) } ?? FileManager.default.temporaryDirectory
        let url = root.appendingPathComponent("server-test-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }

    func testADataFolderOnADiskThatIsNotConnectedIsNamed() {
        let mounted = ["/", "/Volumes/Footage"]
        XCTAssertNil(missingDisk("/Volumes/Footage/Creator Toolset", mounted: mounted))
        XCTAssertEqual(missingDisk("/Volumes/Travel SSD/Creator Toolset", mounted: mounted), "Travel SSD")
        XCTAssertNil(missingDisk(NSHomeDirectory() + "/Library/Application Support/Creator Toolset/data", mounted: mounted))
    }

    func testAMoveNeedsAnotherEmptyFolderWithRoom() {
        let from = URL(fileURLWithPath: "/Users/tiny/data")
        let dest = URL(fileURLWithPath: "/Users/tiny/elsewhere")
        XCTAssertNil(moveProblem(from: from, to: dest, entries: [".DS_Store"], size: 1000, free: 2000))
        XCTAssertNotNil(moveProblem(from: from, to: dest, entries: ["users.json"], size: 1000, free: 2000))
        XCTAssertNotNil(moveProblem(from: from, to: dest, entries: [], size: 1000, free: 1050))   // data + 10 % doesn't fit
        XCTAssertNotNil(moveProblem(from: from, to: from, entries: [], size: 1000, free: 2000))
        XCTAssertNotNil(moveProblem(from: from, to: from.appendingPathComponent("inside"), entries: [], size: 1000, free: 2000))
        XCTAssertNotNil(moveProblem(from: from, to: URL(fileURLWithPath: "/Volumes/Not Connected Disk/data"), entries: [], size: 1, free: nil))
    }

    func testRemoveOldCopyNeverTrashesTheLiveDataFolder() {
        let u = { (p: String) in URL(fileURLWithPath: p) }
        XCTAssertTrue(oldCopyRemovable(u("/Users/tiny/Old data"), live: u("/Volumes/Studio/data")))
        // "Choose another folder…" picked the old copy while the new disk was gone: it is the live folder again
        XCTAssertFalse(oldCopyRemovable(u("/Users/tiny/data"), live: u("/Users/tiny/data/")))
        XCTAssertFalse(oldCopyRemovable(u("/Users/tiny/data"), live: u("/Users/tiny/data/inner")))
        XCTAssertFalse(oldCopyRemovable(u("/Users/tiny/data/inner"), live: u("/Users/tiny/data")))
    }

    func testFolderStatsCountFilesAndBytes() throws {
        let folder = try scratch()
        defer { try? FileManager.default.removeItem(at: folder) }
        try FileManager.default.createDirectory(at: folder.appendingPathComponent("library"), withIntermediateDirectories: true)
        try Data(repeating: 1, count: 10).write(to: folder.appendingPathComponent("users.json"))
        try Data(repeating: 2, count: 32).write(to: folder.appendingPathComponent("library/library.db"))
        try Data(repeating: 3, count: 6).write(to: folder.appendingPathComponent(".DS_Store"))   // Finder's, never counted
        XCTAssertEqual(folderStats(folder), FolderStats(files: 2, bytes: 42))
        XCTAssertNotNil(freeBytes(folder.appendingPathComponent("not/made/yet")))   // the nearest existing folder's disk
    }

    func testTheRunnersFolderFollowsTheDataFolderForTheServerHere() {
        let data = URL(fileURLWithPath: "/Volumes/Footage/data")
        XCTAssertEqual(relayFolder(for: URL(string: "http://127.0.0.1:43128")!, localData: data).path, "/Volumes/Footage/data/relay")
        XCTAssertEqual(relayFolder(for: productionSite, localData: nil), appSupport.appendingPathComponent("relay/creatortoolset.com"))
        XCTAssertEqual(relayFolder(for: URL(string: "http://localhost:3000")!, localData: nil).lastPathComponent, "localhost-3000")
    }
}
