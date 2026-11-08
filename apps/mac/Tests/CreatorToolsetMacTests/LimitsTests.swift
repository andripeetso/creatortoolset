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
}
