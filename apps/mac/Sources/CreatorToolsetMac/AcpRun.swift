// One Agent Client Protocol (ACP) agent on this Mac: an agent program (Cursor, OpenCode, Pi, Kiro, or a local command)
// that speaks JSON-RPC 2.0 over its stdin and stdout, one message per line. This file starts the agent, runs the
// handshake (initialize, session/new), sends prompts (session/prompt), streams the text the agent writes, and answers
// its permission questions through a callback. Blocking code: it runs on the relay's own threads, never on the main thread.
// The client handles no terminals, no elicitation and no MCP bridge; an agent that asks for them gets "method not found".
import Foundation

/// The agent program to start: an absolute path, its arguments, the folder it runs in, and its environment.
struct AcpCommand {
    let executable: String
    var arguments: [String] = []
    let cwd: URL
    var environment: [String: String] = ProcessInfo.processInfo.environment
}

/// An agent's permission question: the tool call's title and the options it offers, in the agent's order.
struct AcpPermissionRequest {
    let sessionId: String
    let title: String
    /// the options as the agent sent them; kind is "allow_once", "allow_always", "reject_once" or "reject_always"
    let options: [(id: String, kind: String)]
}

/// The answer to a permission question. The default is `deny`: a write is never approved unless the caller says so.
enum AcpPermission {
    case allow
    case deny
}

/// One prompt's result: the text the agent wrote, and its stopReason ("end_turn", "cancelled", ...).
struct AcpAnswer {
    let text: String
    let stopReason: String
}

/// A failed ACP step: the message the caller shows.
struct AcpError: Error {
    let message: String
}

/// A request the client sent and is waiting on: signalled when its response arrives or the agent's output ends.
private final class AcpPending {
    let done = DispatchSemaphore(value: 0)
    var reply: [String: Any]?
}

/// The agent process and its JSON-RPC connection. Requests block until the agent answers; the reader thread
/// delivers notifications and agent requests in the order the agent wrote them. `onPermission` runs on the reader
/// thread, so it must return quickly and must not call `request`.
private final class AcpConnection {
    private let process = Process()
    private let input = Pipe()
    private let output = Pipe()
    private let errors = Pipe()
    private let writeLock = NSLock()
    private let stateLock = NSLock()
    private var nextId = 1
    private var waiting: [Int: AcpPending] = [:]
    private var closed = false
    /// the end of the agent's stderr, shown when it stops
    private var stderrTail = ""
    private let onUpdate: ([String: Any]) -> Void
    private let onPermission: (AcpPermissionRequest) -> AcpPermission

    init(command: AcpCommand, onUpdate: @escaping ([String: Any]) -> Void,
         onPermission: @escaping (AcpPermissionRequest) -> AcpPermission) throws {
        self.onUpdate = onUpdate
        self.onPermission = onPermission
        process.executableURL = URL(fileURLWithPath: command.executable)
        process.arguments = command.arguments
        process.currentDirectoryURL = command.cwd
        process.environment = command.environment
        process.standardInput = input
        process.standardOutput = output
        process.standardError = errors
        signal(SIGPIPE, SIG_IGN)   // a write to an agent that already exited is an error, not a crash
        do {
            try process.run()
        } catch {
            throw AcpError(message: "\(URL(fileURLWithPath: command.executable).lastPathComponent) is not installed on this Mac (\(error.localizedDescription))")
        }
        Thread { self.readOutput() }.start()
        Thread { self.readErrors() }.start()
    }

