// What the Mac relay does with one request, as plain functions of their inputs: the
// request's options, the `claude -p` command line and environment, the stream-json reading, the
// usage row, the folder a Workshop turn reads. No process and no network here (ClaudeRun.swift and
// Relay.swift do those); the tests cover this file. the Mac relay is the reference for every rule.
import CryptoKit
import Foundation

/// A request that fails before or during its run; the message is what the site shows.
struct RelayError: LocalizedError {
    let message: String
    var errorDescription: String? { message }
}

/// llm.MODEL and llm.EFFORT.
let defaultModel = "claude-opus-5-5"
let defaultEffort = "xhigh"
let claudeEfforts = ["low", "medium", "high", "xhigh", "max"]
let readTools = "Read,Glob,Grep"
let webTools = "WebSearch,WebFetch"
/// This Mac's own tools for the assistant (RelayRequest.asks): Claude Code's permission rules decide what asks first.
let macTools = "Read,Glob,Grep,Bash,Edit,Write"
let folderNote = "The files this request needs are in the current folder: read them there."
let piecesNote = "\n- sessions/INDEX.md — every Workshop session that became a post, with the post and its numbers (the app links them)."
/// The drivers this Mac runs (Claude, Gemini, Codex and Grok natively; the ACP kinds over stdio). The rest get the message below.
let runnableDrivers = ["claude", "gemini", "codex", "grok", "cursor", "opencode", "antigravity", "pi", "acp"]
let onlyRunnableMessage = "This Mac runs Claude, Gemini, Codex, Grok, Cursor, OpenCode, Antigravity, Pi and local ACP commands only for now"
/// The ACP kinds (contracts/providers.ts isAcpDriver): each starts its agent over stdio (AcpRun.swift). "acp" is the local command
/// from the setup; the others start the command below, plus the launch arguments. Versions are a snapshot from 2026-11-08: re-check before shipping.
let acpDrivers = ["cursor", "opencode", "antigravity", "pi", "acp"]
let acpDefaults: [String: AcpLaunch] = [
    "cursor": AcpLaunch(command: "cursor-agent", args: ["acp"]),
    "opencode": AcpLaunch(command: "opencode", args: ["acp"]),
    "antigravity": AcpLaunch(command: "antigravity-acp", args: []),
    "pi": AcpLaunch(command: "npx", args: ["-y", "pi-acp@0.0.34"]),
]

/// An ACP agent's program and its arguments, as the job carries them.
struct AcpLaunch: Equatable {
    let command: String
    let args: [String]
}

/// One job from POST /api/devices/relay/wait (contracts/providers.ts).
struct RelayRequest {
    let id: String
    let system: String
    let user: String
    let web: Bool
    /// var: big files arrive as "sha256:…" and are swapped for the kept text before the run (resolveBlobs)
    var files: [String: String]
    let driver: String
    let model: String
    let effort: String
    let home: String
    let session: String
    let resume: String
    /// The endpoint a plug-in instance sends its Claude requests to (ANTHROPIC_BASE_URL); "" = the CLI's own. Checked in requestOptions.
    let baseUrl: String
    /// The provider instance's id and the names of its environment variables. The values never come from the server:
    /// the Mac reads each from its own Keychain (providerEnv).
    let instance: String
    let envNames: [String]
    /// The ACP kinds: the local command ("acp" driver), the launch arguments, and the program a manual setup gave ("" = none).
    let acp: AcpLaunch?
    let launchArgs: [String]
    let binaryPath: String
    /// The app's own MCP server for this run (the assistant): its /api/mcp and a job token for one turn. Never logged.
    let mcp: (url: String, token: String)?
    /// The assistant with someone there to answer: this Mac's tools, and each permission question goes to the site
    /// (only with `mcp`; the Workshop, automations and the rest never get it).
    let asks: Bool
    /// The assistant's own folder on this Mac for this server (assistantFolder), set by the runner when `asks`.
    var workdir: URL?

