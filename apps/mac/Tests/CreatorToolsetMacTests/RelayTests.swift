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
        for driver in ["muse", "wat"] {
            let r = request(#"{"id":"j","system":"","user":"","driver":"\#(driver)"}"#)
            XCTAssertThrowsError(try requestOptions(r, root: root)) { error in
                XCTAssertEqual((error as? RelayError)?.message, onlyRunnableMessage)
            }
        }
        for driver in ["claude", "gemini", "codex", "grok", "musecode", "cursor", "opencode", "antigravity", "pi"] {
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
        // the read tools are not allowed up front: Claude Code's own rule keeps them in the folder, and dontAsk refuses the rest
        XCTAssertEqual(args[args.firstIndex(of: "--allowedTools")! + 1], "WebSearch,WebFetch")
        XCTAssertEqual(args[args.firstIndex(of: "--permission-mode")! + 1], "dontAsk")
        let folder = claudeArguments(model: "claude-opus-5-5", effort: "low", systemFile: "/tmp/s.txt", tools: readTools, session: true, resume: "")
        XCTAssertFalse(folder.contains("--allowedTools"))
        XCTAssertEqual(folder[folder.firstIndex(of: "--permission-mode")! + 1], "dontAsk")
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
        // nor one with a quote, which would end Codex's TOML string
        XCTAssertNil(RelayRequest(json: Data((#"{"id":"j4","mcp":{"url":"https://a.test/\",x=\"/api/mcp","token":"ctj_"# + String(repeating: "a", count: 48) + #""}}"#).utf8))?.mcp)
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
        // a link left in the folder goes, the file and folder it pointed to stay, and the site's file lands inside
        let outside = temp()
        try "secret".write(to: outside.appendingPathComponent("secret.txt"), atomically: true, encoding: .utf8)
        try FileManager.default.createSymbolicLink(at: root.appendingPathComponent("link.txt"), withDestinationURL: outside.appendingPathComponent("secret.txt"))
        try FileManager.default.createSymbolicLink(at: root.appendingPathComponent("sources"), withDestinationURL: outside)
        try syncFolder(root, ["sources/talk.md": "talk"], prune: false)
        XCTAssertNil(try? FileManager.default.destinationOfSymbolicLink(atPath: root.appendingPathComponent("link.txt").path))
        XCTAssertEqual(try String(contentsOf: root.appendingPathComponent("sources/talk.md"), encoding: .utf8), "talk")
        XCTAssertNil(try? FileManager.default.destinationOfSymbolicLink(atPath: root.appendingPathComponent("sources").path))
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: outside.path), ["secret.txt"])
        // the assistant's folder, on a turn that brings no file
        try FileManager.default.createSymbolicLink(at: root.appendingPathComponent("link.txt"), withDestinationURL: outside.appendingPathComponent("secret.txt"))
        var req = request(#"{"id":"j","system":"","user":""}"#)
        req.workdir = root
        _ = try prepareFolder(req, work: temp(), tmp: temp())
        XCTAssertNil(try? FileManager.default.destinationOfSymbolicLink(atPath: root.appendingPathComponent("link.txt").path))
        XCTAssertEqual(try String(contentsOf: root.appendingPathComponent("sources/talk.md"), encoding: .utf8), "talk")
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

    // Today's Codex (0.163 on 2026-11-10, its own lines): a notice first, then the answer and the turn's usage.
    private let codexNowLines = [
        #"{"type":"thread.started","thread_id":"01a1c69e-7612-75f1-a263-593414a2a941"}"#,
        #"{"type":"item.completed","item":{"id":"item_0","type":"error","message":"Configured service tier `priority` is not advertised as supported for model `gpt-6-luna` and will be omitted from requests."}}"#,
        #"{"type":"turn.started"}"#,
        #"{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"ready"}}"#,
        #"{"type":"turn.completed","usage":{"input_tokens":16634,"cached_input_tokens":0,"cache_write_input_tokens":0,"output_tokens":5,"reasoning_output_tokens":0}}"#,
    ]

    func testCodexAnswerIsReadFromTodaysEventsAndANoticeIsNotAFailure() {
        let result = feedCodex(codexNowLines).result(err: "")
        XCTAssertEqual(result["is_error"] as? Bool, false)
        XCTAssertEqual(result["result"] as? String, "ready")
        let usage = result["usage"] as? [String: Any] ?? [:]
        XCTAssertEqual(usage["input_tokens"] as? Int, 16634)
        XCTAssertEqual(usage["output_tokens"] as? Int, 5)
    }

    func testCodexsCallToTheAppsToolIsNotTheAnswerNorAFailure() {
        // codex-cli 0.163's own lines for an assistant turn (testRealCodexToolsRun, 2026-11-10): one MCP call, then the answer
        let result = feedCodex([
            #"{"type":"thread.started","thread_id":"01a1c72b-6818-70b3-8e3d-17cd284a25db"}"#,
            #"{"type":"turn.started"}"#,
            #"{"type":"item.started","item":{"id":"item_0","type":"mcp_tool_call","server":"creator-toolset","tool":"workshop_projects","arguments":{},"result":null,"error":null,"status":"in_progress"}}"#,
            #"{"type":"item.completed","item":{"id":"item_0","type":"mcp_tool_call","server":"creator-toolset","tool":"workshop_projects","arguments":{},"result":{"content":[{"type":"text","text":"{\n \"projects\": [\n  {\n   \"id\": \"baa343fc-39f8-4afa-9db3-0e109298da28\",\n   \"name\": \"Tiny Acrobatics 845230\"\n  }\n ]\n}"}],"structured_content":null},"error":null,"status":"completed"}}"#,
            #"{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"Your newest Workshop project is **Tiny Acrobatics 845230**."}}"#,
            #"{"type":"turn.completed","usage":{"input_tokens":67050,"cached_input_tokens":40960,"cache_write_input_tokens":0,"output_tokens":88,"reasoning_output_tokens":0}}"#,
        ]).result(err: "")
        XCTAssertEqual(result["is_error"] as? Bool, false)
        XCTAssertEqual(result["result"] as? String, "Your newest Workshop project is **Tiny Acrobatics 845230**.")
    }

    func testCodexFailureInTodaysEventsIsTheTurnsError() {
        let refused = #"{\"type\":\"error\",\"status\":400,\"error\":{\"message\":\"The 'no-such-model' model is not supported when using Codex with a ChatGPT account.\"}}"#
        let result = feedCodex([
            #"{"type":"item.completed","item":{"id":"item_1","type":"error","message":"Model metadata for `no-such-model` not found."}}"#,
            #"{"type":"turn.started"}"#,
            #"{"type":"turn.failed","error":{"message":""# + refused + #""}}"#,
        ]).result(err: "")
        XCTAssertEqual(result["is_error"] as? Bool, true)
        XCTAssertTrue((result["result"] as? String ?? "").contains("not supported when using Codex with a ChatGPT account"))
    }

    func testCodexsOwnLimitWordsCountAsALimit() {
        XCTAssertTrue(limitFlag("codex", "You've hit your usage limit. Upgrade to Pro or try again in 3 hours 12 minutes."))
        XCTAssertFalse(limitFlag("codex", "The 'gpt-5.6-terra' model requires a newer version of Codex."))
    }

    func testTheNewestCopyOfACliRuns() {
        // an old Homebrew Codex found first, the one the app installed found second: the newer one runs
        let versions = ["/opt/homebrew/bin/codex": [0, 39, 0], "/Users/a/.local/bin/codex": [0, 167, 0]]
        XCTAssertEqual(newest(["/opt/homebrew/bin/codex", "/Users/a/.local/bin/codex"]) { versions[$0] ?? [] }, "/Users/a/.local/bin/codex")
        // the first found wins a tie, and when no copy names a version
        XCTAssertEqual(newest(["/a/claude", "/b/claude"]) { _ in [2, 1, 321] }, "/a/claude")
        XCTAssertEqual(newest(["/a/claude", "/b/claude"]) { _ in [] }, "/a/claude")
        XCTAssertEqual(newest(["/only/codex"]) { _ in XCTFail("one copy needs no version"); return [] }, "/only/codex")
        XCTAssertNil(newest([]))
        XCTAssertEqual(versionNumbers("codex-cli 0.39.0"), [0, 39, 0])
        XCTAssertEqual(versionNumbers("2.1.321 (Claude Code)"), [2, 1, 321])
        XCTAssertEqual(versionNumbers("codex-cli 0.163.0-alpha.11.2"), [0, 163, 0])
        XCTAssertEqual(versionNumbers("no version here"), [])
        // the Codex inside the ChatGPT app is a copy that may run (no download for that person); no Claude inside another app is
        XCTAssertTrue(driverBinaries["codex"]?.contains(chatGPTAppCodex) ?? false)
        XCTAssertEqual(driverBinaries["claude"], ["claude"])
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

    func testCodexCommandLineReadsOnlyItsFolderWithThePromptOnStdin() {
        let args = codexArguments(cwd: "/tmp/run", model: "gpt-x", effort: "low")
        XCTAssertEqual(args.prefix(2), ["exec", "--json"])
        XCTAssertEqual(args[args.firstIndex(of: "-C")! + 1], "/tmp/run")
        XCTAssertEqual(args[args.firstIndex(of: "-m")! + 1], "gpt-x")
        XCTAssertTrue(args.contains("model_reasoning_effort=low"))
        XCTAssertEqual(args.last, "-")
        XCTAssertFalse(codexArguments(cwd: "/tmp/run", model: "", effort: "low").contains("-m"))
        XCTAssertFalse(args.joined(separator: " ").contains("mcp_servers"))
        // the assistant: the app's MCP server for this run, its token from the environment, its calls not asked about
        let tools = codexArguments(cwd: "/tmp/run", model: "gpt-x", effort: "low", mcpURL: "http://127.0.0.1:5360/api/mcp")
        XCTAssertTrue(tools.contains(#"mcp_servers.creator-toolset.url="http://127.0.0.1:5360/api/mcp""#))
        XCTAssertTrue(tools.contains(#"mcp_servers.creator-toolset.bearer_token_env_var="CREATOR_TOOLSET_MCP_TOKEN""#))
        XCTAssertTrue(tools.contains(#"mcp_servers.creator-toolset.default_tools_approval_mode="approve""#))
        XCTAssertEqual(tools.last, "-")
        // every run: its own permission profile (reads in its folder only; no -s, which would win over it), and none of the
        // person's own config, so no MCP server of theirs is in it
        for run in [args, tools] {
            XCTAssertFalse(run.contains("-s"))
            XCTAssertTrue(run.contains("--ignore-user-config"))
            XCTAssertTrue(run.contains(#"default_permissions="creator-toolset-folder""#))
            XCTAssertTrue(run.contains(#"permissions.creator-toolset-folder.filesystem={":minimal"="read",":project_roots"="read"}"#))
            XCTAssertTrue(run.contains(#"shell_environment_policy.inherit="core""#))
        }
    }

    /// Codex's own help decides: one that names permission profiles runs in its folder's profile, an older one is not run.
    func testACodexThatTakesAProfileRunsFencedAndAnOlderOneIsNotRun() throws {
        let dir = temp()
        let seen = dir.appendingPathComponent("seen.txt")
        func stub(_ name: String, help: String) throws -> String {
            let file = dir.appendingPathComponent(name)
            let script = "#!/bin/sh\nif [ \"$1\" = sandbox ]; then echo '\(help)'; exit 0; fi\ncat > /dev/null\necho \"$*\" > '\(seen.path)'\n"
                + #"echo '{"type":"item.completed","item":{"id":"i","type":"agent_message","text":"ok"}}'"# + "\n"
            try script.write(to: file, atomically: true, encoding: .utf8)
            try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: file.path)
            return file.path
        }
        let req = request(#"{"id":"c10","system":"s","user":"u","driver":"codex","effort":"low","files":{"notes.md":"x"}}"#)
        let run = { (cli: String) in try runAnswer(req, try requestOptions(req), cli: cli, work: self.temp(), send: { _ in true }, step: { _ in }).text }
        let current = try stub("codex-current", help: "  -P, --permission-profile <NAME>")
        XCTAssertEqual(codexTakesProfile(current), true)
        XCTAssertEqual(try run(current), "ok")
        let args = try String(contentsOf: seen, encoding: .utf8)
        XCTAssertTrue(args.contains("default_permissions=") && args.contains("--ignore-user-config") && !args.contains("-s read-only"))
        try FileManager.default.removeItem(at: seen)
        let old = try stub("codex-old", help: "  -c, --config <key=value>")
        XCTAssertEqual(codexTakesProfile(old), false)
        XCTAssertThrowsError(try run(old)) { XCTAssertEqual(($0 as? ClaudeFailure)?.message, codexTooOld) }
        XCTAssertFalse(FileManager.default.fileExists(atPath: seen.path))   // it never started
    }

    func testAnOpenCodeRunGetsRulesThatKeepItInItsFolder() throws {
        func parsed(_ text: String?) throws -> [String: Any] {
            try XCTUnwrap(JSONSerialization.jsonObject(with: Data(try XCTUnwrap(text).utf8)) as? [String: Any])
        }
        let env = acpRules(driver: "opencode", web: false)
        let rules = try parsed(env["OPENCODE_PERMISSION"]) as? [String: String]
        XCTAssertEqual(rules, ["*": "deny", "external_directory": "deny", "read": "allow", "glob": "allow", "grep": "allow", "list": "allow",
                               "todowrite": "allow", "webfetch": "deny"])
        XCTAssertTrue(env["OPENCODE_PERMISSION"]!.hasPrefix(#"{"*":"deny""#))   // the catch-all first, the tools it allows after
        // the same rules for the build agent, which every run uses, over the person's own config
        let config = try parsed(env["OPENCODE_CONFIG_CONTENT"])
        XCTAssertEqual(config["default_agent"] as? String, "build")
        XCTAssertEqual(((config["agent"] as? [String: Any])?["build"] as? [String: Any])?["permission"] as? [String: String], rules)
        XCTAssertEqual((try parsed(acpRules(driver: "opencode", web: true)["OPENCODE_PERMISSION"]))["webfetch"] as? String, "allow")
        XCTAssertEqual(acpRules(driver: "pi", web: true), [:])
    }

    /// A Codex that isn't there fails in the words for that, not as a slow start.
    func testAMissingCodexSaysItIsNotInstalled() throws {
        let req = request(#"{"id":"c11","system":"s","user":"u","driver":"codex","effort":"low"}"#)
        XCTAssertThrowsError(try runAnswer(req, try requestOptions(req), cli: temp().appendingPathComponent("codex").path, work: temp(), send: { _ in true }, step: { _ in })) {
            XCTAssertTrue(($0 as? ClaudeFailure)?.message.contains("is not installed on this Mac") == true, "\($0)")
        }
    }

    func testCodexGetsTheTokenInItsEnvironmentNeverAsAnArgument() throws {
        let dir = temp()
        let seen = dir.appendingPathComponent("seen.txt")
        // a codex that names permission profiles in its help, and for a run writes its arguments and the token it was given
        let file = dir.appendingPathComponent("codex")
        let script = "#!/bin/sh\nif [ \"$2\" = \"--help\" ]; then echo '  -P, --permission-profile <NAME>'; exit 0; fi\ncat > /dev/null\n"
            + "echo \"$* token=$\(codexTokenEnv)\" > '\(seen.path)'\n"
            + #"echo '{"type":"item.completed","item":{"id":"i","type":"agent_message","text":"ok"}}'"# + "\n"
        try script.write(to: file, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: file.path)
        let token = "ctj_" + String(repeating: "b", count: 48)
        let req = request(#"{"id":"c9","system":"s","user":"u","driver":"codex","effort":"low","mcp":{"url":"http://127.0.0.1:9/api/mcp","token":""# + token + #""}}"#)
        _ = try runAnswer(req, try requestOptions(req), cli: file.path, work: temp(), send: { _ in true }, step: { _ in })
        let now = try String(contentsOf: seen, encoding: .utf8)
        XCTAssertTrue(now.contains(#"mcp_servers.creator-toolset.url="http://127.0.0.1:9/api/mcp""#))
        XCTAssertTrue(now.hasSuffix(" token=\(token)\n"))
        XCTAssertEqual(now.components(separatedBy: token).count, 2)   // in the environment only, never an argument
    }

    func testGeminiAndGrokGetTheAppsServerForOneRunInTheirOwnFolder() throws {
        // Gemini: only that server, and the rule that lets its calls run in plan mode; nothing more without it
        XCTAssertEqual(geminiArguments(model: "", policy: "/t/p.toml", mcp: true),
                       ["-o", "stream-json", "--approval-mode", "plan", "--skip-trust", "--allowed-mcp-server-names", "creator-toolset", "--policy", "/t/p.toml"])
        XCTAssertEqual(geminiArguments(model: "", policy: "/t/p.toml"), ["-o", "stream-json", "--approval-mode", "plan", "--skip-trust", "--policy", "/t/p.toml"])
        XCTAssertTrue(geminiPolicy(mcp: true).contains(#"mcpName = "creator-toolset""#) && geminiPolicy(mcp: true).contains(#"modes = ["plan"]"#))
        // no way out of plan mode and no writes or shell in any run, in any mode; the app's server only with it
        for mcp in [true, false] {
            XCTAssertTrue(geminiPolicy(mcp: mcp).hasSuffix(#"toolName = ["exit_plan_mode", "write_file", "replace", "run_shell_command"]\#ndecision = "deny"\#npriority = 100\#n"#))
        }
        XCTAssertFalse(geminiPolicy(mcp: false).contains("creator-toolset"))
        // Grok: that server's calls allowed; the rest of its command line as without it
        let prompt = "/tmp/p.txt"
        let plain = grokArguments(cwd: "/tmp/run", model: "", effort: "low", system: "S", web: false, promptFile: prompt)
        let tools = grokArguments(cwd: "/tmp/run", model: "", effort: "low", system: "S", web: false, promptFile: prompt, mcp: true)
        XCTAssertEqual(tools, plain + ["--allow", "MCPTool(creator-toolset__*)"])
        XCTAssertFalse(plain.contains("--allow"))
        // the files name the server and the variable the token is in, never the token
        let run = temp()
        try runMcpFiles(driver: "gemini", url: "http://127.0.0.1:9/api/mcp", cwd: run)
        try runMcpFiles(driver: "grok", url: "http://127.0.0.1:9/api/mcp", cwd: run)
        let settings = try JSONSerialization.jsonObject(with: Data(contentsOf: run.appendingPathComponent(".gemini/settings.json"))) as? [String: Any]
        let server = (settings?["mcpServers"] as? [String: Any])?["creator-toolset"] as? [String: Any]
        XCTAssertEqual(server?["httpUrl"] as? String, "http://127.0.0.1:9/api/mcp")
        XCTAssertEqual((server?["headers"] as? [String: String])?["Authorization"], "Bearer $CREATOR_TOOLSET_MCP_TOKEN")
        XCTAssertEqual(try String(contentsOf: run.appendingPathComponent(".grok/config.toml"), encoding: .utf8),
                       "[mcp_servers.creator-toolset]\nurl = \"http://127.0.0.1:9/api/mcp\"\nbearer_token_env_var = \"CREATOR_TOOLSET_MCP_TOKEN\"\n")
        // the run trusts its own folder through each one's variable, which writes nothing (Grok's --trust would)
        XCTAssertEqual(runMcpEnv(driver: "gemini", token: "ctj_x"), ["CREATOR_TOOLSET_MCP_TOKEN": "ctj_x", "GEMINI_CLI_TRUST_WORKSPACE": "true"])
        XCTAssertEqual(runMcpEnv(driver: "grok", token: "ctj_x"), ["CREATOR_TOOLSET_MCP_TOKEN": "ctj_x", "GROK_FOLDER_TRUST": "0"])
    }

    func testGeminiAndGrokRunsGetTheTokenInTheirEnvironmentAndTheServerInTheirFolder() throws {
        let dir = temp()
        let seen = dir.appendingPathComponent("seen.txt")
        // a program that prints `help` for --help, and for a run writes its sign-in variables, its arguments, the token it was
        // given and the server file in its folder, then answers as Gemini or Grok does
        func stub(_ name: String, help: String, answer: String) throws -> String {
            let file = dir.appendingPathComponent(name)
            let script = "#!/bin/sh\nif [ \"$1\" = \"--help\" ]; then echo '\(help)'; exit 0; fi\ncat > /dev/null\n"
                + "{ echo \"gca=$GOOGLE_GENAI_USE_GCA browser=$NO_BROWSER $* token=$\(codexTokenEnv)\"; cat .gemini/settings.json .grok/config.toml 2>/dev/null; } > '\(seen.path)'\n"
                + "echo '\(answer)'\n"
            try script.write(to: file, atomically: true, encoding: .utf8)
            try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: file.path)
            return file.path
        }
        let token = "ctj_" + String(repeating: "c", count: 48)
        let mcp = #","mcp":{"url":"http://127.0.0.1:9/api/mcp","token":""# + token + #""}}"#
        let answer = (gemini: #"{"type":"message","role":"assistant","content":"ok"}"#, grok: #"{"type":"result","subtype":"success","is_error":false,"result":"ok"}"#)
        for (driver, cli, old) in [("gemini", try stub("gemini", help: "  --policy  Additional policy files", answer: answer.gemini), try stub("gemini-old", help: "  --yolo", answer: answer.gemini)),
                                   ("grok", try stub("grok", help: "", answer: answer.grok), nil)] {
            let req = request(#"{"id":"g9","system":"s","user":"u","driver":""# + driver + #"","effort":"low""# + mcp)
            let run = { (cli: String) in try runAnswer(req, try requestOptions(req), cli: cli, work: self.temp(), send: { _ in true }, step: { _ in }).text }
            XCTAssertEqual(try run(cli), "ok")
            let now = try String(contentsOf: seen, encoding: .utf8)
            XCTAssertTrue(now.contains(" token=\(token)\n"), driver)
            // Gemini's Google-account sign-in for the run, never an API key
            if driver == "gemini" { XCTAssertTrue(now.hasPrefix("gca=true browser=true ")) }
            XCTAssertEqual(now.components(separatedBy: token).count, 2, driver)   // in the environment only: no argument, no file
            XCTAssertTrue(now.contains("http://127.0.0.1:9/api/mcp"), driver)
            XCTAssertTrue(now.contains(driver == "gemini" ? "--allowed-mcp-server-names creator-toolset --policy" : "--allow MCPTool(creator-toolset__*)"), driver)
            // a Gemini too old for a policy file is not run at all: nothing else holds its rules
            if let old {
                try FileManager.default.removeItem(at: seen)
                XCTAssertThrowsError(try run(old)) { XCTAssertEqual(($0 as? ClaudeFailure)?.message, geminiTooOld) }
                XCTAssertFalse(FileManager.default.fileExists(atPath: seen.path))
                // a current Gemini without the app's tools still gets the rules (no file writes), and no MCP server
                let plain = request(#"{"id":"g8","system":"s","user":"u","driver":"gemini","effort":"low"}"#)
                XCTAssertEqual(try runAnswer(plain, try requestOptions(plain), cli: cli, work: temp(), send: { _ in true }, step: { _ in }).text, "ok")
                let rules = try String(contentsOf: seen, encoding: .utf8)
                XCTAssertTrue(rules.contains(" --policy ") && !rules.contains("--allowed-mcp-server-names"))
            }
        }
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

    func testGrokCommandLineNeverHasFileTools() {
        let prompt = "/tmp/p.txt"
        let plain = grokArguments(cwd: "/tmp/run", model: "", effort: "low", system: "S", web: false, promptFile: prompt)
        XCTAssertEqual(plain[plain.firstIndex(of: "--prompt-file")! + 1], prompt)
        // no web: one built-in that touches no file (an empty list would offer them all)
        XCTAssertEqual(plain[plain.firstIndex(of: "--tools")! + 1], "todo_write")
        XCTAssertTrue(plain.contains("--disable-web-search"))
        XCTAssertEqual(plain[plain.firstIndex(of: "--permission-mode")! + 1], "dontAsk")
        XCTAssertEqual(plain[plain.firstIndex(of: "--disallowed-tools")! + 1], "run_terminal_cmd,search_replace,Agent")
        let web = grokArguments(cwd: "/tmp/run", model: "grok-4", effort: "high", system: "S", web: true, promptFile: prompt)
        XCTAssertEqual(web[web.firstIndex(of: "--tools")! + 1], "web_search,web_fetch")
        XCTAssertFalse(web.contains("--disable-web-search"))
        XCTAssertEqual(web[web.firstIndex(of: "-m")! + 1], "grok-4")
        // reads of any path, edits, writes and shell are refused in every run: there is no folder run
        func denied(_ args: [String]) -> [String] { args.indices.filter { args[$0] == "--deny" }.map { args[$0 + 1] } }
        for args in [plain, web] {
            XCTAssertEqual(denied(args), ["Read(**)", "Edit", "Write", "Bash"])
            XCTAssertFalse(args.joined(separator: " ").contains("read_file"))
        }
    }

    func testGrokGetsItsTextFilesInThePromptAndNoOtherFile() {
        XCTAssertEqual(grokInline("Do it.", files: [:]), "Do it.")
        let text = grokInline("Do it.", files: ["notes/b.md": "second", "a.md": "first"])
        XCTAssertEqual(text, "The files this request needs are below, each whole under its path.\n\n"
            + "<file path=\"a.md\">\nfirst\n</file>\n\n<file path=\"notes/b.md\">\nsecond\n</file>\n\nDo it.")
        XCTAssertNil(grokInline("Look.", files: ["a.md": "first", "shot.png": "base64:iVBORw0KGgo="]))
    }

    /// A Grok run never sits in a folder of files: a Workshop session's files reach it in the prompt, it runs in an empty
    /// folder of its own, and a picture is refused before the program starts.
    func testAGrokRunHasNoFolderOfFiles() throws {
        let dir = temp()
        let seen = dir.appendingPathComponent("seen.txt")
        let file = dir.appendingPathComponent("grok")
        // a program that writes where it runs, what is in that folder, its arguments and its prompt, then answers as Grok does
        let script = "#!/bin/sh\nfor a in \"$@\"; do if [ \"$p\" = 1 ]; then f=\"$a\"; p=0; fi; [ \"$a\" = --prompt-file ] && p=1; done\n"
            + "{ pwd; ls -A; echo \"ARGS $*\"; cat \"$f\"; } > '\(seen.path)'\n"
            + #"echo '{"type":"result","subtype":"success","is_error":false,"result":"ok"}'"# + "\n"
        try script.write(to: file, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: file.path)
        let work = temp()
        let run = { (body: String) in
            let req = self.request(#"{"id":"gf","system":"s","user":"Sum it up.","driver":"grok","effort":"low","session":"sess-1","web":true,"# + body + "}")
            return try runAnswer(req, try requestOptions(req), cli: file.path, work: work, send: { _ in true }, step: { _ in }).text
        }
        XCTAssertEqual(try run(#""files":{"sources/talk.md":"CANARY in the session"}"#), "ok")
        let now = try String(contentsOf: seen, encoding: .utf8)
        XCTAssertTrue(now.contains("<file path=\"sources/talk.md\">\nCANARY in the session\n</file>\n\nSum it up."))
        XCTAssertFalse(now.contains("read them there"))                       // no folder note: there is nothing to read
        XCTAssertFalse(now.components(separatedBy: "ARGS")[0].contains("talk.md"))   // the folder it runs in holds no file of the request
        XCTAssertFalse(now.contains(work.path))                               // and it is not the Workshop session's folder
        XCTAssertTrue(now.contains("--tools web_search,web_fetch") && now.contains("--deny Read(**)"))
        // nothing of the session was written on this Mac for it
        XCTAssertFalse(FileManager.default.fileExists(atPath: work.appendingPathComponent("workshop").path))
        try FileManager.default.removeItem(at: seen)
        XCTAssertThrowsError(try run(#""files":{"shot.png":"base64:iVBORw0KGgo="}"#)) { XCTAssertEqual(($0 as? ClaudeFailure)?.message, grokNoFiles) }
        XCTAssertFalse(FileManager.default.fileExists(atPath: seen.path))
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

    /// What a stand-in Codex says to `codex sandbox --help`, as a current one does (it names permission profiles): the first
    /// line of a stand-in's script, since a Codex without profiles is not run.
    private let codexHelp = "if [ \"$1\" = sandbox ]; then echo '  -P, --permission-profile <NAME>'; exit 0; fi\n"

    /// A stand-in CLI that ignores its arguments and prints `lines` (one per line) after reading its prompt.
    private func stubStreamCLI(_ name: String, _ lines: [String]) throws -> String {
        let file = temp().appendingPathComponent(name)
        let script = "#!/bin/sh\n\(codexHelp)cat > /dev/null\ncat <<'STUBEOF'\n" + lines.joined(separator: "\n") + "\nSTUBEOF\n"
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
        let script = "#!/bin/sh\n\(codexHelp)printf '%s\\n' \"$@\" > \(argv)\nprompt=$(cat)\nprintf '{\"id\":\"0\",\"msg\":{\"type\":\"agent_message\",\"message\":\"ok\"}}\\n'\n"
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
        let script = "#!/bin/sh\n\(codexHelp)cat > /dev/null\nprintf '{\"id\":\"0\",\"msg\":{\"type\":\"agent_message\",\"message\":\"%s\"}}\\n' \"$(pwd -P)\"\n"
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
        // CT_REAL_CODEX_BIN names another copy to run (a newly downloaded one); CT_REAL_CODEX_MODEL the model, as the app sends one
        let env = ProcessInfo.processInfo.environment
        let cli = env["CT_REAL_CODEX_BIN"] ?? binary("codex", home: FileManager.default.homeDirectoryForCurrentUser) ?? "codex"
        let model = env["CT_REAL_CODEX_MODEL"].map { #","model":""# + $0 + #"""# } ?? ""
        print("REAL CODEX: running \(cli), version \(cliVersion(cli))")
        let req = request(#"{"id":"real-codex","system":"Reply with just OK.","user":"Reply with just OK.","driver":"codex","effort":"low""# + model + "}")
        let answer = try runAnswer(req, try requestOptions(req), cli: cli, work: temp(), send: { _ in true }, step: { _ in })
        print("REAL CODEX: text=\(answer.text) usage=\(answer.usage)")
        XCTAssertTrue(answer.text.localizedCaseInsensitiveContains("OK"))
    }

    /// CT_REAL_CODEX=1 CT_REAL_SITE=<a server> CT_REAL_KEYS=<file> swift test --filter RealCodexTools: one assistant turn with
    /// the app's tools on a real Creator Toolset server whose account's AI is Codex on this Mac. The file holds that account's
    /// Full key and its paired device's token, one per line. The test makes a project with a new name, asks the assistant for
    /// it, runs the turn as RelayRunner.job does, and checks the answer names it (only a tool call can know it).
    func testRealCodexToolsRun() throws {
        guard ProcessInfo.processInfo.environment["CT_REAL_CODEX"] == "1" else { throw XCTSkip("set CT_REAL_CODEX=1, CT_REAL_SITE and CT_REAL_KEYS") }
        let cli = ProcessInfo.processInfo.environment["CT_REAL_CODEX_BIN"] ?? binary("codex", home: FileManager.default.homeDirectoryForCurrentUser) ?? "codex"
        XCTAssertEqual(codexTakesProfile(cli), true)
        try realToolsRun("codex", cli: cli)
    }

    /// CT_REAL_GEMINI_TOOLS=1 (and CT_REAL_SITE, CT_REAL_KEYS, CT_REAL_ASK as above) swift test --filter RealGeminiTools: the
    /// same turn on a server whose account's AI is Gemini on this Mac. CT_REAL_GEMINI_BIN names another copy; run it with the
    /// HOME (or GEMINI_CLI_HOME) whose ~/.gemini is signed in.
    func testRealGeminiToolsRun() throws {
        guard ProcessInfo.processInfo.environment["CT_REAL_GEMINI_TOOLS"] == "1" else { throw XCTSkip("set CT_REAL_GEMINI_TOOLS=1, CT_REAL_SITE and CT_REAL_KEYS") }
        let cli = ProcessInfo.processInfo.environment["CT_REAL_GEMINI_BIN"] ?? binary("gemini", home: FileManager.default.homeDirectoryForCurrentUser) ?? "gemini"
        XCTAssertEqual(geminiTakesPolicy(cli), true)
        try realToolsRun("gemini", cli: cli)
    }

    /// CT_REAL_GROK_TOOLS=1 (and CT_REAL_SITE, CT_REAL_KEYS, CT_REAL_ASK as above) swift test --filter RealGrokTools: the same
    /// turn on a server whose account's AI is Grok on this Mac, signed in. CT_REAL_GROK_BIN names another copy.
    func testRealGrokToolsRun() throws {
        guard ProcessInfo.processInfo.environment["CT_REAL_GROK_TOOLS"] == "1" else { throw XCTSkip("set CT_REAL_GROK_TOOLS=1, CT_REAL_SITE and CT_REAL_KEYS") }
        try realToolsRun("grok", cli: ProcessInfo.processInfo.environment["CT_REAL_GROK_BIN"] ?? binary("grok", home: FileManager.default.homeDirectoryForCurrentUser) ?? "grok")
    }

    /// One real assistant turn with the app's tools through `cli`, as RelayRunner.job runs it (the three tests above).
    private func realToolsRun(_ driver: String, cli: String) throws {
        let env = ProcessInfo.processInfo.environment
        guard let site = env["CT_REAL_SITE"].flatMap(URL.init(string:)), let keys = env["CT_REAL_KEYS"] else {
            throw XCTSkip("set CT_REAL_SITE and CT_REAL_KEYS to run one real \(driver) turn with the app's tools")
        }
        let lines = try String(contentsOfFile: keys, encoding: .utf8).split(separator: "\n").map(String.init)
        let account = DeviceAPI(base: site, token: lines[0])
        let device = DeviceAPI(base: site, token: lines[1])
        let name = "Tiny Acrobatics " + UUID().uuidString.prefix(6)
        XCTAssertLessThan(try account.call("POST", "/api/workshop/projects", ["name": name]).status, 300)
        // CT_REAL_ASK: another thing to ask (one that changes something); the caller then checks what changed on the server
        let ask = env["CT_REAL_ASK"] ?? "What is my newest Workshop project called?"
        XCTAssertEqual(try account.call("POST", "/api/assistant/turn", ["text": ask]).status, 202)
        let req = try XCTUnwrap(RelayRequest(json: try device.call("POST", "/api/devices/relay/wait", ["blobs": true]).data))
        XCTAssertEqual(req.driver, driver)
        XCTAssertNotNil(req.mcp)
        let base = "/api/devices/relay/\(req.id)"
        let answer = try runAnswer(req, try requestOptions(req), cli: cli, work: temp(), send: { text in
            (try? device.call("POST", "\(base)/text", ["text": text]))?.status != 404   // the site waits only while it hears from the run
        }, step: { label in _ = try? device.call("POST", "\(base)/step", ["label": label]) })
        _ = try device.call("POST", "\(base)/done", ["text": answer.text, "usage": answer.usage, "session_id": "", "session_state": ""])
        print("REAL \(driver.uppercased()) TOOLS: \(cliVersion(cli) ?? cli) asked for \(name), answered: \(answer.text) usage=\(answer.usage)")
        if env["CT_REAL_ASK"] == nil { XCTAssertTrue(answer.text.contains(name)) } else { XCTAssertFalse(answer.text.isEmpty) }
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

    /// CT_REAL_GROK_BIN=<a grok> CT_REAL_GROK_HOME=<a scratch folder> swift test --filter GrokStandIn: real grok runs the way the
    /// relay runs them, needing no account: grok runs in a home of its own made under CT_REAL_GROK_HOME, whose model is a
    /// stand-in on 127.0.0.1 that answers with tool calls on a file outside the run folder (a read, a listing, a search, a
    /// `tail -f` through monitor, a write), then the app's MCP tool (a stand-in server too). In neither run may one of those
    /// file calls run, and the MCP call must: plain, and the assistant with a pasted text file and the web on, whose file
    /// reaches the model in the prompt (a Grok run has no folder of files).
    func testRealGrokStandInRun() throws {
        let env = ProcessInfo.processInfo.environment
        guard let cli = env["CT_REAL_GROK_BIN"], let base = env["CT_REAL_GROK_HOME"] else {
            throw XCTSkip("set CT_REAL_GROK_BIN and CT_REAL_GROK_HOME to run grok against a stand-in model")
        }
        let fm = FileManager.default
        let root = URL(fileURLWithPath: base).appendingPathComponent("standin-\(UUID().uuidString)")
        let home = root.appendingPathComponent("home"), outside = root.appendingPathComponent("outside")
        for dir in [home.appendingPathComponent(".grok"), home.appendingPathComponent("tmp"), outside] {
            try fm.createDirectory(at: dir, withIntermediateDirectories: true)
        }
        let canary = "CANARY-" + UUID().uuidString, canaryFile = outside.appendingPathComponent("canary.txt").path
        let written = outside.appendingPathComponent("written.txt").path
        try canary.write(toFile: canaryFile, atomically: true, encoding: .utf8)
        let token = "ctj_" + String(repeating: "5", count: 48)
        func call(_ name: String, _ input: [String: Any]) -> [String: Any] { ["name": name, "arguments": input] }
        let server = try GrokStandIn(token: token, steps: [
            [call("read_file", ["target_file": canaryFile]), call("read_file", ["target_file": "notes.md"]),
             call("list_dir", ["target_directory": outside.path]), call("grep", ["pattern": "CANARY", "path": outside.path]),
             call("monitor", ["command": "tail -n 1 -f " + canaryFile, "description": "watch", "timeout_ms": 5000]),
             call("write", ["file_path": written, "content": "WRITTEN"]), call("search_tool", ["query": "creator-toolset lookup"])],
            [call("use_tool", ["tool_name": "creator-toolset__lookup", "tool_input": [String: Any]()])],
        ])
        try "[models]\ndefault = \"standin\"\n\n[model.standin]\nmodel = \"standin\"\nbase_url = \"http://127.0.0.1:\(server.port)/v1\"\napi_key = \"standin\"\n"
            .write(to: home.appendingPathComponent(".grok/config.toml"), atomically: true, encoding: .utf8)
        let old = (env["HOME"], env["TMPDIR"])
        setenv("HOME", home.path, 1)
        setenv("TMPDIR", home.appendingPathComponent("tmp").path, 1)   // grok's own temporary files (the run folders stay in ours)
        defer {
            if let home = old.0 { setenv("HOME", home, 1) }
            if let tmp = old.1 { setenv("TMPDIR", tmp, 1) } else { unsetenv("TMPDIR") }
        }
        let mcp = #","mcp":{"url":"http://127.0.0.1:\#(server.port)/api/mcp","token":"\#(token)"}"#
        for (name, extra) in [("plain", #","web":false"#), ("pasted", #","web":true,"files":{"notes.md":"Tiny Acrobatics notes"}"#)] {
            server.reset()
            let req = request(#"{"id":"standin","system":"S","user":"Do the task.","driver":"grok","effort":"low""# + extra + mcp + "}")
            let answer = try runAnswer(req, try requestOptions(req), cli: cli, work: root, send: { _ in true }, step: { _ in })
            let seen = server.bodies
            print("GROK STAND-IN \(cliVersion(cli) ?? cli) \(name): offered \(server.offered.sorted()), outside file read: \(seen.contains(canary))")
            XCTAssertEqual(answer.text, "DONE", name)
            // the app's tool is still found and runs
            XCTAssertTrue(server.results.contains { $0.contains("Look up the newest Workshop project.") }, name)
            XCTAssertTrue(server.results.contains { $0.contains("MCP-LOOKUP-RESULT") }, name)
            XCTAssertFalse(fm.fileExists(atPath: written), name)
            XCTAssertFalse(seen.contains(canary), name)   // the file outside never reached the model
            XCTAssertTrue(server.offered.isDisjoint(with: ["read_file", "list_dir", "grep", "write", "monitor"]), "\(name): \(server.offered)")
            if name == "plain" {
                XCTAssertTrue(server.offered.isSubset(of: ["todo_write", "search_tool", "use_tool", "session_title"]), "\(server.offered)")
            } else {
                XCTAssertTrue(seen.contains("<file path=\\\"notes.md\\\">\\nTiny Acrobatics notes"), name)   // in the prompt, as the model got it (JSON)
            }
        }
        try? fm.removeItem(at: root)
    }

    /// CT_REAL_MUSE=1 swift test --filter RealMuse: real runs through Muse Code, the way the relay runs it. CT_REAL_MUSE_BIN names
    /// the copy (default: the one on this Mac) and CT_REAL_MUSE_HOME the home it runs in (its sign-in is that home's
    /// ~/.config/muse). The runs go out with HOME set to it, so nothing lands in this Mac's own home.
    private func withMuse(_ body: (String, URL) throws -> Void) throws {
        let env = ProcessInfo.processInfo.environment
        guard env["CT_REAL_MUSE"] == "1" else { throw XCTSkip("set CT_REAL_MUSE=1 to run real Muse Code calls") }
        let cli = env["CT_REAL_MUSE_BIN"] ?? binary("musecode", home: FileManager.default.homeDirectoryForCurrentUser) ?? "muse"
        let old = (env["HOME"], env["TMPDIR"])
        var dir: URL?
        if let home = env["CT_REAL_MUSE_HOME"] {
            // its temporary files too (swift test sets its own TMPDIR for the tests)
            let tmp = (home as NSString).appendingPathComponent("tmp")
            try FileManager.default.createDirectory(atPath: tmp, withIntermediateDirectories: true)
            setenv("HOME", home, 1)
            setenv("TMPDIR", tmp, 1)
            let own = URL(fileURLWithPath: tmp).appendingPathComponent("relay-test-\(UUID().uuidString)")
            try FileManager.default.createDirectory(at: own, withIntermediateDirectories: true)
            dir = own
            XCTAssertEqual(ProcessInfo.processInfo.environment["HOME"], home)   // what the run's environment is built from
        }
        defer {
            if let home = old.0 { setenv("HOME", home, 1) }
            if let tmp = old.1 { setenv("TMPDIR", tmp, 1) } else { unsetenv("TMPDIR") }
        }
        print("REAL MUSE: running \(cli), version \(cliVersion(cli) ?? "?")")
        try body(cli, dir ?? temp())
    }

    /// Needs a signed-in home: one tiny answer from Meta's model on that plan. In a home that never signed in it fails with
    /// the words a person sees.
    func testRealMuseRun() throws {
        try withMuse { cli, dir in
            let req = request(#"{"id":"real-muse","system":"Reply with just OK.","user":"Reply with just OK.","driver":"musecode","effort":"low"}"#)
            do {
                let answer = try runAnswer(req, try requestOptions(req), cli: cli, work: dir, send: { _ in true }, step: { _ in })
                print("REAL MUSE: text=\(answer.text) usage=\(answer.usage)")
                XCTAssertTrue(answer.text.localizedCaseInsensitiveContains("OK"))
            } catch let failure as ClaudeFailure {
                print("REAL MUSE: failed: \(failure.message) limit=\(limitFlag("musecode", failure.message)) usage=\(failure.usage ?? [:])")
                XCTFail(failure.message)
            }
        }
    }

    /// Needs no account: the same runs on Muse Code's echo provider (it says the prompt back), through a copy of the program
    /// that swaps `--provider meta` for `--provider echo`. An answer with no folder (no tools), one with a folder (shell and
    /// writes off), and one the site stops at its first text.
    func testRealMuseEchoRun() throws {
        try withMuse { cli, dir in
            let echo = dir.appendingPathComponent("muse-echo")
            try "#!/bin/bash\nargs=(); for a in \"$@\"; do [ \"$a\" = meta ] && a=echo; args+=(\"$a\"); done\nexec \(shellQuote(cli)) \"${args[@]}\"\n"
                .write(to: echo, atomically: true, encoding: .utf8)
            try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: echo.path)
            for files in [#"{}"#, #"{"notes.md":"Tiny Acrobatics"}"#] {
                let req = request(#"{"id":"real-muse-echo","system":"Reply with just OK.","user":"Say hello.","driver":"musecode","effort":"low","files":\#(files)}"#)
                let answer = try runAnswer(req, try requestOptions(req), cli: echo.path, work: dir, send: { _ in true }, step: { _ in })
                print("REAL MUSE ECHO: files=\(files) text=\(answer.text.debugDescription) usage=\(answer.usage)")
                XCTAssertTrue(answer.text.hasPrefix("echo: <instructions>\nReply with just OK.\n</instructions>"))
                XCTAssertTrue(answer.text.hasSuffix("Say hello."))
            }
            let req = request(#"{"id":"real-muse-stop","system":"S","user":"U","driver":"musecode","effort":"low"}"#)
            XCTAssertThrowsError(try runAnswer(req, try requestOptions(req), cli: echo.path, work: dir, send: { _ in false }, step: { _ in })) { error in
                XCTAssertEqual((error as? ClaudeFailure)?.stopped, true)
            }
        }
    }

    /// Needs no account: the app's sign-in (MuseLogin) starts the real `muse login` and gets Meta's page and code from it.
    /// The program runs with macOS's opener blocked, so no browser opens, and it is stopped after 12 s, before anyone approves.
    func testRealMuseLoginGivesThePageAndCode() throws {
        try withMuse { cli, dir in
            let profile = dir.appendingPathComponent("no-browser.sb")
            try """
            (version 1)
            (allow default)
            (deny process-exec (literal "/usr/bin/open"))
            (deny mach-lookup (global-name "com.apple.coreservices.launchservicesd") (global-name "com.apple.lsd.mapdb") (global-name "com.apple.lsd.modifydb") (global-name "com.apple.lsd.open"))
            """.write(to: profile, atomically: true, encoding: .utf8)
            let login = dir.appendingPathComponent("muse-login")
            try "#!/bin/bash\n/usr/bin/sandbox-exec -f \(shellQuote(profile.path)) \(shellQuote(cli)) \"$@\" &\npid=$!\nsleep 12\nkill $pid 2>/dev/null\nwait $pid\n"
                .write(to: login, atomically: true, encoding: .utf8)
            try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: login.path)
            let found = expectation(description: "Meta's page and code")
            MuseLogin().start(binary: login.path) { page, code in
                print("REAL MUSE LOGIN: page on \(page.host ?? "?"), a code of \(code.count) characters")
                XCTAssertEqual(page.host, "auth.meta.com")
                XCTAssertFalse(code.isEmpty)
                found.fulfill()
            }
            wait(for: [found], timeout: 20)
        }
    }

    /// CT_REAL_GEMINI=1 swift test --filter RealGemini: one tiny run through the Gemini CLI setup installed, the way the relay
    /// runs it. It answers only once that home's ~/.gemini is signed in with Google: run it with HOME set to that home.
    func testRealGeminiRun() throws {
        let env = ProcessInfo.processInfo.environment
        guard env["CT_REAL_GEMINI"] == "1" else {
            throw XCTSkip("set CT_REAL_GEMINI=1 to run one real gemini call")
        }
        // CT_REAL_GEMINI_BIN names another copy to run (one installed into a test home)
        let cli = env["CT_REAL_GEMINI_BIN"] ?? binary("gemini", home: FileManager.default.homeDirectoryForCurrentUser) ?? "gemini"
        print("REAL GEMINI: running \(cli), version \(cliVersion(cli))")
        let req = request(#"{"id":"real-gemini","system":"Reply with just OK.","user":"Reply with just OK.","driver":"gemini","model":"gemini-3.8-flash","effort":"low"}"#)
        let answer = try runAnswer(req, try requestOptions(req), cli: cli, work: temp(), send: { _ in true }, step: { _ in })
        print("REAL GEMINI: text=\(answer.text) usage=\(answer.usage)")
        XCTAssertTrue(answer.text.localizedCaseInsensitiveContains("OK"))
    }

    // MARK: Gemini (the Mac relay GeminiRun and its checks)

    func testGeminiSetupInstallIsFound() {
        // setup installs Gemini CLI beside the app's own Node.js; the relay looks there too
        XCTAssertEqual(driverBinaries["gemini"]?.last, appSupport.appendingPathComponent("node/bin/gemini").path)
    }

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


    /// CT_REAL_CLAUDE=1 swift test --filter RealRun: one tiny claude run through a signed-in Claude home, the way the relay
    /// runs it. CT_REAL_CLAUDE_HOME names that home's folder under the person's home folder (default .claude-work). Run it
    /// with the shell's own CLAUDE* and ANTHROPIC* variables unset: the Mac app's environment has none of them.
    func testRealRunThroughTheHubHome() throws {
        let env = ProcessInfo.processInfo.environment
        guard env["CT_REAL_CLAUDE"] == "1" else {
            throw XCTSkip("set CT_REAL_CLAUDE=1 to run one real claude call")
        }
        let home = FileManager.default.homeDirectoryForCurrentUser
        let hub = home.appendingPathComponent(env["CT_REAL_CLAUDE_HOME"] ?? ".claude-work").path
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

    /// CT_REAL_CLAUDE=1 [CT_REAL_CLAUDE_HOME=…] swift test --filter RealClaudeFolderAndTool: two more short real runs through
    /// the same home, for the two things the folder fence must not break. A run with a folder reads a file inside it (reads
    /// are not allowed up front: Claude Code's own rule lets them run inside its folder, and dontAsk refuses the rest). An
    /// assistant run calls the app's MCP tool (a stand-in server on 127.0.0.1) and answers with what it returned.
    func testRealClaudeFolderAndToolRuns() throws {
        let env = ProcessInfo.processInfo.environment
        guard env["CT_REAL_CLAUDE"] == "1" else { throw XCTSkip("set CT_REAL_CLAUDE=1 to run real claude calls") }
        let home = FileManager.default.homeDirectoryForCurrentUser
        let hub = home.appendingPathComponent(env["CT_REAL_CLAUDE_HOME"] ?? ".claude-work").path
        let cli = binary("claude", home: home) ?? "claude"
        let base = #""driver":"claude","model":"claude-opus-5-5","effort":"low","home":"\#(hub)""#
        var steps: [String] = []

        let word = "TINY-" + UUID().uuidString.prefix(8)
        let folder = request(#"{"id":"real-folder","system":"Answer from the files in the current folder.","user":"What is the code word in notes.md? Reply with just the code word.","files":{"notes.md":"The code word is \#(word)."},"# + base + "}")
        let read = try runAnswer(folder, try requestOptions(folder), cli: cli, work: temp(), send: { _ in true }, step: { steps.append($0) })
        print("REAL CLAUDE folder: text=\(read.text) steps=\(steps) cli=\(cli)")
        XCTAssertTrue(read.text.contains(word))

        let token = "ctj_" + String(repeating: "7", count: 48)
        let server = try GrokStandIn(token: token, steps: [])
        let tools = request(#"{"id":"real-tools","system":"Use the creator-toolset tools when the user asks for a lookup.","user":"Call the lookup tool and reply with exactly the text it returns, nothing else.","mcp":{"url":"http://127.0.0.1:\#(server.port)/api/mcp","token":"\#(token)"},"# + base + "}")
        steps = []
        let used = try runAnswer(tools, try requestOptions(tools), cli: cli, work: temp(), send: { _ in true }, step: { steps.append($0) })
        print("REAL CLAUDE tools: text=\(used.text) steps=\(steps)")
        XCTAssertTrue(used.text.contains("MCP-LOOKUP-RESULT"))
    }
}

/// A stand-in model (chat completions, streamed) and MCP server on 127.0.0.1 for testRealGrokStandInRun. A chat request with
/// tools gets the calls of the next step (one step per tool-call message it already carries), then "DONE"; one without
/// tools gets "ok". The MCP side has one tool, `lookup`, and answers only the bearer token. Every request body is kept.
private final class GrokStandIn {
    private(set) var port = 0
    private let fd = socket(AF_INET, SOCK_STREAM, 0)
    private let token: String
    private let steps: [[[String: Any]]]
    private let lock = NSLock()
    private var kept: [String] = []
    private var tools: Set<String> = []
    private var answers: [String] = []

    init(token: String, steps: [[[String: Any]]]) throws {
        self.token = token
        self.steps = steps
        var addr = sockaddr_in()
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_addr.s_addr = inet_addr("127.0.0.1")
        var len = socklen_t(MemoryLayout<sockaddr_in>.size)
        let ok = withUnsafeMutablePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, len) == 0 && listen(fd, 16) == 0 && getsockname(fd, $0, &len) == 0 }
        }
        guard ok else { throw RelayError(message: "the stand-in got no port") }
        port = Int(UInt16(bigEndian: addr.sin_port))
        Thread { [fd] in
            while case let client = accept(fd, nil, nil), client >= 0 { Thread { self.serve(client) }.start() }
        }.start()
    }

    deinit { close(fd) }

    var bodies: String { lock.withLock { kept.joined(separator: "\n") } }
    var offered: Set<String> { lock.withLock { tools } }
    /// what the tools answered, as the model was sent it
    var results: [String] { lock.withLock { answers } }
    func reset() { lock.withLock { kept = []; tools = []; answers = [] } }

    /// One request on `client`, answered with Connection: close.
    private func serve(_ client: Int32) {
        defer { close(client) }
        var data = Data(), buf = [UInt8](repeating: 0, count: 65536)
        let gap = Data("\r\n\r\n".utf8)
        func more() -> Bool { let n = read(client, &buf, buf.count); if n > 0 { data.append(buf, count: n) }; return n > 0 }
        while data.range(of: gap) == nil { guard more() else { return } }
        let split = data.range(of: gap)!
        let head = String(decoding: data[..<split.lowerBound], as: UTF8.self)
        let length = head.components(separatedBy: "\r\n").first { $0.lowercased().hasPrefix("content-length:") }
            .flatMap { Int($0.dropFirst(15).trimmingCharacters(in: .whitespaces)) } ?? 0
        while data.count - split.upperBound < length { guard more() else { return } }
        let body = data.subdata(in: split.upperBound..<split.upperBound + length)
        let line = head.prefix { $0 != "\r" }.split(separator: " ")
        let json = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any] ?? [:]
        lock.withLock { kept.append(String(decoding: body, as: UTF8.self)) }
        let (status, type, reply): (String, String, Data)
        if line.first != "POST" {
            (status, type, reply) = ("405 Method Not Allowed", "text/plain", Data())
        } else if line.dropFirst().first?.hasPrefix("/api/mcp") == true {
            (status, type, reply) = mcp(json, authorized: head.contains("Bearer " + token))
        } else {
            (status, type, reply) = ("200 OK", "text/event-stream", chat(json))
        }
        let out = Data("HTTP/1.1 \(status)\r\nContent-Type: \(type)\r\nContent-Length: \(reply.count)\r\nConnection: close\r\n\r\n".utf8) + reply
        _ = out.withUnsafeBytes { write(client, $0.baseAddress, out.count) }
    }

    private func chat(_ req: [String: Any]) -> Data {
        let names = (req["tools"] as? [[String: Any]] ?? []).compactMap { ($0["function"] as? [String: Any])?["name"] as? String }
        let messages = req["messages"] as? [[String: Any]] ?? []
        lock.withLock {
            tools.formUnion(names)
            answers += messages.filter { $0["role"] as? String == "tool" }.map { "\($0["content"] ?? "")" }
        }
        let step = messages.filter { $0["role"] as? String == "assistant" && $0["tool_calls"] != nil }.count
        var delta: [String: Any] = ["role": "assistant", "content": names.isEmpty ? "ok" : "DONE"]
        if !names.isEmpty, step < steps.count {
            delta = ["role": "assistant", "tool_calls": steps[step].enumerated().map { i, call in
                ["index": i, "id": "call_\(step)_\(i)", "type": "function",
                 "function": ["name": call["name"]!, "arguments": String(decoding: try! JSONSerialization.data(withJSONObject: call["arguments"]!), as: UTF8.self)]]
            }]
        }
        let finish = delta["tool_calls"] == nil ? "stop" : "tool_calls"
        let chunks: [[String: Any]] = [["choices": [["index": 0, "delta": delta]]],
                                       ["choices": [["index": 0, "delta": [String: Any](), "finish_reason": finish]],
                                        "usage": ["prompt_tokens": 10, "completion_tokens": 2, "total_tokens": 12]]]
        let lines = chunks.map { "data: " + String(decoding: try! JSONSerialization.data(withJSONObject: $0.merging(["id": "c", "object": "chat.completion.chunk", "created": 0, "model": "standin"]) { a, _ in a }), as: UTF8.self) }
        return Data((lines + ["data: [DONE]"]).map { $0 + "\n\n" }.joined().utf8)
    }

    private func mcp(_ msg: [String: Any], authorized: Bool) -> (String, String, Data) {
        guard authorized else { return ("401 Unauthorized", "text/plain", Data()) }
        guard let id = msg["id"] else { return ("202 Accepted", "text/plain", Data()) }
        var reply: [String: Any] = ["jsonrpc": "2.0", "id": id]
        switch msg["method"] as? String {
        case "initialize":
            let version = (msg["params"] as? [String: Any])?["protocolVersion"] ?? "2025-06-18"
            reply["result"] = ["protocolVersion": version, "capabilities": ["tools": [String: Any]()], "serverInfo": ["name": "standin", "version": "1"]]
        case "tools/list":
            reply["result"] = ["tools": [["name": "lookup", "description": "Look up the newest Workshop project.", "inputSchema": ["type": "object", "properties": [String: Any]()]]]]
        case "tools/call":
            reply["result"] = ["content": [["type": "text", "text": "MCP-LOOKUP-RESULT: Tiny Acrobatics"]]]
        default:
            reply["error"] = ["code": -32601, "message": "no such method"]
        }
        return ("200 OK", "application/json", try! JSONSerialization.data(withJSONObject: reply))
    }
}
