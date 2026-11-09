import XCTest
@testable import CreatorToolsetMac

final class LaunchAgentTests: XCTestCase {
    func testEachVerbBecomesOneLaunchctlCommandInTheUsersSession() {
        XCTAssertEqual(LaunchAgent.arguments(verb: "start", label: "com.example.agent", uid: 501, home: "/Users/tiny"),
                       ["bootstrap", "gui/501", "/Users/tiny/Library/LaunchAgents/com.example.agent.plist"])
        XCTAssertEqual(LaunchAgent.arguments(verb: "stop", label: "com.example.agent", uid: 501), ["bootout", "gui/501/com.example.agent"])
        XCTAssertEqual(LaunchAgent.arguments(verb: "restart", label: "com.example.agent", uid: 501), ["kickstart", "-k", "gui/501/com.example.agent"])
    }

    func testAnotherVerbOrALabelThatIsNotAReverseDnsNameIsRefused() {
        XCTAssertNil(LaunchAgent.arguments(verb: "delete", label: "com.example.agent", uid: 501))
        XCTAssertNil(LaunchAgent.arguments(verb: "start", label: "", uid: 501))
        XCTAssertNil(LaunchAgent.arguments(verb: "start", label: "com.example/../../evil", uid: 501))
        XCTAssertNil(LaunchAgent.arguments(verb: "start", label: "com.example agent; rm", uid: 501))
        XCTAssertNil(LaunchAgent.arguments(verb: "start", label: "com.exämple", uid: 501))
    }

    func testAPluginRowKeepsOnlyItsValidActions() throws {
        let json = """
        [{"id":"p:x","title":"Worker","detail":"Not reporting","state":"working","href":"/editor",
          "actions":[{"id":"start","title":"Start","run":"start","label":"com.example.agent"},
                     {"id":"bad","title":"Bad","run":"rm","label":"com.example.agent"},
                     {"id":"bad2","title":"Bad2","run":"stop","label":"com.example/x"}]},
         {"id":"p:y","title":"Plain","detail":"","state":"ready","href":"/editor"}]
        """
        let rows = try JSONDecoder().decode([PluginRow].self, from: Data(json.utf8))
        let shown = rows.map(\.row)
        XCTAssertEqual(shown[0].actions.map(\.id), ["start"])
        XCTAssertEqual(shown[1].actions, [])
    }
}
