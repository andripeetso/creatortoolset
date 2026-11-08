// What this Mac reports to the site (the Mac relay report; MacReport in apps/captions/contracts/providers.ts):
// the coding CLIs it finds and their versions, and its Claude and Codex config folders. Read only. Every function takes the home folder so the tests can use a temp one.
import Foundation

/// Every driver the report lists, in contracts/providers.ts order.
let reportDrivers: [(id: String, label: String)] = [
    ("codex", "Codex"), ("claude", "Claude"), ("cursor", "Cursor"), ("grok", "Grok"), ("opencode", "OpenCode"),
    ("antigravity", "Antigravity"), ("muse", "Muse Code"), ("pi", "Pi"),
]

/// Where each CLI may be (the Mac relay BINARIES): the official install on PATH or in the usual folders below.
/// Claude is the `claude` command-line tool its owner installed and signed in to, never a copy inside another app.
let driverBinaries: [String: [String]] = [
    "claude": ["claude"], "codex": ["codex", "/opt/homebrew/bin/codex"], "grok": ["grok", "~/.grok/bin/grok"], "cursor": ["cursor-agent"],
    "opencode": ["opencode", "~/.opencode/bin/opencode"], "antigravity": ["antigravity"], "muse": ["muse"], "pi": ["pi"],
]

/// The folders a GUI app's PATH leaves out (launchd's PATH is short).
private let extraBinDirs = ["/opt/homebrew/bin", "/usr/local/bin", "~/.local/bin", "/usr/bin", "/bin"]

/// The first executable named `name` on PATH or in the usual folders (`name` may be a path, with ~).
func which(_ name: String) -> String? {
    let expanded = (name as NSString).expandingTildeInPath
    if expanded.hasPrefix("/") {
        return FileManager.default.isExecutableFile(atPath: expanded) ? expanded : nil
    }
    let path = (ProcessInfo.processInfo.environment["PATH"] ?? "").split(separator: ":").map(String.init)
    for dir in path + extraBinDirs.map({ ($0 as NSString).expandingTildeInPath }) {
        let candidate = (dir as NSString).appendingPathComponent(name)
        if FileManager.default.isExecutableFile(atPath: candidate) { return candidate }
    }
    return nil
}

/// A driver's CLI on this Mac (the Mac relay binary()).
func binary(_ driver: String, home: URL) -> String? {
    for name in driverBinaries[driver] ?? [] {
        if let found = which(name) { return found }
    }
    return nil
}

/// `<bin> <args>`'s output (stdout, else stderr), or nil when it can't start or runs past `seconds`.
func runQuick(_ path: String, _ args: [String], seconds: Double) -> String? {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: path)
    process.arguments = args
    let out = Pipe()
    let err = Pipe()
    process.standardOutput = out
    process.standardError = err
    process.standardInput = FileHandle.nullDevice
    do { try process.run() } catch { return nil }
    let deadline = Date().addingTimeInterval(seconds)
    while process.isRunning && Date() < deadline { Thread.sleep(forTimeInterval: 0.02) }
    if process.isRunning {
        process.terminate()
        return nil
    }
    let text = String(decoding: out.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
    return text.isEmpty ? String(decoding: err.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self) : text
}

/// The first line of `<bin> --version`, 2 s at most (the Mac relay version()).
func cliVersion(_ path: String) -> String? {
    guard let words = runQuick(path, ["--version"], seconds: 2),
          let first = words.split(separator: "\n", omittingEmptySubsequences: true).first else { return nil }
    return String(first.trimmingCharacters(in: .whitespaces).prefix(120))
}

/// What a CLI says about its own sign-in (`claude auth status --json`, `codex login status`): signed in, and the plan
/// when it says one (Claude's subscriptionType and planTier; Codex never says). Never read from the CLI's files.
func signInFrom(driver: String, output: String) -> (signedIn: Bool, plan: String?)? {
    switch driver {
    case "claude":
        guard let data = output.data(using: .utf8), let o = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return nil }
        let plan = [o["subscriptionType"], o["planTier"]].compactMap { $0 as? String }.filter { !$0.isEmpty }.joined(separator: " ")
        return (o["loggedIn"] as? Bool ?? false, plan.isEmpty ? nil : String(plan.prefix(80)))
    case "codex":
        return (output.localizedCaseInsensitiveContains("logged in") && !output.localizedCaseInsensitiveContains("not logged in"), nil)
    default:
        return nil
    }
}

