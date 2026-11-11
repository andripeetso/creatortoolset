import XCTest
@testable import CreatorToolsetMac

/// The plan limits, offline: the Claude and Codex mappings, the reading states and the keychain item name.
/// No network and no keychain here: the parsers take the usage pages' JSON as dictionaries.
final class LimitsTests: XCTestCase {
    private func object(_ json: String) -> [String: Any] {
        try! JSONSerialization.jsonObject(with: Data(json.utf8)) as! [String: Any]
    }

    // MARK: Claude

    func testClaudeWindowsOrderLabelsAndClamp() {
        let body = object("""
        {
          "seven_day_sonnet": {"utilization": 12, "resets_at": null},
          "seven_day_opus": {"utilization": 40, "resets_at": "2026-11-07T10:00:00Z"},
          "seven_day_overage_included": {"utilization": 99, "resets_at": null},
          "seven_day": {"utilization": 30, "resets_at": "2026-11-08T00:00:00.500Z"},
          "five_hour": {"utilization": 150, "resets_at": "2026-11-07T10:00:00Z"},
          "extra_usage": {"utilization": 5}
        }
        """)
        let rows = claudeWindows(body)
        XCTAssertEqual(rows.map { $0["id"] as? String }, ["five_hour", "seven_day", "seven_day_opus", "seven_day_sonnet"])
        XCTAssertEqual(rows.map { $0["label"] as? String }, ["Session", "Weekly", "Weekly · Opus", "Weekly · Sonnet"])
        XCTAssertEqual(rows.map { $0["kind"] as? String }, ["session", "weekly", "weekly", "weekly"])

        let session = rows[0]
        XCTAssertEqual(session["usedPercent"] as? Double, 100)   // 150 clamped to 100
        XCTAssertEqual(session["windowMs"] as? Int, 5 * 3600 * 1000)
        XCTAssertEqual(session["resetsAt"] as? Int, 1_794_045_600_000)

        let weekly = rows[1]
        XCTAssertEqual(weekly["windowMs"] as? Int, 7 * 86400 * 1000)
        XCTAssertEqual(weekly["resetsAt"] as? Int, 1_794_096_000_500)   // fractional seconds kept

        XCTAssertNil(rows[3]["resetsAt"])   // null reset: no key
    }

