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
}
