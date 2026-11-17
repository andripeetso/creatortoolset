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

    func testCommandQWarnsFirstAndQuitsOnASecondPress() {
        let t = Date(timeIntervalSince1970: 1_000)
        XCTAssertEqual(quitPress(warnedAt: nil, now: t, isRepeat: false), .warn)
        XCTAssertEqual(quitPress(warnedAt: t, now: t.addingTimeInterval(0.5), isRepeat: false), .quit)
        XCTAssertEqual(quitPress(warnedAt: t, now: t.addingTimeInterval(0.5), isRepeat: true), .ignore)   // the hold timer quits
        XCTAssertEqual(quitPress(warnedAt: t, now: t.addingTimeInterval(2), isRepeat: false), .warn)
    }

    func testOnlyCommandQIsHeldBack() {
        XCTAssertTrue(isQuitKey(flags: .command, characters: "q"))
        XCTAssertTrue(isQuitKey(flags: [.command, .capsLock], characters: "Q"))
        XCTAssertFalse(isQuitKey(flags: [.command, .shift], characters: "q"))
        XCTAssertFalse(isQuitKey(flags: [.command, .option], characters: "q"))
        XCTAssertFalse(isQuitKey(flags: [], characters: "q"))
        XCTAssertFalse(isQuitKey(flags: .command, characters: "w"))
        // dictation's F13–F16 pass straight through, alone or with ⌘
        for key in [NSF13FunctionKey, NSF14FunctionKey, NSF15FunctionKey, NSF16FunctionKey] {
            let chars = String(Character(UnicodeScalar(key)!))
            XCTAssertFalse(isQuitKey(flags: .function, characters: chars))
            XCTAssertFalse(isQuitKey(flags: [.command, .function], characters: chars))
        }
    }

    /// Quit from the menu, the Dock, a logout or shutdown, and the Restart to update relaunch all reach
    /// applicationShouldTerminate: it quits at once, also while the ⌘Q message shows.
    @MainActor func testEveryOtherQuitQuitsAtOnce() {
        defer { AppDelegate.quitting = false }
        XCTAssertEqual(AppDelegate().applicationShouldTerminate(NSApplication.shared), .terminateNow)
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