    /// Sends a request and waits for its response. `timeout` is how long the agent may take to answer.
    func request(_ method: String, _ params: [String: Any], timeout: TimeInterval) throws -> [String: Any] {
        let pending = AcpPending()
        let id: Int = try stateLock.withLock {
            if closed { throw AcpError(message: "the agent stopped\(stderrNote())") }
            let id = nextId
            nextId += 1
            waiting[id] = pending
            return id
        }
        do {
            try send(["jsonrpc": "2.0", "id": id, "method": method, "params": params])
        } catch {
            stateLock.withLock { waiting[id] = nil }
            throw error
        }
        guard pending.done.wait(timeout: .now() + timeout) == .success else {
            stateLock.withLock { waiting[id] = nil }
            throw AcpError(message: "the agent did not answer \(method) in time")
        }
        guard let reply = pending.reply else { throw AcpError(message: "the agent stopped\(stderrNote())") }
        if let error = reply["error"] as? [String: Any] {
            throw AcpError(message: "\(method): \(error["message"] as? String ?? "the agent returned an error")")
        }
        return reply["result"] as? [String: Any] ?? [:]
    }

    /// Sends a notification: no answer is expected.
    func notify(_ method: String, _ params: [String: Any]) throws {
        try send(["jsonrpc": "2.0", "method": method, "params": params])
    }

    /// Ends the connection: the agent's input closes, and the process is terminated if it is still running.
    func close() {
        try? input.fileHandleForWriting.close()
        if process.isRunning { process.terminate() }
    }

    private func send(_ message: [String: Any]) throws {
        let data = try JSONSerialization.data(withJSONObject: message) + Data("\n".utf8)
        writeLock.lock()
        defer { writeLock.unlock() }
        do {
            try input.fileHandleForWriting.write(contentsOf: data)
        } catch {
            throw AcpError(message: "the agent stopped reading\(stderrNote())")
        }
    }

    private func stderrNote() -> String {
        let tail = stateLock.withLock { stderrTail.trimmingCharacters(in: .whitespacesAndNewlines) }
        return tail.isEmpty ? "" : ": \(tail)"
    }

    /// Reads the agent's stdout line by line until it ends, then fails every request still waiting.
    private func readOutput() {
        let reader = output.fileHandleForReading
        var buffer = Data()
        while true {
            let chunk = reader.availableData
            if chunk.isEmpty { break }
            buffer.append(chunk)
            while let newline = buffer.firstIndex(of: 0x0A) {
                let line = Data(buffer[buffer.startIndex..<newline])
                buffer.removeSubrange(buffer.startIndex...newline)
                if let message = (try? JSONSerialization.jsonObject(with: line)) as? [String: Any] {
                    handle(message)
                }
            }
        }
        let pending = stateLock.withLock { () -> [AcpPending] in
            closed = true
            let all = Array(waiting.values)
            waiting = [:]
            return all
        }
        pending.forEach { $0.done.signal() }
    }

    /// Keeps the last 2000 characters of the agent's stderr. The pipe is read all the time so the agent never blocks on it.
    private func readErrors() {
        let handle = errors.fileHandleForReading
        while true {
            let chunk = handle.availableData
            if chunk.isEmpty { break }
            stateLock.withLock {
                stderrTail = String((stderrTail + String(decoding: chunk, as: UTF8.self)).suffix(2000))
            }
        }
    }

    private func handle(_ message: [String: Any]) {
        if let method = message["method"] as? String {
            let params = message["params"] as? [String: Any] ?? [:]
            if let id = message["id"] {
                answerAgent(id: id, method: method, params: params)
            } else if method == "session/update", let update = params["update"] as? [String: Any] {
                onUpdate(update)
            }
            return
        }
        // a response to one of our requests
        guard let id = message["id"] as? Int, let pending = stateLock.withLock({ waiting.removeValue(forKey: id) }) else { return }
        pending.reply = message
        pending.done.signal()
    }

