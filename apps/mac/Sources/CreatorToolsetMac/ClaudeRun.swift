// One Claude run on this Mac: the Mac relay answer() and stream(). The folder, the session and the
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

/// The stream's state while it runs; read and written by the output reader and the keep-alive thread.
private final class RunState {
    let lock = NSLock()
    var stream: ClaudeStream
    var lastSend = Date.distantPast
    var killed = false
    var finished = false

    init(cwd: String) { stream = ClaudeStream(cwd: cwd) }

    func with<T>(_ body: (RunState) -> T) -> T {
        lock.lock()
        defer { lock.unlock() }
        return body(self)
    }
}

/// What one `claude -p` process came to (the Mac relay stream()'s return).
struct ClaudeOutcome {
    let text: String
    let result: [String: Any]?
    let seen: [String: [String: Any]]
    let killed: Bool
    let err: String
}

/// the Mac relay SEND_S / ALIVE_S: text at most this often while it arrives, and at least this often while Claude thinks.
let sendEverySeconds: TimeInterval = 0.4
let aliveEverySeconds: TimeInterval = 20

/// the Mac relay answer(): one Claude run for a request. `send(text)` returns false when the site no longer waits (the run stops);
/// `step(label)` hears each tool call. A Workshop turn with a folder or a session runs in that folder.
func claudeAnswer(_ req: RelayRequest, _ opts: RelayOptions, cli: String, work: URL,
                  send: @escaping (String) -> Bool, step: @escaping (String) -> Void) throws -> ClaudeAnswer {
    let fm = FileManager.default
    let folder = !req.files.isEmpty || !req.session.isEmpty
    var system = req.system
    let tmp = fm.temporaryDirectory.appendingPathComponent("relay-\(UUID().uuidString)")
    try fm.createDirectory(at: tmp, withIntermediateDirectories: true)
    defer { try? fm.removeItem(at: tmp) }

    let cwd: URL
    if !req.session.isEmpty {
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
        try syncFolder(cwd, req.files)
    }
    let systemFile = tmp.appendingPathComponent("system.txt")
    try system.write(to: systemFile, atomically: true, encoding: .utf8)

    let tools = [folder ? readTools : nil, req.web ? webTools : nil].compactMap { $0 }.joined(separator: ",")
    let resume = req.session.isEmpty ? "" : opts.resume
    let args = claudeArguments(model: opts.model, effort: opts.effort, systemFile: systemFile.path,
                               tools: tools, session: !req.session.isEmpty, resume: resume)
    let outcome = try runClaude(cli: cli, args: args, cwd: cwd, env: claudeEnv(base: ProcessInfo.processInfo.environment, home: opts.home),
                                prompt: requestText(req.user, folder: folder), folder: folder, send: send, step: step, tmp: tmp)

    var state = req.session.isEmpty ? "" : "new"
    if !req.session.isEmpty && !resume.isEmpty {
        state = "resumed"
        if !outcome.killed && isGone(text: outcome.text, result: outcome.result, err: outcome.err) {
            throw ClaudeFailure(message: "the Claude session this turn resumes is gone", gone: true)
        }
    }
    if outcome.killed {
        throw ClaudeFailure(message: "the site stopped waiting", usage: stoppedRow(outcome.seen), stopped: true)
    }
    guard let result = outcome.result else {
        throw ClaudeFailure(message: "Claude gave no result: \(String(outcome.err.suffix(500)))")
    }
    if result["is_error"] as? Bool == true {
        throw ClaudeFailure(message: "Claude: \(resultText(result))", usage: failedRow(result, model: opts.model))
    }
    do {
        let usage = try usageRow(result, model: opts.model)
        let text = (result["result"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? outcome.text
        return ClaudeAnswer(text: text, usage: usage, session: result["session_id"] as? String ?? "", state: state)
    } catch let error as RelayError {
        throw ClaudeFailure(message: error.message)
    }
}

/// the Mac relay stream(): one `claude -p` run followed as it streams. Text goes out at most every 0.4 s and at least
/// every 20 s; with a folder only the JSON answer streams (Claude may talk between reads).
private func runClaude(cli: String, args: [String], cwd: URL, env: [String: String], prompt: String, folder: Bool,
                       send: @escaping (String) -> Bool, step: @escaping (String) -> Void, tmp: URL) throws -> ClaudeOutcome {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: cli)
    process.arguments = args
    process.currentDirectoryURL = cwd
    process.environment = env
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
        throw ClaudeFailure(message: "Claude is not installed on this Mac (\(error.localizedDescription))")
    }
    // The prompt goes in on its own thread: a long one must not hold the reader back.
    DispatchQueue.global(qos: .utility).async {
        try? input.fileHandleForWriting.write(contentsOf: Data(prompt.utf8))
        try? input.fileHandleForWriting.close()
    }

    let state = RunState(cwd: cwd.path)
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
    state.with { $0.finished = true }
    try? errFile.close()
    let err = (try? String(contentsOf: errURL, encoding: .utf8)) ?? ""
    return state.with { s in
        ClaudeOutcome(text: s.stream.text, result: s.stream.result, seen: s.stream.seen, killed: s.killed, err: err)
    }
}

/// the Mac relay shown(): with a folder, only text that is the JSON answer (or a fenced one) streams.
func looksLikeJSON(_ text: String) -> Bool {
    guard let first = text.drop(while: { $0.isWhitespace }).first else { return false }
    return first == "{" || first == "`"
}
