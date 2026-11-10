// The server on this Mac: the app starts Resources/server/bin/node dist/boot.js (build-app.sh puts it there),
// waits for /api/health, restarts it after a crash (1, 2, 4… s; five crashes in five minutes stops trying),
// writes its output to ~/Library/Logs/Creator Toolset Server.log and stops it on quit. A build without the
// server (`swift run`), or another server picked in Servers, leaves it off.
import AppKit
import Darwin
import Foundation
import Security

/// ~/Library/Application Support/Creator Toolset: the default data folder, Chromium, the remote sites' relay folders.
let appSupport = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
    .appendingPathComponent("Creator Toolset" + AppIdentity.tag())

/// The disk a data folder lives on that isn't connected: "X" for /Volumes/X/… while no volume is mounted there.
func missingDisk(_ path: String, mounted: [String]) -> String? {
    let parts = URL(fileURLWithPath: path).standardized.pathComponents   // ["/", "Volumes", "X", …]
    guard parts.count > 2, parts[1] == "Volumes" else { return nil }
    return mounted.contains("/Volumes/" + parts[2]) ? nil : parts[2]
}

func mountedVolumes() -> [String] {
    (FileManager.default.mountedVolumeURLs(includingResourceValuesForKeys: nil, options: []) ?? []).map { $0.standardized.path }
}

/// Free bytes on the disk holding `url` (its nearest existing folder), as macOS counts them for important files.
func freeBytes(_ url: URL) -> Int64? {
    var at = url
    while !FileManager.default.fileExists(atPath: at.path) && at.pathComponents.count > 1 { at.deleteLastPathComponent() }
    return (try? at.resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey]))?.volumeAvailableCapacityForImportantUsage
}

/// Under 10 GB free on the data disk: the menu and This Mac say so (video fills disks).
let lowSpaceBytes: Int64 = 10_000_000_000

/// Files and bytes under a folder (what a move must carry over, checked after the copy).
struct FolderStats: Equatable {
    var files = 0
    var bytes: Int64 = 0
}

func folderStats(_ url: URL) -> FolderStats {
    var stats = FolderStats()
    let keys: [URLResourceKey] = [.isRegularFileKey, .fileSizeKey]
    guard let walk = FileManager.default.enumerator(at: url, includingPropertiesForKeys: keys) else { return stats }
    for case let file as URL in walk {
        // Finder's .DS_Store may sit in the empty folder a move goes to: never counted
        guard file.lastPathComponent != ".DS_Store", let values = try? file.resourceValues(forKeys: Set(keys)), values.isRegularFile == true else { continue }
        stats.files += 1
        stats.bytes += Int64(values.fileSize ?? 0)
    }
    return stats
}

/// Why `dest` can't take the data folder, or nil: it must be another folder, empty (Finder's .DS_Store aside),
/// on a connected disk with room for the data plus 10 %.
func moveProblem(from: URL, to dest: URL, entries: [String], size: Int64, free: Int64?) -> String? {
    let a = from.standardized.path, b = dest.standardized.path
    if a == b || b.hasPrefix(a + "/") || a.hasPrefix(b + "/") { return "Pick a folder outside the current data folder." }
    if !entries.filter({ $0 != ".DS_Store" }).isEmpty { return "Pick an empty folder." }
    if let disk = missingDisk(b, mounted: mountedVolumes()) { return "\(disk) isn't connected." }
    if let free, free < size + size / 10 { return "Not enough room there: it needs \(bytesText(size + size / 10))." }
    return nil
}

/// Whether the old copy of a move may go to the Trash: never the live data folder, nor one inside or around it.
func oldCopyRemovable(_ old: URL, live: URL) -> Bool {
    let a = old.standardized.path, b = live.standardized.path
    return a != b && !a.hasPrefix(b + "/") && !b.hasPrefix(a + "/")
}

func bytesText(_ n: Int64) -> String {
    ByteCountFormatter.string(fromByteCount: n, countStyle: .file)
}

/// What the person reads when the server cannot start; the technical reason is in the server log.
let serverStartFailed = "Creator Toolset could not start. Try again, or restart your Mac."

