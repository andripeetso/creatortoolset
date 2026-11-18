import XCTest
@testable import CreatorToolsetMac

final class ActivityTests: XCTestCase {
    func testRowsSplitIntoActiveAndForYou() {
        let sessions = [SessionRow(id: "s1", title: "Hook ideas", working: true, ready: false),
                        SessionRow(id: "s2", title: "Carousel", working: false, ready: true),
                        SessionRow(id: "s3", title: "Old", working: false, ready: false)]
        let rows = activityRows(sessions: sessions, aiRunning: 2)
        XCTAssertEqual(rows.active.map(\.title), ["Hook ideas", "This Mac"])
        XCTAssertEqual(rows.active[0].href, "/workshop/sessions/s1")
        XCTAssertEqual(rows.active[1].detail, "2 AI requests")
        XCTAssertNil(rows.active[1].href)
        XCTAssertEqual(rows.forYou.map(\.state), [.ready])
        XCTAssertEqual(rows.forYou[0].href, "/workshop/sessions/s2")

        // plug-in rows: working ones under Active after the sessions, ready ones under For you; the href opens as given
        let plugin = [PluginRow(id: "x", title: "Tiny render", detail: "Editor", state: "working", href: "/editor"),
                      PluginRow(id: "y", title: "Tiny cut", detail: "Editor · ready", state: "ready", href: "/editor/y")]
        let withPlugin = activityRows(sessions: sessions, aiRunning: 0, plugin: plugin)
        XCTAssertEqual(withPlugin.active.map(\.title), ["Hook ideas", "Tiny render"])
        XCTAssertEqual(withPlugin.active[1].href, "/editor")
        XCTAssertEqual(withPlugin.forYou.map(\.title), ["Carousel", "Tiny cut"])
        XCTAssertEqual(withPlugin.forYou[1].state, .ready)

        let empty = activityRows(sessions: [], aiRunning: 0)
        XCTAssertTrue(empty.active.isEmpty && empty.forYou.isEmpty)
        XCTAssertEqual(menuStatusLabel(.up, waiting: 2), "Creator Toolset, running, 2 waiting for you")
    }

    func testServerRowsCarryProgressAndTheReasonTheyWait() throws {
        let json = Data("""
        [{"id":"library:l:prepare","title":"Media Library","detail":"Preparing 17 clips · 45%","state":"working","href":"/library","progress":0.45},
         {"id":"library:l:limit","title":"Media Library","detail":"17 AI descriptions wait","state":"working","href":"/library",
          "reason":"Your Claude plan's weekly limit is reached; it resets 5pm. They carry on by themselves then."},
         {"id":"old","title":"Tiny","detail":"An older server's row","state":"working","href":"/x","progress":7}]
        """.utf8)
        let rows = activityRows(sessions: [], aiRunning: 0, plugin: try JSONDecoder().decode([PluginRow].self, from: json)).active
        XCTAssertEqual(rows.map(\.word), ["Working", "Waiting", "Working"])
        XCTAssertEqual(rows[0].progress, 0.45)
        XCTAssertNil(rows[0].reason)
        XCTAssertNil(rows[1].progress)
        XCTAssertEqual(rows[2].progress, 1, "a progress past the end is shown full")

        // the plan's limit is said once: by the row it holds back, else on the panel's own line
        let limit = "Claude: You've hit your weekly limit · resets 5pm (Europe/Tallinn)"
        XCTAssertNil(panelLimitLine(lastError: limit, rows: rows))
        XCTAssertEqual(panelLimitLine(lastError: limit, rows: [rows[0]]), "Claude's weekly limit is reached · resets 5pm")
        XCTAssertNil(panelLimitLine(lastError: "Claude: something else broke", rows: []))
        XCTAssertNil(panelLimitLine(lastError: nil, rows: []))
    }

    func testComputerWaitsCarryTheirMarkAndTheLogSaysWhatChanged() throws {
        let json = Data("""
        [{"id":"library:l:stuck:files:mac","title":"Media Library","detail":"6 files","state":"working","href":"/settings/devices",
          "reason":"Mac Studio hasn't started on these","mark":"stuck"},
         {"id":"library:l:waits:look","title":"Media Library","detail":"14 shot descriptions","state":"working","href":"/settings/devices",
          "reason":"Linux box is offline","mark":"waits"},
         {"id":"library:l:computer:files","title":"Media Library","detail":"1 file","state":"ready","href":"/settings/devices",
          "reason":"Mac Studio is Off in Load balancing","mark":"computer"}]
        """.utf8)
        let plugin = try JSONDecoder().decode([PluginRow].self, from: json)
        let rows = activityRows(sessions: [], aiRunning: 0, plugin: plugin)
        XCTAssertEqual(rows.active.map(\.mark), ["stuck", "waits"])
        XCTAssertEqual(rows.forYou.map(\.mark), ["computer"])
        XCTAssertEqual([rows.active[0].reasonColor, rows.active[1].reasonColor, rows.forYou[0].reasonColor], [.red, .secondary, .orange])
        // a computer wait is not the plan's limit: the panel still says the limit on its own line
        XCTAssertEqual(panelLimitLine(lastError: "Claude: You've hit your weekly limit · resets 5pm (Europe/Tallinn)", rows: rows.active),
                       "Claude's weekly limit is reached · resets 5pm")

        XCTAssertEqual(activityLogLines(before: [], after: plugin), [
            "activity: library:l:computer:files computer 1 file · Mac Studio is Off in Load balancing",
            "activity: library:l:stuck:files:mac stuck 6 files · Mac Studio hasn't started on these",
            "activity: library:l:waits:look waits 14 shot descriptions · Linux box is offline",
        ])
        XCTAssertEqual(activityLogLines(before: plugin, after: plugin), [], "nothing changed, nothing logged")
        var later = plugin
        later[1].reason = "Linux box is short of disk space"
        XCTAssertEqual(activityLogLines(before: plugin, after: Array(later.dropFirst())), [
            "activity: library:l:stuck:files:mac ok",
            "activity: library:l:waits:look waits 14 shot descriptions · Linux box is short of disk space",
        ])
    }
}
