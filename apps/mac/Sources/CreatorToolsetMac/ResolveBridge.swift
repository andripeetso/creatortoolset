// The Resolve bridge: opens an edit's OTIO draft in DaVinci Resolve as a new timeline, through Resolve's own script
// runner (fuscript, Lua: no Python). Open in Resolve on a draft (Editors.swift) starts a closed Resolve and waits for it
// (untilOpen). The device step is off until Resolve is installed (Logic.swift resolveScriptRunner), and the
// server hands it the resolve step only while the account has a Resolve pack (api/devices.ts). Protocol: the request
// goes to the script as environment variables; the script prints one line on stdout, "ok<TAB>timeline" or
// "error<TAB>why". A run that does not answer in time is stopped (Resolve hangs when no project is open).
import Foundation

struct ResolveRequest: Equatable {
    /// The draft to open: an .otio file on this Mac.
    let otioPath: String
    /// The timeline's name. A name Resolve already has gets " (2)", " (3)"…, so no timeline is replaced.
    let name: String
    /// The edit's own Resolve project, by name: loaded, or made when it doesn't exist. The project open before is saved
    /// first (its contents are not changed); the edit's project is then the open one.
    let project: String
    /// Where the draft's media is, for clips Resolve can't find in its pool (the folder the .otio's files sit in).
    var mediaFolder: String? = nil
    /// The draft's frame rate and frame size. A project made here takes them (Resolve fixes a project's size when it is
    /// made); nil leaves Resolve's own settings.
    var frameRate: String? = nil
    var width: Int? = nil
    var height: Int? = nil

    var environment: [String: String] {
        ["CT_RESOLVE_OTIO": otioPath, "CT_RESOLVE_NAME": name, "CT_RESOLVE_PROJECT": project,
         "CT_RESOLVE_MEDIA": mediaFolder ?? "", "CT_RESOLVE_FPS": frameRate ?? "",
         "CT_RESOLVE_WIDTH": width.map(String.init) ?? "", "CT_RESOLVE_HEIGHT": height.map(String.init) ?? ""]
    }
}

/// The draft's timeline taken back from Resolve after the person changed it there: the one Open in Resolve made (by its
/// name, or "name (2)"… when Resolve numbered it), written as OTIO for the server's next round (api/editor/sent-back.ts).
struct ResolveTakeBack: Equatable {
    let name: String
    let project: String
    let outPath: String

    var environment: [String: String] { ["CT_RESOLVE_NAME": name, "CT_RESOLVE_PROJECT": project, "CT_RESOLVE_OUT": outPath] }
}

enum ResolveReply: Equatable {
    case opened(timeline: String)
    case failed(String)

    /// How the script's answer starts when Resolve has not loaded (or takes no scripts).
    static let notOpen = "Resolve isn't open"

    /// The script's last answer line; nil when it printed none (Resolve crashed or never answered).
    static func parse(_ output: String) -> ResolveReply? {
        for line in output.split(whereSeparator: \.isNewline).reversed() {
            if line.hasPrefix("ok\t") { return .opened(timeline: String(line.dropFirst(3))) }
            if line.hasPrefix("error\t") { return .failed(String(line.dropFirst(6))) }
        }
        return nil
    }
}

enum ResolveBridgeError: Error, Equatable {
    case notInstalled
    case timedOut
    case noReply(status: Int32)
}

enum ResolveBridge {
    /// Long enough for a big draft to import; a run past it is stopped.
    static let defaultTimeout: TimeInterval = 120

    /// Resolve's script runner on this Mac, or nil when Resolve isn't installed (the helper stays off).
    static var runner: URL? {
        resolveScriptRunner(exists: { FileManager.default.isExecutableFile(atPath: $0) }).map { URL(fileURLWithPath: $0) }
    }

    /// Opens the draft in the installed Resolve.
    static func open(_ request: ResolveRequest, timeout: TimeInterval = defaultTimeout) async throws -> ResolveReply {
        guard let runner else { throw ResolveBridgeError.notInstalled }
        return try await run(request, runner: runner, timeout: timeout)
    }