    func testClaudeUtilizationBelowZeroClampsAndBooleansAreNotNumbers() {
        let rows = claudeWindows(object(#"{"five_hour":{"utilization":-4},"seven_day":{"utilization":true}}"#))
        XCTAssertEqual(rows.map { $0["id"] as? String }, ["five_hour"])
        XCTAssertEqual(rows[0]["usedPercent"] as? Double, 0)
    }

    // MARK: Codex

    func testCodexKindAndLabelByWindowLength() {
        let cases: [(seconds: Double, label: String, kind: String)] = [
            (18000, "Session", "session"),
            (604800, "Weekly", "weekly"),
            (2592000, "Monthly", "monthly"),
            (3600, "1-hour", "session"),
        ]
        for c in cases {
            XCTAssertEqual(codexLabel(seconds: c.seconds), c.label, "label for \(c.seconds)")
            XCTAssertEqual(codexKind(seconds: c.seconds), c.kind, "kind for \(c.seconds)")
        }
        XCTAssertEqual(codexLabel(seconds: nil), "Limit")
    }

    func testCodexWindowsMapPrimaryAndSecondary() {
        let body = object("""
        {"rate_limit": {
          "primary_window": {"used_percent": 42.5, "reset_at": 1794045600, "limit_window_seconds": 18000},
          "secondary_window": {"used_percent": 120, "reset_at": 1794096000, "limit_window_seconds": 604800}
        }}
        """)
        let rows = codexWindows(body)
        XCTAssertEqual(rows.map { $0["id"] as? String }, ["primary", "secondary"])
        XCTAssertEqual(rows[0]["label"] as? String, "Session")
        XCTAssertEqual(rows[0]["usedPercent"] as? Double, 42.5)
        XCTAssertEqual(rows[0]["resetsAt"] as? Int, 1_794_045_600_000)
        XCTAssertEqual(rows[0]["windowMs"] as? Int, 18_000_000)
        XCTAssertEqual(rows[1]["kind"] as? String, "weekly")
        XCTAssertEqual(rows[1]["usedPercent"] as? Double, 100)
    }

    // MARK: readings

    func testStatusMapsToState() {
        XCTAssertEqual(readingState(status: 401, body: nil).state, "signed_out")
        XCTAssertEqual(readingState(status: 403, body: nil).state, "signed_out")
        XCTAssertEqual(readingState(status: 200, body: [:]).state, "ok")
        XCTAssertNil(readingState(status: 200, body: [:]).error)

        let server = readingState(status: 500, body: nil)
        XCTAssertEqual(server.state, "error")
        XCTAssertEqual(server.error, "HTTP 500")

        let none = readingState(status: 0, body: nil)
        XCTAssertEqual(none.state, "error")
        XCTAssertEqual(none.error, "no answer")
    }

    // MARK: keychain

    func testKeychainServiceNameUsesTheFirstEightHexDigitsOfThePathHash() {
        // printf '%s' /Users/tiny/.claude | shasum -a 256 | cut -c1-8
        XCTAssertEqual(claudeKeychainService(home: "/Users/tiny/.claude"), "Claude Code-credentials-1ca0ce81")
    }

    // MARK: opt-in

    func testLimitsReadingIsOffUntilTurnedOn() {
        let suite = "limits-optin-test"
        let defaults = UserDefaults(suiteName: suite)!
        defaults.removePersistentDomain(forName: suite)
        defer { defaults.removePersistentDomain(forName: suite) }
        XCTAssertFalse(limitsReadingOn(defaults))
        limitsOnFirstRun(driver: "gemini", defaults)
        XCTAssertFalse(limitsReadingOn(defaults))   // only the two whose limits it reads
        limitsOnFirstRun(driver: "claude", defaults)
        XCTAssertTrue(limitsReadingOn(defaults))    // the first Claude run turns it on
        defaults.set(false, forKey: limitsReadingKey)
        limitsOnFirstRun(driver: "codex", defaults)
        XCTAssertFalse(limitsReadingOn(defaults))   // turned off by the person: stays off
    }

    /// A fixture home on the scratch disk (CT_SCRATCH_DIR), never the Mac's temporary folder. The caller removes it.
    /// Without CT_SCRATCH_DIR the test is skipped.
    private func scratchHome() throws -> URL {
        guard let base = ProcessInfo.processInfo.environment["CT_SCRATCH_DIR"] else {
            throw XCTSkip("Set CT_SCRATCH_DIR to a folder on the external disk: these tests keep their fixtures there")
        }
        let home = URL(fileURLWithPath: base).appendingPathComponent("limits-test-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: home, withIntermediateDirectories: true)
        return home
    }

    /// With the opt-in off the report is empty and no folder is visited: no keychain item is read and no usage page is asked.
    /// The folders are on disk (homeReport finds them), so the empty answer comes from the opt-in alone.
    func testOptedOutReportReadsNothing() throws {
        let home = try scratchHome()
        let fm = FileManager.default
        defer { try? fm.removeItem(at: home) }
        try fm.createDirectory(at: home.appendingPathComponent(".claude-work"), withIntermediateDirectories: true)
        try "{}".write(to: home.appendingPathComponent(".claude-work/settings.json"), atomically: true, encoding: .utf8)
        try fm.createDirectory(at: home.appendingPathComponent(".codex"), withIntermediateDirectories: true)
        try #"{"tokens":{"access_token":"tiny-token","account_id":"tiny-account"}}"#
            .write(to: home.appendingPathComponent(".codex/auth.json"), atomically: true, encoding: .utf8)
        XCTAssertEqual(homeReport(home: home).count, 2)
        XCTAssertTrue(limitsReport(home: home, enabled: false).isEmpty)
    }

    /// The sign-in probe is the other login read (`claude auth status` reads the keychain). Fake `claude` and `codex` on
    /// PATH log their arguments: with the opt-in on the sign-in commands run (so the harness sees them), with it off only
    /// the version command runs and no sign-in command is started.
    func testOptedOutDriverReportRunsNoSignInProbe() throws {
        let home = try scratchHome()
        let fm = FileManager.default
        defer { try? fm.removeItem(at: home) }
        let bin = home.appendingPathComponent("bin")
        try fm.createDirectory(at: bin, withIntermediateDirectories: true)
        let log = home.appendingPathComponent("calls.log")
        let script = [
            "#!/bin/sh",
            "echo \"$@\" >> '\(log.path)'",
            "case \"$1\" in --version) echo fake-1.0 ;; auth) echo '{\"loggedIn\":true}' ;; *) echo 'Logged in' ;; esac",
        ].joined(separator: "\n") + "\n"
        for name in ["claude", "codex"] {
            let file = bin.appendingPathComponent(name)
            try script.write(to: file, atomically: true, encoding: .utf8)
            try fm.setAttributes([.posixPermissions: 0o755], ofItemAtPath: file.path)
        }
        let oldPath = ProcessInfo.processInfo.environment["PATH"] ?? ""
        setenv("PATH", bin.path + ":" + oldPath, 1)
        defer { setenv("PATH", oldPath, 1) }
        XCTAssertEqual(binary("claude", home: home), bin.appendingPathComponent("claude").path)

        let on = driverReport(home: home, signIn: true)
        let calls = (try? String(contentsOf: log, encoding: .utf8)) ?? ""
        XCTAssertTrue(calls.contains("auth status --json"))
        XCTAssertTrue(calls.contains("login status"))
        XCTAssertEqual(on.first { $0["driver"] as? String == "claude" }?["signedIn"] as? Bool, true)

        try? fm.removeItem(at: log)
        let off = driverReport(home: home, signIn: false)
        let offCalls = (try? String(contentsOf: log, encoding: .utf8)) ?? ""
        XCTAssertTrue(offCalls.contains("--version"), "the fake CLIs did not run, so the check below would prove nothing")
        XCTAssertFalse(offCalls.contains("auth status"))
        XCTAssertFalse(offCalls.contains("login status"))
        let claude = off.first { $0["driver"] as? String == "claude" }
        XCTAssertEqual(claude?["installed"] as? Bool, true)
        XCTAssertNil(claude?["signedIn"])
        XCTAssertNil(claude?["plan"])
    }
}
