import Foundation
import XCTest
@testable import CreatorToolsetMac

/// A server's runner that only remembers what was asked of it.
private final class FakeRelay: HostRelay {
    var started = false
    var stopped = false
    var reports = 0
    var models = 0
    var isStopped: Bool { stopped }
    func start() { started = true }
    func stop() { stopped = true }
    func reportNow() { reports += 1 }
    func modelsChanged() { models += 1 }
}

@MainActor
final class RunnersTests: XCTestCase {
    private let a = URL(string: "https://a.example.com")!
    private let b = URL(string: "https://b.example.com")!
    private var made: [String: [FakeRelay]] = [:]
    private var folder: URL!
    private var defaults: UserDefaults!

    override func setUp() async throws {
        folder = FileManager.default.temporaryDirectory.appendingPathComponent("runners-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defaults = UserDefaults(suiteName: "runners-\(UUID().uuidString)")
    }

    override func tearDown() async throws {
        try? FileManager.default.removeItem(at: folder)
    }

    /// Runners whose runners are fakes and whose workers run `script` (in place of node dist/boot.js).
    private func runners(script: String = "sleep 30") -> Runners {
        let r = Runners()
        r.make = { [unowned self] host, _, _, _ in
            let relay = FakeRelay()
            made[host, default: []].append(relay)
            let w = Worker(folder: folder)
            w.program = (URL(fileURLWithPath: "/bin/sh"), ["-c", script])
            return (relay, w)
        }
        return r
    }

    private func relay(_ r: Runners, _ host: String) -> FakeRelay? { r.relay(for: host) as? FakeRelay }

    private func startWorker(_ r: Runners, _ host: String, data: String) -> Bool {
        r.worker(for: host)!.start(server: URL(string: "https://\(host)")!, token: "ctd_\(host)",
                                   data: folder.appendingPathComponent(data), thisMac: false, plugins: [:])
    }

    private func wait(_ what: String, timeout: TimeInterval = 10, until done: () -> Bool) async throws {
        let end = Date().addingTimeInterval(timeout)
        while !done() && Date() < end { try await Task.sleep(for: .milliseconds(50)) }
        XCTAssertTrue(done(), what)
    }

    private func pids(_ name: String) -> [pid_t] {
        ((try? String(contentsOf: folder.appendingPathComponent(name), encoding: .utf8)) ?? "")
            .split(whereSeparator: \.isNewline).compactMap { pid_t($0) }
    }

    // 30
    func testEveryServerSwitchedOnRunsWhateverTheWindowShows() {
        let r = runners()
        r.sync(["a.example.com": a, "b.example.com": b], token: { "t-\($0)" })
        XCTAssertEqual(relay(r, "a.example.com")?.started, true)
        XCTAssertEqual(relay(r, "b.example.com")?.started, true)
        r.windowHost = "b.example.com"
        r.sync(["a.example.com": a, "b.example.com": b], token: { "t-\($0)" })
        XCTAssertEqual(relay(r, "a.example.com")?.stopped, false)
        XCTAssertEqual(made["a.example.com"]?.count, 1, "the window's change restarts nothing")
        // 33: a disk or a speech model change reaches every server's runner (Shell's Places and SpeechModels sinks)
        r.forEach { $0.reportNow(); $0.modelsChanged() }
        XCTAssertEqual([relay(r, "a.example.com")?.reports, relay(r, "b.example.com")?.reports], [1, 1])
        XCTAssertEqual([relay(r, "a.example.com")?.models, relay(r, "b.example.com")?.models], [1, 1])
    }

    // 31
    func testARefusalOrAFailedPairingTouchesOnlyItsServer() {
        let r = runners()
        var tokens = ["a.example.com": "tA", "b.example.com": "tB"]
        var switches = HostSwitches(defaults: defaults, paired: [])
        switches.set("a.example.com", true)
        switches.set("b.example.com", true)
        let want = { [a, b] in ["a.example.com": a, "b.example.com": b].filter { switches.runs($0.key) } }
        r.sync(want(), token: { tokens[$0] })

        // A refused: only A stops and goes off
        XCTAssertTrue(r.refused(host: "a.example.com", token: "tA", vault: tokens["a.example.com"]))
        r.stop(host: "a.example.com")
        switches.set("a.example.com", false)
        r.sync(want(), token: { tokens[$0] })
        XCTAssertNil(r.relay(for: "a.example.com"))
        XCTAssertEqual(relay(r, "b.example.com")?.stopped, false)
        XCTAssertFalse(switches.aiOn("a.example.com"))
        XCTAssertTrue(switches.aiOn("b.example.com"))
        XCTAssertTrue(removedNotice("a.example.com").contains("a.example.com"))

        // a late refusal from B's replaced runner (old token) removes nothing; B starts again on the new token
        relay(r, "b.example.com")?.stop()   // the refused runner stops itself (Relay.swift)
        tokens["b.example.com"] = "tB2"
        XCTAssertFalse(r.refused(host: "b.example.com", token: "tB", vault: tokens["b.example.com"]))
        r.sync(want(), token: { tokens[$0] })
        XCTAssertEqual(made["b.example.com"]?.count, 2)
        XCTAssertEqual(r.handles["b.example.com"]?.token, "tB2")
        XCTAssertEqual(relay(r, "b.example.com")?.started, true)

        // a failed pairing on B: B is out, its switch stays, A (on again) keeps running; shown again, B is tried again
        switches.set("a.example.com", true)
        r.sync(want(), token: { tokens[$0] })
        switches.pairFailed.insert("b.example.com")
        let hosts = { runnerHosts(listed: [self.a, self.b], on: switches.runs, hasToken: { tokens[$0] != nil }, localHost: nil, localRunning: false) }
        XCTAssertEqual(hosts(), ["a.example.com"])
        XCTAssertEqual(switches.on["b.example.com"], true)
        r.sync(want(), token: { tokens[$0] })
        XCTAssertNotNil(r.relay(for: "a.example.com"))
        XCTAssertNil(r.relay(for: "b.example.com"))
        switches.pairFailed.remove("b.example.com")
        XCTAssertEqual(hosts(), ["a.example.com", "b.example.com"])
    }

    // 32
    func testTheSwitchIsPerServer() {
        defaults.set(true, forKey: HostSwitches.oldKey)
        var switches = HostSwitches(defaults: defaults, paired: ["a.example.com", "b.example.com"])
        XCTAssertEqual(switches.on, ["a.example.com": true, "b.example.com": true])
        XCTAssertTrue(defaults.bool(forKey: HostSwitches.migratedKey))
        // once: a later launch does not migrate again
        defaults.set(false, forKey: HostSwitches.oldKey)
        XCTAssertEqual(HostSwitches(defaults: defaults, paired: ["c.example.com"]).on["c.example.com"], nil)
        defaults.set(true, forKey: HostSwitches.oldKey)

        let tokens = ["a.example.com": "tA", "b.example.com": "tB", "c.example.com": "tC"]
        let hosts = { (listed: [URL], localRunning: Bool) in
            runnerHosts(listed: listed, on: switches.runs, hasToken: { tokens[$0] != nil }, localHost: "127.0.0.1", localRunning: localRunning)
        }
        switches.set("a.example.com", false)
        XCTAssertEqual(hosts([a, b], false), ["b.example.com"])
        XCTAssertTrue(switches.aiOn("b.example.com"))
        XCTAssertTrue(switches.aiDefault)
        switches.set("a.example.com", true)
        XCTAssertEqual(hosts([a, b], false), ["a.example.com", "b.example.com"])
        // kept across launches
        XCTAssertEqual(HostSwitches(defaults: defaults, paired: []).on["a.example.com"], true)

        // paired later, no entry: follows the frozen default
        let c = URL(string: "https://c.example.com")!
        XCTAssertTrue(hosts([c], false).contains("c.example.com"))
        // no token: out
        XCTAssertEqual(hosts([URL(string: "https://d.example.com")!], false), [])
        // This Mac's own server only while it runs
        let local = URL(string: "http://127.0.0.1:43128")!
        let localSwitch = runnerHosts(listed: [local], on: { _ in true }, hasToken: { _ in true }, localHost: "127.0.0.1", localRunning: false)
        XCTAssertEqual(localSwitch, [])
        XCTAssertEqual(runnerHosts(listed: [local], on: { _ in true }, hasToken: { _ in true }, localHost: "127.0.0.1", localRunning: true), ["127.0.0.1"])

        // a token change restarts that server's runner, and only that one
        let r = runners()
        r.sync(["a.example.com": a, "b.example.com": b], token: { tokens[$0] })
        r.sync(["a.example.com": a, "b.example.com": b], token: { $0 == "a.example.com" ? "tA2" : tokens[$0] })
        XCTAssertEqual(made["a.example.com"]?.count, 2)
        XCTAssertEqual(made["a.example.com"]?.first?.stopped, true)
        XCTAssertEqual(made["b.example.com"]?.count, 1)
        // switched off: stopped
        r.sync(["b.example.com": b], token: { tokens[$0] })
        XCTAssertNil(r.relay(for: "a.example.com"))
    }

    // 34
    func testOneWorkerPerServerAndQuitStopsThemAllAtOnce() async throws {
        // each worker notes its pid, its turn folder and a child's pid, and ignores SIGTERM (only the group kill ends it)
        let r = runners(script: "trap '' TERM; echo $$ >> \"$DATA_DIR/../pids\"; echo \"$CT_TURN_DIR\" >> \"$DATA_DIR/../turns\"; sleep 30 & echo $! >> \"$DATA_DIR/../pids\"; wait")
        r.sync(["a.example.com": a, "b.example.com": b], token: { "t-\($0)" })
        XCTAssertTrue(startWorker(r, "a.example.com", data: "a/work"))
        // B's step waits while A's worker runs: B's worker starts too
        XCTAssertTrue(startWorker(r, "b.example.com", data: "b/work"))
        try await wait("both started") { self.pids("a/pids").count == 2 && self.pids("b/pids").count == 2 }
        let turns = ["a", "b"].map { (try? String(contentsOf: folder.appendingPathComponent("\($0)/turns"), encoding: .utf8)) ?? "" }
        XCTAssertEqual(turns[0], turns[1])
        XCTAssertFalse(turns[0].isEmpty)

        // each worker's row names its server
        XCTAssertEqual(workRow(WorkStatus(editId: "e", edit: "x"), host: "a.example.com").id, "work:a.example.com")
        XCTAssertEqual(workRow(WorkStatus(editId: "e", edit: "x"), host: "b.example.com").id, "work:b.example.com")

        let all = pids("a/pids") + pids("b/pids")
        let start = Date()
        r.stopAll(grace: 2)
        // one grace for both, not one after the other (that would be over 4.5 s)
        XCTAssertLessThan(Date().timeIntervalSince(start), 3.5)
        try await wait("nothing left behind") { all.allSatisfy { kill($0, 0) != 0 } }
        XCTAssertTrue(r.isEmpty)
        XCTAssertEqual(made["a.example.com"]?.first?.stopped, true)
        XCTAssertEqual(made["b.example.com"]?.first?.stopped, true)
    }

    // 36
    func testAnotherServersErrorIsLoggedOnceAndNeverLightsTheDot() {
        let r = runners()
        r.sync(["a.example.com": a, "b.example.com": b], token: { "t-\($0)" })
        r.windowHost = "a.example.com"
        var lines: [String] = []
        for _ in 0..<20 {
            if let line = r.note(AIStatus(lastError: "the server did not answer"), host: "b.example.com") { lines.append(line) }
        }
        XCTAssertEqual(lines, ["relay b.example.com: the server did not answer"])
        XCTAssertNil(r.windowStatus.lastError, "no dot for another server")
        XCTAssertEqual(r.note(AIStatus(), host: "b.example.com"), "relay b.example.com: ok")
        XCTAssertNil(r.note(AIStatus(), host: "b.example.com"))
        _ = r.note(AIStatus(lastError: "refused"), host: "a.example.com")
        XCTAssertEqual(r.windowStatus.lastError, "refused", "the window's server's error is the dot")

        // the counts are every server's
        _ = r.note(AIStatus(running: 2), host: "b.example.com")
        _ = r.note(AIStatus(running: 1, drawing: true), host: "a.example.com")
        XCTAssertEqual(r.running, 3)
        XCTAssertTrue(r.drawing)
        // a stopped server's count goes with it
        r.stop(host: "b.example.com")
        XCTAssertEqual(r.running, 1)

        // an update waits for the AI jobs, but never past 30 min
        XCTAssertTrue(aiHoldsUpdate(running: 1, drawing: false, waited: 29 * 60))
        XCTAssertFalse(aiHoldsUpdate(running: 1, drawing: false, waited: 30 * 60))
        XCTAssertFalse(aiHoldsUpdate(running: 0, drawing: false, waited: 0))
        XCTAssertTrue(aiHoldsUpdate(running: 0, drawing: true, waited: 0))
    }
}
