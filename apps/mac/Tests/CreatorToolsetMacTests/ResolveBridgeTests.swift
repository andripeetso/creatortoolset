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
          *) if [ -n "$CT_RESOLVE_OUT" ] && grep -q EXPORT_OTIO "$3"; then printf '{"OTIO_SCHEMA":"Timeline.1"}' > "$CT_RESOLVE_OUT"; fi
             printf 'loading...\\nok\\t%s\\n' "$CT_RESOLVE_NAME" ;;
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

    func testTakesTheDraftBackAsOtio() async throws {
        let (runner, dir) = try fakeRunner()
        defer { try? FileManager.default.removeItem(at: dir) }
        let out = dir.appendingPathComponent("back.otio")
        let request = ResolveTakeBack(name: "Tiny Acrobatics cut", project: "Tiny Acrobatics edit", outPath: out.path)
        XCTAssertEqual(request.environment["CT_RESOLVE_OUT"], out.path)
        let reply = try await ResolveBridge.run(request, runner: runner, timeout: 10)
        XCTAssertEqual(reply, .opened(timeline: "Tiny Acrobatics cut"))
        XCTAssertEqual(try String(contentsOf: out, encoding: .utf8), #"{"OTIO_SCHEMA":"Timeline.1"}"#)
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

    /// The open script itself, run by a plain Lua against a fake Resolve object model (skipped where no `lua` is installed):
    /// the timeline lands in Timelines, the draft's earlier imports move to Timelines/Earlier cuts, the footage to Footage.
    func testOpenScriptFilesTheDraftIntoBins() throws {
        guard let lua = ["/opt/homebrew/bin/lua", "/usr/local/bin/lua", "/usr/bin/lua"].first(where: { FileManager.default.isExecutableFile(atPath: $0) })
        else { throw XCTSkip("no lua here") }
        let (_, dir) = try fakeRunner()
        defer { try? FileManager.default.removeItem(at: dir) }
        let fake = """
        local function folder(n) return { n = n, subs = {}, clips = {}, GetName = function(s) return s.n end,
          GetSubFolderList = function(s) return s.subs end, GetClipList = function(s) return s.clips end } end
        local function clip(n, kind) return { n = n, GetName = function(s) return s.n end, GetClipProperty = function(s, k) return { Type = kind } end } end
        local master, timelines = folder("Master"), folder("Timelines")
        master.subs[1] = timelines
        timelines.clips = { clip("Cut", "Timeline"), clip("Cut (2)", "Timeline"), clip("Cut (2) old", "Timeline"), clip("Other", "Timeline") }
        local current = master
        local pool = {
          GetRootFolder = function() return master end, GetCurrentFolder = function() return current end,
          SetCurrentFolder = function(_, f) current = f; return true end,
          AddSubFolder = function(_, p, n) local f = folder(n); p.subs[#p.subs + 1] = f; return f end,
          ImportTimelineFromFile = function(_, path, o)
            current.clips[#current.clips + 1] = clip(o.timelineName, "Timeline")
            current.clips[#current.clips + 1] = clip("Take A", "Video + Audio")
            return {} end,
          MoveClips = function(_, cs, to) for _, c in ipairs(cs) do print("move\\t" .. c.n .. "\\t" .. to.n) end return true end,
        }
        local names = { "Cut", "Cut (2)", "Cut (2) old", "Other" }
        local project = { GetName = function() return "Tiny edit" end, GetTimelineCount = function() return #names end,
          GetTimelineByIndex = function(_, i) return { GetName = function() return names[i] end } end,
          GetMediaPool = function() return pool end, SetCurrentTimeline = function() return true end }
        local pm = { GetCurrentProject = function() return project end, SaveProject = function() print("current\\t" .. current.n) return true end }
        function Resolve() return { GetProjectManager = function() return pm end } end

        """
        let script = dir.appendingPathComponent("open.lua")
        try (fake + openDraftScript).write(to: script, atomically: true, encoding: .utf8)
        let p = Process()
        p.executableURL = URL(fileURLWithPath: lua)
        p.arguments = [script.path]
        p.environment = ResolveRequest(otioPath: "/x/cut.otio", name: "Cut", project: "Tiny edit", mediaFolder: nil).environment
        let out = Pipe()
        p.standardOutput = out
        try p.run()
        p.waitUntilExit()
        let lines = String(decoding: out.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self).split(separator: "\n").map(String.init)
        XCTAssertEqual(lines, ["move\tCut\tEarlier cuts", "move\tCut (2)\tEarlier cuts", "move\tTake A\tFootage", "current\tMaster", "ok\tCut (3)"])
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
