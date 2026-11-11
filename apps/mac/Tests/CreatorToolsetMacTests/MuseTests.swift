import XCTest
@testable import CreatorToolsetMac

/// Muse Code's runner (MuseStream, museArguments, the sign-in page). The fixtures are lines Muse Code 1.4.15 wrote on a Mac with
/// no Meta account (its echo provider answers without one); the lines marked "made from the schema" are built from `muse schema
/// generate-json-schema` for what that Mac could not produce: a turn with real token counts, a closed plan window.
final class MuseTests: XCTestCase {
    enum Recorded {
        /// A whole answer, every line `muse serve --provider echo --disable-shell --disable-write --no-session-log --disable-request-user-input` (Muse Code 1.4.15) wrote, as recorded.
        static let echoRun = #"""
{"jsonrpc":"2.0","id":1,"result":{"serverInfo":{"name":"muse","version":"1.4.15"},"userAgent":"muse-build/1.4.15 (serve; macos-aarch64; build c7a95b745e7eb209c8446981803d89c497d7cae0)","museHome":"/Users/tiny/.local/share/muse","platformFamily":"unix","platformOs":"macos","schema":{"version":1,"fingerprint":"sha256:ef311d2dbf051ed9114556e14ad3980eb515104baa3409306a6817082a61d8cd"},"grantedCapabilities":[],"experimentalApi":false,"sessionDurability":"ephemeral","sandboxAvailability":"available"}}
{"jsonrpc":"2.0","method":"session/started","params":{"session":{"sessionId":"01a1c7d9-d8c9-7797-95b5-a5ac5b1d8ebb","path":"","status":"idle","activeTurnId":null,"createdAt":"2026-11-10T23:45:05.442639Z","updatedAt":"2026-11-10T23:45:05.502617Z","workspaceRoot":"/Users/tiny/work","providerId":"echo","modelId":null,"turnCount":0,"forkedFrom":null,"sideFrom":null,"approvalMode":{"mode":"denyUnmatched","source":"startup","lastCommandId":null},"createdByClient":{"name":"probe","version":"1"}}},"emittedAtMs":1794354306390}
{"jsonrpc":"2.0","method":"session/approvalModeChanged","params":{"sessionId":"01a1c7d9-d8c9-7797-95b5-a5ac5b1d8ebb","viewCursor":"v9:01a1c7d9-d8c9-7797-95b5-a5ac5b1d8ebb:1","sourceRange":{"stream":{"kind":"session","id":"01a1c7d9-d8c9-7797-95b5-a5ac5b1d8ebb"},"first":{"id":"01a1c7d9-d9de-72b0-9a4e-ac0cd48532f3","sequence":4},"last":{"id":"01a1c7d9-d9de-72b0-9a4e-ac0cd48532f3","sequence":4}},"mode":"denyUnmatched","source":"approvalReconfigure","commandId":"01a1c7d9-d8c9-75ba-bc36-30558cb66286","clientName":"probe"},"emittedAtMs":1794354306399}
{"jsonrpc":"2.0","id":2,"result":{"session":{"sessionId":"01a1c7d9-d8c9-7797-95b5-a5ac5b1d8ebb","path":"","status":"idle","activeTurnId":null,"createdAt":"2026-11-10T23:45:05.442639Z","updatedAt":"2026-11-10T23:45:05.502617Z","workspaceRoot":"/Users/tiny/work","providerId":"echo","modelId":null,"turnCount":0,"forkedFrom":null,"sideFrom":null,"approvalMode":{"mode":"denyUnmatched","source":"startup","lastCommandId":null},"createdByClient":{"name":"probe","version":"1"}},"viewCursor":"pending:seam-c-session-view-fold"}}
{"jsonrpc":"2.0","id":3,"result":{"commandId":"01a1c7d9-dd6e-74cd-a047-ca67fe1e8931","status":"accepted","turnId":"01a1c7d9-dd6e-74cd-a047-ca67fe1e8931","startedNewTurn":true,"disposition":"started"}}
{"jsonrpc":"2.0","method":"session/statusChanged","params":{"sessionId":"01a1c7d9-d8c9-7797-95b5-a5ac5b1d8ebb","status":"running","viewCursor":"v9:01a1c7d9-d8c9-7797-95b5-a5ac5b1d8ebb:2"},"emittedAtMs":1794354306572}
{"jsonrpc":"2.0","method":"turn/started","params":{"sessionId":"01a1c7d9-d8c9-7797-95b5-a5ac5b1d8ebb","viewCursor":"v9:01a1c7d9-d8c9-7797-95b5-a5ac5b1d8ebb:2","sourceRange":{"stream":{"kind":"session","id":"01a1c7d9-d8c9-7797-95b5-a5ac5b1d8ebb"},"first":{"id":"01a1c7d9-ddfc-7173-8f4c-420382e472df","sequence":12},"last":{"id":"01a1c7d9-ddfc-7173-8f4c-420382e472df","sequence":12}},"turnId":"01a1c7d9-dd6e-74cd-a047-ca67fe1e8931","commandId":"01a1c7d9-dd6e-74cd-a047-ca67fe1e8931"},"emittedAtMs":1794354306574}
{"jsonrpc":"2.0","method":"item/completed","params":{"sessionId":"01a1c7d9-d8c9-7797-95b5-a5ac5b1d8ebb","viewCursor":"v9:01a1c7d9-d8c9-7797-95b5-a5ac5b1d8ebb:3","sourceRange":{"stream":{"kind":"session","id":"01a1c7d9-d8c9-7797-95b5-a5ac5b1d8ebb"},"first":{"id":"01a1c7d9-ddfc-7173-8f4c-420382e472df","sequence":12},"last":{"id":"01a1c7d9-ddfc-7173-8f4c-420382e472df","sequence":12}},"item":{"itemId":"698e8f22-6b5e-4f2e-8876-86bd7ceb50df","kind":"userMessage","turnId":"01a1c7d9-dd6e-74cd-a047-ca67fe1e8931","revision":1,"status":"completed","recordedAt":"2026-11-10T23:45:06.556471Z","text":"<instructions>\nAnswer in one line.\n</instructions>\n\nSay hello to Tiny Acrobatics.","commandId":"01a1c7d9-dd6e-74cd-a047-ca67fe1e8931"}},"emittedAtMs":1794354306574}
{"jsonrpc":"2.0","method":"item/started","params":{"sessionId":"01a1c7d9-d8c9-7797-95b5-a5ac5b1d8ebb","viewCursor":"v9:01a1c7d9-d8c9-7797-95b5-a5ac5b1d8ebb:4","sourceRange":{"stream":{"kind":"session","id":"01a1c7d9-d8c9-7797-95b5-a5ac5b1d8ebb"},"first":{"id":"01a1c7d9-de63-7552-a210-82949072a76f","sequence":28},"last":{"id":"01a1c7d9-de63-7552-a210-82949072a76f","sequence":28}},"item":{"itemId":"01a1c7d9-de63-7552-a210-82949072a76f","kind":"reminderChild","turnId":"01a1c7d9-dd6e-74cd-a047-ca67fe1e8931","revision":1,"status":"inProgress","recordedAt":"2026-11-10T23:45:06.659141Z","fallbackText":"Reminder child session","childSessionId":"01a1c7d9-de56-7d33-b71d-68b2a7d16f2c","reminderAgentId":"skill-reminder","generationId":1,"taskId":"01a1c7d9-de56-7d33-b71d-68a849e4ecd1"}},"emittedAtMs":1794354306660}
{"jsonrpc":"2.0","method":"item/started","params":{"sessionId":"01a1c7d9-d8c9-7797-95b5-a5ac5b1d8ebb","viewCursor":"v9:01a1c7d9-d8c9-7797-95b5-a5ac5b1d8ebb:4.1","item":{"itemId":"715d4724-141f-49ce-8d40-a999831b66a4","kind":"agentMessage","turnId":"01a1c7d9-dd6e-74cd-a047-ca67fe1e8931","revision":1,"status":"inProgress","text":"","messagePhase":"finalAnswer"}},"emittedAtMs":1794354306692}
{"jsonrpc":"2.0","method":"item/delta","params":{"sessionId":"01a1c7d9-d8c9-7797-95b5-a5ac5b1d8ebb","viewCursor":"v9:01a1c7d9-d8c9-7797-95b5-a5ac5b1d8ebb:4.2","itemId":"715d4724-141f-49ce-8d40-a999831b66a4","field":"text","delta":"echo: <instructions>\nAnswer in one line.\n</instructions>\n\nSay hello to Tiny Acrobatics."},"emittedAtMs":1794354306692}
{"jsonrpc":"2.0","method":"session/tokenUsage","params":{"sessionId":"01a1c7d9-d8c9-7797-95b5-a5ac5b1d8ebb","viewCursor":"v9:01a1c7d9-d8c9-7797-95b5-a5ac5b1d8ebb:5","sourceRange":{"stream":{"kind":"session","id":"01a1c7d9-d8c9-7797-95b5-a5ac5b1d8ebb"},"first":{"id":"01a1c7d9-de86-77f1-921e-e10f4247f155","sequence":40},"last":{"id":"01a1c7d9-de86-77f1-921e-e10f4247f155","sequence":40}},"turnId":"01a1c7d9-dd6e-74cd-a047-ca67fe1e8931","modelId":null,"usage":{"inputTokens":0,"outputTokens":0,"cachedTokens":0,"reasoningTokens":0},"promptTokens":0,"totalTokens":0,"durationMs":7,"cumulative":{"promptTokens":0,"outputTokens":0,"totalTokens":0}},"emittedAtMs":1794354306695}
{"jsonrpc":"2.0","method":"item/completed","params":{"sessionId":"01a1c7d9-d8c9-7797-95b5-a5ac5b1d8ebb","viewCursor":"v9:01a1c7d9-d8c9-7797-95b5-a5ac5b1d8ebb:6","sourceRange":{"stream":{"kind":"session","id":"01a1c7d9-d8c9-7797-95b5-a5ac5b1d8ebb"},"first":{"id":"01a1c7d9-de89-7610-884b-ee40ce639610","sequence":42},"last":{"id":"01a1c7d9-de89-7610-884b-ee40ce639610","sequence":42}},"item":{"itemId":"715d4724-141f-49ce-8d40-a999831b66a4","kind":"agentMessage","turnId":"01a1c7d9-dd6e-74cd-a047-ca67fe1e8931","revision":2,"status":"completed","recordedAt":"2026-11-10T23:45:06.697085Z","text":"echo: <instructions>\nAnswer in one line.\n</instructions>\n\nSay hello to Tiny Acrobatics.","messagePhase":"finalAnswer"}},"emittedAtMs":1794354306697}
{"jsonrpc":"2.0","method":"turn/foregroundCompleted","params":{"sessionId":"01a1c7d9-d8c9-7797-95b5-a5ac5b1d8ebb","viewCursor":"v9:01a1c7d9-d8c9-7797-95b5-a5ac5b1d8ebb:7","sourceRange":{"stream":{"kind":"session","id":"01a1c7d9-d8c9-7797-95b5-a5ac5b1d8ebb"},"first":{"id":"01a1c7d9-de8d-7ae0-9ed8-60966dcc9d15","sequence":48},"last":{"id":"01a1c7d9-de8d-7ae0-9ed8-60966dcc9d15","sequence":48}},"turnId":"01a1c7d9-dd6e-74cd-a047-ca67fe1e8931","blockingAgents":["goal-reminder"]},"emittedAtMs":1794354306702}
{"jsonrpc":"2.0","method":"item/started","params":{"sessionId":"01a1c7d9-d8c9-7797-95b5-a5ac5b1d8ebb","viewCursor":"v9:01a1c7d9-d8c9-7797-95b5-a5ac5b1d8ebb:8","sourceRange":{"stream":{"kind":"session","id":"01a1c7d9-d8c9-7797-95b5-a5ac5b1d8ebb"},"first":{"id":"01a1c7d9-de8d-7ae0-9ed8-60966dcc9d15","sequence":48},"last":{"id":"01a1c7d9-de8d-7ae0-9ed8-60966dcc9d15","sequence":48}},"item":{"itemId":"01a1c7d9-de8d-7ae0-9ed8-60966dcc9d15","kind":"reminderChild","turnId":"01a1c7d9-dd6e-74cd-a047-ca67fe1e8931","revision":1,"status":"inProgress","recordedAt":"2026-11-10T23:45:06.701625Z","fallbackText":"Reminder child session","childSessionId":"01a1c7d9-de8c-7a63-8730-696c3fc63356","reminderAgentId":"goal-reminder","generationId":1,"taskId":"01a1c7d9-de8c-7a63-8730-695ea01cd19f","blocking":true}},"emittedAtMs":1794354306702}
{"jsonrpc":"2.0","method":"item/started","params":{"sessionId":"01a1c7d9-d8c9-7797-95b5-a5ac5b1d8ebb","viewCursor":"v9:01a1c7d9-d8c9-7797-95b5-a5ac5b1d8ebb:9","sourceRange":{"stream":{"kind":"session","id":"01a1c7d9-d8c9-7797-95b5-a5ac5b1d8ebb"},"first":{"id":"01a1c7d9-de8f-77e2-ab35-769412ea7077","sequence":55},"last":{"id":"01a1c7d9-de8f-77e2-ab35-769412ea7077","sequence":55}},"item":{"itemId":"01a1c7d9-de8f-77e2-ab35-769412ea7077","kind":"reminderChild","turnId":"01a1c7d9-dd6e-74cd-a047-ca67fe1e8931","revision":1,"status":"inProgress","recordedAt":"2026-11-10T23:45:06.703215Z","fallbackText":"Reminder child session","childSessionId":"01a1c7d9-de8e-76b1-b523-fedea749b42e","reminderAgentId":"verify-reminder","generationId":1,"taskId":"01a1c7d9-de8e-76b1-b523-fecba16f24c0","blocking":true}},"emittedAtMs":1794354306703}
{"jsonrpc":"2.0","method":"item/completed","params":{"sessionId":"01a1c7d9-d8c9-7797-95b5-a5ac5b1d8ebb","viewCursor":"v9:01a1c7d9-d8c9-7797-95b5-a5ac5b1d8ebb:10","sourceRange":{"stream":{"kind":"session","id":"01a1c7d9-d8c9-7797-95b5-a5ac5b1d8ebb"},"first":{"id":"01a1c7d9-de63-7552-a210-82949072a76f","sequence":28},"last":{"id":"01a1c7d9-deba-79e2-adfb-97715d2965b5","sequence":57}},"item":{"itemId":"01a1c7d9-de63-7552-a210-82949072a76f","kind":"reminderChild","turnId":"01a1c7d9-dd6e-74cd-a047-ca67fe1e8931","revision":2,"status":"completed","recordedAt":"2026-11-10T23:45:06.74666Z","fallbackText":"Reminder child session","childSessionId":"01a1c7d9-de56-7d33-b71d-68b2a7d16f2c","reminderAgentId":"skill-reminder","generationId":1,"taskId":"01a1c7d9-de56-7d33-b71d-68a849e4ecd1"}},"emittedAtMs":1794354306747}
{"jsonrpc":"2.0","method":"item/completed","params":{"sessionId":"01a1c7d9-d8c9-7797-95b5-a5ac5b1d8ebb","viewCursor":"v9:01a1c7d9-d8c9-7797-95b5-a5ac5b1d8ebb:11","sourceRange":{"stream":{"kind":"session","id":"01a1c7d9-d8c9-7797-95b5-a5ac5b1d8ebb"},"first":{"id":"01a1c7d9-de8d-7ae0-9ed8-60966dcc9d15","sequence":48},"last":{"id":"01a1c7d9-debb-7c61-ba2b-98e62d464c0e","sequence":58}},"item":{"itemId":"01a1c7d9-de8d-7ae0-9ed8-60966dcc9d15","kind":"reminderChild","turnId":"01a1c7d9-dd6e-74cd-a047-ca67fe1e8931","revision":2,"status":"completed","recordedAt":"2026-11-10T23:45:06.747262Z","fallbackText":"Reminder child session","childSessionId":"01a1c7d9-de8c-7a63-8730-696c3fc63356","reminderAgentId":"goal-reminder","generationId":1,"taskId":"01a1c7d9-de8c-7a63-8730-695ea01cd19f","blocking":true}},"emittedAtMs":1794354306747}
{"jsonrpc":"2.0","method":"item/completed","params":{"sessionId":"01a1c7d9-d8c9-7797-95b5-a5ac5b1d8ebb","viewCursor":"v9:01a1c7d9-d8c9-7797-95b5-a5ac5b1d8ebb:12","sourceRange":{"stream":{"kind":"session","id":"01a1c7d9-d8c9-7797-95b5-a5ac5b1d8ebb"},"first":{"id":"01a1c7d9-de8f-77e2-ab35-769412ea7077","sequence":55},"last":{"id":"01a1c7d9-debb-7c61-ba2b-98f8d6cc19f3","sequence":59}},"item":{"itemId":"01a1c7d9-de8f-77e2-ab35-769412ea7077","kind":"reminderChild","turnId":"01a1c7d9-dd6e-74cd-a047-ca67fe1e8931","revision":2,"status":"completed","recordedAt":"2026-11-10T23:45:06.747363Z","fallbackText":"Reminder child session","childSessionId":"01a1c7d9-de8e-76b1-b523-fedea749b42e","reminderAgentId":"verify-reminder","generationId":1,"taskId":"01a1c7d9-de8e-76b1-b523-fecba16f24c0","blocking":true}},"emittedAtMs":1794354306747}
{"jsonrpc":"2.0","method":"session/statusChanged","params":{"sessionId":"01a1c7d9-d8c9-7797-95b5-a5ac5b1d8ebb","status":"idle","viewCursor":"v9:01a1c7d9-d8c9-7797-95b5-a5ac5b1d8ebb:13"},"emittedAtMs":1794354306749}
{"jsonrpc":"2.0","method":"turn/completed","params":{"sessionId":"01a1c7d9-d8c9-7797-95b5-a5ac5b1d8ebb","viewCursor":"v9:01a1c7d9-d8c9-7797-95b5-a5ac5b1d8ebb:13","sourceRange":{"stream":{"kind":"session","id":"01a1c7d9-d8c9-7797-95b5-a5ac5b1d8ebb"},"first":{"id":"01a1c7d9-debc-7071-9838-4f6384891848","sequence":61},"last":{"id":"01a1c7d9-debc-7071-9838-4f6384891848","sequence":61}},"turnId":"01a1c7d9-dd6e-74cd-a047-ca67fe1e8931","terminal":"completed","durationMs":211,"timeToFirstTokenMs":156},"emittedAtMs":1794354306749}
{"jsonrpc":"2.0","method":"session/closed","params":{"sessionId":"01a1c7d9-d8c9-7797-95b5-a5ac5b1d8ebb","reason":"hostShutdown","viewCursor":"pending:seam-c-session-view-fold"},"emittedAtMs":1794354306808}
{"jsonrpc":"2.0","method":"session/statusChanged","params":{"sessionId":"01a1c7d9-d8c9-7797-95b5-a5ac5b1d8ebb","status":"notLoaded","viewCursor":"pending:seam-c-session-view-fold"},"emittedAtMs":1794354306808}
"""#

        /// `--provider meta` in a home that never signed in: the turn's end, as recorded.
        static let signedOut = #"""
{"jsonrpc":"2.0","method":"turn/completed","params":{"sessionId":"01a1c7e1-b20f-7fea-98aa-f11af32d776c","viewCursor":"v9:01a1c7e1-b20f-7fea-98aa-f11af32d776c:4","sourceRange":{"stream":{"kind":"session","id":"01a1c7e1-b20f-7fea-98aa-f11af32d776c"},"first":{"id":"01a1c7e1-b22d-74a0-b6a3-a7be26545335","sequence":26},"last":{"id":"01a1c7e1-b22d-74a0-b6a3-a7be26545335","sequence":26}},"turnId":"01a1c7e1-b229-74b9-aed0-4cf45f4ecef3","terminal":"failed","reason":"not logged in: run /login to add an API key","durationMs":3,"error":{"kind":"authRequired","message":"not logged in: run /login to add an API key","retryable":false}},"emittedAtMs":1794354819629}
"""#

        /// A turn stopped with turn/interrupt, as recorded.
        static let stopped = #"""
{"jsonrpc":"2.0","method":"turn/completed","params":{"sessionId":"01a1c7dd-874a-77c6-9794-8c38375ce13f","viewCursor":"v9:01a1c7dd-874a-77c6-9794-8c38375ce13f:13","sourceRange":{"stream":{"kind":"session","id":"01a1c7dd-874a-77c6-9794-8c38375ce13f"},"first":{"id":"01a1c7dd-8f18-78e2-97fa-4ed71ec6fc89","sequence":67},"last":{"id":"01a1c7dd-8f18-78e2-97fa-4ed71ec6fc89","sequence":67}},"turnId":"01a1c7dd-8dc3-767c-8fdd-5179c7a4002d","terminal":"cancelled","reason":"cancelled during end-of-turn reminder wait","durationMs":246,"timeToFirstTokenMs":155},"emittedAtMs":1794354548505}
"""#

    }

    private let echoSession = "01a1c7d9-d8c9-7797-95b5-a5ac5b1d8ebb"

    /// The lines a stream wrote back to Muse Code, each as an object.
    private func written(_ updates: [StreamUpdate]) -> [[String: Any]] {
        updates.flatMap { update -> [[String: Any]] in
            guard case .write(let data) = update else { return [] }
            return String(decoding: data, as: UTF8.self).split(separator: "\n").map { try! JSONSerialization.jsonObject(with: Data($0.utf8)) as! [String: Any] }
        }
    }

    /// A recorded run's lines as this stream's own session (the recording's session id swapped for the stream's).
    private func lines(_ text: String, recorded: String, as s: MuseStream) -> [String] {
        text.replacingOccurrences(of: recorded, with: s.session).split(separator: "\n").map(String.init)
    }

    private func stream(model: String = "", effort: String = "low") -> MuseStream {
        MuseStream(prompt: "<instructions>\nAnswer in one line.\n</instructions>\n\nSay hello to Tiny Acrobatics.", model: model, effort: effort, cwd: "/Users/tiny/work")
    }

    func testARecordedAnswerIsAnsweredStepByStepAndEndsOnTurnCompleted() throws {
        var s = stream()
        XCTAssertTrue(s.opening.hasSuffix("\n"))
        XCTAssertEqual((try JSONSerialization.jsonObject(with: Data(s.opening.utf8)) as? [String: Any])?["method"] as? String, "initialize")
        let recorded = lines(Recorded.echoRun, recorded: echoSession, as: s)
        // initialize's answer: initialized, then one session in the run's folder that refuses what nobody is there to approve
        let first = written(s.feed(recorded[0]))
        XCTAssertEqual(first.map { $0["method"] as? String }, ["initialized", "session/start"])
        let start = try XCTUnwrap(first[1]["params"] as? [String: Any])
        XCTAssertEqual(start["sessionId"] as? String, s.session)
        XCTAssertEqual(start["workspaceRoot"] as? String, "/Users/tiny/work")
        XCTAssertEqual(start["approvalMode"] as? String, "denyUnmatched")
        XCTAssertNil(start["modelId"])   // no model named: Muse Code's own default
        // session/start's answer: the turn, with the whole prompt and the effort; the rest streams the answer
        var updates: [StreamUpdate] = []
        for line in recorded.dropFirst() { updates += s.feed(line) }
        let turn = try XCTUnwrap(written(updates).first { $0["method"] as? String == "turn/start" }?["params"] as? [String: Any])
        XCTAssertEqual((turn["input"] as? [[String: Any]])?.first?["text"] as? String, s.prompt)
        XCTAssertEqual(turn["reasoningEffort"] as? String, "low")
        XCTAssertEqual(turn["sessionId"] as? String, s.session)
        XCTAssertTrue(updates.contains(.text("echo: " + s.prompt)))
        XCTAssertEqual(updates.filter { $0 == .result }.count, 1)
        let result = s.result(err: "")
        XCTAssertEqual(result["is_error"] as? Bool, false)
        XCTAssertEqual(result["result"] as? String, "echo: " + s.prompt)
    }

    func testANamedModelGoesOnTheSession() {
        var s = stream(model: "muse-spark-1.3")
        let start = written(s.feed(lines(Recorded.echoRun, recorded: echoSession, as: s)[0]))[1]["params"] as? [String: Any]
        XCTAssertEqual(start?["modelId"] as? String, "muse-spark-1.3")
    }

    func testAnotherSessionsLinesAreNotThisAnswer() {
        var s = stream()   // the recording keeps its own session id: a subagent's or a reminder's lines look like this
        var updates: [StreamUpdate] = []
        for line in Recorded.echoRun.split(separator: "\n") { updates += s.feed(String(line)) }
        XCTAssertEqual(s.text, "")
        XCTAssertFalse(updates.contains(.result))
    }

    func testSignedOutSaysToSignInFirstAndKeepsMuseCodesOwnWords() {
        var s = stream()
        XCTAssertEqual(lines(Recorded.signedOut, recorded: "01a1c7e1-b20f-7fea-98aa-f11af32d776c", as: s).flatMap { s.feed($0) }, [.result])
        let message = s.result(err: "")["result"] as? String ?? ""
        XCTAssertEqual(message, "Muse Code isn't signed in on this Mac. Sign in to Muse Code, then try again. Muse Code said: not logged in: run /login to add an API key")
        XCTAssertEqual(s.result(err: "")["is_error"] as? Bool, true)
        XCTAssertFalse(limitFlag("musecode", message))
        // the Providers page puts its Sign in button on a failed check that says so (providerStatus)
        XCTAssertNotNil(message.range(of: "sign in|log ?in|login", options: [.regularExpression, .caseInsensitive]))
    }

    func testNotLoggedInIsASignInWhateverTheKind() {
        var s = stream()
        // recorded against a stand-in model endpoint on this Mac, with a made-up key: the same words, kind modelError
        let line = #"{"jsonrpc":"2.0","method":"turn/completed","params":{"sessionId":"01a1c7e2-1a9a-762e-b3de-5ead8855ebfb","viewCursor":"v9:01a1c7e2-1a9a-762e-b3de-5ead8855ebfb:4","sourceRange":{"stream":{"kind":"session","id":"01a1c7e2-1a9a-762e-b3de-5ead8855ebfb"},"first":{"id":"01a1c7e2-1e71-73c2-8291-4a9f23cdd9c7","sequence":25},"last":{"id":"01a1c7e2-1e71-73c2-8291-4a9f23cdd9c7","sequence":25}},"turnId":"01a1c7e2-1db6-7294-a535-67b5cce128e2","terminal":"failed","reason":"not logged in: run /login to add an API key","durationMs":92,"error":{"kind":"modelError","message":"not logged in: run /login to add an API key","retryable":false}},"emittedAtMs":1794354847347}"#
        _ = s.feed(line.replacingOccurrences(of: "01a1c7e2-1a9a-762e-b3de-5ead8855ebfb", with: s.session))
        XCTAssertTrue((s.result(err: "")["result"] as? String ?? "").hasPrefix("Muse Code isn't signed in on this Mac. Sign in to Muse Code"))
    }

    func testALongLimitMessageKeepsItsResetTimeInsideWhatTheSiteKeeps() {
        var s = stream()
        let long = String(repeating: "Your allowance for this window is used up. ", count: 10)
        _ = s.feed(#"{"jsonrpc":"2.0","method":"turn/completed","params":{"sessionId":"\#(s.session)","terminal":"failed","error":{"kind":"modelError","message":"\#(long)","retryable":false,"quota":{"limitKind":"tierLimit","resetsAtMs":1794380400000}}}}"#)
        let message = s.result(err: "")["result"] as? String ?? ""
        XCTAssertLessThanOrEqual(message.count, 300)   // api/lib/mac-claude.ts keeps 300 and reads the time from the end
        XCTAssertTrue(message.hasSuffix("It resets \(Date(timeIntervalSince1970: 1_794_380_400).formatted(date: .abbreviated, time: .shortened))."))
    }

    func testAStoppedTurnSaysSo() {
        var s = stream()
        _ = lines(Recorded.stopped, recorded: "01a1c7dd-874a-77c6-9794-8c38375ce13f", as: s).flatMap { s.feed($0) }
        XCTAssertEqual(s.result(err: "")["result"] as? String, "Muse Code stopped the answer. Muse Code said: cancelled during end-of-turn reminder wait")
    }

    func testAClosedPlanWindowIsALimitAndSaysWhenItOpens() {
        var s = stream()
        // made from the schema: a turn/completed whose error carries the quota detail (TurnError.quota)
        let line = #"{"jsonrpc":"2.0","method":"turn/completed","params":{"sessionId":"\#(s.session)","turnId":"01a1c7e2-0000-7000-8000-000000000001","terminal":"failed","reason":"usage limit reached","error":{"kind":"modelError","message":"usage limit reached","retryable":false,"quota":{"limitKind":"tierLimit","resetsAtMs":1794380400000}}}}"#
        XCTAssertEqual(s.feed(line), [.result])
        let reset = Date(timeIntervalSince1970: 1_794_380_400).formatted(date: .abbreviated, time: .shortened)
        let message = s.result(err: "")["result"] as? String ?? ""
        XCTAssertEqual(message, "Your Muse Code plan's usage limit is reached. Muse Code said: usage limit reached. It resets \(reset).")
        XCTAssertTrue(limitFlag("musecode", message))
        // Muse Code's own words for a refused request, when the detail is missing
        XCTAssertTrue(limitFlag("musecode", "API error 429: quota exceeded for this subscription"))
        XCTAssertFalse(limitFlag("musecode", "API error 500: internal"))
    }

    func testAnErrorAnswerEndsTheRunWithItsWords() {
        var s = stream()
        // recorded: what session/start answers a command id that is not a UUIDv7
        let line = #"{"jsonrpc":"2.0","id":2,"error":{"code":-32602,"message":"invalid session/start commandId: expected UUIDv7","data":{"kind":"invalidParams"}}}"#
        XCTAssertEqual(s.feed(line), [.result])
        XCTAssertEqual(s.result(err: "")["result"] as? String, "Muse Code stopped before it answered. Muse Code said: invalid session/start commandId: expected UUIDv7")
    }

    func testAProgramThatDiesSaysWhatItPrinted() {
        let s = stream()
        XCTAssertEqual(s.result(err: "muse serve: unexpected argument '--wat' found\n")["result"] as? String,
                       "Muse Code stopped before it answered. Muse Code said: muse serve: unexpected argument '--wat' found")
    }

    func testAQuestionOnlyAPersonCanAnswerIsRefusedAndEndsTheRun() throws {
        var s = stream()
        // made from the schema: approval/request is the request Muse Code sends when a person must say yes
        let updates = s.feed(#"{"jsonrpc":"2.0","id":41,"method":"approval/request","params":{"sessionId":"x","toolName":"web_fetch","subject":{"kind":"network","host":"tinyacrobatics.example"}}}"#)
        let back = written(updates)
        XCTAssertEqual(back.count, 1)
        XCTAssertEqual(back[0]["id"] as? Int, 41)
        XCTAssertEqual((back[0]["error"] as? [String: Any])?["code"] as? Int, -32601)
        XCTAssertEqual(updates.last, .result)   // the turn would wait for a yes: the run ends instead
        XCTAssertEqual(s.result(err: "")["result"] as? String, "Muse Code stopped: it asked for a yes that nobody here can give (web_fetch).")
    }

    func testUsageAddsUpAndTheTurnsOwnTotalWins() {
        var s = stream()
        // made from the schema: session/tokenUsage and turn/completed with counts (the echo provider reports zeros)
        _ = s.feed(#"{"jsonrpc":"2.0","method":"session/tokenUsage","params":{"sessionId":"\#(s.session)","modelId":"muse-spark-1.3","usage":{"inputTokens":1200,"outputTokens":30,"cachedTokens":1000,"cacheReadTokens":1000,"cacheWriteTokens":0,"reasoningTokens":12}}}"#)
        XCTAssertEqual(s.seen["musecode"]?["input_tokens"] as? Int, 200)
        XCTAssertEqual(s.seen["musecode"]?["cache_read_input_tokens"] as? Int, 1000)
        XCTAssertEqual(s.seen["musecode"]?["output_tokens"] as? Int, 30)
        _ = s.feed(#"{"jsonrpc":"2.0","method":"item/delta","params":{"sessionId":"\#(s.session)","itemId":"m","delta":"lost"}}"#)   // no message started: not the answer
        _ = s.feed(#"{"jsonrpc":"2.0","method":"item/started","params":{"sessionId":"\#(s.session)","item":{"itemId":"m","kind":"agentMessage","revision":1,"status":"inProgress","text":""}}}"#)
        _ = s.feed(#"{"jsonrpc":"2.0","method":"item/delta","params":{"sessionId":"\#(s.session)","itemId":"m","delta":"Hello"}}"#)
        _ = s.feed(#"{"jsonrpc":"2.0","method":"turn/completed","params":{"sessionId":"\#(s.session)","terminal":"completed","usage":{"inputTokens":1500,"outputTokens":40,"cachedTokens":1000,"reasoningTokens":12}}}"#)
        let row = genericUsageRow(s.result(err: ""), model: "")
        XCTAssertEqual(row["models"] as? [String], ["muse-spark-1.3"])
        XCTAssertEqual(row["input"] as? Int, 500)
        XCTAssertEqual(row["cache_read"] as? Int, 1000)
        XCTAssertEqual(row["output"] as? Int, 40)
        XCTAssertEqual(row["thinking"] as? Int, 12)
        XCTAssertEqual(s.result(err: "")["result"] as? String, "Hello")
    }

    func testOnlyTheLastMessageIsTheAnswer() {
        var s = stream()
        for (id, said) in [("a", "Let me look."), ("b", "{\"answer\":1}")] {
            _ = s.feed(#"{"jsonrpc":"2.0","method":"item/completed","params":{"sessionId":"\#(s.session)","item":{"itemId":"\#(id)","kind":"agentMessage","revision":2,"status":"completed","text":"\#(said.replacingOccurrences(of: "\"", with: "\\\""))"}}}"#)
        }
        XCTAssertEqual(s.text, "{\"answer\":1}")
    }

    func testCommandIdsAreUUIDv7() {
        let at = Date(timeIntervalSince1970: 1_794_354_306.390)
        let id = uuidV7(at)
        XCTAssertNotNil(id.range(of: "^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$", options: .regularExpression))
        XCTAssertTrue(id.hasPrefix("01a1c7d9-dd56"))   // the time in milliseconds comes first
        XCTAssertNotEqual(uuidV7(at), uuidV7(at))
    }

    func testNoFolderAndNoWebMeansNoToolsAndNothingEverWritesOrRuns() {
        XCTAssertEqual(museArguments(tools: false), ["serve", "--provider", "meta", "--no-session-log", "--disable-request-user-input", "--preset", "empty"])
        XCTAssertEqual(museArguments(tools: true), ["serve", "--provider", "meta", "--no-session-log", "--disable-request-user-input", "--disable-shell", "--disable-write"])
        for args in [museArguments(tools: false), museArguments(tools: true)] {
            for flag in ["--yolo", "--trust-workspace", "--disable-sandbox", "--disable-approval"] { XCTAssertFalse(args.contains(flag)) }
        }
    }

    func testMuseCodeTakesNoHomeAndNoMetaKey() throws {
        let home = FileManager.default.temporaryDirectory.appendingPathComponent("muse-\(UUID().uuidString)")
        let folder = home.appendingPathComponent(".config/muse")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: home) }
        let req = RelayRequest(json: Data(#"{"id":"j","system":"","user":"","driver":"musecode","home":"\#(folder.path)"}"#.utf8))!
        XCTAssertThrowsError(try requestOptions(req, root: home)) { error in
            XCTAssertEqual((error as? RelayError)?.message, "Muse Code keeps its own folder (~/.config/muse): it takes no home")
        }
        XCTAssertNil(driverEnv(base: ["META_API_KEY": "k", "PATH": "/bin"])["META_API_KEY"])   // the plan's sign-in, never a pay-as-you-go key
    }

    func testTheSignInPageAndCodeComeFromMuseLoginsOwnOutput() {
        // recorded with no terminal, the code made up
        let printed = "Open this page to sign in:\n  https://auth.meta.com/oauth/device/?code=TINY-2468\nconfirm this code matches:\n  TINY-2468\n\nWaiting for approval\u{2026}"
        let got = museLoginPage(printed)
        XCTAssertEqual(got?.page.absoluteString, "https://auth.meta.com/oauth/device/?code=TINY-2468")
        XCTAssertEqual(got?.code, "TINY-2468")
        XCTAssertNil(museLoginPage("Open this page to sign in:\n  https://auth.meta.com/oauth/device/?code=TINY-2468\n"))   // not all printed yet
        XCTAssertNil(museLoginPage(printed.replacingOccurrences(of: "auth.meta.com", with: "auth.meta.com.example")))   // only Meta's own page
        XCTAssertNil(museLoginPage(printed.replacingOccurrences(of: "https://", with: "http://")))
    }

    func testTheReportReadsMuseCodesSignIn() {
        // recorded: `muse usage --json` in a home that never signed in
        XCTAssertEqual(signInFrom(driver: "musecode", output: "muse usage: not logged in: run `muse login` first\n")?.signedIn, false)
        // made from the schema (SubscriptionUsage): signed in, with the plan's tier
        let usage = signInFrom(driver: "musecode", output: #"{"observedAtMs":1794354306390,"tier":"everyday","window":{"usedPercent":10},"weekly":{"usedPercent":2}}"#)
        XCTAssertEqual(usage?.signedIn, true)
        XCTAssertEqual(usage?.plan, "everyday")
        XCTAssertNil(signInFrom(driver: "musecode", output: "error: network unreachable"))
    }
}
