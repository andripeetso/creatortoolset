import XCTest
@testable import CreatorToolsetMac

final class SignInTests: XCTestCase {
    func testClaudeLoginRunsInItsHomeByFullPath() {
        let script = signInScript(driver: "claude", home: "/Users/tiny/.claude-hub", binary: "/opt/bin/claude")
        XCTAssertEqual(script, "#!/bin/zsh\nexport CLAUDE_CONFIG_DIR='/Users/tiny/.claude-hub'\nexec '/opt/bin/claude' auth login\n")
    }

    func testCodexLoginSetsCodexHome() {
        let script = signInScript(driver: "codex", home: "/Users/tiny/.codex", binary: "/opt/homebrew/bin/codex")
        XCTAssertEqual(script, "#!/bin/zsh\nexport CODEX_HOME='/Users/tiny/.codex'\nexec '/opt/homebrew/bin/codex' login\n")
    }

    func testGrokLoginTakesNoHome() {
        XCTAssertEqual(signInScript(driver: "grok", home: "", binary: "/Users/tiny/.grok/bin/grok"),
                       "#!/bin/zsh\nexec '/Users/tiny/.grok/bin/grok' login\n")
        XCTAssertNil(signInScript(driver: "grok", home: "/Users/tiny/.grok", binary: "/Users/tiny/.grok/bin/grok"))
    }

    func testUnknownDriverAndRelativeBinaryGiveNothing() {
        XCTAssertNil(signInScript(driver: "gemini", home: "", binary: "/opt/bin/gemini"))
        XCTAssertNil(signInScript(driver: "claude", home: "", binary: "claude"))
    }

    func testQuotesInPathsCannotEscapeTheScript() {
        XCTAssertEqual(shellQuote("it's"), "'it'\\''s'")
        let script = signInScript(driver: "claude", home: "/Users/tiny/it's here", binary: "/opt/bin/claude")
        XCTAssertEqual(script, "#!/bin/zsh\nexport CLAUDE_CONFIG_DIR='/Users/tiny/it'\\''s here'\nexec '/opt/bin/claude' auth login\n")
    }
}