/// Seconds to wait before restarting after these crashes, or nil after five in five minutes (stop trying).
func restartDelay(crashes: [Date], now: Date) -> TimeInterval? {
    let recent = crashes.filter { now.timeIntervalSince($0) < 300 }
    if recent.count >= 5 { return nil }
    return min(60, pow(2, Double(max(recent.count - 1, 0))))
}

/// The server's log: the child's stdout and stderr, plus the app's notes about it. At 10 MB it becomes `.1`.
enum ServerLog {
    static let path = NSHomeDirectory() + "/Library/Logs/Creator Toolset\(AppIdentity.tag()) Server.log"
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

/// CT_CHANNEL=release and CT_VERSION for the bundled server, only in a release build: build-app.sh writes CTChannel into
/// Info.plist when it signs with SIGN_IDENTITY. Dev runs, `swift run` and ad-hoc builds get nothing.
func releaseEnv(_ info: [String: Any]?) -> [String: String] {
    guard info?["CTChannel"] as? String == "release" else { return [:] }
    return ["CT_CHANNEL": "release", "CT_VERSION": info?["CFBundleShortVersionString"] as? String ?? ""]
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
    private static let vault = AppIdentity.keychain("server")
    /// The owner account the server makes on its first start (api/users.ts bootstrap, ADMIN_USERNAME unset).
    static let ownerName = "admin"

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

    /// This Mac can change it (stop first); saved phone and browser addresses carry it, so it never hops by itself.
    var port: Int {
        get {
            let saved = UserDefaults.standard.integer(forKey: portKey)
            return (1024...65535).contains(saved) ? saved : AppIdentity.port()
        }
        set { UserDefaults.standard.set(newValue, forKey: portKey) }
    }

    var url: URL { URL(string: "http://127.0.0.1:\(port)")! }

    static let defaultDataDir = appSupport.appendingPathComponent("data")

    /// The data folder (DATA_DIR): Application Support by default, anywhere after Move… (This Mac → Data location).
    var dataDir: URL {
        UserDefaults.standard.string(forKey: "dataFolder").map { URL(fileURLWithPath: $0) } ?? Self.defaultDataDir
    }

    /// The copy a move to another disk left behind, until Remove old copy.
    var oldDataDir: URL? {
        UserDefaults.standard.string(forKey: "oldDataFolder").map { URL(fileURLWithPath: $0) }
    }

    /// Why the server can't start on its data folder, or nil. Never a fresh empty folder in its place: that would look
    /// like lost data (and on a missing disk it would land on the Mac's own disk under /Volumes).
    func dataProblem() -> String? {
        if let disk = missingDisk(dataDir.path, mounted: mountedVolumes()) {
            return "Your data is on \(disk), which isn't connected. Connect it, or choose another folder in This Mac → Data location."
        }
        if dataDir != Self.defaultDataDir && !FileManager.default.fileExists(atPath: dataDir.path) {
            return "Your data folder \(dataDir.path) is gone. Choose another folder in This Mac → Data location."
        }
        return nil
    }

    /// "Access from other devices" (This Mac): on = the server listens on every interface (phones, the LAN);
    /// off = this Mac only. The server lets another device sign in only once the owner has a password of their own.
    var otherDevices: Bool {
        get { UserDefaults.standard.bool(forKey: "serverOtherDevices") }
        set { UserDefaults.standard.set(newValue, forKey: "serverOtherDevices") }
    }

    /// The owner's password, when they chose one (to turn on other devices). Until then it is APP_SECRET.
    var hasOwnerPassword: Bool { DeviceVault.token(for: "owner-password", service: Self.vault) != nil }

    /// The passwords to sign the window in with, newest first. Nothing here is ever shown or logged.
    func ownerPasswords() -> [String] {
        [DeviceVault.token(for: "owner-password", service: Self.vault), appSecret()].compactMap { $0 }
    }

    func saveOwnerPassword(_ password: String) -> Bool {
        DeviceVault.save(password, for: "owner-password", service: Self.vault)
    }

    func forgetOwnerPassword() {
        DeviceVault.remove(for: "owner-password", service: Self.vault)
    }

    private var pidFile: URL { dataDir.appendingPathComponent("server.pid") }

    /// Try again after a failure: the crashes so far no longer hold back the restart.
    func retry() {
        crashes = []
        start()
    }

    func start() {
        guard process == nil, let folder = Self.folder else { return }
        stopping = false
        if let problem = dataProblem() {
            ServerLog.note(problem)
            state = .failed(problem)
            return
        }
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
            return "Port \(port) is in use by another program. Change the port in This Mac."
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
            ServerLog.note("the Keychain did not keep the server's secret")
            state = .failed(serverStartFailed)
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
        env["HOST"] = otherDevices ? "0.0.0.0" : "127.0.0.1"
        env["DATA_DIR"] = dataDir.path
        env["APP_SECRET"] = secret
        env["PLAYWRIGHT_BROWSERS_PATH"] = appSupport.appendingPathComponent("runtime/chromium").path
        env["CT_LOCAL"] = "1"
        env["CT_APP_FOLDER"] = appSupport.path
        env["CT_EXIT_WITH_PARENT"] = "1"
        env.merge(releaseEnv(Bundle.main.infoDictionary), uniquingKeysWith: { $1 })
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
            state = .failed(serverStartFailed)
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
            state = .failed(serverStartFailed)
            return
        }
        state = .starting
        Task {
            try? await Task.sleep(for: .seconds(delay))
            if !stopping { start() }
        }
    }

