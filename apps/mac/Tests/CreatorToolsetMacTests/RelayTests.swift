import Foundation
import XCTest
@testable import CreatorToolsetMac

/// The device relay, offline: the request's checks, the claude command line and environment, the stream
/// reading, usage, folder sync, sessions and the Mac report.
final class RelayTests: XCTestCase {
    private func temp() -> URL {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("relay-test-\(UUID().uuidString)")
        try! FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }

    private func request(_ json: String) -> RelayRequest {
        RelayRequest(json: Data(json.utf8))!
    }

    private func object(_ json: String) -> [String: Any] {
        try! JSONSerialization.jsonObject(with: Data(json.utf8)) as! [String: Any]
    }

    // MARK: request

    func testRequestDefaultsAndFiles() {
        let r = request(#"{"id":"j1","system":"S","user":"U","files":{"a.md":"x","n":3},"session":"s-1"}"#)
        XCTAssertEqual(r.id, "j1")
        XCTAssertEqual(r.driver, "claude")
        XCTAssertEqual(r.effort, "xhigh")
        XCTAssertEqual(r.files, ["a.md": "x"])
        XCTAssertFalse(r.web)
        XCTAssertNil(RelayRequest(json: Data(#"{"system":"S"}"#.utf8)))   // no id: nothing to answer
    }

    func testOnlyClaudeRunsHereAndOthersFailWithTheSameWords() {
        let root = temp()
        for driver in ["grok", "codex", "cursor"] {
            let r = request(#"{"id":"j","system":"","user":"","driver":"\#(driver)"}"#)
            XCTAssertThrowsError(try requestOptions(r, root: root)) { error in
                XCTAssertEqual((error as? RelayError)?.message, "This Mac runs Claude only for now")
            }
        }
    }

    func testEffortModelAndResumeAreChecked() throws {
        let root = temp()
        let ok = try requestOptions(request(#"{"id":"j","system":"","user":""}"#), root: root)
        XCTAssertEqual(ok, RelayOptions(model: "claude-opus-5-5", effort: "xhigh", home: "", resume: ""))
        XCTAssertThrowsError(try requestOptions(request(#"{"id":"j","system":"","user":"","effort":"ultra"}"#), root: root))
        XCTAssertThrowsError(try requestOptions(request(#"{"id":"j","system":"","user":"","model":"gpt-5"}"#), root: root))
        XCTAssertThrowsError(try requestOptions(request(#"{"id":"j","system":"","user":"","resume":"a b"}"#), root: root))
        XCTAssertThrowsError(try requestOptions(request(#"{"id":"j","system":"","user":"","resume":"abc\n"}"#), root: root))
        let resumed = try requestOptions(request(#"{"id":"j","system":"","user":"","resume":"0f3c-9a"}"#), root: root)
        XCTAssertEqual(resumed.resume, "0f3c-9a")
    }

    func testHomeMustBeAFolderUnderTheHomeNotTheHomeItself() throws {
        let root = temp()
        let hub = root.appendingPathComponent(".claude-work")
        try FileManager.default.createDirectory(at: hub, withIntermediateDirectories: true)
        let home = try requestOptions(request(#"{"id":"j","system":"","user":"","home":"\#(hub.path)"}"#), root: root)
        XCTAssertEqual(home.home, realPath(hub.path))
        XCTAssertThrowsError(try checkedHome(root.path, root: root))                  // the home itself
        XCTAssertThrowsError(try checkedHome("/usr", root: root))                     // outside
        XCTAssertThrowsError(try checkedHome(root.appendingPathComponent("nope").path, root: root))   // missing
    }

    // MARK: command line and environment

    func testPlainRunHasNoToolsAndNoSession() {
        let args = claudeArguments(model: "claude-opus-5-5", effort: "xhigh", systemFile: "/tmp/s.txt", tools: "", session: false, resume: "")
        XCTAssertEqual(args.prefix(2), ["-p", "--model"])
        XCTAssertTrue(args.contains("--no-session-persistence"))
        XCTAssertTrue(args.contains("--strict-mcp-config"))
        XCTAssertEqual(args[args.firstIndex(of: "--setting-sources")! + 1], "")
        XCTAssertEqual(args[args.firstIndex(of: "--tools")! + 1], "")
        XCTAssertFalse(args.contains("--allowedTools"))
        XCTAssertFalse(args.contains("--resume"))
    }

    func testFolderAndWebGetTheReadTools() {
        let tools = [readTools, webTools].joined(separator: ",")
        let args = claudeArguments(model: "claude-opus-5-5", effort: "low", systemFile: "/tmp/s.txt", tools: tools, session: false, resume: "")
        XCTAssertEqual(args[args.firstIndex(of: "--tools")! + 1], "Read,Glob,Grep,WebSearch,WebFetch")
        XCTAssertEqual(args[args.firstIndex(of: "--allowedTools")! + 1], "Read,Glob,Grep,WebSearch,WebFetch")
        XCTAssertEqual(args[args.firstIndex(of: "--permission-mode")! + 1], "dontAsk")
    }

    func testSessionKeepsItsTranscriptAndResumes() {
        let args = claudeArguments(model: "claude-opus-5-5", effort: "xhigh", systemFile: "/tmp/s.txt", tools: readTools, session: true, resume: "abc-1")
        XCTAssertFalse(args.contains("--no-session-persistence"))
        XCTAssertEqual(args[args.firstIndex(of: "--resume")! + 1], "abc-1")
    }

    func testHomeEnvComesFromSettingsWithoutTheKeyOrNumbers() throws {
        let home = temp()
        let settings = #"{"env":{"ANTHROPIC_BASE_URL":"https://proxy.example:8317","ANTHROPIC_AUTH_TOKEN":"t-1","ANTHROPIC_API_KEY":"sk-x","FLAG":"1","NUM":3}}"#
        try settings.write(to: home.appendingPathComponent("settings.json"), atomically: true, encoding: .utf8)
        let base = ["PATH": "/usr/bin", "ANTHROPIC_API_KEY": "sk-base", "ANTHROPIC_BASE_URL": "https://base", "CLAUDE_CONFIG_DIR": "/x"]
        let env = claudeEnv(base: base, home: home.path)
        XCTAssertEqual(env["ANTHROPIC_BASE_URL"], "https://proxy.example:8317")
        XCTAssertEqual(env["ANTHROPIC_AUTH_TOKEN"], "t-1")
        XCTAssertEqual(env["FLAG"], "1")
        XCTAssertNil(env["NUM"])
        XCTAssertNil(env["ANTHROPIC_API_KEY"])
        XCTAssertEqual(env["CLAUDE_CONFIG_DIR"], home.path)
        XCTAssertEqual(env["PATH"], "/usr/bin")
        XCTAssertEqual(env["CLAUDE_CODE_DISABLE_AUTO_MEMORY"], "1")
    }

    func testNoHomeIsTheSubscriptionEnvAsBefore() {
        let env = claudeEnv(base: ["ANTHROPIC_API_KEY": "k", "ANTHROPIC_BASE_URL": "u", "CLAUDE_CONFIG_DIR": "/x"], home: "")
        XCTAssertNil(env["ANTHROPIC_API_KEY"])
        XCTAssertNil(env["ANTHROPIC_BASE_URL"])
        XCTAssertNil(env["CLAUDE_CONFIG_DIR"])
        XCTAssertEqual(env["CLAUDE_CODE_DISABLE_CLAUDE_MDS"], "1")
    }

    // MARK: stream

    /// The fixture of the Mac relay's FAKE: says a word between reads, then the JSON answer.
    private func fixtureLines() -> [String] {
        [
            #"{"type":"stream_event","event":{"type":"message_start"}}"#,
            #"{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"Let me look "}}}"#,
            #"{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"at the posts."}}}"#,
            #"{"type":"assistant","message":{"id":"msg_1","usage":{"input_tokens":4,"output_tokens":2},"content":[{"type":"tool_use","name":"Read","input":{"file_path":"CWD/my-posts/INDEX.md"}},{"type":"tool_use","name":"WebSearch","input":{"query":"tummy time crawling onset study"}},{"type":"text","text":"not a step"}]}}"#,
            #"{"type":"stream_event","event":{"type":"message_start"}}"#,
            #"{"type":"stream_event","event":{"type":"content_block_start","content_block":{"type":"thinking"}}}"#,
            #"{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"{\"reply\": "}}}"#,
            #"{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"\"done\"}"}}}"#,
            #"{"type":"assistant","message":{"id":"msg_2","usage":{"input_tokens":9,"output_tokens":3},"content":[]}}"#,
            #"{"type":"result","result":"{\"reply\": \"done\"}","session_id":"s-1","modelUsage":{"claude-opus-5-5":{"inputTokens":13,"outputTokens":5}},"total_cost_usd":0.25}"#,
        ]
    }

    func testStreamFollowsTextStepsThinkingUsageAndResult() {
        let cwd = temp().path
        var stream = ClaudeStream(cwd: realPath(cwd))
        var updates: [StreamUpdate] = []
        for line in fixtureLines().map({ $0.replacingOccurrences(of: "CWD", with: realPath(cwd)) }) {
            updates += stream.feed(line)
        }
        XCTAssertEqual(updates.compactMap { if case .step(let s) = $0 { return s } else { return nil } },
                       ["Read my-posts/INDEX.md", "Searched the web: \"tummy time crawling onset study\"", "Thinking"])
        XCTAssertEqual(stream.text, "{\"reply\": \"done\"}")                 // the last message's text only
        XCTAssertEqual(stream.seen["msg_1"]?["output_tokens"] as? Int, 2)
        XCTAssertEqual(stream.result?["session_id"] as? String, "s-1")
    }

    func testStreamSkipsLinesThatAreNotJSON() {
        var stream = ClaudeStream(cwd: "/tmp")
        XCTAssertEqual(stream.feed("warning: something"), [])
        XCTAssertEqual(stream.feed("{not json"), [])
    }

    func testToolStepLabelsReadInsideTheFolderAndNameOutside() {
        let cwd = realPath(temp().path)
        func label(_ name: String, _ input: [String: Any]) -> String {
            toolStep(["type": "tool_use", "name": name, "input": input], cwd: cwd)
        }
        XCTAssertEqual(label("Read", ["file_path": cwd + "/sessions/INDEX.md"]), "Read sessions/INDEX.md")
        XCTAssertEqual(label("Read", ["file_path": "/etc/hosts"]), "Read /etc/hosts")
        XCTAssertEqual(label("Grep", ["pattern": "hook", "path": cwd]), "Searched . for \"hook\"")
        XCTAssertEqual(label("Grep", ["pattern": "hook"]), "Searched the folder for \"hook\"")
        XCTAssertEqual(label("Glob", ["pattern": "**/*.md"]), "Looked for **/*.md")
        XCTAssertEqual(label("WebFetch", ["url": "https://example.com"]), "Read https://example.com")
        XCTAssertEqual(label("Bash", ["command": "ls"]), "")
    }

    // MARK: usage, limits, sessions

    func testUsageRowSumsAndRefusesAnotherModel() throws {
        let result = object(#"{"modelUsage":{"claude-opus-5-5":{"inputTokens":10,"outputTokens":5,"cacheReadInputTokens":7,"costUSD":0.5}},"total_cost_usd":0.123456,"duration_ms":900}"#)
        let row = try usageRow(result, model: "claude-opus-5-5")
        XCTAssertEqual(row["input"] as? Int, 10)
        XCTAssertEqual(row["output"] as? Int, 5)
        XCTAssertEqual(row["cache_read"] as? Int, 7)
        XCTAssertEqual(row["cost_usd"] as? Double, 0.1235)
        XCTAssertEqual(row["ms"] as? Int, 900)
        XCTAssertThrowsError(try usageRow(result, model: "claude-haiku-5-5")) { error in
            XCTAssertTrue((error as? RelayError)?.message.contains("not claude-haiku-5-5") == true)
        }
    }

    func testFailedRowKeepsWhatItCanWithoutAModelCheck() {
        let row = failedRow(object(#"{"is_error":true,"result":"oops","total_cost_usd":0.02}"#), model: "claude-opus-5-5")
        XCTAssertEqual(row["models"] as? [String], [])
        XCTAssertEqual(row["cost_usd"] as? Double, 0.02)
    }

    func testStoppedRowAddsWhatEachMessageShowed() {
        let row = stoppedRow(["a": ["input_tokens": 3, "output_tokens": 4], "b": ["input_tokens": 1, "output_tokens": 2]])
        XCTAssertEqual(row["input"] as? Int, 4)
        XCTAssertEqual(row["output"] as? Int, 6)
        XCTAssertEqual(row["partial"] as? Bool, true)
    }

    func testLimitWordsAndAGoneSession() {
        XCTAssertTrue(isLimitError("Claude AI usage limit reached|1700000000"))
        XCTAssertTrue(isLimitError("You've hit your session limit"))
        XCTAssertFalse(isLimitError("API Error 500"))
        XCTAssertTrue(isGone(text: "", result: nil, err: "No conversation found with session ID: x"))
        XCTAssertFalse(isGone(text: "some answer", result: nil, err: "No conversation found"))
        XCTAssertTrue(isGone(text: "", result: ["is_error": true, "result": "No conversation found"], err: ""))
    }

    func testSessionFolderIsStableAndSafe() {
        let root = temp()
        let folder = sessionFolder("a b/../c", root: root)
        XCTAssertEqual(folder.deletingLastPathComponent().lastPathComponent, "a_b____c")
        XCTAssertEqual(folder.lastPathComponent, "folder")
        XCTAssertEqual(sessionFolder("a b/../c", root: root), folder)
    }

    func testAFolderNobodyUsedForTwoWeeksGoes() throws {
        let root = temp()
        let old = root.appendingPathComponent("old")
        let fresh = root.appendingPathComponent("fresh")
        try FileManager.default.createDirectory(at: old, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: fresh, withIntermediateDirectories: true)
        let now = Date()
        try FileManager.default.setAttributes([.modificationDate: now.addingTimeInterval(-15 * 86400)], ofItemAtPath: old.path)
        pruneSessions(root: root, now: now)
        XCTAssertFalse(FileManager.default.fileExists(atPath: old.path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: fresh.path))
    }

    // MARK: folder

    func testBigFilesAreFetchedOnceKeptAndChecked() throws {
        let cache = temp().appendingPathComponent("blobs")
        let book = String(repeating: "a book\n", count: 10)
        let sha = sha256Hex(book)
        var fetched = 0
        let fetch: (String) throws -> String? = { got in
            XCTAssertEqual(got, sha)
            fetched += 1
            return book
        }
        XCTAssertEqual(try resolveBlobs(["context/b.md": "sha256:\(sha)", "x.md": "small"], cache: cache, fetch: fetch), ["context/b.md": book, "x.md": "small"])
        XCTAssertEqual(try resolveBlobs(["context/b.md": "sha256:\(sha)"], cache: cache, fetch: fetch)["context/b.md"], book)
        XCTAssertEqual(fetched, 1)
        XCTAssertThrowsError(try resolveBlobs(["c.md": "sha256:" + String(repeating: "0", count: 64)], cache: cache) { _ in "not the book" })
    }

    func testFolderIsWrittenSyncedAndOnlyInside() throws {
        let root = temp()
        try "stale".write(to: root.appendingPathComponent("stale.txt"), atomically: true, encoding: .utf8)
        try syncFolder(root, [
            "my-posts/INDEX.md": "# posts",
            "img/1.jpg": "base64:AAEC",
            "../escape.txt": "nope",
            "/abs.txt": "nope",
        ])
        XCTAssertEqual(try String(contentsOf: root.appendingPathComponent("my-posts/INDEX.md"), encoding: .utf8), "# posts")
        XCTAssertEqual(try Data(contentsOf: root.appendingPathComponent("img/1.jpg")), Data([0, 1, 2]))
        XCTAssertFalse(FileManager.default.fileExists(atPath: root.appendingPathComponent("stale.txt").path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: root.deletingLastPathComponent().appendingPathComponent("escape.txt").path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: "/abs.txt"))
    }

    func testTheFolderNoteAndTheRequestText() {
        XCTAssertEqual(requestText("hi", folder: false), "hi")
        XCTAssertTrue(requestText("hi", folder: true).hasPrefix(folderNote + "\n\nhi"))
    }

    // MARK: the Mac's report

    func testHomesAreClaudeFoldersWithALoginAndCodex() throws {
        let home = temp()
        let fm = FileManager.default
        try fm.createDirectory(at: home.appendingPathComponent(".claude"), withIntermediateDirectories: true)
        try fm.createDirectory(at: home.appendingPathComponent(".claude-work"), withIntermediateDirectories: true)
        try "{}".write(to: home.appendingPathComponent(".claude-work/settings.json"), atomically: true, encoding: .utf8)
        try fm.createDirectory(at: home.appendingPathComponent(".claude-empty"), withIntermediateDirectories: true)
        try fm.createDirectory(at: home.appendingPathComponent(".codex"), withIntermediateDirectories: true)
        let rows = homeReport(home: home).map { "\($0["driver"] as! String) \(URL(fileURLWithPath: $0["home"] as! String).lastPathComponent)" }
        XCTAssertEqual(rows, ["claude .claude", "claude .claude-work", "codex .codex"])
    }

    func testTheReportHasEveryDriverAndTheTimestamp() {
        let report = macReport(home: temp(), now: Date(timeIntervalSince1970: 1_700_000_000))
        XCTAssertEqual(report["at"] as? Int, 1_700_000_000_000)
        XCTAssertEqual((report["drivers"] as? [[String: Any]])?.count, reportDrivers.count)
        XCTAssertEqual((report["drivers"] as? [[String: Any]])?.first?["driver"] as? String, "codex")
        XCTAssertNotNil(report["homes"])
    }

    // MARK: pairing and the request's device body

    func testDeviceBodyFromThePairReply() throws {
        let pair = try JSONDecoder().decode(PairReply.self, from: Data(#"{"device":{"id":"dev_1","owner":"alex","kind":"app"},"token":"ctd_abc"}"#.utf8))
        XCTAssertEqual(pair.device.id, "dev_1")
        XCTAssertEqual(pair.token, "ctd_abc")
    }

    // MARK: real run, only when asked (costs a few cents of the subscription)

    /// CT_REAL_CLAUDE=1 swift test --filter RealRun: one tiny claude run through ~/.claude-work, the way the relay runs it.
    func testRealRunThroughTheHubHome() throws {
        guard ProcessInfo.processInfo.environment["CT_REAL_CLAUDE"] == "1" else {
            throw XCTSkip("set CT_REAL_CLAUDE=1 to run one real claude call")
        }
        let home = FileManager.default.homeDirectoryForCurrentUser
        let hub = home.appendingPathComponent(".claude-work").path
        let req = request(#"{"id":"real-1","system":"Reply with just OK.","user":"Reply with just OK.","driver":"claude","model":"claude-opus-5-5","effort":"low","home":"\#(hub)"}"#)
        let opts = try requestOptions(req)
        let cli = claudeBinary(home: home) ?? "claude"
        var streamed: [String] = []
        let started = Date()
        let answer = try claudeAnswer(req, opts, cli: cli, send: { streamed.append($0); return true }, step: { _ in })
        let seconds = Date().timeIntervalSince(started)
        print("REAL RUN: text=\(answer.text) usage=\(answer.usage) seconds=\(String(format: "%.1f", seconds)) cli=\(cli)")
        XCTAssertFalse(answer.text.isEmpty)
        XCTAssertTrue(answer.text.localizedCaseInsensitiveContains("OK"))
        XCTAssertEqual(answer.usage["models"] as? [String], ["claude-opus-5-5"])
    }
}
