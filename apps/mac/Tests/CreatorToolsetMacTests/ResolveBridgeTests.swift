import Foundation
import XCTest
@testable import CreatorToolsetMac

/// The Resolve bridge's protocol, tested against a fake Resolve: a shell script in place of fuscript that answers the
/// way the real script does (one line on stdout). No Resolve is started.
final class ResolveBridgeTests: XCTestCase {
    /// A fake runner in a fresh folder: `ok` echoes the request, `refuse…` answers an error, `hang…` never answers.
    private func fakeRunner() throws -> (URL, URL) {
        let root = ProcessInfo.processInfo.environment["CT_SCRATCH_DIR"].map { URL(fileURLWithPath: $0) }
            ?? FileManager.default.temporaryDirectory
        let dir = root.appendingPathComponent("resolve-fake-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let runner = dir.appendingPathComponent("fuscript")
        try """
        #!/bin/sh
        case "$CT_RESOLVE_NAME" in
          refuse*) printf 'noise\\nerror\\tResolve refused %s\\n' "$CT_RESOLVE_OTIO" ;;
          hang*) exec sleep 30 ;;
          *) printf 'loading...\\nok\\t%s\\n' "$CT_RESOLVE_NAME" ;;
        esac
        """.write(to: runner, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: runner.path)
        return (runner, dir)
    }

    func testReplyIsTheLastAnswerLine() {
        XCTAssertEqual(ResolveReply.parse("loading\nok\tDraft 2\n"), .opened(timeline: "Draft 2"))
        XCTAssertEqual(ResolveReply.parse("ok\tfirst\nerror\tlater\n"), .failed("later"))
        XCTAssertEqual(ResolveReply.parse("error\tno project is open in Resolve"), .failed("no project is open in Resolve"))
        XCTAssertNil(ResolveReply.parse("just noise\n"))
        XCTAssertNil(ResolveReply.parse(""))
    }

    func testOpensTheDraftAndReadsTheTimelineName() async throws {
        let (runner, dir) = try fakeRunner()
        defer { try? FileManager.default.removeItem(at: dir) }
        let request = ResolveRequest(otioPath: "/tmp/tiny-draft.otio", name: "Tiny Acrobatics cut",
                                     project: "Tiny Acrobatics edit", mediaFolder: nil)
        let reply = try await ResolveBridge.run(request, runner: runner, timeout: 10)
        XCTAssertEqual(reply, .opened(timeline: "Tiny Acrobatics cut"))
    }

    func testResolveRefusalComesBackAsAFailure() async throws {
        let (runner, dir) = try fakeRunner()
        defer { try? FileManager.default.removeItem(at: dir) }
        let reply = try await ResolveBridge.run(
            ResolveRequest(otioPath: "/tmp/tiny.otio", name: "refuse me", project: "p", mediaFolder: nil), runner: runner, timeout: 10)
        XCTAssertEqual(reply, .failed("Resolve refused /tmp/tiny.otio"))
    }

    func testARunThatNeverAnswersIsStopped() async throws {
        let (runner, dir) = try fakeRunner()
        defer { try? FileManager.default.removeItem(at: dir) }
        do {
            _ = try await ResolveBridge.run(
                ResolveRequest(otioPath: "/tmp/x.otio", name: "hang", project: "p", mediaFolder: nil), runner: runner, timeout: 0.5)
            XCTFail("a hung Resolve must time out")
        } catch {
            XCTAssertEqual(error as? ResolveBridgeError, .timedOut)
        }
    }

    func testProbeIsOffWithoutResolve() {
        XCTAssertNil(resolveScriptRunner(exists: { _ in false }))
        XCTAssertEqual(
            resolveScriptRunner(exists: { $0.hasPrefix("/Applications/DaVinci Resolve/") }),
            "/Applications/DaVinci Resolve/DaVinci Resolve.app/Contents/Libraries/Fusion/fuscript")
    }

    func testRequestCarriesItsInputsAsEnvironment() {
        let env = ResolveRequest(otioPath: "/a/b.otio", name: "Cut", project: "Edit A", mediaFolder: "/m",
                                 frameRate: "25", width: 2160, height: 3840).environment
        XCTAssertEqual(env, ["CT_RESOLVE_OTIO": "/a/b.otio", "CT_RESOLVE_NAME": "Cut", "CT_RESOLVE_PROJECT": "Edit A",
                             "CT_RESOLVE_MEDIA": "/m", "CT_RESOLVE_FPS": "25", "CT_RESOLVE_WIDTH": "2160",
                             "CT_RESOLVE_HEIGHT": "3840"])
        let bare = ResolveRequest(otioPath: "/a.otio", name: "C", project: "P", mediaFolder: nil,
                                  frameRate: nil, width: nil, height: nil).environment
        XCTAssertEqual(bare["CT_RESOLVE_MEDIA"], "")
        XCTAssertEqual(bare["CT_RESOLVE_FPS"], "")
        XCTAssertEqual(bare["CT_RESOLVE_WIDTH"], "")
    }
}
