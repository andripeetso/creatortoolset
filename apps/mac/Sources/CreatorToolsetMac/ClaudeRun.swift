// One Claude or Gemini run on this Mac: the Mac relay answer() and stream(). The folder, the session and the
// command line come from ClaudeRequest.swift; this file starts the process, follows its output,
// and says how it ended. Blocking code: it runs on the relay's own threads, never on the main thread.
import Foundation

/// A finished answer, as the Mac relay answer() returns it.
struct ClaudeAnswer {
    let text: String
    let usage: [String: Any]
    let session: String
    /// "new" (a Workshop session kept for next time), "resumed", or "" (no session)
    let state: String
}

/// A failed or stopped run: the message the site shows, the usage it had used, and the flags the site reads.
struct ClaudeFailure: Error {
    let message: String
    var usage: [String: Any]?
    var gone = false
    /// the site stopped waiting (its text post answered 404): the run was killed
    var stopped = false
}

/// One CLI's stream as a run follows it: the text of the message being written, the usage per message, and each line's updates.
protocol RunStream {
    var text: String { get }
    var seen: [String: [String: Any]] { get }
    mutating func feed(_ line: String) -> [StreamUpdate]
}

/// The stream's state while it runs; read and written by the output reader and the keep-alive thread.
private final class RunState<S: RunStream> {
    let lock = NSLock()
    var stream: S
    var lastSend = Date.distantPast
    var killed = false
    var finished = false
    /// questions Claude Code took back
    var cancelled: Set<String> = []

    init(stream: S) { self.stream = stream }

    func with<T>(_ body: (RunState<S>) -> T) -> T {
        lock.lock()
        defer { lock.unlock() }
        return body(self)
    }
}

/// What one CLI process came to (the Mac relay stream()'s return): its stream, whether the site stopped it, and its stderr.
struct StreamOutcome<S: RunStream> {
    let stream: S
    let killed: Bool
    let err: String
}

/// the Mac relay SEND_S / ALIVE_S: text at most this often while it arrives, and at least this often while the CLI thinks.
let sendEverySeconds: TimeInterval = 0.4
let aliveEverySeconds: TimeInterval = 20
/// A question is asked again this often while it waits; past the site's 10 minutes (plus slack) it's a no here too.
let askEverySeconds: TimeInterval = 2
let askGiveUpSeconds: TimeInterval = 11 * 60

/// The site's answer to a permission question: "waiting", "allowed", "denied", "expired", "gone" (nobody waits), or nil (unreachable: ask again).
typealias AskSite = (PermissionAsk) -> String?

/// the Mac relay answer() for the request's driver: Gemini, or Claude (the default).
func runAnswer(_ req: RelayRequest, _ opts: RelayOptions, cli: String, work: URL,
               send: @escaping (String) -> Bool, step: @escaping (String) -> Void, ask: AskSite? = nil) throws -> ClaudeAnswer {
    if opts.driver == "gemini" {
        return try geminiAnswer(req, opts, cli: cli, work: work, send: send, step: step)
    }
    return try claudeAnswer(req, opts, cli: cli, work: work, send: send, step: step, ask: ask)
}

