// The server on this Mac: the app starts Resources/server/bin/node dist/boot.js (build-app.sh puts it there),
// waits for /api/health, restarts it after a crash (1, 2, 4… s; five crashes in five minutes stops trying),
// writes its output to ~/Library/Logs/Creator Toolset Server.log and stops it on quit. A build without the
// server (`swift run`) or the "site" choice in Mac settings leaves it off: the window opens a remote site.
import AppKit
import Darwin
import Foundation
import Security

let defaultServerPort = 43128

/// Seconds to wait before restarting after these crashes, or nil after five in five minutes (stop trying).
func restartDelay(crashes: [Date], now: Date) -> TimeInterval? {
    let recent = crashes.filter { now.timeIntervalSince($0) < 300 }
    if recent.count >= 5 { return nil }
    return min(60, pow(2, Double(max(recent.count - 1, 0))))
}

/// The server's log: the child's stdout and stderr, plus the app's notes about it. At 10 MB it becomes `.1`.
enum ServerLog {
    static let path = NSHomeDirectory() + "/Library/Logs/Creator Toolset Server.log"
    private static let queue = DispatchQueue(label: "com.creatortoolset.mac.server-log")

    static func append(_ data: Data) {
        guard !data.isEmpty else { return }
        queue.async {
            rotate(path, over: 10_000_000)
            AppLog.append(data, to: path)
        }
    }

    static func note(_ line: String) {
        append(Data("\(ISO8601DateFormatter().string(from: Date())) [app] \(line)\n".utf8))
    }

    /// The file past `limit` bytes becomes `<path>.1` (replacing the older one); the next write starts a new file.
    static func rotate(_ path: String, over limit: Int) {
        let fm = FileManager.default
        guard let size = (try? fm.attributesOfItem(atPath: path))?[.size] as? Int, size > limit else { return }
        try? fm.removeItem(atPath: path + ".1")
        try? fm.moveItem(atPath: path, toPath: path + ".1")
    }
}

/// The path of a running process's program (to tell our own node from another program before stopping it).
func processPath(_ pid: pid_t) -> String? {
    var buffer = [CChar](repeating: 0, count: 4 * Int(MAXPATHLEN))
    return proc_pidpath(pid, &buffer, UInt32(buffer.count)) > 0 ? String(cString: buffer) : nil
}

@MainActor
final class LocalServer: ObservableObject {
    /// off: not started or stopped on purpose; failed: it can't run, with what to tell the person.
    enum State: Equatable {
        case off, starting, running
        case failed(String)
    }

    @Published private(set) var state = State.off
    /// Called each time the server answers its health check after a start.
    var onReady: (() -> Void)?

    /// Resources/server inside the app, when this build has one.
    static let folder: URL? = Bundle.main.resourceURL.map { $0.appendingPathComponent("server") }
        .flatMap { FileManager.default.isExecutableFile(atPath: $0.appendingPathComponent("bin/node").path) ? $0 : nil }
    static let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        .appendingPathComponent("Creator Toolset")
    private static let vault = "com.creatortoolset.mac.server"

    private let portKey = "serverPort"
    private var process: Process?
    private var input: Pipe?
    private var stopping = false
    private var crashes: [Date] = []

