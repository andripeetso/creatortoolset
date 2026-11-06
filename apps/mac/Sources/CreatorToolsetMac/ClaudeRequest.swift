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
let folderNote = "The files this request needs are in the current folder: read them there."
let piecesNote = "\n- sessions/INDEX.md — every Workshop session that became a post, with the post and its numbers (the app links them)."
let onlyClaudeMessage = "This Mac runs Claude only for now"

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
    }
}

/// The request's checked options (the Mac relay request_options).
struct RelayOptions: Equatable {
    let model: String
    let effort: String
    let home: String
    let resume: String
}

/// the Mac relay request_options: the driver, model, effort, home and resume, checked. A bad one fails the request.
/// Only Claude runs on this Mac for now; Grok and Codex fail with the same message.
func requestOptions(_ req: RelayRequest, root: URL = FileManager.default.homeDirectoryForCurrentUser) throws -> RelayOptions {
    guard req.driver == "claude" else { throw RelayError(message: onlyClaudeMessage) }
    guard claudeEfforts.contains(req.effort) else { throw RelayError(message: "not an effort: \(req.effort)") }
    let model = req.model.isEmpty ? defaultModel : req.model
    guard matches(model, "^claude-[a-z0-9-]+\\z") else { throw RelayError(message: "not a Claude model: \(model)") }
    let home = req.home.isEmpty ? "" : try checkedHome(req.home, root: root)
    if !req.resume.isEmpty && !matches(req.resume, "^[A-Za-z0-9-]{1,80}\\z") {
        throw RelayError(message: "not a Claude session id: \(req.resume)")
    }
    return RelayOptions(model: model, effort: req.effort, home: home, resume: req.resume)
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
/// The home's API key is dropped too (the subscription only); nothing printed or posted here.
func claudeEnv(base: [String: String], home: String) -> [String: String] {
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
func claudeArguments(model: String, effort: String, systemFile: String, tools: String, session: Bool, resume: String) -> [String] {
    var args = ["-p", "--model", model, "--effort", effort,
                "--output-format", "stream-json", "--verbose", "--include-partial-messages",
                "--system-prompt-file", systemFile, "--tools", tools, "--strict-mcp-config",
                "--setting-sources", ""]
    if !session { args.append("--no-session-persistence") }   // a cold run leaves no transcript behind
    if !resume.isEmpty { args += ["--resume", resume] }
    if !tools.isEmpty { args += ["--allowedTools", tools, "--permission-mode", "dontAsk"] }   // anything else is refused
    return args
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
}

/// the Mac relay stream() reading: `claude -p --output-format stream-json --include-partial-messages`, one line at a time.
struct ClaudeStream {
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

// MARK: the Workshop folder and sessions

/// the Mac relay BLOBS: big files (a book in Knowledge) kept on this Mac by their hash.
func blobCache() -> URL {
    FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".cache/creator-toolset/blobs")
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
/// longer there is deleted, the rest is left alone. "base64:…" is a file's bytes. A path that would leave `root` is skipped.
func syncFolder(_ root: URL, _ files: [String: String]) throws {
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
    if let walk = fm.enumerator(at: root, includingPropertiesForKeys: [.isRegularFileKey]) {
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
    let safe = String(key.unicodeScalars.map { scalar -> Character in
        let ok = (scalar.value >= 48 && scalar.value <= 57) || (scalar.value >= 65 && scalar.value <= 90)
            || (scalar.value >= 97 && scalar.value <= 122) || scalar == "_" || scalar == "-"
        return ok ? Character(scalar) : "_"
    }.prefix(100))
    return root.appendingPathComponent(safe).appendingPathComponent("folder")
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

/// The Workshop folder on this Mac (the Mac relay WORKSHOP).
func workshopRoot(home: URL = FileManager.default.homeDirectoryForCurrentUser) -> URL {
    home.appendingPathComponent(".cache/creator-toolset/workshop")
}