    /// The first answer that is not "Resolve isn't open", trying again every `pause` seconds for up to `waiting` seconds:
    /// a Resolve just started takes scripts only once it has loaded. Its last answer when the time is up.
    static func untilOpen(waiting: TimeInterval, pause: TimeInterval = 3,
                          _ attempt: () async throws -> ResolveReply) async throws -> ResolveReply {
        let deadline = Date().addingTimeInterval(waiting)
        while true {
            let reply = try await attempt()
            guard case .failed(let why) = reply, why.hasPrefix(ResolveReply.notOpen), Date() < deadline else { return reply }
            try await Task.sleep(nanoseconds: UInt64(pause * 1_000_000_000))
        }
    }

    /// Runs the open script with `runner` (Resolve's fuscript, or a fake in the tests) and reads its answer.
    static func run(_ request: ResolveRequest, runner: URL, timeout: TimeInterval) async throws -> ResolveReply {
        try await run(script: openDraftScript, environment: request.environment, runner: runner, timeout: timeout)
    }

    /// Runs the take-back script: the draft's timeline as Resolve has it now, written as OTIO to `request.outPath`.
    static func run(_ request: ResolveTakeBack, runner: URL, timeout: TimeInterval) async throws -> ResolveReply {
        try await run(script: takeBackScript, environment: request.environment, runner: runner, timeout: timeout)
    }

