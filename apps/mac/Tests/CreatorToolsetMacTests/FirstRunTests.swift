import XCTest
@testable import CreatorToolsetMac

final class FirstRunTests: XCTestCase {
    func testNotificationsAreAskedOnlyWhenFirstNeededAndInFront() {
        // undecided, app in front, never asked: the line comes first
        XCTAssertEqual(notePostStep(undetermined: true, appActive: true, asked: false), .askFirst)
        // undecided, app in the background: nothing is asked from behind, the note waits
        XCTAssertEqual(notePostStep(undetermined: true, appActive: false, asked: false), .wait)
        // asked before (answered or declined): post, a declined post is a no-op
        XCTAssertEqual(notePostStep(undetermined: true, appActive: true, asked: true), .post)
        XCTAssertEqual(notePostStep(undetermined: true, appActive: false, asked: true), .post)
        // already decided by macOS: post
        XCTAssertEqual(notePostStep(undetermined: false, appActive: false, asked: false), .post)
    }

    func testClosingKeepsTheNoticeToOneTimeAndNeverOnQuit() {
        XCTAssertTrue(closeNoticeNeeded(quitting: false, said: false))
        XCTAssertFalse(closeNoticeNeeded(quitting: false, said: true))
        XCTAssertFalse(closeNoticeNeeded(quitting: true, said: false))
    }

    func testLoginShellPathIsReadAgainAfterAMinute() {
        let read = Date(timeIntervalSince1970: 1_000)
        XCTAssertTrue(shellPathFresh(readAt: read, now: read.addingTimeInterval(59)))
        XCTAssertFalse(shellPathFresh(readAt: read, now: read.addingTimeInterval(61)))
    }

    func testServerFailureSaysWhatToDoInPlainWords() {
        XCTAssertTrue(serverStartFailed.contains("Try again"))
        XCTAssertFalse(serverStartFailed.lowercased().contains("port"))
        XCTAssertFalse(serverStartFailed.contains("Open server log"))
    }
}