/// the Mac relay answer() for Claude: one `claude -p` run for a request. `send(text)` returns false when the site no longer
/// waits (the run stops); `step(label)` hears each tool call. A Workshop turn with a folder or a session runs in that folder.
/// With `req.asks` (the assistant), Claude runs in the assistant's own folder with this Mac's tools, and each question it
/// would ask a person goes to `ask` (no `ask` = every question is a no).
func claudeAnswer(_ req: RelayRequest, _ opts: RelayOptions, cli: String, work: URL,
                  send: @escaping (String) -> Bool, step: @escaping (String) -> Void, ask: AskSite? = nil) throws -> ClaudeAnswer {
    let fm = FileManager.default
    let folder = !req.files.isEmpty || !req.session.isEmpty
    let tmp = fm.temporaryDirectory.appendingPathComponent("relay-\(UUID().uuidString)")
    try fm.createDirectory(at: tmp, withIntermediateDirectories: true)
    defer { try? fm.removeItem(at: tmp) }

    let (cwd, system) = try prepareFolder(req, work: work, tmp: tmp)
    let systemFile = tmp.appendingPathComponent("system.txt")
    try system.write(to: systemFile, atomically: true, encoding: .utf8)

    var mcpFile = ""
    if let mcp = req.mcp {   // the token lives only in this run's private temp folder, removed with it
        let file = tmp.appendingPathComponent("mcp.json")
        guard fm.createFile(atPath: file.path, contents: mcpConfig(url: mcp.url, token: mcp.token), attributes: [.posixPermissions: 0o600]) else {
            throw RelayError(message: "couldn't write the MCP config")
        }
        mcpFile = file.path
    }
    let tools = [req.asks ? macTools : folder ? readTools : nil, req.web ? webTools : nil].compactMap { $0 }.joined(separator: ",")
    let resume = req.session.isEmpty ? "" : opts.resume
    let args = claudeArguments(model: opts.model, effort: opts.effort, systemFile: systemFile.path,
                               tools: tools, session: !req.session.isEmpty, resume: resume, mcpConfigFile: mcpFile, asks: req.asks)
    // asks: the chat's text streams as it comes (only a Workshop folder waits for its JSON answer)
    let outcome = try runStream(cli: cli, args: args, cwd: cwd, env: claudeEnv(base: ProcessInfo.processInfo.environment, home: opts.home),
                                prompt: requestText(req.user, folder: folder), folder: folder && !req.asks, send: send, step: step, tmp: tmp,
                                stream: ClaudeStream(cwd: cwd.path), ask: req.asks ? (ask ?? { _ in "denied" }) : nil)
    let stream = outcome.stream

    var state = req.session.isEmpty ? "" : "new"
    if !req.session.isEmpty && !resume.isEmpty {
        state = "resumed"
        if !outcome.killed && isGone(text: stream.text, result: stream.result, err: outcome.err) {
            throw ClaudeFailure(message: "the Claude session this turn resumes is gone", gone: true)
        }
    }
    if outcome.killed {
        throw ClaudeFailure(message: "the site stopped waiting", usage: stoppedRow(stream.seen), stopped: true)
    }
    guard let result = stream.result else {
        throw ClaudeFailure(message: "Claude gave no result: \(String(outcome.err.suffix(500)))")
    }
    if result["is_error"] as? Bool == true {
        throw ClaudeFailure(message: "Claude: \(resultText(result))", usage: failedRow(result, model: opts.model))
    }
    do {
        let usage = try usageRow(result, model: opts.model)
        let text = (result["result"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? stream.text
        return ClaudeAnswer(text: text, usage: usage, session: result["session_id"] as? String ?? "", state: state)
    } catch let error as RelayError {
        throw ClaudeFailure(message: error.message)
    }
}

/// the Mac relay answer() for Gemini: one `gemini` run in plan mode (its read tools only) in a fresh folder, or the
/// Workshop session's; the last message is the answer. No resume: a Gemini turn keeps no session ("" state).
func geminiAnswer(_ req: RelayRequest, _ opts: RelayOptions, cli: String, work: URL,
                  send: @escaping (String) -> Bool, step: @escaping (String) -> Void) throws -> ClaudeAnswer {
    let fm = FileManager.default
    let folder = !req.files.isEmpty || !req.session.isEmpty
    let tmp = fm.temporaryDirectory.appendingPathComponent("relay-\(UUID().uuidString)")
    try fm.createDirectory(at: tmp, withIntermediateDirectories: true)
    defer { try? fm.removeItem(at: tmp) }

    let (cwd, system) = try prepareFolder(req, work: work, tmp: tmp)
    let prompt = "<instructions>\n\(system)\n</instructions>\n\n" + requestText(req.user, folder: folder)
    let outcome = try runStream(cli: cli, args: geminiArguments(model: opts.model), cwd: cwd,
                                env: driverEnv(base: ProcessInfo.processInfo.environment), prompt: prompt, folder: folder,
                                send: send, step: step, tmp: tmp, stream: GeminiStream(cwd: cwd.path))
    if outcome.killed {
        throw ClaudeFailure(message: "the site stopped waiting", usage: stoppedRow(outcome.stream.seen), stopped: true)
    }
    let result = outcome.stream.result(err: outcome.err)
    let usage = genericUsageRow(result, model: opts.model)
    if result["is_error"] as? Bool == true {
        throw ClaudeFailure(message: "Gemini: \(resultText(result))", usage: usage)
    }
    return ClaudeAnswer(text: result["result"] as? String ?? "", usage: usage, session: "", state: "")
}

/// the Mac relay answer()'s folder: a Workshop session keeps one folder (the same path every turn, under `work`); else a
/// fresh one in `tmp`. With a folder, the request's files are written into it. Returns the folder and the system text.
func prepareFolder(_ req: RelayRequest, work: URL, tmp: URL) throws -> (cwd: URL, system: String) {
    let fm = FileManager.default
    let folder = !req.files.isEmpty || !req.session.isEmpty
    var system = req.system
    let cwd: URL
    if let workdir = req.workdir {
        cwd = workdir
    } else if !req.session.isEmpty {
        let root = work.appendingPathComponent("workshop")
        try fm.createDirectory(at: root, withIntermediateDirectories: true)
        pruneSessions(root: root)
        cwd = sessionFolder(req.session, root: root)
        try fm.createDirectory(at: cwd.deletingLastPathComponent(), withIntermediateDirectories: true)
        try? fm.setAttributes([.modificationDate: Date()], ofItemAtPath: cwd.deletingLastPathComponent().path)   // in use now
    } else {
        cwd = tmp.appendingPathComponent("folder")
    }
    try fm.createDirectory(at: cwd, withIntermediateDirectories: true)
    if folder {
        if req.files["sessions/INDEX.md"] != nil { system += piecesNote }
        try syncFolder(cwd, req.files, prune: req.workdir == nil)   // the assistant's folder keeps what's in it
    }
    return (cwd, system)
}

/// the Mac relay stream(): one CLI run followed as it streams. Text goes out at most every 0.4 s and at least every 20 s;
/// with a folder only the JSON answer streams (the CLI may talk between reads). With `ask` the prompt is one stream-json
/// message and stdin stays open for the answers to Claude Code's questions until its result line.
private func runStream<S: RunStream>(cli: String, args: [String], cwd: URL, env: [String: String], prompt: String, folder: Bool,
                                     send: @escaping (String) -> Bool, step: @escaping (String) -> Void, tmp: URL,
                                     stream: S, ask: AskSite? = nil) throws -> StreamOutcome<S> {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: cli)
    process.arguments = args
    process.currentDirectoryURL = cwd
    process.environment = withBinaryOnPath(env, binary: cli)
    let input = Pipe()
    let output = Pipe()
    // stderr goes to a file: a pipe nobody reads yet would stall the run and hold its slot
    let errURL = tmp.appendingPathComponent("stderr.txt")
    FileManager.default.createFile(atPath: errURL.path, contents: nil)
    let errFile = try FileHandle(forWritingTo: errURL)
    process.standardInput = input
    process.standardOutput = output
    process.standardError = errFile
    signal(SIGPIPE, SIG_IGN)   // a write to a child that already exited is an error, not a crash
    do {
        try process.run()
    } catch {
        throw ClaudeFailure(message: "\(URL(fileURLWithPath: cli).lastPathComponent) is not installed on this Mac (\(error.localizedDescription))")
    }
    // stdin: the prompt, then (asks) the answers; one writer at a time, nothing after it's closed
    let stdin = StdinWriter(input.fileHandleForWriting)
    // The prompt goes in on its own thread: a long one must not hold the reader back.
    DispatchQueue.global(qos: .utility).async {
        if ask == nil {
            stdin.write(Data(prompt.utf8))
            stdin.close()
        } else {
            stdin.write(userMessageLine(prompt))
        }
    }

    let state = RunState(stream: stream)
    /// One question: asked of the site every 2 s until it's answered, then the answer goes to Claude Code. Its own
    /// thread, so the output keeps flowing and several questions can wait at once.
    func answer(_ question: PermissionAsk, _ ask: @escaping AskSite) {
        Thread {
            let started = Date()
            var status = "expired"
            while Date().timeIntervalSince(started) < askGiveUpSeconds {
                if state.with({ $0.finished || $0.killed || $0.cancelled.contains(question.id) }) { return }
                if let got = ask(question), got != "waiting" {
                    status = got
                    break
                }
                Thread.sleep(forTimeInterval: askEverySeconds)
            }
            if state.with({ $0.cancelled.contains(question.id) }) { return }
            stdin.write(askAnswer(question, status: status))
        }.start()
    }
    let stopRun = {
        state.with { $0.killed = true }
        Darwin.kill(process.processIdentifier, SIGKILL)
    }
    // Keep-alive: the site gives up after 60 s of silence, so the current text goes out at least every 20 s.
    let alive = Thread {
        while !state.with({ $0.finished }) {
            Thread.sleep(forTimeInterval: 1)
            let due = state.with { s -> Bool in
                guard Date().timeIntervalSince(s.lastSend) >= aliveEverySeconds else { return false }
                s.lastSend = Date()
                return true
            }
            guard due else { continue }
            let shown = state.with { s in folder && !looksLikeJSON(s.stream.text) ? "" : s.stream.text }
            if !send(shown) { stopRun() }
        }
    }
    alive.start()

    let handle = output.fileHandleForReading
    var buffer = Data()
    reading: while true {
        let chunk = handle.availableData
        if chunk.isEmpty { break }
        buffer.append(chunk)
        while let newline = buffer.firstIndex(of: 0x0A) {
            let line = String(decoding: buffer[buffer.startIndex..<newline], as: UTF8.self)
            buffer.removeSubrange(buffer.startIndex...newline)
            let updates = state.with { $0.stream.feed(line) }
            for update in updates {
                switch update {
                case .step(let label):
                    step(label)
                case .ask(let question):
                    if let ask { answer(question, ask) }
                case .cancelAsk(let id):
                    state.with { _ = $0.cancelled.insert(id) }
                case .result:
                    if ask != nil { stdin.close() }   // nothing more to answer: the CLI ends
                case .text(let text):
                    let go = state.with { s -> Bool in
                        guard !(folder && !looksLikeJSON(text)), Date().timeIntervalSince(s.lastSend) > sendEverySeconds else { return false }
                        s.lastSend = Date()
                        return true
                    }
                    if go, !send(text) {
                        stopRun()
                        break reading
                    }
                }
            }
        }
    }
    process.waitUntilExit()
    stdin.close()
    state.with { $0.finished = true }
    try? errFile.close()
    let err = (try? String(contentsOf: errURL, encoding: .utf8)) ?? ""
    return state.with { s in StreamOutcome(stream: s.stream, killed: s.killed, err: err) }
}

/// The CLI's stdin, written from several threads (the prompt, each answer), closed once.
private final class StdinWriter {
    private let handle: FileHandle
    private let lock = NSLock()
    private var closed = false

    init(_ handle: FileHandle) { self.handle = handle }

    func write(_ data: Data) {
        lock.lock()
        defer { lock.unlock() }
        if !closed { try? handle.write(contentsOf: data) }
    }

    func close() {
        lock.lock()
        defer { lock.unlock() }
        if !closed { try? handle.close() }
        closed = true
    }
}

/// the Mac relay shown(): with a folder, only text that is the JSON answer (or a fenced one) streams.
func looksLikeJSON(_ text: String) -> Bool {
    guard let first = text.drop(while: { $0.isWhitespace }).first else { return false }
    return first == "{" || first == "`"
}
