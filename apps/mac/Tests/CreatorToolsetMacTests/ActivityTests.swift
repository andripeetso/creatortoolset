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
}
