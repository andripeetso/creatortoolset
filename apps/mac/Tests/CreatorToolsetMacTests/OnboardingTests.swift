import Foundation
import XCTest
@testable import CreatorToolsetMac

/// First run and the CLI lookup: the AI stays off until Connect, and a CLI runs with its own folder first on PATH.
final class OnboardingTests: XCTestCase {
    func testFirstRunLeavesTheAIOffWhenTheServerAnswers() {
        XCTAssertFalse(startsAIWhenReady(aiOn: false, running: false))
        XCTAssertTrue(startsAIWhenReady(aiOn: true, running: false))
        XCTAssertFalse(startsAIWhenReady(aiOn: true, running: true))
    }

    func testLoginShellPathIsTheLastLineThatStartsWithASlash() {
        let out = "Last login: Sat\nWelcome, zsh noise\n/opt/homebrew/bin:/usr/bin:/bin\n"
        XCTAssertEqual(pathFromShellOutput(out), "/opt/homebrew/bin:/usr/bin:/bin")
        XCTAssertEqual(pathFromShellOutput("/a:/b\n/c:/d\n"), "/c:/d")
        XCTAssertEqual(pathFromShellOutput("  /x/bin  \n"), "/x/bin")
        XCTAssertNil(pathFromShellOutput("no path here\n"))
        XCTAssertNil(pathFromShellOutput(""))
    }

    func testTheCLIsOwnFolderGoesFirstOnPath() {
        let env = withBinaryOnPath(["PATH": "/usr/bin:/bin", "HOME": "/Users/x"], binary: "/Users/x/.nvm/versions/node/v22/bin/claude")
        XCTAssertEqual(env["PATH"], "/Users/x/.nvm/versions/node/v22/bin:/usr/bin:/bin")
        XCTAssertEqual(env["HOME"], "/Users/x")
    }

    func testABareNameLeavesThePathAlone() {
        let env = withBinaryOnPath(["PATH": "/usr/bin"], binary: "claude")
        XCTAssertEqual(env["PATH"], "/usr/bin")
    }
}