    // MARK: data location

    /// A folder for the data without copying anything (the old one is on a disk that's gone): the server starts there.
    func useFolder(_ url: URL) {
        stop()
        UserDefaults.standard.set(url.path, forKey: "dataFolder")
        start()
    }

    /// Move… : stop the server, move the data folder into `dest` (a rename on the same disk; else a copy with ditto,
    /// which keeps the files' modes, checked by file count and size), point the app at it and start again. A copy keeps
    /// the old folder until Remove old copy. Returns what went wrong, or nil.
    // ponytail: copies caches too (library/cache, scratch); skip them if moves of big libraries get slow
    func move(to dest: URL) async -> String? {
        let from = dataDir
        let fm = FileManager.default
        let entries = (try? fm.contentsOfDirectory(atPath: dest.path)) ?? []
        if let problem = moveProblem(from: from, to: dest, entries: entries, size: 0, free: nil) { return problem }
        // stopped before counting: a running server writes (its pid file, users.json) and the copy would never match
        stop()
        state = .starting
        let before = await Task.detached { folderStats(from) }.value
        if let problem = moveProblem(from: from, to: dest, entries: entries, size: before.bytes, free: freeBytes(dest)) {
            start()
            return problem
        }
        let volume = { (u: URL) in (try? u.resourceValues(forKeys: [.volumeIdentifierKey]))?.volumeIdentifier as? NSObject }
        var copied = false
        if let a = volume(from), let b = volume(dest), a.isEqual(b) {
            do {
                try fm.removeItem(at: dest)
                try fm.moveItem(at: from, to: dest)
            } catch {
                start()
                return "Could not move it: \(error.localizedDescription)"
            }
        } else {
            let ok = await Task.detached { () -> Bool in
                let ditto = Process()
                ditto.executableURL = URL(fileURLWithPath: "/usr/bin/ditto")
                ditto.arguments = [from.path, dest.path]
                guard (try? ditto.run()) != nil else { return false }
                ditto.waitUntilExit()
                return ditto.terminationStatus == 0 && folderStats(dest) == before
            }.value
            guard ok else {
                start()
                return "The copy didn't match the data folder. Nothing changed; the copy in \(dest.path) can go."
            }
            copied = true
        }
        UserDefaults.standard.set(dest.path, forKey: "dataFolder")
        UserDefaults.standard.set(copied ? from.path : nil, forKey: "oldDataFolder")
        ServerLog.note("data folder moved")
        start()
        return nil
    }

    /// Remove old copy: the folder a move copied from goes to the Trash, unless the server uses it again (Choose
    /// another folder… picked it when the new disk was gone).
    func removeOldCopy() {
        if let old = oldDataDir, oldCopyRemovable(old, live: dataDir) { try? FileManager.default.trashItem(at: old, resultingItemURL: nil) }
        UserDefaults.standard.set(nil, forKey: "oldDataFolder")
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