    /// An agent's request to us. Permission questions go to the callback; anything else is refused, so the agent does not wait.
    private func answerAgent(id: Any, method: String, params: [String: Any]) {
        guard method == "session/request_permission" else {
            reply(id, error: (-32601, "this client does not handle \(method)"))
            return
        }
        let options = (params["options"] as? [[String: Any]] ?? []).compactMap { option -> (id: String, kind: String)? in
            guard let optionId = option["optionId"] as? String else { return nil }
            return (optionId, option["kind"] as? String ?? "")
        }
        let title = (params["toolCall"] as? [String: Any])?["title"] as? String ?? ""
        let request = AcpPermissionRequest(sessionId: params["sessionId"] as? String ?? "", title: title, options: options)
        // the agent's own option for the answer: the first of the kinds wanted, in that order; none offered = cancelled
        let wanted = onPermission(request) == .allow ? ["allow_once", "allow_always"] : ["reject_once", "reject_always"]
        let chosen = wanted.lazy.compactMap { kind in options.first { $0.kind == kind } }.first
        let outcome: [String: Any] = chosen.map { ["outcome": "selected", "optionId": $0.id] } ?? ["outcome": "cancelled"]
        reply(id, result: ["outcome": outcome])
    }

    private func reply(_ id: Any, result: [String: Any]? = nil, error: (code: Int, message: String)? = nil) {
        var message: [String: Any] = ["jsonrpc": "2.0", "id": id]
        if let result { message["result"] = result }
        if let error { message["error"] = ["code": error.code, "message": error.message] }
        try? send(message)
    }
}

/// One ACP agent run: the handshake on the first prompt, then one `prompt` per message. `onText` gets each text chunk the
/// agent writes as it arrives. Call `close` when the run is over.
final class AcpRun {
    private let connection: AcpConnection
    /// the folder the session runs in (session/new cwd)
    private let cwd: URL
    /// the text of the prompt in progress, written by the reader thread
    private let text: TextBox
    private var sessionId: String?

    /// Starts the agent process. Throws if the program can't be started.
    init(command: AcpCommand, onText: @escaping (String) -> Void = { _ in },
         onPermission: @escaping (AcpPermissionRequest) -> AcpPermission = { _ in .deny }) throws {
        let text = TextBox()
        self.text = text
        cwd = command.cwd
        connection = try AcpConnection(command: command, onUpdate: { update in
            guard update["sessionUpdate"] as? String == "agent_message_chunk",
                  let content = update["content"] as? [String: Any], content["type"] as? String == "text",
                  let chunk = content["text"] as? String else { return }
            text.append(chunk)
            onText(chunk)
        }, onPermission: onPermission)
    }

    /// Sends one prompt and returns when the agent ends its turn. The first call runs initialize and session/new in the
    /// command's folder. A prompt in progress keeps streaming through `onText` until it ends.
    func prompt(_ message: String) throws -> AcpAnswer {
        let session: String
        if let sessionId {
            session = sessionId
        } else {
            _ = try connection.request("initialize", ["protocolVersion": 1, "clientCapabilities": [:]], timeout: 60)
            let created = try connection.request("session/new", ["cwd": cwd.path, "mcpServers": []], timeout: 60)
            guard let id = created["sessionId"] as? String else { throw AcpError(message: "the agent gave no session") }
            session = id
            sessionId = id
        }
        text.reset()
        let result = try connection.request("session/prompt",
                                            ["sessionId": session, "prompt": [["type": "text", "text": message]]],
                                            timeout: 30 * 60)
        return AcpAnswer(text: text.value, stopReason: result["stopReason"] as? String ?? "")
    }

    /// Asks the agent to stop the prompt in progress (session/cancel). The prompt then ends with stopReason "cancelled".
    func cancel() {
        guard let sessionId else { return }
        try? connection.notify("session/cancel", ["sessionId": sessionId])
    }

    /// Ends the run and stops the agent process.
    func close() {
        connection.close()
    }
}

/// The text of the prompt in progress: the reader thread appends, the caller reads when the prompt returns.
private final class TextBox {
    private let lock = NSLock()
    private var text = ""

    var value: String { lock.withLock { text } }

    func append(_ chunk: String) { lock.withLock { text += chunk } }

    func reset() { lock.withLock { text = "" } }
}
