// What this Mac reports to the site (the Mac relay report; MacReport in apps/captions/contracts/providers.ts):
// the coding CLIs it finds and their versions, and its Claude and Codex config folders. Read only. Every function takes the home folder so the tests can use a temp one.
import Foundation

/// Every driver the report lists, in contracts/providers.ts order.
let reportDrivers: [(id: String, label: String)] = [
    ("codex", "Codex"), ("claude", "Claude"), ("cursor", "Cursor"), ("grok", "Grok"), ("opencode", "OpenCode"),
    ("antigravity", "Antigravity"), ("muse", "Muse Code"), ("pi", "Pi"),
]

/// Where each non-Claude CLI may be (the Mac relay BINARIES). Claude is found by claudeBinary.
let driverBinaries: [String: [String]] = [
    "codex": ["codex", "/opt/homebrew/bin/codex"], "grok": ["grok", "~/.grok/bin/grok"], "cursor": ["cursor-agent"],
    "opencode": ["opencode", "~/.opencode/bin/opencode"], "antigravity": ["antigravity"], "muse": ["muse"], "pi": ["pi"],
]

/// The folders a GUI app's PATH leaves out (launchd's PATH is short).
private let extraBinDirs = ["/opt/homebrew/bin", "/usr/local/bin", "~/.local/bin", "/usr/bin", "/bin"]

/// The CLI a `claude` run uses: the newest Claude Code the desktop app keeps (its bundled copy knows the newest models),
/// else `claude` on PATH (llm.cli()). nil when neither exists.
func claudeBinary(home: URL) -> String? {
    let fm = FileManager.default
    let root = home.appendingPathComponent("Library/Application Support/Claude/claude-code")
    var bundled: [(key: [Int], path: String)] = []
    for version in (try? fm.contentsOfDirectory(atPath: root.path)) ?? [] {
        let versionDir = root.appendingPathComponent(version)
        let key = version.split(separator: ".").compactMap { Int($0) }
        // <version>/claude.app, or <version>/<hash>/claude.app (the desktop app's layout since 2026-10-01)
        var dirs = [versionDir]
        dirs += ((try? fm.contentsOfDirectory(atPath: versionDir.path)) ?? []).map { versionDir.appendingPathComponent($0) }
        for dir in dirs {
            let path = dir.appendingPathComponent("claude.app/Contents/MacOS/claude").path
            if fm.isExecutableFile(atPath: path) { bundled.append((key, path)) }
        }
    }
    if let newest = bundled.max(by: { $0.key.lexicographicallyPrecedes($1.key) }) { return newest.path }
    return which("claude")
}

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
    if driver == "claude" { return claudeBinary(home: home) }
    for name in driverBinaries[driver] ?? [] {
        if let found = which(name) { return found }
    }
    return nil
}

/// The first line of `<bin> --version`, 2 s at most (the Mac relay version()).
func cliVersion(_ path: String) -> String? {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: path)
    process.arguments = ["--version"]
    let out = Pipe()
    let err = Pipe()
    process.standardOutput = out
    process.standardError = err
    process.standardInput = FileHandle.nullDevice
    do { try process.run() } catch { return nil }
    let deadline = Date().addingTimeInterval(2)
    while process.isRunning && Date() < deadline { Thread.sleep(forTimeInterval: 0.02) }
    if process.isRunning {
        process.terminate()
        return nil
    }
    let text = String(decoding: out.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
    let words = text.isEmpty ? String(decoding: err.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self) : text
    guard let first = words.split(separator: "\n", omittingEmptySubsequences: true).first else { return nil }
    return String(first.trimmingCharacters(in: .whitespaces).prefix(120))
}

/// the Mac relay drivers(): each driver's CLI, installed, its version and path.
func driverReport(home: URL) -> [[String: Any]] {
    reportDrivers.map { driver in
        var row: [String: Any] = ["driver": driver.id, "installed": false]
        if let path = binary(driver.id, home: home) {
            row["installed"] = true
            row["path"] = path
            if let version = cliVersion(path) { row["version"] = version }
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
    ]
}
