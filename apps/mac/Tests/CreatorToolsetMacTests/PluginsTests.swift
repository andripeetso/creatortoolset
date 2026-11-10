import XCTest
@testable import CreatorToolsetMac

final class PluginsTests: XCTestCase {
    func testTheAskParserReadsOnlyWellFormedAsks() {
        XCTAssertEqual(pluginAsk("plugin:on:tiny-acro"), .on("tiny-acro"))
        XCTAssertEqual(pluginAsk("plugin:on:my:folder"), .on("my:folder"))   // a colon in the folder's name
        XCTAssertNil(pluginAsk("plugin:on:"))                                 // an empty folder
        XCTAssertNil(pluginAsk("plugin:on:../x"))
        XCTAssertNil(pluginAsk("plugin:on:a/b"))
        XCTAssertNil(pluginAsk("plugin:on:a\\b"))
        XCTAssertNil(pluginAsk("plugin:on:.hidden"))
        XCTAssertEqual(pluginAsk("plugin:off:tiny-acro"), .off("tiny-acro"))
        XCTAssertNil(pluginAsk("plugin:off:Bad_Id"))
        XCTAssertEqual(pluginAsk("plugin:show:"), .show(""))                  // the plugins folder itself
        XCTAssertEqual(pluginAsk("plugin:show:tiny"), .show("tiny"))
        XCTAssertNil(pluginAsk("plugin:show:a/b"))
        XCTAssertEqual(pluginAsk("plugins:resume"), .resume)
        XCTAssertNil(pluginAsk("plugin:frob:x"))
        XCTAssertTrue(isPluginAsk("plugin:frob:x"))                           // answered (ok: false), never the AI default
        XCTAssertTrue(isPluginAsk("plugins:resume"))
        XCTAssertFalse(isPluginAsk("state"))
    }

    func testTheServerGetsSortedPairsAndMalformedOnesAreDropped() {
        let fp = String(repeating: "a", count: 64)
        let b = String(repeating: "b", count: 64)
        let approved = ["zeta": fp, "alpha": b, "Bad": fp, "short-fp": String(repeating: "c", count: 63), "upper": "XYZ"]
        XCTAssertEqual(pluginsOnValue(approved), "alpha:\(b),zeta:\(fp)")
        XCTAssertEqual(pluginsOnValue([:]), "")
        let env = pluginEnvironment(approved: approved, paused: true)
        XCTAssertEqual(env["CT_PLUGINS_ON"], "alpha:\(b),zeta:\(fp)")
        XCTAssertEqual(env["CT_PLUGINS_PAUSED"], "1")
        XCTAssertTrue(pluginEnvironment(approved: [:], paused: false).isEmpty)   // none on, not paused: nothing added
        XCTAssertNil(pluginEnvironment(approved: [:], paused: true)["CT_PLUGINS_ON"])
    }

    func testTheSwitchOnAlertSaysWhatThePluginCanReach() {
        let server = switchOnAlertText(name: "Tiny", server: true, web: true)
        XCTAssertEqual(server.message, "Switch on “Tiny”?")
        XCTAssertEqual(server.detail, "This plug-in was not made by Creator Toolset. It runs on this Mac inside the app, with the app's access to your files, your keys and the internet.")
        XCTAssertEqual(switchOnAlertText(name: "Tiny", server: false, web: true).detail, "This plug-in was not made by Creator Toolset. It adds pages to the app, and they can see and change everything in it.")
        XCTAssertNil(switchOnAlertText(name: "Tiny", server: false, web: false).detail)
    }

    func testTheFifthCrashPausesPluginsOnceWhenOneIsOn() {
        XCTAssertTrue(pluginsPauseInsteadOfStopping(on: 1, paused: false))
        XCTAssertFalse(pluginsPauseInsteadOfStopping(on: 0, paused: false))   // none on: stop trying, as before
        XCTAssertFalse(pluginsPauseInsteadOfStopping(on: 2, paused: true))    // already paused: stop trying
    }

    func testTheRecordEncodesAndDecodesAndKeepsItsOwnKeychainService() {
        let fp = String(repeating: "f", count: 64)
        let data = PluginRecord.encode(["tiny": fp])
        XCTAssertEqual(data.flatMap(PluginRecord.decode), ["tiny": fp])
        XCTAssertNil(PluginRecord.decode(Data("not json".utf8)))
        // the test's own service: the app's real Keychain items are never read or written here
        let store = PluginRecord(service: "com.creatortoolset.mac.tests.plugins")
        defer { store.remove() }
        store.remove()
        // a test run has no provisioning profile: the record is in the file-based Keychain, and the app knows it
        XCTAssertFalse(store.protected)
        XCTAssertEqual(store.load(), [:])
        XCTAssertTrue(store.save(["tiny": fp]))
        XCTAssertEqual(store.load(), ["tiny": fp])
        XCTAssertTrue(store.save([:]))
        XCTAssertEqual(store.load(), [:])
    }
}
