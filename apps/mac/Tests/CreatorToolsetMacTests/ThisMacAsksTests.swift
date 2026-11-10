import XCTest
@testable import CreatorToolsetMac

final class ThisMacAsksTests: XCTestCase {
    func testThePageMayAskOnlyTheQuestionsItNeeds() {
        // the Access button sends "access"; the AI questions stay as they were; anything else is answered as off
        XCTAssertTrue(thisMacAsks.contains("access"))
        XCTAssertTrue(thisMacAsks.contains("start"))
        XCTAssertTrue(thisMacAsks.contains("state"))
        XCTAssertFalse(thisMacAsks.contains("forget"))
        XCTAssertFalse(thisMacAsks.contains("ai:on"))
    }

    func testInstallIsAskedWithAnAiAppAndAKeyAndNothingElse() {
        let key = "ctk_" + String(repeating: "a1b2", count: 8)   // made up: the shape of a key, not one
        XCTAssertEqual(installAsk("install:claude:\(key)")?.app, "claude")
        XCTAssertEqual(installAsk("install:codex:\(key)")?.key, key)
        XCTAssertNil(installAsk("install:gemini:\(key)"))
        XCTAssertNil(installAsk("install:claude:\(key) --dangerously"))
        XCTAssertNil(installAsk("install:claude:\(key):more"))
        XCTAssertNil(installAsk("install:claude:short"))
        XCTAssertNil(installAsk("state"))
    }

    func testCodexSettingsGetTheServerOnceAndKeepEverythingElse() {
        let old = "model = \"gpt\"\n\n[mcp_servers.other]\nurl = \"https://other.example/mcp\"\n\n[mcp_servers.creator-toolset]\nurl = \"https://old.example/api/mcp\"\nhttp_headers = { Authorization = \"Bearer old\" }\n\n[mcp_servers.creator-toolset.env]\nA = \"1\"\n\n[profiles.x]\nmodel = \"y\"\n"
        let new = codexConfig(old, name: "creator-toolset", url: "https://tools.example.com/api/mcp", key: "ctk_new")
        XCTAssertTrue(new.contains("model = \"gpt\""))
        XCTAssertTrue(new.contains("[mcp_servers.other]\nurl = \"https://other.example/mcp\""))
        XCTAssertTrue(new.contains("[profiles.x]\nmodel = \"y\""))
        XCTAssertFalse(new.contains("old.example"))
        XCTAssertFalse(new.contains("[mcp_servers.creator-toolset.env]"))
        XCTAssertEqual(new.components(separatedBy: "[mcp_servers.creator-toolset]").count, 2)
        XCTAssertTrue(new.hasSuffix("[mcp_servers.creator-toolset]\nurl = \"https://tools.example.com/api/mcp\"\nhttp_headers = { Authorization = \"Bearer ctk_new\" }\n"))
        // an empty file gets just the table
        XCTAssertEqual(codexConfig("", name: "creator-toolset", url: "u", key: "k"), "[mcp_servers.creator-toolset]\nurl = \"u\"\nhttp_headers = { Authorization = \"Bearer k\" }\n")
    }
}
