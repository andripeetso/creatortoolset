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

    func testClaudeGeminiCodexAndTheAcpKindsRunHereAndOthersFailWithTheSameWords() throws {
        let root = temp()
        for driver in ["musecode", "muse", "wat"] {
            let r = request(#"{"id":"j","system":"","user":"","driver":"\#(driver)"}"#)
            XCTAssertThrowsError(try requestOptions(r, root: root)) { error in
                XCTAssertEqual((error as? RelayError)?.message, onlyRunnableMessage)
            }
        }
        for driver in ["claude", "gemini", "codex", "grok", "cursor", "opencode", "antigravity", "pi"] {
            XCTAssertEqual(try requestOptions(request(#"{"id":"j","system":"","user":"","driver":"\#(driver)"}"#), root: root).driver, driver)
        }
    }

    func testAcpKindsStartTheirCommandWithTheirLaunchArguments() throws {
        let root = temp()
        XCTAssertEqual(try requestOptions(request(#"{"id":"j","system":"","user":"","driver":"pi"}"#), root: root).acp,
                       AcpLaunch(command: "npx", args: ["-y", "pi-acp@0.0.34"]))
        XCTAssertEqual(try requestOptions(request(#"{"id":"j","system":"","user":"","driver":"cursor","launchArgs":["--model","m"]}"#), root: root).acp,
                       AcpLaunch(command: "cursor-agent", args: ["acp", "--model", "m"]))
        // a manual setup's program replaces the default command; its launch arguments follow
        XCTAssertEqual(try requestOptions(request(#"{"id":"j","system":"","user":"","driver":"pi","binaryPath":"/opt/pi/pi-acp","launchArgs":["--v"]}"#), root: root).acp,
                       AcpLaunch(command: "/opt/pi/pi-acp", args: ["--v"]))
        // a local command takes its own program and arguments
        XCTAssertEqual(try requestOptions(request(#"{"id":"j","system":"","user":"","driver":"acp","acp":{"command":"my-agent","args":["acp"]}}"#), root: root).acp,
                       AcpLaunch(command: "my-agent", args: ["acp"]))
        XCTAssertThrowsError(try requestOptions(request(#"{"id":"j","system":"","user":"","driver":"acp"}"#), root: root))
        XCTAssertNil(try requestOptions(request(#"{"id":"j","system":"","user":"","driver":"claude"}"#), root: root).acp)
    }

    /// The fake ACP agent (AcpRunTests.fakeAgent) answers a request as pi and as opencode: the prompt goes out with the
    /// instructions in front, the agent's permission question is denied, and the text comes back as the answer.
    func testAcpAnswerRunsTheFakeAgentAsPiAndAsOpencode() throws {
        let dir = temp()
        let script = dir.appendingPathComponent("fake_agent.py")
        try AcpRunTests.fakeAgent.write(to: script, atomically: true, encoding: .utf8)
        for driver in ["pi", "opencode"] {
            let req = request(#"{"id":"j","system":"Be brief.","user":"hi","driver":"\#(driver)"}"#)
            let opts = RelayOptions(model: "", effort: "xhigh", home: "", resume: "", driver: driver,
                                    acp: AcpLaunch(command: "/usr/bin/python3", args: [script.path]))
            let answer = try runAnswer(req, opts, cli: driver, work: dir, send: { _ in true }, step: { _ in })
            XCTAssertEqual(answer.text, "Hello: <instructions>\nBe brief.\n</instructions>\n\nhi[no]")
            XCTAssertEqual(answer.state, "")
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

    func testAssistantRunGetsTheAppsMcpToolsOnly() throws {
        let job = #"{"id":"j1","mcp":{"url":"https://example.test/api/mcp","token":"ctj_"# + String(repeating: "a", count: 48) + #""}}"#
        let req = try XCTUnwrap(RelayRequest(json: Data(job.utf8)))
        XCTAssertEqual(req.mcp?.url, "https://example.test/api/mcp")
        let config = try XCTUnwrap(JSONSerialization.jsonObject(with: mcpConfig(url: req.mcp!.url, token: req.mcp!.token)) as? [String: Any])
        let server = try XCTUnwrap((config["mcpServers"] as? [String: Any])?["creator-toolset"] as? [String: Any])
        XCTAssertEqual((server["headers"] as? [String: String])?["Authorization"], "Bearer " + req.mcp!.token)
        let args = claudeArguments(model: "claude-opus-5-5", effort: "xhigh", systemFile: "/tmp/s.txt", tools: "", session: false, resume: "", mcpConfigFile: "/tmp/m.json")
        XCTAssertEqual(args[args.firstIndex(of: "--mcp-config")! + 1], "/tmp/m.json")
        XCTAssertTrue(args.contains("--strict-mcp-config"))
        XCTAssertEqual(args[args.firstIndex(of: "--allowedTools")! + 1], "mcp__creator-toolset__*")
        XCTAssertEqual(args[args.firstIndex(of: "--tools")! + 1], "")
        // a token that isn't a job token, or another address, is ignored
        XCTAssertNil(RelayRequest(json: Data(#"{"id":"j2","mcp":{"url":"https://example.test/api/mcp","token":"ctk_x"}}"#.utf8))?.mcp)
        XCTAssertNil(RelayRequest(json: Data((#"{"id":"j3","mcp":{"url":"file:///etc/passwd","token":"ctj_"# + String(repeating: "a", count: 48) + #""}}"#).utf8))?.mcp)
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

    func testPlugInEndpointReachesTheClaudeEnvAndWinsOverTheHome() throws {
        let r = request(#"{"id":"j4","system":"","user":"","baseUrl":"https://proxy.example.test/v1"}"#)
        XCTAssertEqual(try requestOptions(r).baseUrl, "https://proxy.example.test/v1")
        XCTAssertThrowsError(try requestOptions(request(#"{"id":"j5","system":"","user":"","baseUrl":"file:///etc/passwd"}"#)))
        XCTAssertEqual(try requestOptions(request(#"{"id":"j6","system":"","user":""}"#)).baseUrl, "")
        let home = temp()
        try #"{"env":{"ANTHROPIC_BASE_URL":"https://home.example"}}"#.write(to: home.appendingPathComponent("settings.json"), atomically: true, encoding: .utf8)
        XCTAssertEqual(claudeEnv(base: [:], home: home.path, baseUrl: "https://proxy.example.test/v1")["ANTHROPIC_BASE_URL"], "https://proxy.example.test/v1")
        XCTAssertEqual(claudeEnv(base: [:], home: home.path)["ANTHROPIC_BASE_URL"], "https://home.example")
        XCTAssertNil(claudeEnv(base: ["ANTHROPIC_BASE_URL": "https://base"], home: "")["ANTHROPIC_BASE_URL"])
    }

    func testProviderValuesComeFromTheMacKeychainOnlyForNamedVariables() throws {
        let kept = ["claude_hub/CURSOR_API_KEY": "k-1", "claude_hub/BAD NAME": "x"]
        XCTAssertEqual(providerEnv(instance: "claude_hub", names: ["CURSOR_API_KEY", "MISSING", "BAD NAME"], read: { kept[$0] }), ["CURSOR_API_KEY": "k-1"])
        XCTAssertEqual(providerEnv(instance: "", names: ["CURSOR_API_KEY"], read: { kept[$0] }), [:])
        // the request carries the names; the values come from the reader, and only for Claude
        let r = request(#"{"id":"j7","system":"","user":"","instance":"claude_hub","envNames":["CURSOR_API_KEY"]}"#)
        XCTAssertEqual(try requestOptions(r, read: { kept[$0] }).env, ["CURSOR_API_KEY": "k-1"])
        let codex = request(#"{"id":"j8","system":"","user":"","driver":"codex","instance":"claude_hub","envNames":["CURSOR_API_KEY"]}"#)
        XCTAssertEqual(try requestOptions(codex, read: { kept[$0] }).env, [:])
    }

    func testProviderValuesNeverReplaceTheSubscriptionKeysOrTheFolder() throws {
        let home = temp()
        let env = claudeEnv(base: [:], home: home.path, extra: ["ANTHROPIC_API_KEY": "sk", "ANTHROPIC_BASE_URL": "u", "CLAUDE_CONFIG_DIR": "/x", "CURSOR_API_KEY": "k-1"])
        XCTAssertNil(env["ANTHROPIC_API_KEY"])
        XCTAssertNil(env["ANTHROPIC_BASE_URL"])
        XCTAssertEqual(env["CLAUDE_CONFIG_DIR"], home.path)
        XCTAssertEqual(env["CURSOR_API_KEY"], "k-1")
    }

    func testMacReportNamesMuseCodeAsTheSiteDoes() {
        let ids = reportDrivers.map { $0.id }
        XCTAssertTrue(ids.contains("musecode"))
        XCTAssertFalse(ids.contains("muse"))
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
        XCTAssertEqual(label("Bash", ["command": "ls"]), "Command: ls")
        XCTAssertEqual(label("Write", ["file_path": cwd + "/note.txt"]), "Write note.txt")
        XCTAssertEqual(label("Agent", ["prompt": "x"]), "")
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

    func testACustomEndpointIsAFlagAndTheURLAndTokenStayOnTheMac() throws {
        let home = temp()
        let fm = FileManager.default
        let hub = home.appendingPathComponent(".claude-hub")
        try fm.createDirectory(at: hub, withIntermediateDirectories: true)
        try #"{"env":{"ANTHROPIC_BASE_URL":"https://gateway.tinyacrobatics.example","ANTHROPIC_AUTH_TOKEN":"sk-test-token-123"}}"#
            .write(to: hub.appendingPathComponent("settings.json"), atomically: true, encoding: .utf8)
        try fm.createDirectory(at: home.appendingPathComponent(".claude"), withIntermediateDirectories: true)
        try "{}".write(to: home.appendingPathComponent(".claude/settings.json"), atomically: true, encoding: .utf8)
        let flags = Dictionary(uniqueKeysWithValues: homeReport(home: home).map {
            (URL(fileURLWithPath: $0["home"] as! String).lastPathComponent, $0["customEndpoint"] as? Bool)
        })
        XCTAssertEqual(flags[".claude-hub"], true)
        XCTAssertEqual(flags[".claude"], false)
        let sent = String(decoding: try JSONSerialization.data(withJSONObject: homeReport(home: home)), as: UTF8.self)
        XCTAssertFalse(sent.contains("gateway.tinyacrobatics"))
        XCTAssertFalse(sent.contains("sk-test-token-123"))
    }

    func testTheReportHasEveryDriverAndTheTimestamp() {
        let report = macReport(home: temp(), now: Date(timeIntervalSince1970: 1_700_000_000))
        XCTAssertEqual(report["at"] as? Int, 1_700_000_000_000)
        XCTAssertEqual((report["drivers"] as? [[String: Any]])?.count, reportDrivers.count)
        XCTAssertEqual((report["drivers"] as? [[String: Any]])?.first?["driver"] as? String, "codex")
        XCTAssertNotNil(report["homes"])
        XCTAssertTrue(reportDrivers.contains { $0.id == "musecode" } && !reportDrivers.contains { $0.id == "muse" })   // the id providers.ts uses
        let machine = report["machine"] as? [String: Any]
        XCTAssertEqual(machine?["os"] as? String, "mac")
        XCTAssertGreaterThan(machine?["cpus"] as? Int ?? 0, 0)
    }

    func testSignInAndPlanComeFromWhatTheCLISays() {
        let pro = signInFrom(driver: "claude", output: #"{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"pro","planTier":"default_claude_pro"}"#)
        XCTAssertEqual(pro?.signedIn, true)
        XCTAssertEqual(pro?.plan, "pro default_claude_pro")
        let token = signInFrom(driver: "claude", output: #"{"loggedIn":true,"authMethod":"oauth_token"}"#)
        XCTAssertEqual(token?.signedIn, true)
        XCTAssertNil(token?.plan)
        XCTAssertEqual(signInFrom(driver: "claude", output: #"{"loggedIn":false}"#)?.signedIn, false)
        XCTAssertNil(signInFrom(driver: "claude", output: "not json"))
        XCTAssertEqual(signInFrom(driver: "codex", output: "Logged in using ChatGPT")?.signedIn, true)
        XCTAssertNil(signInFrom(driver: "codex", output: "Logged in using ChatGPT")?.plan)
        XCTAssertEqual(signInFrom(driver: "codex", output: "Not logged in")?.signedIn, false)
    }

    // MARK: pairing and the request's device body

    func testDeviceBodyFromThePairReply() throws {
        let pair = try JSONDecoder().decode(PairReply.self, from: Data(#"{"device":{"id":"dev_1","owner":"alex","kind":"app"},"token":"ctd_abc"}"#.utf8))
        XCTAssertEqual(pair.device.id, "dev_1")
        XCTAssertEqual(pair.token, "ctd_abc")
    }

    // MARK: Codex and Grok (the Mac relay codex_cmd, grok_cmd, CodexRun and their checks)

    /// Lines captured from codex-cli 0.39 (`codex exec --json`) on this Mac: the MCP error, the model refused by the
    /// account (the retries, then the error), and a full answer with its usage.
    private let codexRefusedLines = [
        #"{"id":"","msg":{"type":"error","message":"MCP client for `computer-use` failed to start: No such file or directory (os error 2)"}}"#,
        #"{"id":"0","msg":{"type":"task_started","model_context_window":null}}"#,
        #"{"id":"0","msg":{"type":"stream_error","message":"stream error: unexpected status 400 Bad Request: {\"detail\":\"The 'gpt-6-astra' model is not supported when using Codex with a ChatGPT account.\"}; retrying 1/5 in 194ms…"}}"#,
        #"{"id":"0","msg":{"type":"error","message":"unexpected status 400 Bad Request: {\"detail\":\"The 'gpt-6-astra' model is not supported when using Codex with a ChatGPT account.\",\"error\":{\"type\":\"invalid_request_error\",\"code\":\"model_not_found\"}}"}}"#,
    ]
    private let codexAnswerLines = [
        #"{"provider":"openai","sandbox":"read-only","model":"gpt-x"}"#,
        #"{"id":"","msg":{"type":"error","message":"MCP client for `computer-use` failed to start"}}"#,
        #"{"id":"0","msg":{"type":"task_started"}}"#,
        #"{"id":"0","msg":{"type":"agent_message_delta","delta":"Let me look "}}"#,
        #"{"id":"0","msg":{"type":"agent_message_delta","delta":"at the posts."}}"#,
        #"{"id":"0","msg":{"type":"agent_message","message":"Let me look at the posts."}}"#,
        #"{"id":"0","msg":{"type":"agent_message_delta","delta":"{\"reply\": "}}"#,
        #"{"id":"0","msg":{"type":"agent_message_delta","delta":"\"OK\"}"}}"#,
        #"{"id":"0","msg":{"type":"agent_message","message":"{\"reply\": \"OK\"}"}}"#,
        #"{"id":"0","msg":{"type":"token_count","info":{"total_token_usage":{"input_tokens":120,"cached_input_tokens":100,"output_tokens":7,"reasoning_output_tokens":3,"total_tokens":127}}}}"#,
        #"{"id":"0","msg":{"type":"task_complete","last_agent_message":"{\"reply\": \"OK\"}"}}"#,
    ]

    private func feedCodex(_ lines: [String]) -> CodexStream {
        var stream = CodexStream()
        for line in lines { _ = stream.feed(line) }
        return stream
    }

    func testCodexAnswerIsTheLastMessageWithUncachedInputUsage() {
        let stream = feedCodex(codexAnswerLines)
        let result = stream.result(err: "")
        XCTAssertEqual(result["is_error"] as? Bool, false)
        XCTAssertEqual(result["result"] as? String, #"{"reply": "OK"}"#)
        let usage = result["usage"] as? [String: Any] ?? [:]
        XCTAssertEqual(usage["input_tokens"] as? Int, 20)                 // 120 in, 100 of them cached
        XCTAssertEqual(usage["cache_read_input_tokens"] as? Int, 100)
        XCTAssertEqual(usage["output_tokens"] as? Int, 7)
        XCTAssertEqual(usage["reasoning_tokens"] as? Int, 3)
        XCTAssertEqual(stream.seen["codex"]?["output_tokens"] as? Int, 7)
    }

    func testCodexStreamShowsTheAnswerAsItWrites() {
        var stream = CodexStream()
        var shown: [String] = []
        for line in codexAnswerLines {
            for update in stream.feed(line) {
                if case .text(let text) = update { shown.append(text) }
            }
        }
        XCTAssertEqual(shown.first, "Let me look ")
        XCTAssertEqual(shown.last, #"{"reply": "OK"}"#)
        XCTAssertTrue(shown.contains("Let me look at the posts."))   // a message that ended is kept until a new one starts
    }

    func testCodexRefusedModelIsTheFailureWithTheCLIsWords() {
        let result = feedCodex(codexRefusedLines).result(err: "")
        XCTAssertEqual(result["is_error"] as? Bool, true)
        XCTAssertTrue((result["result"] as? String ?? "").hasPrefix("unexpected status 400 Bad Request"))
        XCTAssertTrue((result["result"] as? String ?? "").contains("The 'gpt-6-astra' model is not supported when using Codex with a ChatGPT account."))
    }

    func testCodexErrorBeforeAnAnswerIsNotTheFailureAndNoAnswerUsesStderr() {
        XCTAssertFalse(feedCodex(Array(codexAnswerLines[1...1]) + Array(codexAnswerLines[8...])).result(err: "")["is_error"] as? Bool ?? true)
        let none = feedCodex([#"{"id":"0","msg":{"type":"task_started"}}"#]).result(err: "ERROR: something on stderr")
        XCTAssertEqual(none["result"] as? String, "ERROR: something on stderr")
    }

    func testCodexCommandLineIsReadOnlyInTheFolderWithThePromptOnStdin() {
        let args = codexArguments(cwd: "/tmp/run", model: "gpt-x", effort: "low")
        XCTAssertEqual(args.prefix(2), ["exec", "--json"])
        XCTAssertEqual(args[args.firstIndex(of: "-s")! + 1], "read-only")
        XCTAssertEqual(args[args.firstIndex(of: "-C")! + 1], "/tmp/run")
        XCTAssertEqual(args[args.firstIndex(of: "-m")! + 1], "gpt-x")
        XCTAssertTrue(args.contains("model_reasoning_effort=low"))
        XCTAssertEqual(args.last, "-")
        XCTAssertFalse(codexArguments(cwd: "/tmp/run", model: "", effort: "low").contains("-m"))
    }

    func testCodexAndGrokOptionsAndHomes() throws {
        let root = temp()
        let codexHome = root.appendingPathComponent(".codex-work")
        try FileManager.default.createDirectory(at: codexHome, withIntermediateDirectories: true)
        let codex = try requestOptions(request(#"{"id":"j","system":"","user":"","driver":"codex","model":"gpt-x","effort":"low","home":"\#(codexHome.path)"}"#), root: root)
        XCTAssertEqual(codex, RelayOptions(model: "gpt-x", effort: "low", home: realPath(codexHome.path), resume: "", driver: "codex"))
        XCTAssertEqual(try requestOptions(request(#"{"id":"j","system":"","user":"","driver":"codex"}"#), root: root).model, "")
        XCTAssertThrowsError(try requestOptions(request(#"{"id":"j","system":"","user":"","driver":"codex","model":"bad model!"}"#), root: root)) { error in
            XCTAssertEqual((error as? RelayError)?.message, "not a Codex model: bad model!")
        }
        XCTAssertThrowsError(try requestOptions(request(#"{"id":"j","system":"","user":"","driver":"grok","home":"\#(codexHome.path)"}"#), root: root)) { error in
            XCTAssertEqual((error as? RelayError)?.message, "Grok keeps its own folder (~/.grok): it takes no home")
        }
        XCTAssertEqual(try requestOptions(request(#"{"id":"j","system":"","user":"","driver":"grok","model":"grok-4"}"#), root: root).model, "grok-4")
    }

    func testCodexHomeGoesToTheEnvironmentOnlyWhenNamed() {
        let base = ["PATH": "/usr/bin", "OPENAI_API_KEY": "sk-1", "CODEX_HOME": "/old"]
        XCTAssertEqual(driverEnv(base: base, home: "/Users/x/.codex-work")["CODEX_HOME"], "/Users/x/.codex-work")
        XCTAssertEqual(driverEnv(base: base)["CODEX_HOME"], "/old")
        XCTAssertNil(driverEnv(base: base)["OPENAI_API_KEY"])
    }

    func testGrokCommandLineHasTheReadToolsOnlyInAFolder() {
        let prompt = "/tmp/p.txt"
        let folder = grokArguments(cwd: "/tmp/run", model: "", effort: "low", system: "S", web: false, folder: true, promptFile: prompt)
        XCTAssertEqual(folder[folder.firstIndex(of: "--prompt-file")! + 1], prompt)
        XCTAssertEqual(folder[folder.firstIndex(of: "--tools")! + 1], "read_file,grep,list_dir")
        XCTAssertTrue(folder.contains("--disable-web-search"))
        XCTAssertEqual(folder[folder.firstIndex(of: "--permission-mode")! + 1], "dontAsk")
        XCTAssertEqual(folder[folder.firstIndex(of: "--disallowed-tools")! + 1], "run_terminal_cmd,search_replace,Agent")
        let web = grokArguments(cwd: "/tmp/run", model: "grok-4", effort: "high", system: "S", web: true, folder: true, promptFile: prompt)
        XCTAssertEqual(web[web.firstIndex(of: "--tools")! + 1], "read_file,grep,list_dir,web_search,web_fetch")
        XCTAssertFalse(web.contains("--disable-web-search"))
        XCTAssertEqual(web[web.firstIndex(of: "-m")! + 1], "grok-4")
        let plain = grokArguments(cwd: "/tmp/run", model: "", effort: "low", system: "S", web: false, folder: false, promptFile: prompt)
        XCTAssertEqual(plain[plain.firstIndex(of: "--tools")! + 1], "")   // no folder, no web: no built-in tools at all
    }

    /// Lines captured from grok on this Mac when it was not signed in: an init line, then the error result.
    func testGrokErrorResultIsTheFailureWithItsErrorsList() {
        let lines = [
            #"{"type":"system","subtype":"init","session_id":"","apiKeySource":"user","model":"unknown","cwd":"","permissionMode":"default","tools":[],"slash_commands":[],"mcp_servers":[],"skills":[]}"#,
            #"{"type":"result","subtype":"error_during_execution","is_error":true,"duration_ms":0,"duration_api_ms":0,"num_turns":0,"total_cost_usd":0.0,"usage":{"input_tokens":0,"output_tokens":0,"cache_read_input_tokens":0,"cache_creation_input_tokens":0},"modelUsage":{},"errors":["Not signed in. To authenticate without a browser, run:\n  grok login --device-code"],"session_id":""}"#,
        ]
        var stream = ClaudeStream(cwd: "/tmp/none")
        for line in lines { XCTAssertEqual(stream.feed(line), line.contains(#""type":"result""#) ? [.result] : []) }
        let result = stream.result
        XCTAssertEqual(result?["is_error"] as? Bool, true)
        XCTAssertEqual(resultText(result ?? [:]), "Not signed in. To authenticate without a browser, run:\n  grok login --device-code")
        let row = genericUsageRow(result ?? [:], model: "grok-4")
        XCTAssertEqual(row["models"] as? [String], ["grok-4"])
        XCTAssertEqual(row["input"] as? Int, 0)
    }

    /// A stand-in CLI that ignores its arguments and prints `lines` (one per line) after reading its prompt.
    private func stubStreamCLI(_ name: String, _ lines: [String]) throws -> String {
        let file = temp().appendingPathComponent(name)
        let script = "#!/bin/sh\ncat > /dev/null\ncat <<'STUBEOF'\n" + lines.joined(separator: "\n") + "\nSTUBEOF\n"
        try script.write(to: file, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: file.path)
        return file.path
    }

    func testCodexRunThroughTheRelayGivesTheAnswerAndItsUsage() throws {
        let cli = try stubStreamCLI("codex", codexAnswerLines)
        let req = request(#"{"id":"c1","system":"Reply in JSON.","user":"say OK","driver":"codex","effort":"low"}"#)
        let answer = try runAnswer(req, try requestOptions(req), cli: cli, work: temp(), send: { _ in true }, step: { _ in })
        XCTAssertEqual(answer.text, #"{"reply": "OK"}"#)
        XCTAssertEqual(answer.usage["models"] as? [String], [])            // the CLI named no model; the request's is empty too
        XCTAssertEqual(answer.usage["output"] as? Int, 7)
        XCTAssertEqual(answer.state, "")
    }

    func testCodexPicturesAreImageFlagsBeforeThePromptMarker() {
        let args = codexArguments(cwd: "/tmp/run", model: "gpt-6-luna", effort: "xhigh", pictures: ["/tmp/run/attached/1.jpg", "/tmp/run/attached/2.png"])
        XCTAssertEqual(Array(args.suffix(3)), ["--image=/tmp/run/attached/1.jpg", "--image=/tmp/run/attached/2.png", "-"])
        XCTAssertEqual(codexPictures(["attached/2.png": "base64:AA==", "attached/1.jpg": "base64:AA==", "notes.md": "x"], cwd: URL(fileURLWithPath: "/tmp/run")),
                       ["/tmp/run/attached/1.jpg", "/tmp/run/attached/2.png"])
    }

    func testCodexRunThroughTheRelayGetsItsModelAndPicturesAsFlags() throws {
        // A stand-in codex that writes its argv to a file and echoes the prompt it was given on stdin as its answer.
        let dir = temp()
        let file = dir.appendingPathComponent("codex")
        let argv = dir.appendingPathComponent("argv.txt").path
        let script = "#!/bin/sh\nprintf '%s\\n' \"$@\" > \(argv)\nprompt=$(cat)\nprintf '{\"id\":\"0\",\"msg\":{\"type\":\"agent_message\",\"message\":\"ok\"}}\\n'\n"
        try script.write(to: file, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: file.path)
        let req = request(#"{"id":"c4","system":"","user":"look","driver":"codex","model":"gpt-6-luna","effort":"xhigh","files":{"attached/1.jpg":"base64:/9j/","notes.md":"x"}}"#)
        let answer = try runAnswer(req, try requestOptions(req), cli: file.path, work: temp(), send: { _ in true }, step: { _ in })
        XCTAssertEqual(answer.text, "ok")
        let lines = try String(contentsOfFile: argv, encoding: .utf8).split(separator: "\n").map(String.init)
        XCTAssertEqual(lines.last, "-")
        XCTAssertEqual(lines[lines.firstIndex(of: "-m")! + 1], "gpt-6-luna")
        XCTAssertEqual(lines.filter { $0.hasPrefix("--image=") }.count, 1, "the notes file is not a picture")
        XCTAssertTrue(lines.contains { $0.hasPrefix("--image=") && $0.hasSuffix("/attached/1.jpg") })
    }

    func testCodexWithNoFolderStartsInItsOwnEmptyFolderUnderApplicationSupport() throws {
        // A stand-in codex that answers with its working folder, so the test can see where the run started.
        let file = temp().appendingPathComponent("codex")
        let script = "#!/bin/sh\ncat > /dev/null\nprintf '{\"id\":\"0\",\"msg\":{\"type\":\"agent_message\",\"message\":\"%s\"}}\\n' \"$(pwd -P)\"\n"
        try script.write(to: file, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: file.path)
        let req = request(#"{"id":"c3","system":"","user":"where","driver":"codex","effort":"low"}"#)
        let answer = try runAnswer(req, try requestOptions(req), cli: file.path, work: temp(), send: { _ in true }, step: { _ in })
        let runs = realPath(appSupport.appendingPathComponent("codex-runs").path)
        XCTAssertTrue(answer.text.hasPrefix(runs + "/"), "ran in \(answer.text), not under \(runs)")
        XCTAssertFalse(FileManager.default.fileExists(atPath: answer.text), "the run folder is removed after the run")
    }

    func testCodexRefusalThroughTheRelayIsAFailureWithItsUsageRow() throws {
        let cli = try stubStreamCLI("codex", codexRefusedLines)
        let req = request(#"{"id":"c2","system":"","user":"x","driver":"codex","model":"gpt-6-astra"}"#)
        XCTAssertThrowsError(try runAnswer(req, try requestOptions(req), cli: cli, work: temp(), send: { _ in true }, step: { _ in })) { error in
            XCTAssertTrue((error as? ClaudeFailure)?.message.hasPrefix("Codex: unexpected status 400") == true)
        }
    }

    func testGrokRunThroughTheRelayGivesTheAnswerOrItsError() throws {
        let answerLines = [
            #"{"type":"stream_event","event":{"type":"message_start"}}"#,
            #"{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"OK"}}}"#,
            #"{"type":"result","is_error":false,"result":"OK","usage":{"input_tokens":3,"output_tokens":1},"modelUsage":{"grok-4":{"inputTokens":3,"outputTokens":1}},"total_cost_usd":0.0,"duration_ms":40,"session_id":"g-1"}"#,
        ]
        let req = request(#"{"id":"g1","system":"Reply briefly.","user":"say OK","driver":"grok","model":"grok-4","effort":"low"}"#)
        let ok = try runAnswer(req, try requestOptions(req), cli: try stubStreamCLI("grok", answerLines), work: temp(), send: { _ in true }, step: { _ in })
        XCTAssertEqual(ok.text, "OK")
        XCTAssertEqual(ok.usage["models"] as? [String], ["grok-4"])
        XCTAssertEqual(ok.usage["output"] as? Int, 1)
        XCTAssertEqual(ok.state, "")
        let failing = request(#"{"id":"g2","system":"","user":"x","driver":"grok"}"#)
        let cli = try stubStreamCLI("grok", [#"{"type":"result","is_error":true,"result":"","errors":["Not signed in"],"usage":{}}"#])
        XCTAssertThrowsError(try runAnswer(failing, try requestOptions(failing), cli: cli, work: temp(), send: { _ in true }, step: { _ in })) { error in
            XCTAssertEqual((error as? ClaudeFailure)?.message, "Grok: Not signed in")
        }
    }

    /// CT_REAL_CODEX=1 swift test --filter RealCodex: one tiny codex run through the codex on this Mac, the way the relay runs it.
    func testRealCodexRun() throws {
        guard ProcessInfo.processInfo.environment["CT_REAL_CODEX"] == "1" else {
            throw XCTSkip("set CT_REAL_CODEX=1 to run one real codex call")
        }
        let cli = binary("codex", home: FileManager.default.homeDirectoryForCurrentUser) ?? "codex"
        let req = request(#"{"id":"real-codex","system":"Reply with just OK.","user":"Reply with just OK.","driver":"codex","effort":"low"}"#)
        let answer = try runAnswer(req, try requestOptions(req), cli: cli, work: temp(), send: { _ in true }, step: { _ in })
        print("REAL CODEX: text=\(answer.text) usage=\(answer.usage)")
        XCTAssertTrue(answer.text.localizedCaseInsensitiveContains("OK"))
    }

    /// CT_REAL_GROK=1 swift test --filter RealGrok: one tiny grok run through the grok on this Mac, the way the relay runs it.
    func testRealGrokRun() throws {
        guard ProcessInfo.processInfo.environment["CT_REAL_GROK"] == "1" else {
            throw XCTSkip("set CT_REAL_GROK=1 to run one real grok call")
        }
        let cli = binary("grok", home: FileManager.default.homeDirectoryForCurrentUser) ?? "grok"
        let req = request(#"{"id":"real-grok","system":"Reply with just OK.","user":"Reply with just OK.","driver":"grok","effort":"low"}"#)
        let answer = try runAnswer(req, try requestOptions(req), cli: cli, work: temp(), send: { _ in true }, step: { _ in })
        print("REAL GROK: text=\(answer.text) usage=\(answer.usage)")
        XCTAssertTrue(answer.text.localizedCaseInsensitiveContains("OK"))
    }

    // MARK: Gemini (the Mac relay GeminiRun and its checks)

    func testGeminiOptionsModelAndHome() throws {
        let root = temp()
        let ok = try requestOptions(request(#"{"id":"j","system":"","user":"","driver":"gemini"}"#), root: root)
        XCTAssertEqual(ok, RelayOptions(model: "", effort: "xhigh", home: "", resume: "", driver: "gemini"))
        XCTAssertThrowsError(try requestOptions(request(#"{"id":"j","system":"","user":"","driver":"gemini","model":"bad model!"}"#), root: root))
        let hub = root.appendingPathComponent(".gemini-work")
        try FileManager.default.createDirectory(at: hub, withIntermediateDirectories: true)
        XCTAssertThrowsError(try requestOptions(request(#"{"id":"j","system":"","user":"","driver":"gemini","home":"\#(hub.path)"}"#), root: root)) { error in
            XCTAssertEqual((error as? RelayError)?.message, "Gemini keeps its own folder (~/.gemini): it takes no home")
        }
    }

    func testGeminiCommandLineEnvAndLimit() {
        XCTAssertEqual(geminiArguments(model: "gemini-3.8-flash"),
                       ["-o", "stream-json", "--approval-mode", "plan", "--skip-trust", "-m", "gemini-3.8-flash"])
        XCTAssertEqual(geminiArguments(model: ""), ["-o", "stream-json", "--approval-mode", "plan", "--skip-trust"])
        let env = driverEnv(base: ["GEMINI_API_KEY": "k", "GOOGLE_API_KEY": "g", "PATH": "/bin"])
        XCTAssertEqual(env, ["PATH": "/bin"])
        XCTAssertTrue(limitFlag("gemini", "You have exhausted your daily quota on this model."))
        XCTAssertFalse(limitFlag("gemini", "some other error"))
        XCTAssertTrue(limitFlag("claude", "Claude AI usage limit reached|1700000000"))
    }

    func testGeminiStreamReadsTheAnswerAfterItsLastToolCall() {
        let lines = [
            #"{"type":"tool_use","tool_name":"read_file","tool_id":"t1","parameters":{"file_path":"a.md"}}"#,
            #"{"type":"message","role":"assistant","content":"Let me look ","delta":true}"#,
            #"{"type":"message","role":"assistant","content":"at it.","delta":true}"#,
            #"{"type":"tool_use","tool_name":"google_web_search","tool_id":"t2","parameters":{"query":"crawling study"}}"#,
            #"{"type":"message","role":"assistant","content":"{\"reply\": ","delta":true}"#,
            #"{"type":"message","role":"assistant","content":"\"OK\"}","delta":true}"#,
            #"{"type":"result","status":"success","stats":{"input_tokens":20,"output_tokens":5,"cached":8,"models":{"gemini-3.8-flash":{"input_tokens":20,"output_tokens":5,"cached":8}}}}"#,
        ]
        var stream = GeminiStream(cwd: "/tmp/none")
        var steps: [String] = []
        for line in lines {
            for update in stream.feed(line) {
                if case .step(let label) = update { steps.append(label) }
            }
        }
        XCTAssertEqual(steps, ["Read a.md", "Searched the web: \"crawling study\""])
        let got = stream.result(err: "")
        XCTAssertEqual(got["is_error"] as? Bool, false)
        XCTAssertEqual(got["result"] as? String, "{\"reply\": \"OK\"}")
        let row = genericUsageRow(got, model: "gemini-3.8-flash")
        XCTAssertEqual(row["input"] as? Int, 12)
        XCTAssertEqual(row["cache_read"] as? Int, 8)
        XCTAssertEqual(row["output"] as? Int, 5)
        XCTAssertEqual(row["models"] as? [String], ["gemini-3.8-flash"])
    }

    func testAGeminiQuotaErrorIsTheFailureAndALimit() {
        var stream = GeminiStream(cwd: "/tmp")
        _ = stream.feed(#"{"type":"result","status":"error","error":{"type":"TerminalQuotaError","message":"You have exhausted your daily quota on this model."},"stats":{"input_tokens":3,"output_tokens":0,"cached":0,"models":{}}}"#)
        let got = stream.result(err: "")
        XCTAssertEqual(got["is_error"] as? Bool, true)
        XCTAssertEqual(got["result"] as? String, "You have exhausted your daily quota on this model.")
        XCTAssertTrue(limitFlag("gemini", resultText(got)))
    }

    // MARK: the assistant's permission questions (asks)

    private let jobToken = "ctj_" + String(repeating: "a", count: 48)

    func testOnlyTheAssistantWithMcpAsks() {
        XCTAssertTrue(request(#"{"id":"a1","asks":true,"mcp":{"url":"https://example.test/api/mcp","token":"\#(jobToken)"}}"#).asks)
        XCTAssertFalse(request(#"{"id":"a2","asks":true}"#).asks)   // no app MCP: not the assistant
        XCTAssertFalse(request(#"{"id":"a3","mcp":{"url":"https://example.test/api/mcp","token":"\#(jobToken)"}}"#).asks)   // an automation
    }

    func testAskingRunHasTheMacToolsAndPreAllowsOnlyWebAndTheApp() {
        let tools = [macTools, webTools].joined(separator: ",")
        let args = claudeArguments(model: "claude-opus-5-5", effort: "xhigh", systemFile: "/tmp/s.txt", tools: tools, session: false,
                                   resume: "", mcpConfigFile: "/tmp/m.json", asks: true)
        XCTAssertEqual(args[args.firstIndex(of: "--tools")! + 1], "Read,Glob,Grep,Bash,Edit,Write,WebSearch,WebFetch")
        XCTAssertEqual(args[args.firstIndex(of: "--allowedTools")! + 1], "WebSearch,WebFetch,mcp__creator-toolset__*")
        XCTAssertEqual(args[args.firstIndex(of: "--permission-mode")! + 1], "manual")
        XCTAssertEqual(args[args.firstIndex(of: "--permission-prompt-tool")! + 1], "stdio")
        XCTAssertEqual(args[args.firstIndex(of: "--input-format")! + 1], "stream-json")
        XCTAssertFalse(args.contains("dontAsk"))
        XCTAssertFalse(args.contains("--dangerously-skip-permissions"))
    }

    func testTheStreamReadsAQuestionItsCancelAndTheResult() throws {
        var stream = ClaudeStream(cwd: "/tmp")
        let line = #"{"type":"control_request","request_id":"r-1","request":{"subtype":"can_use_tool","tool_name":"Bash","input":{"command":"touch made.txt","description":"Make it"},"description":"Make it","decision_reason":"needs approval","permission_suggestions":[{"type":"addRules"}]}}"#
        let updates = stream.feed(line)
        guard case .ask(let ask) = try XCTUnwrap(updates.first) else { return XCTFail("no ask in \(updates)") }
        XCTAssertEqual(ask.id, "r-1")
        XCTAssertEqual(ask.tool, "Bash")
        XCTAssertEqual(ask.detail, "touch made.txt")
        XCTAssertEqual(ask.description, "Make it")
        XCTAssertEqual(ask.reason, "needs approval")
        XCTAssertEqual(stream.feed(#"{"type":"control_cancel_request","request_id":"r-1"}"#), [.cancelAsk("r-1")])
        XCTAssertEqual(stream.feed(#"{"type":"control_request","request_id":"r-2","request":{"subtype":"interrupt"}}"#), [])
        XCTAssertEqual(stream.feed(#"{"type":"result","result":"ok"}"#), [.result])
        XCTAssertEqual(askDetail("Glob", ["pattern": "**/*.md", "path": "/Users/x"]), "**/*.md in /Users/x")
        XCTAssertEqual(askDetail("Read", ["file_path": "/etc/hosts"]), "/etc/hosts")
        XCTAssertEqual(askDetail("Other", ["b": 1, "a": "x"]), #"{"a":"x","b":1}"#)
    }

    func testAnswersAreOneLineAndAYesKeepsTheInput() throws {
        let ask = PermissionAsk(id: "r-9", tool: "Bash", description: "", reason: "", detail: "ls", input: ["command": "ls"])
        func decoded(_ status: String) throws -> [String: Any] {
            let data = askAnswer(ask, status: status)
            XCTAssertEqual(data.last, 0x0A)
            XCTAssertEqual(data.filter { $0 == 0x0A }.count, 1)
            let obj = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
            XCTAssertEqual(obj["type"] as? String, "control_response")
            let response = try XCTUnwrap(obj["response"] as? [String: Any])
            XCTAssertEqual(response["request_id"] as? String, "r-9")
            return try XCTUnwrap(response["response"] as? [String: Any])
        }
        let yes = try decoded("allowed")
        XCTAssertEqual(yes["behavior"] as? String, "allow")
        XCTAssertEqual(yes["updatedInput"] as? [String: String], ["command": "ls"])
        for status in ["denied", "expired", "gone", "anything"] {
            XCTAssertEqual(try decoded(status)["behavior"] as? String, "deny")
        }
        let user = try XCTUnwrap(JSONSerialization.jsonObject(with: userMessageLine("hi")) as? [String: Any])
        XCTAssertEqual(user["type"] as? String, "user")
        XCTAssertEqual((user["message"] as? [String: Any])?["content"] as? String, "hi")
    }

    func testTheAssistantFolderIsPerServerUnderApplicationSupport() throws {
        let home = URL(fileURLWithPath: "/Users/someone")
        XCTAssertEqual(assistantFolder(host: "tools.example.com", home: home).path,
                       "/Users/someone/Library/Application Support/Creator Toolset\(AppIdentity.tag())/assistant/tools_example_com")
        XCTAssertEqual(assistantFolder(host: "../x", home: home).lastPathComponent, "___x")
        // its own files stay when a turn's attachments are written
        let root = temp()
        try "mine".write(to: root.appendingPathComponent("notes.md"), atomically: true, encoding: .utf8)
        try syncFolder(root, ["attached/01-a.txt": "x"], prune: false)
        XCTAssertEqual(try String(contentsOf: root.appendingPathComponent("notes.md"), encoding: .utf8), "mine")
        XCTAssertEqual(try String(contentsOf: root.appendingPathComponent("attached/01-a.txt"), encoding: .utf8), "x")
    }

    /// A stand-in CLI: reads the prompt line, asks one question, reads the answer, says what it got as its result.
    private func stubCLI() throws -> String {
        let file = temp().appendingPathComponent("claude")
        let script = #"""
        #!/bin/sh
        read -r prompt
        case "$prompt" in *'"type":"user"'*) kind=user;; *) kind=other;; esac
        echo '{"type":"control_request","request_id":"r1","request":{"subtype":"can_use_tool","tool_name":"Bash","input":{"command":"touch made.txt"},"description":"Make a file"}}'
        read -r answer
        case "$answer" in *'"behavior":"allow"'*) b=allow;; *) b=deny;; esac
        printf '{"type":"result","is_error":false,"result":"%s %s","modelUsage":{"claude-opus-5-5":{"inputTokens":1,"outputTokens":1}},"total_cost_usd":0}\n' "$b" "$kind"
        """#
        try script.write(to: file, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: file.path)
        return file.path
    }

    func testAQuestionWaitsForTheSiteThenTheAnswerReachesTheCLI() throws {
        let cli = try stubCLI()
        var req = request(#"{"id":"a9","user":"make a file","asks":true,"mcp":{"url":"https://example.test/api/mcp","token":"\#(jobToken)"}}"#)
        req.workdir = temp()
        let opts = try requestOptions(req)
        for (site, want) in [("allowed", "allow user"), ("denied", "deny user"), ("gone", "deny user")] {
            let lock = NSLock()
            var asked: [String] = []
            let answer = try claudeAnswer(req, opts, cli: cli, work: temp(), send: { _ in true }, step: { _ in }, ask: { question in
                lock.lock()
                defer { lock.unlock() }
                asked.append(question.detail)
                return asked.count < 2 ? "waiting" : site   // waits one round first
            })
            XCTAssertEqual(answer.text, want)
            XCTAssertEqual(asked, ["touch made.txt", "touch made.txt"])
        }
    }

    // MARK: real run, only when asked (costs a few cents of the subscription)

    /// CT_REAL_CLAUDE=1 swift test --filter RealAsk: a real claude run with the Mac tools, asked to `touch` in its folder: yes, then no.
    func testRealAskTouchAllowThenDeny() throws {
        guard ProcessInfo.processInfo.environment["CT_REAL_CLAUDE"] == "1" else {
            throw XCTSkip("set CT_REAL_CLAUDE=1 to run real claude calls")
        }
        let home = FileManager.default.homeDirectoryForCurrentUser
        let hub = home.appendingPathComponent(".claude-work").path
        let cli = binary("claude", home: home) ?? "claude"
        for allow in [true, false] {
            let folder = temp()
            // no MCP server listens there: the run carries on without the app's tools
            var req = request(#"{"id":"real-ask","system":"Do what the user asks with your tools.","user":"Run exactly this shell command with the Bash tool: touch made.txt. Then say done.","driver":"claude","model":"claude-haiku-5-5","effort":"low","home":"\#(hub)","asks":true,"mcp":{"url":"http://127.0.0.1:9/api/mcp","token":"\#(jobToken)"}}"#)
            req.workdir = URL(fileURLWithPath: realPath(folder.path))
            var asked: [PermissionAsk] = []
            let answer = try claudeAnswer(req, try requestOptions(req), cli: cli, work: temp(), send: { _ in true }, step: { print("STEP", $0) }, ask: { q in
                asked.append(q)
                return allow ? "allowed" : "denied"
            })
            print("REAL ASK allow=\(allow): asked=\(asked.map { "\($0.tool): \($0.detail)" }) text=\(answer.text)")
            XCTAssertTrue(asked.contains { $0.tool == "Bash" && $0.detail.contains("touch made.txt") })
            XCTAssertEqual(FileManager.default.fileExists(atPath: folder.appendingPathComponent("made.txt").path), allow)
        }
    }


    /// CT_REAL_CLAUDE=1 swift test --filter RealRun: one tiny claude run through ~/.claude-work, the way the relay runs it.
    func testRealRunThroughTheHubHome() throws {
        guard ProcessInfo.processInfo.environment["CT_REAL_CLAUDE"] == "1" else {
            throw XCTSkip("set CT_REAL_CLAUDE=1 to run one real claude call")
        }
        let home = FileManager.default.homeDirectoryForCurrentUser
        let hub = home.appendingPathComponent(".claude-work").path
        let req = request(#"{"id":"real-1","system":"Reply with just OK.","user":"Reply with just OK.","driver":"claude","model":"claude-opus-5-5","effort":"low","home":"\#(hub)"}"#)
        let opts = try requestOptions(req)
        let cli = binary("claude", home: home) ?? "claude"
        var streamed: [String] = []
        let started = Date()
        let answer = try claudeAnswer(req, opts, cli: cli, work: temp(), send: { streamed.append($0); return true }, step: { _ in })
        let seconds = Date().timeIntervalSince(started)
        print("REAL RUN: text=\(answer.text) usage=\(answer.usage) seconds=\(String(format: "%.1f", seconds)) cli=\(cli)")
        XCTAssertFalse(answer.text.isEmpty)
        XCTAssertTrue(answer.text.localizedCaseInsensitiveContains("OK"))
        XCTAssertEqual(answer.usage["models"] as? [String], ["claude-opus-5-5"])
    }
}
