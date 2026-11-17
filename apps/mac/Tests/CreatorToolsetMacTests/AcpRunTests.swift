import Foundation
import XCTest
@testable import CreatorToolsetMac

/// The ACP client against a fake agent: a small Python script that speaks the protocol over stdio. It covers the
/// handshake, streamed text, a permission question (denied by default, allowed when the caller says so), session reuse,
/// and a program that isn't there.
final class AcpRunTests: XCTestCase {
    /// The fake agent. It answers initialize and session/new, streams two text chunks and a permission question on each
    /// session/prompt, then echoes the permission outcome as a chunk before it ends the turn.
    static let fakeAgent = """
    import json, sys
    def send(o):
        sys.stdout.write(json.dumps(o) + "\\n")
        sys.stdout.flush()
    def chunk(text):
        send({"jsonrpc": "2.0", "method": "session/update", "params": {"sessionId": "s1",
              "update": {"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": text}}}})
    prompt_id = None
    for line in sys.stdin:
        msg = json.loads(line)
        method = msg.get("method")
        if method == "initialize":
            send({"jsonrpc": "2.0", "id": msg["id"], "result": {"protocolVersion": 1, "agentCapabilities": {}}})
        elif method == "session/new":
            send({"jsonrpc": "2.0", "id": msg["id"], "result": {"sessionId": "s1"}})
        elif method == "session/prompt":
            prompt_id = msg["id"]
            chunk("Hel")
            chunk("lo: " + msg["params"]["prompt"][0]["text"])
            send({"jsonrpc": "2.0", "id": 900, "method": "session/request_permission", "params": {"sessionId": "s1",
                  "toolCall": {"toolCallId": "t1", "title": "Write notes.md"},
                  "options": [{"optionId": "yes", "name": "Allow", "kind": "allow_once"},
                              {"optionId": "no", "name": "Reject", "kind": "reject_once"}]}})
        elif method is None and msg.get("id") == 900:
            outcome = msg["result"]["outcome"]
            chunk("[" + outcome.get("optionId", outcome["outcome"]) + "]")
            send({"jsonrpc": "2.0", "id": prompt_id, "result": {"stopReason": "end_turn"}})
        elif "id" in msg:
            send({"jsonrpc": "2.0", "id": msg["id"], "error": {"code": -32601, "message": "unsupported"}})
    """

    /// Writes the fake agent into a fresh temp folder and returns the command that starts it.
    private func fakeCommand() throws -> AcpCommand {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("acp-test-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: dir) }
        let script = dir.appendingPathComponent("fake_agent.py")
        try Self.fakeAgent.write(to: script, atomically: true, encoding: .utf8)
        return AcpCommand(executable: "/usr/bin/python3", arguments: [script.path], cwd: dir)
    }

    func testPromptStreamsTextAndDeniesPermissionByDefault() throws {
        var streamed: [String] = []
        var asked: [AcpPermissionRequest] = []
        let run = try AcpRun(command: try fakeCommand(), onText: { streamed.append($0) },
                             onPermission: { asked.append($0); return .deny })
        defer { run.close() }

        let answer = try run.prompt("hi")

        XCTAssertEqual(answer.stopReason, "end_turn")
        XCTAssertEqual(answer.text, "Hello: hi[no]")
        XCTAssertEqual(streamed, ["Hel", "lo: hi", "[no]"])
        XCTAssertEqual(asked.count, 1)
        XCTAssertEqual(asked.first?.title, "Write notes.md")
        XCTAssertEqual(asked.first?.sessionId, "s1")
        XCTAssertEqual(asked.first?.options.map(\.kind), ["allow_once", "reject_once"])
    }

    func testPermissionIsAllowedOnlyWhenTheCallerSaysSo() throws {
        let run = try AcpRun(command: try fakeCommand(), onPermission: { _ in .allow })
        defer { run.close() }

        XCTAssertEqual(try run.prompt("go").text, "Hello: go[yes]")
    }

    func testSecondPromptReusesTheSession() throws {
        let run = try AcpRun(command: try fakeCommand())
        defer { run.close() }

        XCTAssertEqual(try run.prompt("one").text, "Hello: one[no]")
        XCTAssertEqual(try run.prompt("two").text, "Hello: two[no]")
    }

    /// An agent that says nothing for 1.5 s after the prompt (one reading a video), then answers.
    static let quietAgent = """
    import json, sys, time
    def send(o):
        sys.stdout.write(json.dumps(o) + "\\n")
        sys.stdout.flush()
    for line in sys.stdin:
        msg = json.loads(line)
        method = msg.get("method")
        if method == "initialize":
            send({"jsonrpc": "2.0", "id": msg["id"], "result": {"protocolVersion": 1, "agentCapabilities": {}}})
        elif method == "session/new":
            send({"jsonrpc": "2.0", "id": msg["id"], "result": {"sessionId": "s1"}})
        elif method == "session/prompt":
            time.sleep(1.5)
            send({"jsonrpc": "2.0", "method": "session/update", "params": {"sessionId": "s1",
                  "update": {"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": "{}"}}}})
            send({"jsonrpc": "2.0", "id": msg["id"], "result": {"stopReason": "end_turn"}})
    """

    func testQuietAgentKeepsTheSiteWaiting() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("acp-test-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: dir) }
        let script = dir.appendingPathComponent("quiet_agent.py")
        try Self.quietAgent.write(to: script, atomically: true, encoding: .utf8)
        let req = RelayRequest(json: Data(#"{"id":"r1","system":"S","user":"U","driver":"acp"}"#.utf8))!
        let opts = RelayOptions(model: "", effort: "", home: "", resume: "", driver: "acp",
                                acp: AcpLaunch(command: "/usr/bin/python3", args: [script.path]))
        let sent = NSMutableArray()
        let answer = try acpAnswer(req, opts, work: dir, send: { sent.add($0); return true }, aliveEvery: 0.3)
        XCTAssertEqual(answer.text, "{}")
        // the silence was filled with the text so far (none yet), so the site never gave up on it
        XCTAssertGreaterThanOrEqual(sent.count, 3)
        XCTAssertEqual(sent.firstObject as? String, "")
    }

    func testMissingProgramThrows() {
        let command = AcpCommand(executable: "/nonexistent/acp-agent", cwd: FileManager.default.temporaryDirectory)
        XCTAssertThrowsError(try AcpRun(command: command)) { error in
            XCTAssertTrue((error as? AcpError)?.message.contains("is not installed on this Mac") ?? false)
        }
    }
}
