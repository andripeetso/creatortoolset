import Foundation
import XCTest
@testable import CreatorToolsetMac

final class EditorsTests: XCTestCase {
    func testFindsEachEditorOnceNewestFirstAndSkipsTheirHelpers() throws {
        let root = ProcessInfo.processInfo.environment["CT_SCRATCH_DIR"].map { URL(fileURLWithPath: $0) } ?? FileManager.default.temporaryDirectory
        let apps = root.appendingPathComponent("editors-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: apps) }
        func app(_ path: String, id: String, version: String) throws {
            let contents = apps.appendingPathComponent(path).appendingPathComponent("Contents")
            try FileManager.default.createDirectory(at: contents, withIntermediateDirectories: true)
            let plist: NSDictionary = ["CFBundleIdentifier": id, "CFBundleShortVersionString": version]
            XCTAssertTrue(plist.write(to: contents.appendingPathComponent("Info.plist"), atomically: true))
        }
        try app("DaVinci Resolve/DaVinci Resolve.app", id: "com.blackmagic-design.DaVinciResolve", version: "21.2.0")
        try app("DaVinci Resolve/DaVinci Resolve Project Server.app", id: "com.blackmagic-design.ProjectServer", version: "21.2.0")
        try app("Adobe Premiere Pro 2024/Adobe Premiere Pro 2024.app", id: "com.adobe.PremierePro.24", version: "24.6")
        try app("Adobe Premiere Pro 2025/Adobe Premiere Pro 2025.app", id: "com.adobe.PremierePro.25", version: "25.1")
        try app("Final Cut Pro.app", id: "com.apple.FinalCut", version: "11.1")
        try app("Notes.app", id: "com.apple.Notes", version: "4.0")

        let found = Editors.installed(in: apps)
        XCTAssertEqual(found.map(\.id), ["resolve-studio", "final-cut", "premiere"])
        XCTAssertEqual(found.map(\.name), ["DaVinci Resolve", "Final Cut Pro", "Adobe Premiere Pro 2025"])
        XCTAssertEqual(found.map(\.version), ["21.2.0", "11.1", "25.1"])
        XCTAssertEqual(found.map(\.format), ["otio", "fcpxml", "xml"])
    }

    func testTellsTheFreeResolveAndMediaComposerApart() {
        XCTAssertEqual(Editors.id(appName: "DaVinci Resolve", bundleID: "com.blackmagic-design.DaVinciResolveLite"), "resolve")
        XCTAssertEqual(Editors.id(appName: "AvidMediaComposer", bundleID: "com.avid.mediacomposer"), "avid")
        XCTAssertEqual(Editors.id(appName: "Final Cut Pro Trial", bundleID: nil), "final-cut")
        XCTAssertNil(Editors.id(appName: "Adobe Premiere Pro Uninstaller", bundleID: nil))
        XCTAssertNil(VideoEditor(id: "avid", name: "AvidMediaComposer", version: nil, app: URL(fileURLWithPath: "/x.app")).format)
    }

    func testTheOpenAskTakesOnlyIdsThatGoInAnAddress() throws {
        XCTAssertTrue(isEditorAsk("editors"))
        let ask = try XCTUnwrap(openEditorAsk(#"open-editor:{"edit":"ed_1","draft":"v2","editor":"premiere","name":"Tiny cut","fps":29.97,"width":1080,"height":1920}"#))
        XCTAssertEqual(ask, OpenEditorAsk(edit: "ed_1", draft: "v2", editor: "premiere", name: "Tiny cut", project: "", fps: "29.97", width: 1080, height: 1920))
        XCTAssertEqual(openEditorAsk(#"open-editor:{"edit":"e","draft":"v1","editor":"resolve-studio","fps":25}"#)?.fps, "25")
        XCTAssertNil(openEditorAsk(#"open-editor:{"edit":"../x","draft":"v2","editor":"premiere"}"#))
        XCTAssertNil(openEditorAsk(#"open-editor:{"edit":"e","draft":"v2?format=zip","editor":"premiere"}"#))
        XCTAssertNil(openEditorAsk("open-editor:nope"))
        // a timeline's name never leaves the timelines folder
        let file = try Editors.file(for: OpenEditorAsk(edit: "e", draft: "v1", editor: "premiere", name: "../../etc/x"), format: "xml")
        XCTAssertEqual(file.deletingLastPathComponent().lastPathComponent, "Timelines")
        XCTAssertEqual(try Editors.file(for: OpenEditorAsk(edit: "e", draft: "v1", editor: "premiere", name: ".."), format: "xml").lastPathComponent, "v1.xml")
    }

    func testAResolveJustStartedIsAskedAgainUntilItTakesTheDraft() async throws {
        var tries = 0
        let reply = try await ResolveBridge.untilOpen(waiting: 5, pause: 0.01) {
            tries += 1
            return tries < 3 ? .failed(ResolveReply.notOpen + ", or external scripting is off") : .opened(timeline: "Cut")
        }
        XCTAssertEqual(reply, .opened(timeline: "Cut"))
        XCTAssertEqual(tries, 3)
        // any other answer, or no time to wait, is the answer
        tries = 0
        let once = try await ResolveBridge.untilOpen(waiting: 0, pause: 0.01) { tries += 1; return .failed(ResolveReply.notOpen) }
        XCTAssertEqual(once, .failed(ResolveReply.notOpen))
        XCTAssertEqual(tries, 1)
    }
}
