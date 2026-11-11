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
        XCTAssertEqual(pluginAsk("plugins:state"), .state)
        XCTAssertEqual(pluginAsk("plugins:auto:on"), .auto(true))
        XCTAssertEqual(pluginAsk("plugins:auto:off"), .auto(false))
        XCTAssertNil(pluginAsk("plugins:auto:yes"))
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
        // the folder each one was taken from goes with it, for the same plug-ins (a folder's name may hold anything)
        let record = PluginApprovals(on: approved.mapValues { PluginApproval(fingerprint: $0, folder: $0 == b ? "my \"own\", folder/x" : "zeta", server: true) })
        let env = pluginEnvironment(approved: record, paused: true)
        XCTAssertEqual(env["CT_PLUGINS_ON"], "alpha:\(b),zeta:\(fp)")
        XCTAssertEqual(env["CT_PLUGINS_FOLDERS"], #"{"alpha":"my \"own\", folder/x","zeta":"zeta"}"#)
        XCTAssertEqual(env["CT_PLUGINS_PAUSED"], "1")
        XCTAssertTrue(pluginEnvironment(approved: PluginApprovals(), paused: false).isEmpty)   // none on, not paused: nothing added
        XCTAssertNil(pluginEnvironment(approved: PluginApprovals(), paused: true)["CT_PLUGINS_ON"])
        XCTAssertNil(pluginEnvironment(approved: PluginApprovals(), paused: true)["CT_PLUGINS_FOLDERS"])
    }

    func testTheSwitchOnAlertSaysWhatThePluginCanReach() {
        let server = switchOnAlertText(name: "Tiny", server: true, web: true, auto: false)
        XCTAssertEqual(server.message, "Switch on “Tiny”?")
        XCTAssertEqual(server.detail, "This plug-in was not made by Creator Toolset. It runs on this Mac inside the app, with the app's access to your files, your keys and the internet.")
        XCTAssertEqual(switchOnAlertText(name: "Tiny", server: false, web: true, auto: false).detail, "This plug-in was not made by Creator Toolset. It adds pages to the app, and they can see and change everything in it.")
        XCTAssertNil(switchOnAlertText(name: "Tiny", server: false, web: false, auto: true).detail)
    }

    /// The click covers what the folder holds later only while Update automatically is on, and the alert says which.
    func testTheSwitchOnAlertSaysLaterChangesRunByThemselvesOnlyWhileTheyDo() {
        let later = " Later changes to its folder run by themselves unless you switch off Update automatically."
        for (server, web) in [(true, true), (true, false), (false, true)] {
            let waits = switchOnAlertText(name: "Tiny", server: server, web: web, auto: false).detail!
            XCTAssertFalse(waits.contains("Later changes"))
            XCTAssertEqual(switchOnAlertText(name: "Tiny", server: server, web: web, auto: true).detail, waits + later)
        }
    }

    func testAFolderIsLookedIntoOnceItStoodStillAndOnlyOnce() {
        XCTAssertFalse(pluginFolderSettled(stamp: "a", last: nil, handled: nil))    // the first look: nothing to compare
        XCTAssertFalse(pluginFolderSettled(stamp: "b", last: "a", handled: nil))    // still being written
        XCTAssertTrue(pluginFolderSettled(stamp: "b", last: "b", handled: "a"))     // stood still, a new state
        XCTAssertFalse(pluginFolderSettled(stamp: "b", last: "b", handled: "b"))    // already looked into: no second prepare
        XCTAssertFalse(pluginFolderSettled(stamp: nil, last: nil, handled: nil))    // the folder is gone
    }

    func testAFoldersStampMovesWithItsFilesAndLeavesOutWhatTheFingerprintLeavesOut() throws {
        let fm = FileManager.default
        let root = fm.temporaryDirectory.appendingPathComponent("ct-plugin-stamp-\(UUID().uuidString)")
        defer { try? fm.removeItem(at: root) }
        XCTAssertNil(pluginFolderStamp(root))                                         // no folder
        try fm.createDirectory(at: root.appendingPathComponent("lib"), withIntermediateDirectories: true)
        try Data("one".utf8).write(to: root.appendingPathComponent("plugin.ts"))
        try Data("two".utf8).write(to: root.appendingPathComponent("lib/more.ts"))
        let first = try XCTUnwrap(pluginFolderStamp(root))
        XCTAssertEqual(pluginFolderStamp(root), first)                                // nothing moved
        XCTAssertTrue(first.contains("/plugin.ts 3 ") && first.contains("/lib/more.ts 3 "))
        try fm.createDirectory(at: root.appendingPathComponent("node_modules/x"), withIntermediateDirectories: true)
        try Data("pkg".utf8).write(to: root.appendingPathComponent("node_modules/x/index.js"))
        try Data("x".utf8).write(to: root.appendingPathComponent(".DS_Store"))
        XCTAssertEqual(pluginFolderStamp(root), first)                                // hidden files and node_modules don't count
        try Data("three".utf8).write(to: root.appendingPathComponent("lib/more.ts"))
        XCTAssertNotEqual(pluginFolderStamp(root), first)                             // a file changed
    }

    /// Only another version of the plug-in that is on comes in by itself: never another id, never the same copy again.
    func testOnlyAnotherVersionOfThePluginThatIsOnIsTakenUp() {
        let a = String(repeating: "a", count: 64), b = String(repeating: "b", count: 64)
        let on = PluginApproval(fingerprint: a, folder: "tiny", server: true)
        func prepared(_ id: String, _ fingerprint: String) -> PluginPrepared {
            PluginPrepared(id: id, name: "Tiny", fingerprint: fingerprint, server: true, web: false)
        }
        XCTAssertEqual(pluginChange(prepared("tiny", b), id: "tiny", on: on), .takes)
        XCTAssertEqual(pluginChange(prepared("tiny", a), id: "tiny", on: on), PluginChange.none)      // the same copy: no restart
        XCTAssertEqual(pluginChange(prepared("other", b), id: "tiny", on: on), PluginChange.none)     // the folder now states another id
        XCTAssertEqual(pluginChange(prepared("tiny", "nonsense"), id: "tiny", on: on), PluginChange.none)
    }

    /// A change never gets more than the person agreed to: the alert of a plug-in with pages only never said it runs on
    /// the Mac, so a version that adds a server half waits for their click, whatever Update automatically says.
    func testAChangeThatAddsAServerHalfWaitsForAClick() {
        let a = String(repeating: "a", count: 64), b = String(repeating: "b", count: 64)
        func prepared(server: Bool, web: Bool) -> PluginPrepared {
            PluginPrepared(id: "tiny", name: "Tiny", fingerprint: b, server: server, web: web)
        }
        let pagesOnly = PluginApproval(fingerprint: a, folder: "tiny", server: false)
        XCTAssertEqual(pluginChange(prepared(server: true, web: true), id: "tiny", on: pagesOnly), .asks)
        XCTAssertEqual(pluginChange(prepared(server: true, web: false), id: "tiny", on: pagesOnly), .asks)
        XCTAssertEqual(pluginChange(prepared(server: false, web: true), id: "tiny", on: pagesOnly), .takes)   // still pages only
        let runsHere = PluginApproval(fingerprint: a, folder: "tiny", server: true)
        XCTAssertEqual(pluginChange(prepared(server: true, web: true), id: "tiny", on: runsHere), .takes)     // pages added: no more reach
        XCTAssertEqual(pluginChange(prepared(server: false, web: true), id: "tiny", on: runsHere), .takes)    // less reach
        // a record that does not say (none was ever shipped): the lesser agreement
        let old = PluginRecord.decode(Data(#"{"on":{"tiny":{"fingerprint":"\#(a)","folder":"tiny"}}}"#.utf8))
        XCTAssertEqual(old?.on["tiny"]?.server, false)
    }

    func testAPluginThatChangesFiveTimesInFiveMinutesWaitsForAClick() {
        let now = Date()
        let four = (1...4).map { now.addingTimeInterval(-Double($0) * 20) }
        XCTAssertFalse(pluginChangesTooOften(four, now: now))
        XCTAssertTrue(pluginChangesTooOften(four + [now.addingTimeInterval(-200)], now: now))
        XCTAssertFalse(pluginChangesTooOften(four + [now.addingTimeInterval(-400)], now: now))   // an old one no longer counts
    }

    func testAChangeWaitsWhileTheServerIsInTheMiddleOfSomething() {
        XCTAssertFalse(serverBusyHere(active: 0, recording: false, runsPrograms: false))
        XCTAssertTrue(serverBusyHere(active: 1, recording: false, runsPrograms: false))   // a reply being written, an AI request
        XCTAssertTrue(serverBusyHere(active: 0, recording: true, runsPrograms: false))
        XCTAssertTrue(serverBusyHere(active: 0, recording: false, runsPrograms: true))    // ffmpeg for an export
    }

    func testAProcessWithAProgramRunningIsSeen() throws {
        XCTAssertFalse(hasChildPrograms(getpid()))
        let sleeper = Process()
        sleeper.executableURL = URL(fileURLWithPath: "/bin/sleep")
        sleeper.arguments = ["30"]
        try sleeper.run()
        defer { sleeper.terminate() }
        XCTAssertTrue(hasChildPrograms(getpid()))
    }

    func testTheFifthCrashPausesPluginsOnceWhenOneIsOn() {
        XCTAssertTrue(pluginsPauseInsteadOfStopping(on: 1, paused: false))
        XCTAssertFalse(pluginsPauseInsteadOfStopping(on: 0, paused: false))   // none on: stop trying, as before
        XCTAssertFalse(pluginsPauseInsteadOfStopping(on: 2, paused: true))    // already paused: stop trying
    }

    func testTheRecordEncodesAndDecodesAndKeepsItsOwnKeychainService() {
        let fp = String(repeating: "f", count: 64)
        let tiny = PluginApprovals(on: ["tiny": PluginApproval(fingerprint: fp, folder: "tiny folder", server: true)])
        XCTAssertEqual(PluginRecord.encode(tiny).flatMap(PluginRecord.decode), tiny)
        XCTAssertNil(PluginRecord.decode(Data("not json".utf8)))
        XCTAssertNil(PluginRecord.decode(Data(#"{"tiny":"\#(fp)"}"#.utf8)))          // not this record's shape: nothing is on
        // Update automatically is on until it is switched off, and the switch is kept with the clicks
        XCTAssertFalse(tiny.waits)
        XCTAssertEqual(PluginRecord.decode(Data(#"{"on":{}}"#.utf8)), PluginApprovals())
        XCTAssertEqual(PluginRecord.encode(PluginApprovals(waits: true)).flatMap(PluginRecord.decode)?.waits, true)
        // the test's own service: the app's real Keychain items are never read or written here
        let store = PluginRecord(service: "com.creatortoolset.mac.tests.plugins")
        defer { store.remove() }
        store.remove()
        // a test run has no provisioning profile: the record is in the file-based Keychain, and the app knows it
        XCTAssertFalse(store.protected)
        XCTAssertEqual(store.load(), PluginApprovals())
        XCTAssertTrue(store.save(tiny))
        XCTAssertEqual(store.load(), tiny)
        XCTAssertTrue(store.save(PluginApprovals(waits: true)))
        XCTAssertEqual(store.load(), PluginApprovals(waits: true))
    }
}