    private static func run(script text: String, environment: [String: String], runner: URL, timeout: TimeInterval) async throws -> ResolveReply {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("resolve-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let script = dir.appendingPathComponent("resolve.lua")
        try text.write(to: script, atomically: true, encoding: .utf8)

        let process = Process()
        process.executableURL = runner
        process.arguments = ["-l", "lua", script.path]
        process.environment = ProcessInfo.processInfo.environment.merging(environment) { _, new in new }
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = FileHandle.nullDevice
        process.standardInput = FileHandle.nullDevice
        let stopped = Flag()
        try process.run()
        // ponytail: one timer per run, stops the process and lets the pipe close; a Resolve child that keeps the pipe open would hold the read.
        let timer = DispatchWorkItem {
            if process.isRunning { stopped.set(); process.terminate() }
        }
        DispatchQueue.global().asyncAfter(deadline: .now() + timeout, execute: timer)
        let handle = pipe.fileHandleForReading
        let output = await Task.detached { handle.readDataToEndOfFile() }.value
        process.waitUntilExit()
        timer.cancel()

        if stopped.value { throw ResolveBridgeError.timedOut }
        guard let reply = ResolveReply.parse(String(decoding: output, as: UTF8.self)) else {
            throw ResolveBridgeError.noReply(status: process.terminationStatus)
        }
        return reply
    }
}

/// A flag set from the timer's thread and read after the run.
private final class Flag: @unchecked Sendable {
    private let lock = NSLock()
    private var on = false
    func set() { lock.lock(); on = true; lock.unlock() }
    var value: Bool { lock.lock(); defer { lock.unlock() }; return on }
}

/// The script Resolve runs (Resolve's own Lua API, as its bundled examples use it). It only ever adds a timeline to the
/// edit's project: a name taken is numbered, and no other timeline is touched. Clips missing from the pool are looked
/// for in the media folder.
private let openDraftScript = """
-- Opens one OTIO draft in DaVinci Resolve as a new timeline of the edit's project. Inputs: the environment variables
-- CT_RESOLVE_OTIO (the .otio file), CT_RESOLVE_NAME (the timeline's name), CT_RESOLVE_PROJECT (the project's name) and
-- CT_RESOLVE_MEDIA (optional: the folder the draft's media is in). Prints one answer line.
resolve = Resolve()
if not resolve then print("error\\tResolve isn't open, or external scripting is off: Preferences -> System -> General -> External scripting: Local") return end
local otio = os.getenv("CT_RESOLVE_OTIO")
local name = os.getenv("CT_RESOLVE_NAME") or "Draft"
local wanted = os.getenv("CT_RESOLVE_PROJECT") or ""
local media = os.getenv("CT_RESOLVE_MEDIA") or ""
if not otio or otio == "" then print("error\\tno draft file given") return end
local pm = resolve:GetProjectManager()
-- the edit's project is loaded, or made; whatever project was open is saved first, then the edit's project is open
local project = nil
local current = pm:GetCurrentProject()
if wanted == "" then
  project = current
elseif current and current:GetName() == wanted then
  project = current
else
  if current then pm:SaveProject() end
  project = pm:LoadProject(wanted)
  if not project then
    project = pm:CreateProject(wanted)
    local fps, w, h = os.getenv("CT_RESOLVE_FPS") or "", os.getenv("CT_RESOLVE_WIDTH") or "", os.getenv("CT_RESOLVE_HEIGHT") or ""
    if project and fps ~= "" then
      project:SetSetting("timelineFrameRate", fps)
      project:SetSetting("timelinePlaybackFrameRate", fps)
    end
    if project and w ~= "" and h ~= "" then
      project:SetSetting("timelineResolutionWidth", w)
      project:SetSetting("timelineResolutionHeight", h)
    end
  end
end
if not project then print("error\\tResolve wouldn't open or make the project " .. wanted) return end
local taken = {}
for i = 1, project:GetTimelineCount() do taken[project:GetTimelineByIndex(i):GetName()] = true end
local title, k = name, 1
while taken[title] do k = k + 1; title = name .. " (" .. k .. ")" end
local pool = project:GetMediaPool()
local options = { timelineName = title, importSourceClips = true }
if media ~= "" then options.sourceClipsPath = media end
local timeline = pool:ImportTimelineFromFile(otio, options)
if not timeline then print("error\\tResolve refused " .. otio) return end
project:SetCurrentTimeline(timeline)
pm:SaveProject()
print("ok\\t" .. title)
"""

/// The take-back script: the edit's project (loaded when another is open, which is saved first), then the timeline open
/// now when it is the draft's, else the newest of the draft's (its name, or its name numbered), exported as OTIO. Nothing in
/// Resolve is changed.
private let takeBackScript = """
-- Writes the draft's timeline as Resolve has it now to CT_RESOLVE_OUT (OTIO). Inputs: CT_RESOLVE_NAME (the name Open in
-- Resolve gave it), CT_RESOLVE_PROJECT (the edit's project). Prints one answer line.
resolve = Resolve()
if not resolve then print("error\\tResolve isn't open, or external scripting is off: Preferences -> System -> General -> External scripting: Local") return end
local name = os.getenv("CT_RESOLVE_NAME") or "Draft"
local wanted = os.getenv("CT_RESOLVE_PROJECT") or ""
local out = os.getenv("CT_RESOLVE_OUT") or ""
if out == "" then print("error\\tno file to write") return end
local pm = resolve:GetProjectManager()
local project = pm:GetCurrentProject()
if wanted ~= "" and not (project and project:GetName() == wanted) then
  if project then pm:SaveProject() end
  project = pm:LoadProject(wanted)
end
if not project then print("error\\tResolve has no project " .. wanted .. ": open the draft in Resolve first") return end
-- 1 for the name itself, k for "name (k)", nil for any other timeline
local function number(t)
  local n = t:GetName()
  if n == name then return 1 end
  if n:sub(1, #name + 2) == name .. " (" then return tonumber(n:sub(#name + 3):match("^(%d+)%)$")) end
  return nil
end
local timeline = project:GetCurrentTimeline()
if not (timeline and number(timeline)) then
  timeline = nil
  local best = 0
  for i = 1, project:GetTimelineCount() do
    local t = project:GetTimelineByIndex(i)
    local k = number(t)
    if k and k >= best then best, timeline = k, t end
  end
end
if not timeline then print("error\\tResolve's project " .. project:GetName() .. " has no timeline " .. name .. ": open the draft in Resolve first") return end
if not resolve.EXPORT_OTIO or not timeline:Export(out, resolve.EXPORT_OTIO) then print("error\\tResolve wouldn't write " .. timeline:GetName() .. " as OTIO (it needs Resolve 18.5 or newer)") return end
print("ok\\t" .. timeline:GetName())
"""
