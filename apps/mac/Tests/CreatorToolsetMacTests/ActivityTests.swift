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

        let empty = activityRows(sessions: [], aiRunning: 0)
        XCTAssertTrue(empty.active.isEmpty && empty.forYou.isEmpty)
        XCTAssertEqual(menuStatusLabel(.up, waiting: 2), "Creator Toolset, running, 2 waiting for you")
    }
}
