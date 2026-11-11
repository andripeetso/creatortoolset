import AppKit
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

    func testADragsFinderItemsComeWithTheirPathAndWhetherEachIsAFolder() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("ct-drop-\(UUID().uuidString)")
        let file = dir.appendingPathComponent("clip 1.mov")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        try Data().write(to: file)
        defer { try? FileManager.default.removeItem(at: dir) }
        let board = NSPasteboard(name: NSPasteboard.Name("ct-drop-test"))
        board.clearContents()
        board.writeObjects([dir as NSURL, file as NSURL, NSString(string: "some text")])
        let items = droppedItems(board)
        XCTAssertEqual(items.map { $0["path"] as? String }, [dir.path, file.path])
        XCTAssertEqual(items.map { $0["folder"] as? Bool }, [true, false])
        XCTAssertTrue(thisMacAsks.contains("dropped"))
    }

    func testThePageGetsADragsPathsOnlyOnceItIsDroppedAndOnlyOnce() {
        let items: [[String: Any]] = [["path": "/Users/you/Movies/Shoot", "folder": true]]
        var drag = DragPaths()
        // passing over without a drop leaves nothing, during the drag or after it left
        drag.entered(items)
        XCTAssertTrue(drag.take().isEmpty)
        drag.exited()
        drag.dropped()
        XCTAssertTrue(drag.take().isEmpty)
        // a drop: its items once
        drag.entered(items)
        drag.dropped()
        XCTAssertEqual(drag.take().first?["path"] as? String, "/Users/you/Movies/Shoot")
        XCTAssertTrue(drag.take().isEmpty)
        // a drop nobody asked about soon goes stale
        let then = Date()
        drag.entered(items)
        drag.dropped(at: then)
        XCTAssertTrue(drag.take(at: then.addingTimeInterval(11)).isEmpty)
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

    /// Telling the page about this Mac asks nothing of the local network: the host name is the kernel's own, and no
    /// source file asks `ProcessInfo` for it (that call sends 52 lookups, and macOS then asks the person to let the app
    /// "find devices on local networks" right after it starts).
    func testThisMacsNameAsksNothingOfTheLocalNetwork() throws {
        var kernel = [CChar](repeating: 0, count: 256)
        XCTAssertEqual(gethostname(&kernel, 255), 0)
        XCTAssertEqual(macHostName(), String(cString: kernel).lowercased())
        XCTAssertFalse(macHostName().isEmpty)
        let sources = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().appendingPathComponent("Sources")
        let files = try FileManager.default.subpathsOfDirectory(atPath: sources.path).filter { $0.hasSuffix(".swift") }
        XCTAssertGreaterThan(files.count, 20)
        for file in files {
            let code = try String(contentsOf: sources.appendingPathComponent(file), encoding: .utf8).split(separator: "\n")
                .filter { !$0.trimmingCharacters(in: .whitespaces).hasPrefix("//") }
            XCTAssertFalse(code.contains { $0.contains(".hostName") }, "\(file) asks ProcessInfo for the host name: use macHostName()")
        }
    }
}