    init() {
        NotificationCenter.default.addObserver(forName: NSApplication.willTerminateNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.stop() }
        }
    }

    /// Mac settings can change it (stop first); saved phone and browser addresses carry it, so it never hops by itself.
    var port: Int {
        get {
            let saved = UserDefaults.standard.integer(forKey: portKey)
            return (1024...65535).contains(saved) ? saved : defaultServerPort
        }
        set { UserDefaults.standard.set(newValue, forKey: portKey) }
    }

    var url: URL { URL(string: "http://127.0.0.1:\(port)")! }

    /// The data folder (DATA_DIR). Moving it is a later Mac setting; the default is in Application Support.
    var dataDir: URL {
        UserDefaults.standard.string(forKey: "dataFolder").map { URL(fileURLWithPath: $0) }
            ?? Self.support.appendingPathComponent("data")
    }

    private var pidFile: URL { dataDir.appendingPathComponent("server.pid") }

    func start() {
        guard process == nil, let folder = Self.folder else { return }
        stopping = false
        state = .starting
        Task {
            if let problem = await clearPort() {
                ServerLog.note(problem)
                state = .failed(problem)
                return
            }
            launch(folder)
        }
    }

    /// On quit or when switched off: close its stdin (CT_EXIT_WITH_PARENT), SIGTERM, up to 10 s, then SIGKILL.
    func stop() {
        stopping = true
        guard let p = process else { return }
        try? input?.fileHandleForWriting.close()
        p.terminate()
        let deadline = Date().addingTimeInterval(10)
        while p.isRunning && Date() < deadline { usleep(50_000) }
        if p.isRunning {
            kill(p.processIdentifier, SIGKILL)
            p.waitUntilExit()
        }
        ServerLog.note("stopped")
        process = nil
        input = nil
        try? FileManager.default.removeItem(at: pidFile)
        state = .off
    }

    private struct Health: Decodable {
        let environment: String?
    }

    /// nil = nothing answers on the port; a Health with no environment = something that isn't our server.
    private func health() async -> Health? {
        var request = URLRequest(url: url.appendingPathComponent("api/health"))
        request.timeoutInterval = 2
        guard let (data, response) = try? await URLSession.shared.data(for: request) else { return nil }
        guard (response as? HTTPURLResponse)?.statusCode == 200 else { return Health(environment: nil) }
        return (try? JSONDecoder().decode(Health.self, from: data)) ?? Health(environment: nil)
    }

    /// The port must be free. Our own server left from a crash (same data folder, a node of this app) is stopped;
    /// anything else is reported, never worked around with another port (saved addresses carry the port).
    private func clearPort() async -> String? {
        guard let answer = await health() else { return nil }
        let file = try? Data(contentsOf: dataDir.appendingPathComponent("environment.json"))
        let ours = file.flatMap { try? JSONDecoder().decode([String: String].self, from: $0) }?["id"]   // api/boot.ts environmentOf
        let pid = (try? String(contentsOf: pidFile, encoding: .utf8)).flatMap { pid_t($0.trimmingCharacters(in: .whitespacesAndNewlines)) }
        guard let theirs = answer.environment, theirs == ours, let pid,
              processPath(pid)?.hasSuffix("/server/bin/node") == true else {
            return "Port \(port) is in use by another program. Change the port in Mac settings."
        }
        ServerLog.note("stopping the server left from an earlier run (pid \(pid))")
        kill(pid, SIGTERM)
        for _ in 0..<50 {
            if await health() == nil { return nil }
            try? await Task.sleep(for: .milliseconds(200))
        }
        kill(pid, SIGKILL)
        try? await Task.sleep(for: .milliseconds(500))
        return nil
    }

    private func launch(_ folder: URL) {
        guard process == nil, !stopping else { return }
        guard let secret = appSecret() else {
            state = .failed("The Keychain did not keep the server's secret")
            return
        }
        let fm = FileManager.default
        try? fm.createDirectory(at: dataDir, withIntermediateDirectories: true)
        let p = Process()
        p.executableURL = folder.appendingPathComponent("bin/node")
        p.arguments = ["dist/boot.js"]
        // runtime/ffmpeg, runtime/fingerprints, dist/public and the fonts resolve from here
        p.currentDirectoryURL = folder
        let inherited = ProcessInfo.processInfo.environment
        var env = inherited.filter { ["HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "LANG", "LC_ALL"].contains($0.key) }
        // ffprobe is called by name: the bundled one comes first
        env["PATH"] = folder.appendingPathComponent("runtime").path + ":/usr/bin:/bin:/usr/sbin:/sbin"
        env["NODE_ENV"] = "production"
        env["PORT"] = String(port)
        env["HOST"] = "127.0.0.1"
        env["DATA_DIR"] = dataDir.path
        env["APP_SECRET"] = secret
        env["PLAYWRIGHT_BROWSERS_PATH"] = Self.support.appendingPathComponent("runtime/chromium").path
        env["CT_LOCAL"] = "1"
        env["CT_EXIT_WITH_PARENT"] = "1"
        p.environment = env
        // stdin stays open while the app runs: a Finder launch's /dev/null would end the server at once
        let stdin = Pipe(), output = Pipe()
        p.standardInput = stdin
        p.standardOutput = output
        p.standardError = output
        output.fileHandleForReading.readabilityHandler = { handle in
            let data = handle.availableData
            if data.isEmpty { handle.readabilityHandler = nil } else { ServerLog.append(data) }
        }
        p.terminationHandler = { [weak self] ended in
            Task { @MainActor in self?.ended(ended) }
        }
        do {
            try p.run()
        } catch {
            ServerLog.note("could not start node: \(error.localizedDescription)")
            state = .failed("The server could not start. Open server log")
            return
        }
        process = p
        input = stdin
        try? String(p.processIdentifier).write(to: pidFile, atomically: true, encoding: .utf8)
        ServerLog.note("started pid \(p.processIdentifier) on port \(port)")
        Task { await waitForHealth(p) }
    }

    /// Polls /api/health every 200 ms for up to 30 s; no answer by then counts as a crash.
    private func waitForHealth(_ p: Process) async {
        for _ in 0..<150 {
            guard p === process, p.isRunning else { return }
            if await health()?.environment != nil {
                guard p === process else { return }
                state = .running
                onReady?()
                return
            }
            try? await Task.sleep(for: .milliseconds(200))
        }
        guard p === process else { return }
        ServerLog.note("no answer on /api/health after 30 s")
        p.terminate()
    }

    private func ended(_ p: Process) {
        guard p === process else { return }   // stop() already handled it
        process = nil
        input = nil
        try? FileManager.default.removeItem(at: pidFile)
        if stopping { return }
        ServerLog.note("the server ended (status \(p.terminationStatus))")
        crashes.append(Date())
        guard let delay = restartDelay(crashes: crashes, now: Date()) else {
            state = .failed("The server stopped. Open server log")
            return
        }
        state = .starting
        Task {
            try? await Task.sleep(for: .seconds(delay))
            if !stopping { start() }
        }
    }

    /// APP_SECRET: made once (32 random bytes) and kept in the Keychain. The server makes the owner account with it.
    private func appSecret() -> String? {
        if let saved = DeviceVault.token(for: "APP_SECRET", service: Self.vault) { return saved }
        var bytes = [UInt8](repeating: 0, count: 32)
        guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else { return nil }
        let secret = bytes.map { String(format: "%02x", $0) }.joined()
        return DeviceVault.save(secret, for: "APP_SECRET", service: Self.vault) ? secret : nil
    }
}
