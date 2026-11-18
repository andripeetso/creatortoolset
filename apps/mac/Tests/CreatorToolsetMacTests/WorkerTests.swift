import Foundation
import XCTest
@testable import CreatorToolsetMac

@MainActor
final class WorkerTests: XCTestCase {
    private var folder: URL!

    override func setUp() async throws {
        folder = FileManager.default.temporaryDirectory.appendingPathComponent("worker-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    }

    override func tearDown() async throws {
        try? FileManager.default.removeItem(at: folder)
    }

    /// A worker whose program is a shell script (in place of node dist/boot.js), run in `folder` with the real env.
    private func worker(_ script: String) -> Worker {
        let w = Worker(folder: folder)
        w.program = (URL(fileURLWithPath: "/bin/sh"), ["-c", script])
        return w
    }

    private func start(_ w: Worker, thisMac: Bool = false) -> Bool {
        w.start(server: URL(string: "https://studio.example.com")!, token: "ctd_test", data: folder.appendingPathComponent("work"),
                thisMac: thisMac, plugins: [:])
    }

    /// Polls with Task.sleep (never spinning the main run loop by hand: that lets AppKit free what earlier tests left).
    private func wait(_ what: String, timeout: TimeInterval = 10, until done: () -> Bool) async throws {
        let end = Date().addingTimeInterval(timeout)
        while !done() && Date() < end { try await Task.sleep(for: .milliseconds(50)) }
        XCTAssertTrue(done(), what)
    }

    private func exists(_ name: String) -> Bool {
        FileManager.default.fileExists(atPath: folder.appendingPathComponent("work/\(name)").path)
    }

    func testEnvironmentNamesTheServerTokenAndDataFolderAndServesNothing() {
        let app = URL(fileURLWithPath: "/Applications/Creator Toolset.app/Contents/Resources/server")
        let env = workerEnvironment(server: URL(string: "https://studio.example.com")!, token: "ctd_abc",
                                    data: URL(fileURLWithPath: "/x/relay/studio.example.com/work"), folder: app,
                                    inherited: ["HOME": "/Users/me", "SECRET": "no", "PORT": "1"],
                                    plugins: ["CT_PLUGINS_ON": "face-blur"], release: ["CT_CHANNEL": "release"])
        XCTAssertEqual(env["CT_WORKER"], "https://studio.example.com")
        XCTAssertEqual(env["CT_DEVICE_TOKEN"], "ctd_abc")
        XCTAssertEqual(env["DATA_DIR"], "/x/relay/studio.example.com/work")
        XCTAssertEqual(env["PATH"]?.components(separatedBy: ":").first, app.appendingPathComponent("runtime").path)
        XCTAssertEqual(env["CT_PLUGINS_ON"], "face-blur")
        XCTAssertEqual(env["CT_CHANNEL"], "release")
        XCTAssertEqual(env["CT_EXIT_WITH_PARENT"], "1")
        // one folder for every server's worker: one job at a time on this Mac (api/work/turn.ts)
        XCTAssertEqual(env["CT_TURN_DIR"], appSupport.appendingPathComponent("work-turn").path)
        XCTAssertEqual(env["PLAYWRIGHT_BROWSERS_PATH"], appSupport.appendingPathComponent("runtime/chromium").path)
        XCTAssertEqual(env["HOME"], "/Users/me")
        for key in ["PORT", "HOST", "APP_SECRET", "CT_LOCAL", "SECRET"] { XCTAssertNil(env[key], key) }
    }

    func testNoWorkerWhileTheWindowShowsThisMac() async throws {
        let w = worker("touch \"$DATA_DIR/ran\"; sleep 5")
        XCTAssertFalse(start(w, thisMac: true))
        XCTAssertFalse(w.isRunning)
        try await Task.sleep(for: .milliseconds(300))
        XCTAssertFalse(exists("ran"))
    }

    func testOneWorkerAtMost() async throws {
        let w = worker("echo $$ >> \"$DATA_DIR/started\"; sleep 30")
        XCTAssertTrue(start(w))
        XCTAssertTrue(start(w))
        try await wait("the worker started") { exists("started") }
        try await Task.sleep(for: .milliseconds(300))
        let lines = (try? String(contentsOf: folder.appendingPathComponent("work/started"), encoding: .utf8))?.split(separator: "\n")
        XCTAssertEqual(lines?.count, 1)
        w.stop()
        XCTAssertFalse(w.isRunning)
    }

    func testExit3AsksForTheUpdateAndNoWorkerStartsAgain() async throws {
        let w = worker("exit 3")
        var asked = 0
        w.onNeedsUpdate = { asked += 1 }
        XCTAssertTrue(start(w))
        try await wait("the worker ended asking for an update") { w.needsUpdate }
        XCTAssertEqual(asked, 1)
        XCTAssertFalse(w.isRunning)
        XCTAssertFalse(start(w))
        XCTAssertFalse(w.isRunning)
    }

    func testIdleExitIsNoUpdateAndALaterHintStartsItAgain() async throws {
        let w = worker("exit 0")
        XCTAssertTrue(start(w))
        try await wait("the worker ended") { !w.isRunning }
        XCTAssertFalse(w.needsUpdate)
        XCTAssertTrue(start(w))
        w.stop()
    }

    func testCancelSendsTheSignalAndStatusLinesReachTheMenu() async throws {
        let w = worker("""
            trap 'touch "$DATA_DIR/cancelled"; exit 0' USR2
            echo '[work:status] {"editId":"e1","edit":"Beach day","done":340000000,"total":1200000000,"leftS":180}'
            touch "$DATA_DIR/ready"
            while :; do sleep 0.1; done
            """)
        XCTAssertTrue(start(w))
        try await wait("the status line came") { w.status != nil }
        XCTAssertEqual(w.status?.edit, "Beach day")
        try await wait("the script is ready") { exists("ready") }
        w.cancel()
        try await wait("the worker got SIGUSR2") { exists("cancelled") }
        try await wait("the worker ended") { !w.isRunning }
        XCTAssertNil(w.status)
    }

    func testStatusLinesAndTheMenuRow() throws {
        XCTAssertNil(workStatusLine("[work] claim: offline"))
        XCTAssertEqual(workStatusLine("[work:status] null")!, nil)
        let s = try XCTUnwrap(workStatusLine(#"[work:status] {"editId":"e1","edit":"Beach day","line":"downloading proxies","done":340000000,"total":1200000000,"leftS":180}"#) ?? nil)
        XCTAssertEqual(workDetail(s), "downloading proxies, 340 MB of 1.2 GB, about 3 min left")
        let row = workRow(s)
        XCTAssertEqual(row.title, "Working on Beach day")
        XCTAssertEqual(row.href, "/editor/e1")
        XCTAssertEqual(row.actions.map(\.run), [workCancelVerb])
        XCTAssertEqual(row.progress ?? 0, 340.0 / 1200.0, accuracy: 0.001)
        XCTAssertEqual(workDetail(WorkStatus(editId: "e", edit: "x", line: "analysing")), "analysing")
        XCTAssertEqual(workBytes(0), "0 MB")
        XCTAssertEqual(workBytes(12_400_000_000), "12 GB")
        XCTAssertEqual(workTimeLeft(30), "under a minute")
        XCTAssertEqual(workTimeLeft(3900), "about 1 h 5 min")
    }

    private func lines(_ name: String) -> [Int32] {
        ((try? String(contentsOf: folder.appendingPathComponent("work/\(name)"), encoding: .utf8)) ?? "")
            .split(separator: "\n").compactMap { Int32($0) }
    }

    /// PRD 28: a worker that says nothing (hung) is replaced on the next hint: start() returns at once, its whole group
    /// (node and the ffmpeg it started) goes, and the new one starts only after it ended.
    func testASilentWorkerIsReplacedWithItsChildrenAndNeverTwoAtOnce() async throws {
        let w = worker("""
            for p in $(cat "$DATA_DIR/started" 2>/dev/null); do kill -0 $p 2>/dev/null && touch "$DATA_DIR/overlap"; done
            echo $$ >> "$DATA_DIR/started"
            sleep 30 &
            echo $! >> "$DATA_DIR/children"
            wait
            """)
        w.silentAfter = 0.2
        XCTAssertTrue(start(w))
        try await wait("the worker and its child started") { lines("children").count == 1 }
        XCTAssertTrue(start(w))   // not silent yet: nothing happens
        try await Task.sleep(for: .milliseconds(400))
        XCTAssertTrue(w.isSilent)
        let t = Date()
        XCTAssertTrue(start(w))
        XCTAssertLessThan(Date().timeIntervalSince(t), 0.1)
        try await wait("a new worker started", timeout: 20) { lines("started").count == 2 }
        let (old, child) = (lines("started")[0], lines("children")[0])
        XCTAssertNotEqual(kill(old, 0), 0, "the old worker is gone")
        try await wait("its child is gone") { kill(child, 0) != 0 }
        XCTAssertFalse(exists("overlap"))
        XCTAssertTrue(w.isRunning)
        XCTAssertFalse(w.isSilent)
        w.stop()
        for c in lines("children") { kill(c, SIGKILL) }
    }

    /// PRD 29: `[work:alive]` keeps it from being silent, replaces nothing, and never reaches the log.
    func testAnAliveWorkerIsNeverReplacedAndItsAliveLinesAreNotLogged() async throws {
        let w = worker("""
            echo $$ >> "$DATA_DIR/started"
            while :; do echo '[work:alive]'; sleep 0.05; done
            """)
        w.silentAfter = 0.2
        XCTAssertTrue(start(w))
        try await Task.sleep(for: .milliseconds(500))
        XCTAssertFalse(w.isSilent)
        XCTAssertTrue(start(w))
        try await Task.sleep(for: .milliseconds(300))
        XCTAssertEqual(lines("started").count, 1)
        let log = (try? String(contentsOfFile: AppLog.path, encoding: .utf8)) ?? ""
        XCTAssertFalse(log.contains("worker: [work:alive]"))
        w.stop()
        XCTAssertFalse(Worker(folder: folder).needsUpdate)
    }

    func testTheLongPollsWorkHint() {
        XCTAssertTrue(RelayRunner.workWaits(Data(#"{"work":true}"#.utf8)))
        XCTAssertFalse(RelayRunner.workWaits(Data(#"{"editor":true}"#.utf8)))
    }
}