    init?(json: Data) {
        guard let obj = (try? JSONSerialization.jsonObject(with: json)) as? [String: Any],
              let id = obj["id"] as? String, !id.isEmpty else { return nil }
        self.id = id
        system = obj["system"] as? String ?? ""
        user = obj["user"] as? String ?? ""
        web = obj["web"] as? Bool ?? false
        files = (obj["files"] as? [String: Any] ?? [:]).compactMapValues { $0 as? String }
        driver = (obj["driver"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? "claude"
        model = obj["model"] as? String ?? ""
        effort = (obj["effort"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? defaultEffort
        home = obj["home"] as? String ?? ""
        session = obj["session"] as? String ?? ""
        resume = obj["resume"] as? String ?? ""
        baseUrl = obj["baseUrl"] as? String ?? ""
        instance = obj["instance"] as? String ?? ""
        envNames = obj["envNames"] as? [String] ?? []
        acp = (obj["acp"] as? [String: Any]).flatMap { a in
            (a["command"] as? String).map { AcpLaunch(command: $0, args: a["args"] as? [String] ?? []) }
        }
        launchArgs = obj["launchArgs"] as? [String] ?? []
        binaryPath = obj["binaryPath"] as? String ?? ""
        if let m = obj["mcp"] as? [String: Any], let url = m["url"] as? String, let token = m["token"] as? String,
           matches(url, "^https?://[^\\s\"\\\\]+/api/mcp\\z"), matches(token, "^ctj_[a-f0-9]{48}\\z") {   // no quote: Codex gets it as a TOML string
            mcp = (url, token)
        } else {
            mcp = nil
        }
        asks = mcp != nil && obj["asks"] as? Bool == true
    }
}

/// The --mcp-config file for the app's own MCP server: its tools then show up as mcp__creator-toolset__*.
func mcpConfig(url: String, token: String) -> Data {
    let config: [String: Any] = ["mcpServers": ["creator-toolset": ["type": "http", "url": url, "headers": ["Authorization": "Bearer " + token]]]]
    return (try? JSONSerialization.data(withJSONObject: config)) ?? Data()
}
let mcpTools = "mcp__creator-toolset__*"

/// The request's checked options (the Mac relay request_options).
struct RelayOptions: Equatable {
    let model: String
    let effort: String
    let home: String
    let resume: String
    /// the driver the request names: "claude", "gemini", "codex" or "grok"
    var driver = "claude"
    /// the plug-in instance's endpoint for the Claude CLI ("" = none)
    var baseUrl = ""
    /// the instance's environment variables and their values from this Mac's Keychain (providerEnv); none for the other drivers
    var env: [String: String] = [:]
    /// the ACP kinds: the program and its arguments, launch arguments included (nil for the other drivers)
    var acp: AcpLaunch? = nil
}

/// The Keychain service that keeps provider environment values, one item per instance and variable. Its account is
/// "<instance id>/<NAME>". The values are written from this Mac only, never sent to the server.
let providerEnvService = AppIdentity.keychain("env")

/// The Keychain value of one provider environment variable, or nil when none is kept here.
func providerEnvValue(_ account: String) -> String? {
    DeviceVault.token(for: account, service: providerEnvService)
}

/// The values of an instance's environment variables from `read` (the Keychain by default). A name that is not a
/// variable name, or has no value here, is left out; no instance id means none.
func providerEnv(instance: String, names: [String], read: (String) -> String?) -> [String: String] {
    guard !instance.isEmpty else { return [:] }
    var env: [String: String] = [:]
    for name in names where matches(name, "^[A-Za-z_][A-Za-z0-9_]{0,63}\\z") {
        if let value = read("\(instance)/\(name)"), !value.isEmpty { env[name] = value }
    }
    return env
}

/// the Mac relay request_options: the driver, model, effort, home and resume, checked. A bad one fails the request.
/// Claude, Gemini, Codex and Grok run on this Mac; any other driver fails with the message above.
func requestOptions(_ req: RelayRequest, root: URL = FileManager.default.homeDirectoryForCurrentUser,
                    read: (String) -> String? = providerEnvValue) throws -> RelayOptions {
    guard runnableDrivers.contains(req.driver) else { throw RelayError(message: onlyRunnableMessage) }
    guard claudeEfforts.contains(req.effort) else { throw RelayError(message: "not an effort: \(req.effort)") }
    let isClaude = req.driver == "claude"
    let model = req.model.isEmpty ? (isClaude ? defaultModel : "") : req.model
    if isClaude {
        guard matches(model, "^claude-[a-z0-9-]+\\z") else { throw RelayError(message: "not a Claude model: \(model)") }
    } else if !model.isEmpty && !matches(model, "^[A-Za-z0-9._/:-]{1,80}\\z") {
        throw RelayError(message: "not a \(driverLabel(req.driver)) model: \(model)")
    }
    let home = req.home.isEmpty ? "" : try checkedHome(req.home, root: root)
    var acp: AcpLaunch? = nil
    if acpDrivers.contains(req.driver) {
        guard home.isEmpty else { throw RelayError(message: "\(driverLabel(req.driver)) keeps its own setup: it takes no home") }
        let base: AcpLaunch?
        if req.driver == "acp" {
            base = req.acp
        } else if !req.binaryPath.isEmpty {
            base = AcpLaunch(command: req.binaryPath, args: [])   // a manual setup's program replaces the default command
        } else {
            base = acpDefaults[req.driver]
        }
        guard let base else { throw RelayError(message: "\(driverLabel(req.driver)) has no command to start") }
        acp = AcpLaunch(command: base.command, args: base.args + req.launchArgs)
    }
    if req.driver == "gemini" && !home.isEmpty {
        throw RelayError(message: "Gemini keeps its own folder (~/.gemini): it takes no home")
    }
    if req.driver == "grok" && !home.isEmpty {
        throw RelayError(message: "Grok keeps its own folder (~/.grok): it takes no home")
    }
    if !req.resume.isEmpty && !matches(req.resume, "^[A-Za-z0-9-]{1,80}\\z") {
        throw RelayError(message: "not a Claude session id: \(req.resume)")
    }
    if !req.baseUrl.isEmpty && !matches(req.baseUrl, "^https?://[^\\s]{1,300}\\z") {
        throw RelayError(message: "not an endpoint address: \(req.baseUrl)")
    }
    let env = isClaude || acp != nil ? providerEnv(instance: req.instance, names: req.envNames, read: read) : [:]
    return RelayOptions(model: model, effort: req.effort, home: home, resume: req.resume, driver: req.driver, baseUrl: isClaude ? req.baseUrl : "", env: env, acp: acp)
}

/// The name a driver shows in messages and the Mac report ("Codex"); the id itself when unknown.
func driverLabel(_ driver: String) -> String {
    reportDrivers.first { $0.id == driver }?.label ?? driver
}

private func matches(_ text: String, _ pattern: String) -> Bool {
    text.range(of: pattern, options: .regularExpression) != nil
}

/// the Mac relay checked_home: an existing folder under the user's home, never the home itself. Returns it resolved.
func checkedHome(_ home: String, root: URL) throws -> String {
    let rootPath = realPath((root.path as NSString).standardizingPath)
    let expanded = (home as NSString).expandingTildeInPath
    let path = realPath(expanded)
    var isDir: ObjCBool = false
    guard path != rootPath, path.hasPrefix(rootPath + "/"),
          FileManager.default.fileExists(atPath: path, isDirectory: &isDir), isDir.boolValue else {
        throw RelayError(message: "not a folder under your home: \(home)")
    }
    return path
}

/// Symlinks resolved, so /var and /private/var compare equal (the folder checks and tool labels need that).
func realPath(_ path: String) -> String {
    URL(fileURLWithPath: path).resolvingSymlinksInPath().standardizedFileURL.path
}

// MARK: the environment

/// the Mac relay claude_run_env: the environment for `claude` without an API key or a proxy, the three
/// disable flags, and with a home: CLAUDE_CONFIG_DIR = the home plus its settings.json `env` (string values).
/// The home's API key is dropped too (the subscription only); nothing printed or posted here. A plug-in instance's
/// `extra` (the instance's Keychain values) goes after the home, never over the subscription keys or the folder.
/// `baseUrl` (checked) is set last, so it wins over the home's own ANTHROPIC_BASE_URL.
func claudeEnv(base: [String: String], home: String, baseUrl: String = "", extra: [String: String] = [:]) -> [String: String] {
    let stripped = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL"]
    var env = base.filter { !stripped.contains($0.key) }
    env["CLAUDE_CODE_DISABLE_CLAUDE_MDS"] = "1"
    env["CLAUDE_CODE_DISABLE_AUTO_MEMORY"] = "1"
    env["CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC"] = "1"
    env.removeValue(forKey: "CLAUDE_CONFIG_DIR")
    if !home.isEmpty {
        for (key, value) in homeEnv(home) where key != "ANTHROPIC_API_KEY" { env[key] = value }
        env["CLAUDE_CONFIG_DIR"] = home
    }
    for (key, value) in extra where !stripped.contains(key) && key != "CLAUDE_CONFIG_DIR" { env[key] = value }
    if !baseUrl.isEmpty { env["ANTHROPIC_BASE_URL"] = baseUrl }
    return env
}

/// the Mac relay home_env: the string values of <home>/settings.json's `env`; {} when the file is missing or odd.
func homeEnv(_ home: String) -> [String: String] {
    let file = URL(fileURLWithPath: home).appendingPathComponent("settings.json")
    guard let data = try? Data(contentsOf: file),
          let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
          let env = obj["env"] as? [String: Any] else { return [:] }
    return env.compactMapValues { $0 as? String }
}

// MARK: the command line

/// the Mac relay's `claude -p` arguments (the prompt comes on stdin). `resume` is passed only with a session.
/// `mcpConfigFile`: the app's own MCP server (the assistant), whose tools are then allowed too.
/// `asks`: Claude Code's own permission rules, its questions on stdout and the answers on stdin (stream-json; ClaudeRun
/// answers them through the site). Only the web and the app's MCP tools are allowed up front then; the rest of `tools`
/// runs when Claude Code treats it as safe, else it asks.
func claudeArguments(model: String, effort: String, systemFile: String, tools: String, session: Bool, resume: String,
                     mcpConfigFile: String = "", asks: Bool = false) -> [String] {
    var args = ["-p", "--model", model, "--effort", effort,
                "--output-format", "stream-json", "--verbose", "--include-partial-messages",
                "--system-prompt-file", systemFile, "--tools", tools, "--strict-mcp-config",
                "--setting-sources", ""]
    if !session { args.append("--no-session-persistence") }   // a cold run leaves no transcript behind
    if !resume.isEmpty { args += ["--resume", resume] }
    if !mcpConfigFile.isEmpty { args += ["--mcp-config", mcpConfigFile] }
    let web = webTools.split(separator: ",")
    let upFront = asks ? tools.split(separator: ",").filter { web.contains($0) }.joined(separator: ",") : tools
    let allowed = [upFront, mcpConfigFile.isEmpty ? "" : mcpTools].filter { !$0.isEmpty }.joined(separator: ",")
    if asks {
        args += ["--input-format", "stream-json", "--permission-prompt-tool", "stdio", "--permission-mode", "manual"]
        if !allowed.isEmpty { args += ["--allowedTools", allowed] }
    } else if !allowed.isEmpty {
        args += ["--allowedTools", allowed, "--permission-mode", "dontAsk"]   // anything else is refused
    }
    return args
}

// MARK: permission questions (asks)

/// One question Claude Code would ask a person ("can_use_tool" on its stdout): the tool, its own words, the exact command or path.
struct PermissionAsk: Equatable {
    let id: String
    let tool: String
    let description: String
    let reason: String
    let detail: String
    /// sent back unchanged with a yes
    let input: NSDictionary
}

/// A control_request line's question, or nil when it's another kind of request.
func permissionAsk(_ obj: [String: Any]) -> PermissionAsk? {
    guard let id = obj["request_id"] as? String, !id.isEmpty,
          let req = obj["request"] as? [String: Any], req["subtype"] as? String == "can_use_tool",
          let tool = req["tool_name"] as? String else { return nil }
    let input = req["input"] as? [String: Any] ?? [:]
    return PermissionAsk(id: id, tool: tool, description: req["description"] as? String ?? "",
                         reason: req["decision_reason"] as? String ?? "", detail: askDetail(tool, input), input: input as NSDictionary)
}

/// The exact thing a question is about: the command, the path, the address; else the input as JSON.
func askDetail(_ tool: String, _ input: [String: Any]) -> String {
    func text(_ key: String) -> String { input[key] as? String ?? "" }
    let detail: String
    switch tool {
    case "Bash": detail = text("command")
    case "Read", "Write", "Edit", "MultiEdit": detail = text("file_path")
    case "NotebookEdit": detail = text("notebook_path")
    case "Glob", "Grep": detail = [text("pattern"), text("path")].filter { !$0.isEmpty }.joined(separator: " in ")
    case "WebFetch": detail = text("url")
    case "WebSearch": detail = text("query")
    default:
        detail = (try? JSONSerialization.data(withJSONObject: input, options: [.sortedKeys])).map { String(decoding: $0, as: UTF8.self) } ?? ""
    }
    return String(detail.prefix(4000))
}

/// The answer line for a question: "allowed" runs it as asked; anything else is a no that tells Claude not to work around it.
func askAnswer(_ ask: PermissionAsk, status: String) -> Data {
    let response: [String: Any]
    switch status {
    case "allowed": response = ["behavior": "allow", "updatedInput": ask.input]
    case "expired", "waiting":
        response = ["behavior": "deny", "message": "Nobody answered within 10 minutes, so it was not done. Don't try it another way."]
    default:
        response = ["behavior": "deny", "message": "The user declined this. Don't try it another way: say what you wanted to do and ask them."]
    }
    return jsonLine(["type": "control_response", "response": ["subtype": "success", "request_id": ask.id, "response": response]])
}

/// The prompt as one stream-json user message (stdin stays open for the answers).
func userMessageLine(_ text: String) -> Data {
    jsonLine(["type": "user", "message": ["role": "user", "content": text]])
}

private func jsonLine(_ obj: [String: Any]) -> Data {
    ((try? JSONSerialization.data(withJSONObject: obj)) ?? Data()) + Data("\n".utf8)
}

/// The assistant's own folder on this Mac, one per server (the device token is per server, so per account):
/// ~/Library/Application Support/Creator Toolset/assistant/<host>.
func assistantFolder(host: String, home: URL = FileManager.default.homeDirectoryForCurrentUser) -> URL {
    home.appendingPathComponent("Library/Application Support/Creator Toolset\(AppIdentity.tag())/assistant").appendingPathComponent(safeName(host.isEmpty ? "site" : host))
}

/// The prompt: the folder note first when there is a folder (the Mac relay request_text).
func requestText(_ user: String, folder: Bool) -> String {
    (folder ? folderNote + "\n\n" : "") + user
}

// MARK: the stream

enum StreamUpdate: Equatable {
    /// the text of the message being written so far
    case text(String)
    /// a tool call, as the author reads it, or "Thinking" after one
    case step(String)
    /// a permission question (asks), and one Claude Code took back
    case ask(PermissionAsk)
    case cancelAsk(String)
    /// the result line came: nothing more will be asked
    case result
}

/// the Mac relay stream() reading: `claude -p --output-format stream-json --include-partial-messages`, one line at a time.
struct ClaudeStream: RunStream {
    let cwd: String
    private(set) var text = ""
    private(set) var result: [String: Any]?
    /// message id -> its usage as it streamed (what a stopped run has used)
    private(set) var seen: [String: [String: Any]] = [:]
    private var afterTool = false   // thinking after a read is its own step, not minutes on the read

    init(cwd: String) { self.cwd = cwd }

    mutating func feed(_ line: String) -> [StreamUpdate] {
        guard line.hasPrefix("{"),
              let obj = (try? JSONSerialization.jsonObject(with: Data(line.utf8))) as? [String: Any] else { return [] }
        var updates: [StreamUpdate] = []
        switch obj["type"] as? String {
        case "stream_event":
            let event = obj["event"] as? [String: Any] ?? [:]
            if event["type"] as? String == "message_start" { text = "" }   // a new message: only its text streams
            if afterTool, (event["content_block"] as? [String: Any])?["type"] as? String == "thinking" {
                afterTool = false
                updates.append(.step("Thinking"))
            }
            if let delta = event["delta"] as? [String: Any], delta["type"] as? String == "text_delta" {
                text += delta["text"] as? String ?? ""
                updates.append(.text(text))
            }
        case "assistant":
            let msg = obj["message"] as? [String: Any] ?? [:]
            let id = msg["id"] as? String ?? ""
            let usage = msg["usage"] as? [String: Any]
            seen[id] = (usage?.isEmpty == false ? usage : nil) ?? seen[id] ?? [:]
            for block in msg["content"] as? [[String: Any]] ?? [] where block["type"] as? String == "tool_use" {
                let label = toolStep(block, cwd: cwd)
                if !label.isEmpty {
                    updates.append(.step(label))
                    afterTool = true
                }
            }
        case "result":
            result = obj
            updates.append(.result)
        case "control_request":
            if let ask = permissionAsk(obj) { updates.append(.ask(ask)) }
        case "control_cancel_request":
            if let id = obj["request_id"] as? String { updates.append(.cancelAsk(id)) }
        default:
            break
        }
        return updates
    }
}

/// the Mac relay tool_step: one tool call as the author reads it; "" for anything else.
func toolStep(_ block: [String: Any], cwd: String) -> String {
    let input = block["input"] as? [String: Any] ?? [:]
    let root = realPath(cwd)
    // a path inside the run's folder, as the folder names it; anything else as it was given
    func rel(_ value: Any?) -> String {
        guard let path = value as? String, !path.isEmpty else { return "" }
        let real = realPath(path)
        if real == root { return "." }
        return real.hasPrefix(root + "/") ? String(real.dropFirst(root.count + 1)) : path
    }
    switch block["name"] as? String {
    case "WebSearch": return "Searched the web: \"\(input["query"] as? String ?? "")\""
    case "WebFetch": return "Read \(input["url"] as? String ?? "")"
    case "Read": return "Read \(rel(input["file_path"]))"
    case "Grep":
        let scope = rel(input["path"])
        return "Searched \(scope.isEmpty ? "the folder" : scope) for \"\(input["pattern"] as? String ?? "")\""
    case "Glob": return "Looked for \(input["pattern"] as? String ?? "")"
    case "Bash": return "Command: \(String((input["command"] as? String ?? "").prefix(200)))"
    case "Write": return "Write \(rel(input["file_path"]))"
    case "Edit": return "Edit \(rel(input["file_path"]))"
    default: return ""
    }
}

// MARK: usage, limits, resume

/// the Mac relay usage_row: the result line's usage, summed over the models that answered. It must have come from `model`
/// (never a quiet downgrade). The row is what the site tallies.
func usageRow(_ result: [String: Any], model: String) throws -> [String: Any] {
    let models = result["modelUsage"] as? [String: [String: Any]] ?? [:]
    let usage = result["usage"] as? [String: Any] ?? [:]
    func sum(_ key: String) -> Int { Int(models.values.reduce(0.0) { $0 + number($1[key]) }) }
    let names = models.keys.sorted()
    guard names.contains(where: { $0.hasPrefix(model) }) else {
        throw RelayError(message: "Claude answered with \(names), not \(model)")
    }
    let total = number(result["total_cost_usd"])
    let cost = total != 0 ? total : models.values.reduce(0.0) { $0 + number($1["costUSD"]) }
    return [
        "step": "site", "models": names,
        "input": sum("inputTokens"), "output": sum("outputTokens"),
        "cache_read": sum("cacheReadInputTokens"), "cache_write": sum("cacheCreationInputTokens"),
        "thinking": Int(number((usage["output_tokens_details"] as? [String: Any])?["thinking_tokens"])),
        "cost_usd": round4(cost), "ms": Int(number(result["duration_ms"])),
    ]
}

/// the Mac relay failed_row: an error result's usage; the model check is skipped (an error can come before any answer).
func failedRow(_ result: [String: Any], model: String) -> [String: Any] {
    if let row = try? usageRow(result, model: model) { return row }
    return ["step": "site", "models": [], "input": 0, "output": 0, "cache_read": 0, "cache_write": 0,
            "cost_usd": round4(number(result["total_cost_usd"]))]
}

/// the Mac relay stopped_row: what a stopped run had used, from each message's usage as the stream showed it (no cost).
func stoppedRow(_ seen: [String: [String: Any]]) -> [String: Any] {
    func sum(_ key: String) -> Int { Int(seen.values.reduce(0.0) { $0 + number($1[key]) }) }
    return ["step": "site", "models": [], "partial": true, "input": sum("input_tokens"), "output": sum("output_tokens"),
            "cache_read": sum("cache_read_input_tokens"), "cache_write": sum("cache_creation_input_tokens"), "cost_usd": 0]
}

/// the Mac relay: the CLI's own words for a closed usage window (llm.LIMIT).
func isLimitError(_ text: String) -> Bool {
    text.range(of: "hit your .{0,20}limit|usage limit|session limit", options: [.regularExpression, .caseInsensitive]) != nil
}

/// the Mac relay gone: the CLI does not have the --resume session it was asked for (no answer came, and it says so).
func isGone(text: String, result: [String: Any]?, err: String) -> Bool {
    if !text.isEmpty { return false }
    let said = "No conversation found"
    if err.localizedCaseInsensitiveContains(said) { return true }
    guard result?["is_error"] as? Bool == true else { return false }
    return String(describing: result?["result"] ?? "").localizedCaseInsensitiveContains(said)
}

/// the Mac relay result_text: the result's words, or the errors list, or "no message".
func resultText(_ result: [String: Any]) -> String {
    if let text = result["result"] as? String, !text.isEmpty { return text }
    let errors = (result["errors"] as? [String] ?? []).joined(separator: "; ")
    return errors.isEmpty ? "no message" : errors
}

/// A JSON number as a Double (0 when it is not one).
func number(_ value: Any?) -> Double {
    (value as? NSNumber)?.doubleValue ?? 0
}

func round4(_ x: Double) -> Double {
    (x * 10_000).rounded() / 10_000
}

// MARK: Gemini (the Mac relay GeminiRun, gemini_cmd, gemini_usage, limit_flag)

/// gemini's tool names as the step labels read them (the Mac relay GEMINI_TOOLS).
let geminiTools = ["read_file": "Read", "grep_search": "Grep", "glob": "Glob", "google_web_search": "WebSearch"]

/// the Mac relay gemini_cmd: `gemini -o stream-json`, the prompt on stdin (no -p: the CLI reads a piped prompt). Plan mode
/// is its read tools only, no edits or shell; --skip-trust for the run's own folder. This CLI has no effort flag.
func geminiArguments(model: String) -> [String] {
    var args = ["-o", "stream-json", "--approval-mode", "plan", "--skip-trust"]
    if !model.isEmpty { args += ["-m", model] }
    return args
}

/// A new empty folder for one Codex run with no folder of its own, under Application Support (created here, removed by the
/// caller). Codex starts in it, so nothing in the user's own folders is its working root.
func codexRunFolder() -> URL {
    let folder = appSupport.appendingPathComponent("codex-runs").appendingPathComponent(UUID().uuidString)
    try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    return folder
}

/// the Mac relay codex_cmd: `codex exec --json` (codex-cli 0.39) in a read-only sandbox in the run's folder, the prompt on
/// stdin ("-"). The effort goes in as its config key; the model only when one is named.
/// What Codex can still do (measured with `codex debug seatbelt` from codex-cli 0.39 on this Mac). Its read-only sandbox
/// (`-s read-only`, the most restrictive mode `exec` offers; it has no approval flag) still lets its shell read any file the
/// Mac user can read, by absolute path: codex-cli 0.39 has no flag that limits reads. That is the same as running Codex in
/// the user's own terminal. It runs in an empty folder of its own per run (removed after the run), so no project files sit in
/// its working root. Writes are off too (a write inside the run folder was refused in the probe), and network access is off
/// (direct connections and DNS both failed in the sandbox). Its use of CODEX_HOME was not measured. Runs only ever carry the device owner's own prompts:
/// unnamed calls are refused and no one else's login is used (providers-routing).
/// ponytail: read access is not limited here; add a read allowlist when codex exposes one.
/// `mcpURL`: the app's own MCP server for this run only (the assistant), its token read from `codexTokenEnv`. The person's
/// config.toml is not read then, as --strict-mcp-config does for Claude: none of the MCP servers listed there are in the run,
/// and a creator-toolset table saved there can't merge into this one (codex-cli 0.163 merges even an inline table).
/// Its calls need no approval (exec has no one to ask); the shell stays read-only.
func codexArguments(cwd: String, model: String, effort: String, pictures: [String] = [], mcpURL: String = "") -> [String] {
    var args = ["exec", "--json", "--skip-git-repo-check", "-C", cwd, "-s", "read-only", "-c", "model_reasoning_effort=" + effort]
    if !mcpURL.isEmpty {
        let server = "mcp_servers.creator-toolset."
        args += ["--ignore-user-config", "-c", server + "url=\"\(mcpURL)\"", "-c", server + "bearer_token_env_var=\"\(codexTokenEnv)\"",
                 "-c", server + "default_tools_approval_mode=\"approve\""]
    }
    if !model.isEmpty { args += ["-m", model] }
    // one `--image=<file>` each: the list form would take the "-" (the prompt from stdin) as a picture
    args += pictures.map { "--image=" + $0 }
    return args + ["-"]
}

/// The variable the turn's job token goes in, so it is never on the command line.
let codexTokenEnv = "CREATOR_TOOLSET_MCP_TOKEN"

/// Whether this Codex takes an MCP server for one run (`--ignore-user-config`; codex-cli 0.39 has neither). An older one
/// answers with the message alone, as before.
func codexTakesMcp(_ cli: String) -> Bool {
    runQuick(cli, ["exec", "--help"], seconds: 5)?.contains("--ignore-user-config") ?? false
}

/// The pictures in a run's folder (the Caption Studio and Vision passes write them there), as the paths Codex attaches.
func codexPictures(_ files: [String: String], cwd: URL) -> [String] {
    let exts: Set<String> = ["jpg", "jpeg", "png", "webp", "gif"]
    return files.keys.filter { exts.contains(URL(fileURLWithPath: $0).pathExtension.lowercased()) }.sorted()
        .map { cwd.appendingPathComponent($0).path }
}

/// grok's tool ids for its read tools and its web tools (the Mac relay GROK_READ, GROK_WEB).
let grokReadTools = "read_file,grep,list_dir"
let grokWebTools = "web_search,web_fetch"

/// the Mac relay grok_cmd: `grok -p`'s headless stream, the prompt in `promptFile`. Tools are only the read tools of a folder
/// (plus web when asked); with no folder there is no shell, no editing and no subagents. It never asks (dontAsk).
func grokArguments(cwd: String, model: String, effort: String, system: String, web: Bool, folder: Bool, promptFile: String) -> [String] {
    var args = ["--prompt-file", promptFile, "--verbatim",
                "--output-format", "streaming-messages-json", "--include-partial-messages", "--no-memory", "--no-subagents",
                "--cwd", cwd, "--reasoning-effort", effort, "--permission-mode", "dontAsk",
                "--system-prompt-override", system, "--disallowed-tools", "run_terminal_cmd,search_replace,Agent"]
    if !model.isEmpty { args += ["-m", model] }
    // Always passed: without a folder the list is empty (grok's default built-ins would read any file on this Mac).
    args += ["--tools", ((folder ? [grokReadTools] : []) + (web ? [grokWebTools] : [])).joined(separator: ",")]
    if !web { args.append("--disable-web-search") }
    return args
}

/// the Mac relay driver_env: the environment without API keys (the subscription only, never API billing), and
/// CODEX_HOME for a Codex home (the folder codex keeps its sign-in in).
func driverEnv(base: [String: String], home: String = "") -> [String: String] {
    let stripped = ["OPENAI_API_KEY", "XAI_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY"]
    var env = base.filter { !stripped.contains($0.key) }
    if !home.isEmpty { env["CODEX_HOME"] = home }
    return env
}

/// the Mac relay limit_flag: the usage-limit flag. Claude's and Codex's windows (isLimitError: "You've hit your usage
/// limit") and Gemini's quota errors; the rest have none.
func limitFlag(_ driver: String, _ text: String) -> Bool {
    if driver == "claude" || driver == "codex" { return isLimitError(text) }
    return driver == "gemini"
        && text.range(of: "exhausted your (daily )?(quota|capacity)|MODEL_CAPACITY_EXHAUSTED", options: [.regularExpression, .caseInsensitive]) != nil
}

/// the Mac relay gemini_usage: a stream's result stats in the claude usage shape. The prompt count includes the cached tokens.
func geminiUsage(_ stats: [String: Any]) -> [String: Any] {
    let cached = Int(number(stats["cached"]))
    return ["input_tokens": max(Int(number(stats["input_tokens"])) - cached, 0), "cache_read_input_tokens": cached,
            "output_tokens": Int(number(stats["output_tokens"])), "reasoning_tokens": 0, "cache_creation_input_tokens": 0]
}

/// the Mac relay usage_of for a driver other than Claude: its own usage fields, no model check (the CLI names its own models).
func genericUsageRow(_ result: [String: Any], model: String) -> [String: Any] {
    let usage = result["usage"] as? [String: Any] ?? [:]
    let names = (result["modelUsage"] as? [String: Any] ?? [:]).keys.sorted()
    let models: [String] = names.isEmpty ? (model.isEmpty ? [] : [model]) : names
    return ["step": "site", "models": models,
            "input": Int(number(usage["input_tokens"])), "output": Int(number(usage["output_tokens"])),
            "cache_read": Int(number(usage["cache_read_input_tokens"])), "cache_write": Int(number(usage["cache_creation_input_tokens"])),
            "thinking": Int(number(usage["reasoning_tokens"])), "cost_usd": round4(number(result["total_cost_usd"])),
            "ms": Int(number(result["duration_ms"]))]
}

/// the Mac relay GeminiRun: `gemini -o stream-json` events, one line at a time: the answer's text (the assistant's text since
/// its last tool call), the result's stats as usage, and the error. A result with status "error" is the failure.
struct GeminiStream: RunStream {
    let cwd: String
    private(set) var text = ""
    private var error = ""
    private var status = ""
    private var models: [String] = []
    private var usage: [String: Any] = [:]

    init(cwd: String) { self.cwd = cwd }

    var seen: [String: [String: Any]] { usage.isEmpty ? [:] : ["gemini": usage] }

    mutating func feed(_ line: String) -> [StreamUpdate] {
        guard line.hasPrefix("{"),
              let obj = (try? JSONSerialization.jsonObject(with: Data(line.utf8))) as? [String: Any] else { return [] }
        var updates: [StreamUpdate] = []
        switch obj["type"] as? String {
        case "message" where (obj["role"] as? String) == "assistant":
            let content = obj["content"] as? String ?? ""
            text = (obj["delta"] as? Bool) == true ? text + content : content
            updates.append(.text(text))
        case "tool_use":
            text = ""   // what was said before a tool call is not the answer
            let params = obj["parameters"] as? [String: Any] ?? [:]
            var input: [String: Any] = [:]
            if let path = params["file_path"] ?? params["absolute_path"] { input["file_path"] = path }
            if let pattern = params["pattern"] { input["pattern"] = pattern }
            if let dir = params["dir_path"] { input["path"] = dir }
            if let query = params["query"] { input["query"] = query }
            if let name = geminiTools[obj["tool_name"] as? String ?? ""] {
                let label = toolStep(["name": name, "input": input], cwd: cwd)
                if !label.isEmpty { updates.append(.step(label)) }
            }
        case "result":
            let stats = obj["stats"] as? [String: Any] ?? [:]
            usage = geminiUsage(stats)
            models = (stats["models"] as? [String: Any] ?? [:]).keys.sorted()
            status = obj["status"] as? String ?? ""
            if status == "error" { error = (obj["error"] as? [String: Any])?["message"] as? String ?? error }
        case "error" where (obj["severity"] as? String) == "error":
            error = obj["message"] as? String ?? error
        default:
            break
        }
        return updates
    }

    /// the Mac relay GeminiRun.result: the answer, or the error (or stderr) as the failure.
    func result(err: String) -> [String: Any] {
        var modelUsage: [String: [String: Any]] = [:]
        for model in models { modelUsage[model] = [:] }
        if status != "error" && !text.isEmpty {
            return ["is_error": false, "result": text, "usage": usage, "modelUsage": modelUsage, "total_cost_usd": 0]
        }
        let tail = String(err.trimmingCharacters(in: .whitespacesAndNewlines).suffix(500))
        let message = !error.isEmpty ? error : (tail.isEmpty ? "no answer" : tail)
        return ["is_error": true, "result": message, "usage": usage, "modelUsage": modelUsage, "total_cost_usd": 0]
    }
}

// MARK: Codex (the Mac relay CodexRun, codex_usage)

/// codex's total usage in the usage shape the rest reads. Its input counts the cached tokens; here input is the uncached part.
func codexUsage(_ total: [String: Any]) -> [String: Any] {
    let cached = Int(number(total["cached_input_tokens"]))
    return ["input_tokens": max(Int(number(total["input_tokens"])) - cached, 0), "cache_read_input_tokens": cached,
            "output_tokens": Int(number(total["output_tokens"])), "reasoning_tokens": Int(number(total["reasoning_output_tokens"])),
            "cache_creation_input_tokens": 0]
}

/// `codex exec --json` events, one line at a time: the answer's text (the last message), its total usage and its last
/// error. Codex exits 0 when a model refuses, so an answer is what counts. Two shapes are read: today's
/// (`{"type":"item.completed","item":{…}}`, `turn.completed`, `turn.failed`) and codex-cli 0.39's (`{"msg":{"type":…}}`).
/// An item of type "error" is a notice (a setting the model ignores), not a failure.
struct CodexStream: RunStream {
    private(set) var text = ""
    private var done = false   // the last message is complete: a new message starts a new text
    private var error = ""
    private var total: [String: Any] = [:]

    var seen: [String: [String: Any]] { total.isEmpty ? [:] : ["codex": codexUsage(total)] }

    mutating func feed(_ line: String) -> [StreamUpdate] {
        guard line.hasPrefix("{"),
              let obj = (try? JSONSerialization.jsonObject(with: Data(line.utf8))) as? [String: Any] else { return [] }
        if let type = obj["type"] as? String {
            switch type {
            case "item.started", "item.updated", "item.completed":
                let item = obj["item"] as? [String: Any] ?? [:]
                guard item["type"] as? String == "agent_message", let said = nonEmpty(item["text"] as? String) else { return [] }
                text = said
                done = true
                return [.text(text)]
            case "turn.completed":
                total = obj["usage"] as? [String: Any] ?? total
            case "error":
                error = nonEmpty(obj["message"] as? String) ?? error
            case "turn.failed":
                error = nonEmpty((obj["error"] as? [String: Any])?["message"] as? String) ?? error
            default:
                break
            }
            return []
        }
        let msg = obj["msg"] as? [String: Any] ?? [:]
        switch msg["type"] as? String {
        case "agent_message_delta":
            if done { text = "" }
            done = false
            text += msg["delta"] as? String ?? ""
            return [.text(text)]
        case "agent_message":
            text = nonEmpty(msg["message"] as? String) ?? text
            done = true
            return [.text(text)]
        case "task_complete":
            text = nonEmpty(msg["last_agent_message"] as? String) ?? text
            done = true
            return [.text(text)]
        case "token_count":
            total = ((msg["info"] as? [String: Any])?["total_token_usage"] as? [String: Any]) ?? total
        case "error", "stream_error":   // retries come as stream_error; the last one is what failed
            error = nonEmpty(msg["message"] as? String) ?? error
        default:
            break
        }
        return []
    }

    /// The run's result line, as the claude stream's: the answer, or the last error (or stderr) as the failure.
    func result(err: String) -> [String: Any] {
        let usage = codexUsage(total)
        if !text.isEmpty { return ["is_error": false, "result": text, "usage": usage, "total_cost_usd": 0] }
        let tail = String(err.trimmingCharacters(in: .whitespacesAndNewlines).suffix(500))
        let message = !error.isEmpty ? error : (tail.isEmpty ? "no answer" : tail)
        return ["is_error": true, "result": message, "usage": usage, "total_cost_usd": 0]
    }

    private func nonEmpty(_ value: String?) -> String? {
        guard let value, !value.isEmpty else { return nil }
        return value
    }
}

// MARK: the Workshop folder and sessions

/// The runner's own folder: `workshop/` (a Workshop session's folder while its Claude session is kept) and `blobs/`
/// (big files, a book in Knowledge, kept by their hash). Under the data folder for the server on this Mac, so it moves
/// with it; under Application Support per site for a remote one.
func relayFolder(for site: URL, localData: URL?) -> URL {
    if let localData { return localData.appendingPathComponent("relay") }
    let name = (site.host ?? "site") + (site.port.map { "-\($0)" } ?? "")
    return appSupport.appendingPathComponent("relay").appendingPathComponent(name)
}

func sha256Hex(_ text: String) -> String {
    SHA256.hash(data: Data(text.utf8)).map { String(format: "%02x", $0) }.joined()
}

/// the Mac relay resolve_blobs: a "sha256:<hex>" file is read from `cache`, or fetched once with `fetch` (checked against
/// its hash) and kept there. Copies unused for 30 days go.
func resolveBlobs(_ files: [String: String], cache: URL, fetch: (String) throws -> String?) throws -> [String: String] {
    let fm = FileManager.default
    var out = files
    for (rel, text) in files where text.hasPrefix("sha256:") {
        let sha = String(text.dropFirst("sha256:".count))
        guard sha.count == 64, sha.allSatisfy({ "0123456789abcdef".contains($0) }) else { throw RelayError(message: "bad file hash for \(rel)") }
        let kept = cache.appendingPathComponent(sha)
        if let have = try? String(contentsOf: kept, encoding: .utf8) {
            try? fm.setAttributes([.modificationDate: Date()], ofItemAtPath: kept.path)
            out[rel] = have
            continue
        }
        guard let got = try fetch(sha), sha256Hex(got) == sha else { throw RelayError(message: "\(rel) could not be fetched from the site") }
        try fm.createDirectory(at: cache, withIntermediateDirectories: true)
        try got.write(to: kept, atomically: true, encoding: .utf8)
        out[rel] = got
    }
    if let names = try? fm.contentsOfDirectory(at: cache, includingPropertiesForKeys: [.contentModificationDateKey]) {
        for f in names where ((try? f.resourceValues(forKeys: [.contentModificationDateKey]))?.contentModificationDate ?? Date()) < Date().addingTimeInterval(-30 * 86400) {
            try? fm.removeItem(at: f)
        }
    }
    return out
}

/// the Mac relay sync_folder: make `root` hold the site's folder (path -> text). A changed file is rewritten, one no
/// longer there is deleted (unless `prune` is off: the assistant's own folder keeps what's in it), the rest is left
/// alone. "base64:…" is a file's bytes. A path that would leave `root` is skipped.
func syncFolder(_ root: URL, _ files: [String: String], prune: Bool = true) throws {
    var want: [String: Data] = [:]
    for (rel, text) in files where isSafeRelative(rel) {
        if text.hasPrefix("base64:") {
            if let data = Data(base64Encoded: String(text.dropFirst("base64:".count))) { want[rel] = data }
        } else {
            want[rel] = Data(text.utf8)
        }
    }
    let fm = FileManager.default
    let base = realPath(root.path) + "/"   // /var and /private/var are the same folder: compare resolved paths
    if prune, let walk = fm.enumerator(at: root, includingPropertiesForKeys: [.isRegularFileKey]) {
        for case let file as URL in walk {
            let real = realPath(file.path)
            guard real.hasPrefix(base), (try? file.resourceValues(forKeys: [.isRegularFileKey]))?.isRegularFile == true else { continue }
            if want[String(real.dropFirst(base.count))] == nil { try? fm.removeItem(at: file) }
        }
    }
    for (rel, data) in want {
        let dest = root.appendingPathComponent(rel)
        if (try? Data(contentsOf: dest)) == data { continue }
        try fm.createDirectory(at: dest.deletingLastPathComponent(), withIntermediateDirectories: true)
        try data.write(to: dest)
    }
}

/// A relative path that stays inside the folder: no leading slash, no "..".
func isSafeRelative(_ rel: String) -> Bool {
    !rel.isEmpty && !rel.hasPrefix("/") && !rel.split(separator: "/").contains("..")
}

/// the Mac relay session_dir: a Workshop session's folder, the same path every turn so its Claude session finds its transcript.
func sessionFolder(_ key: String, root: URL) -> URL {
    root.appendingPathComponent(safeName(key)).appendingPathComponent("folder")
}

/// A folder name from any text: letters, digits, _ and - kept, the rest "_", at most 100.
func safeName(_ key: String) -> String {
    String(key.unicodeScalars.map { scalar -> Character in
        let ok = (scalar.value >= 48 && scalar.value <= 57) || (scalar.value >= 65 && scalar.value <= 90)
            || (scalar.value >= 97 && scalar.value <= 122) || scalar == "_" || scalar == "-"
        return ok ? Character(scalar) : "_"
    }.prefix(100))
}

/// the Mac relay prune_sessions: session folders no turn has used for `days` go; the next turn writes them again.
func pruneSessions(root: URL, days: Double = 14, now: Date = Date()) {
    let fm = FileManager.default
    let cut = now.addingTimeInterval(-days * 86400)
    for dir in (try? fm.contentsOfDirectory(at: root, includingPropertiesForKeys: [.contentModificationDateKey])) ?? [] {
        let modified = (try? dir.resourceValues(forKeys: [.contentModificationDateKey]))?.contentModificationDate
        if let modified, modified < cut { try? fm.removeItem(at: dir) }
    }
}

