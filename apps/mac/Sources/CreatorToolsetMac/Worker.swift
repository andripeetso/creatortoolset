// The computer worker: while the window shows a server by its address, this Mac runs that server's video steps for its
// own account in the bundled Node (api/work/computer.ts, started by api/boot.ts with CT_WORKER). The device runner's long
// poll says when a step waits (`{"work": true}`, Relay.swift); the worker claims it itself and ends after 10 minutes with
// nothing to do (exit 0). Exit 3: the server needs a newer app, so the update prompt shows and no worker starts again
// until the app is updated. SIGUSR2 cancels the running step. Never two at once; none while the window shows This Mac.
import AppKit
import Foundation

/// What the worker says it does, from its `[work:status] {…}` lines.
struct WorkStatus: Decodable, Equatable {
    let editId: String
    let edit: String
    var line: String?
    var done: Int64?
    var total: Int64?
    var leftS: Int?
}

/// The worker's environment: the server it works for, this Mac's token there, its own data folder, the bundled ffmpeg
/// first on PATH, the app's export browser and the approved plug-ins. No PORT, HOST, APP_SECRET or CT_LOCAL: it serves nothing.
func workerEnvironment(server: URL, token: String, data: URL, folder: URL, inherited: [String: String],
                       plugins: [String: String], release: [String: String] = [:]) -> [String: String] {
    var env = inherited.filter { ["HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "LANG", "LC_ALL"].contains($0.key) }
    env["PATH"] = folder.appendingPathComponent("runtime").path + ":/usr/bin:/bin:/usr/sbin:/sbin"
    env["NODE_ENV"] = "production"
    env["CT_WORKER"] = server.absoluteString
    env["CT_DEVICE_TOKEN"] = token
    env["DATA_DIR"] = data.path
    env["CT_APP_FOLDER"] = appSupport.path
    // the frame browser of a caption export: the one This Mac's server downloads (Server.swift), never a second copy
    env["PLAYWRIGHT_BROWSERS_PATH"] = appSupport.appendingPathComponent("runtime/chromium").path
    env["CT_EXIT_WITH_PARENT"] = "1"
    env.merge(release, uniquingKeysWith: { $1 })
    env.merge(plugins, uniquingKeysWith: { $1 })
    return env
}

/// The status line of one stdout line, `.some(nil)` for the end of a step, nil for any other line.
func workStatusLine(_ line: Substring) -> WorkStatus?? {
    let tag = "[work:status] "
    guard line.hasPrefix(tag) else { return nil }
    let json = line.dropFirst(tag.count)
    if json == "null" { return .some(nil) }
    return .some(try? JSONDecoder().decode(WorkStatus.self, from: Data(json.utf8)))
}

/// Bytes as the web page says them (LibraryProcessing.tsx gbOf, stepLine): "0 MB", "340 MB", "1.2 GB", "12 GB".
func workBytes(_ n: Int64) -> String {
    if n <= 0 { return "0 MB" }
    let d = Double(n)
    if d >= 1e9 { return String(format: d >= 1e10 ? "%.0f GB" : "%.1f GB", d / 1e9) }
    return "\(max(1, Int((d / 1e6).rounded()))) MB"
}

/// Time left as the web page says it (aboutTime): "under a minute", "about 3 min", "about 1 h 5 min".
func workTimeLeft(_ s: Int) -> String {
    if s < 60 { return "under a minute" }
    let m = Int((Double(s) / 60).rounded())
    if m < 60 { return "about \(m) min" }
    return "about \(m / 60) h" + (m % 60 > 0 ? " \(m % 60) min" : "")
}

/// The menu row's detail: what it does, the bytes and the time left ("340 MB of 1.2 GB, about 3 min left").
func workDetail(_ s: WorkStatus) -> String {
    let bytes = s.total.flatMap { $0 > 0 ? "\(workBytes(s.done ?? 0)) of \(workBytes($0))" : nil }
    let left = s.leftS.map { "\(workTimeLeft($0)) left" }
    return [s.line, bytes, left].compactMap { $0?.isEmpty == false ? $0 : nil }.joined(separator: ", ")
}

/// The Cancel button's verb on the worker's row (Shell.runAgent sends it to the worker, not to a LaunchAgent).
let workCancelVerb = "cancel-work"

/// The menu's row for the step this Mac runs: "Working on <edit>", the bytes and time left, Cancel; it opens the edit.
func workRow(_ s: WorkStatus) -> ActivityRow {
    ActivityRow(id: "work", title: "Working on \(s.edit.isEmpty ? "an edit" : s.edit)", detail: workDetail(s), state: .working,
                href: "/editor/\(s.editId)", actions: [PluginAction(id: "cancel", title: "Cancel", run: workCancelVerb, label: "")],
                progress: s.total.flatMap { $0 > 0 ? min(1, Double(s.done ?? 0) / Double($0)) : nil })
}

@MainActor
final class Worker: ObservableObject {
    /// The work package version the bundled worker runs (apps/captions/contracts/work.ts WORK_V): sent with the long poll.
    static let packageVersion = 1

    /// What runs now, for the menu; nil between steps.
    @Published private(set) var status: WorkStatus?
    /// The server wants a newer app: no worker until the app is updated (the relaunch clears it).
    @Published private(set) var needsUpdate = false
    /// Called once when a worker exits asking for a newer app.
    var onNeedsUpdate: (() -> Void)?
    /// The program and its arguments, run in `folder`: the bundled node and dist/boot.js (a test puts a script here).
    var program: (URL, [String])?
    let folder: URL?
    private var process: Process?
    private var input: Pipe?

    init(folder: URL?) {
        self.folder = folder
        program = folder.map { ($0.appendingPathComponent("bin/node"), ["dist/boot.js"]) }
        NotificationCenter.default.addObserver(forName: NSApplication.willTerminateNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.stop() }
        }
    }

    var isRunning: Bool { process != nil }

    /// Starts a worker for `server` unless one runs, the app needs an update first, or the window shows This Mac (the
    /// server here does its own steps). Whether one runs afterwards.
    @discardableResult
    func start(server: URL, token: String, data: URL, thisMac: Bool,
               plugins: [String: String] = pluginEnvironment(approved: PluginRecord.live.load(), paused: UserDefaults.standard.bool(forKey: pluginsPausedKey))) -> Bool {
        guard !thisMac, !needsUpdate, let folder, let program else { return isRunning }
        guard process == nil else { return true }
        try? FileManager.default.createDirectory(at: data, withIntermediateDirectories: true)
        let p = Process()
        p.executableURL = program.0
        p.arguments = program.1
        p.currentDirectoryURL = folder
        p.environment = workerEnvironment(server: server, token: token, data: data, folder: folder,
                                          inherited: ProcessInfo.processInfo.environment, plugins: plugins,
                                          release: releaseEnv(Bundle.main.infoDictionary))
        // stdin stays open while the app runs (CT_EXIT_WITH_PARENT); stdout carries the status lines
        let stdin = Pipe(), output = Pipe()
        p.standardInput = stdin
        p.standardOutput = output
        p.standardError = output
        nonisolated(unsafe) var rest = Data()   // the handler runs one call at a time
        output.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            if data.isEmpty { handle.readabilityHandler = nil; return }
            rest.append(data)
            while let nl = rest.firstIndex(of: UInt8(ascii: "\n")) {
                let line = String(decoding: rest[rest.startIndex..<nl], as: UTF8.self)
                rest = Data(rest[rest.index(after: nl)...])
                if let status = workStatusLine(line[...]) {
                    Task { @MainActor in if self?.process === p { self?.status = status } }
                } else if !line.isEmpty {
                    AppLog.write("worker: \(line)")
                }
            }
        }
        p.terminationHandler = { [weak self] ended in
            Task { @MainActor in self?.ended(ended) }
        }
        do {
            try p.run()
        } catch {
            AppLog.write("worker: could not start node: \(error.localizedDescription)")
            return false
        }
        process = p
        input = stdin
        AppLog.write("worker: started pid \(p.processIdentifier) for \(server.absoluteString)")
        return true
    }

    /// Cancel in the menu: the running step stops, its download within a moment, and ends Stopped.
    func cancel() {
        guard let p = process, p.isRunning else { return }
        kill(p.processIdentifier, SIGUSR2)
    }

    /// With the runner and on quit, as LocalServer.stop: stdin closed, half a second, SIGTERM, up to 10 s, SIGKILL.
    func stop() {
        guard let p = process else { return }
        process = nil
        status = nil
        try? input?.fileHandleForWriting.close()
        input = nil
        let grace = Date().addingTimeInterval(0.5)
        while p.isRunning && Date() < grace { usleep(20_000) }
        if p.isRunning { p.terminate() }
        let deadline = Date().addingTimeInterval(10)
        while p.isRunning && Date() < deadline { usleep(50_000) }
        if p.isRunning {
            kill(p.processIdentifier, SIGKILL)
            p.waitUntilExit()
        }
    }

    private func ended(_ p: Process) {
        guard process === p else { return }   // stopped on purpose: stop() already let it go
        process = nil
        input = nil
        status = nil
        AppLog.write("worker: ended (\(p.terminationStatus))")
        if p.terminationReason == .exit && p.terminationStatus == 3 {
            needsUpdate = true
            onNeedsUpdate?()
        }
    }
}
