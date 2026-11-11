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
}