private let signInArgs: [String: [String]] = ["claude": ["auth", "status", "--json"], "codex": ["login", "status"]]

/// the Mac relay drivers(): each driver's CLI, installed, its version and path.
func driverReport(home: URL) -> [[String: Any]] {
    reportDrivers.map { driver in
        var row: [String: Any] = ["driver": driver.id, "installed": false]
        if let path = binary(driver.id, home: home) {
            row["installed"] = true
            row["path"] = path
            if let version = cliVersion(path) { row["version"] = version }
            if let args = signInArgs[driver.id], let out = runQuick(path, args, seconds: 5),
               let status = signInFrom(driver: driver.id, output: out) {
                row["signedIn"] = status.signedIn
                if let plan = status.plan { row["plan"] = plan }
            }
        }
        return row
    }
}

/// the Mac relay homes(): ~/.claude, every ~/.claude-* with a settings.json or .credentials.json, and ~/.codex.
func homeReport(home: URL) -> [[String: Any]] {
    let fm = FileManager.default
    func isDir(_ url: URL) -> Bool {
        var dir: ObjCBool = false
        return fm.fileExists(atPath: url.path, isDirectory: &dir) && dir.boolValue
    }
    var out: [[String: Any]] = []
    if isDir(home.appendingPathComponent(".claude")) {
        out.append(["driver": "claude", "home": home.appendingPathComponent(".claude").path])
    }
    let names = ((try? fm.contentsOfDirectory(atPath: home.path)) ?? []).filter { $0.hasPrefix(".claude-") }
    for name in names.sorted() {
        let dir = home.appendingPathComponent(name)
        let hasLogin = ["settings.json", ".credentials.json"].contains { fm.fileExists(atPath: dir.appendingPathComponent($0).path) }
        if isDir(dir) && hasLogin { out.append(["driver": "claude", "home": dir.path]) }
    }
    if isDir(home.appendingPathComponent(".codex")) {
        out.append(["driver": "codex", "home": home.appendingPathComponent(".codex").path])
    }
    return out
}

/// A file's top-level JSON object, or nil when it is missing or not one.
func jsonObject(_ url: URL) -> [String: Any]? {
    guard let data = try? Data(contentsOf: url) else { return nil }
    return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
}

/// The whole MacReport body (`POST /api/devices/relay/report`).
func macReport(home: URL = FileManager.default.homeDirectoryForCurrentUser, now: Date = Date()) -> [String: Any] {
    [
        "at": Int(now.timeIntervalSince1970 * 1000),
        "drivers": driverReport(home: home),
        "homes": homeReport(home: home),
        "machine": machineReport(),
    ]
}

/// This Mac for the site's Devices page (`Machine` in apps/captions/contracts/providers.ts): chip, cores, memory, load.
func machineReport() -> [String: Any] {
    let info = ProcessInfo.processInfo
    var out: [String: Any] = [
        "os": "mac",
        "host": info.hostName,
        "cpus": info.processorCount,
        "memGb": (Double(info.physicalMemory) / 1_073_741_824 * 10).rounded() / 10,
    ]
    var size = 0
    if sysctlbyname("machdep.cpu.brand_string", nil, &size, nil, 0) == 0, size > 0 {
        var chars = [CChar](repeating: 0, count: size)
        if sysctlbyname("machdep.cpu.brand_string", &chars, &size, nil, 0) == 0 { out["cpu"] = String(cString: chars) }
    }
    var load = [Double](repeating: 0, count: 3)
    if getloadavg(&load, 3) > 0 { out["load"] = min(1, (load[0] / Double(max(1, info.processorCount)) * 1000).rounded() / 1000) }
    return out
}
