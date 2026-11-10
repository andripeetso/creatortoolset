// What this Mac reports to the site (the Mac relay report; MacReport in apps/captions/contracts/providers.ts):
// the coding CLIs it finds and their versions, its Claude and Codex config folders, and its disks. Read only. Every function takes the home folder so the tests can use a temp one.
import Foundation

/// Every driver the report lists, in contracts/providers.ts order.
let reportDrivers: [(id: String, label: String)] = [
    ("codex", "Codex"), ("claude", "Claude"), ("cursor", "Cursor"), ("grok", "Grok"), ("gemini", "Gemini"), ("opencode", "OpenCode"),
    ("antigravity", "Antigravity"), ("musecode", "Muse Code"), ("pi", "Pi"),
]

/// Where each CLI may be (the Mac relay BINARIES): the official install on PATH or in the usual folders below.
/// Claude is the `claude` command-line tool its owner installed and signed in to, never a copy inside another app.
/// Codex also counts the copy the ChatGPT app carries (OpenAI's own program, the same sign-in in ~/.codex): a person
/// with the ChatGPT app connects with no download, and the newest copy runs (binary()).
let chatGPTAppCodex = "/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex"
let driverBinaries: [String: [String]] = [
    "claude": ["claude"], "codex": ["codex", "/opt/homebrew/bin/codex", chatGPTAppCodex], "grok": ["grok", "~/.grok/bin/grok"], "gemini": ["gemini", "/opt/homebrew/bin/gemini"],
    "cursor": ["cursor-agent"],
    "opencode": ["opencode", "~/.opencode/bin/opencode"], "antigravity": ["antigravity-acp"], "musecode": ["muse"], "pi": ["pi"],
]

/// The folders a GUI app's PATH leaves out (launchd's PATH is short).
private let extraBinDirs = ["/opt/homebrew/bin", "/usr/local/bin", "~/.local/bin", "/usr/bin", "/bin"]

/// The PATH a login shell gives (zsh -lic also reads .zshrc, where nvm is set up). nil when the shell says nothing
/// usable. A Finder-launched app does not inherit the Terminal's PATH, so this is how a CLI under nvm is found.
/// Read again after a minute, so a CLI installed or an nvm Node changed while the app runs is seen on the next report.
/// ponytail: one zsh per minute, shared by every which() in a report; per-report read if a report ever needs it fresh.
private var shellPathCache: (value: String?, at: Date)?
func loginShellPath(now: Date = Date()) -> String? {
    if let cache = shellPathCache, shellPathFresh(readAt: cache.at, now: now) { return cache.value }
    let value = runQuick("/bin/zsh", ["-lic", "echo $PATH"], seconds: 5).flatMap(pathFromShellOutput)
    shellPathCache = (value, now)
    return value
}

/// True while a login-shell PATH read is still within a minute.
func shellPathFresh(readAt: Date, now: Date) -> Bool { now.timeIntervalSince(readAt) < 60 }

/// The login shell's PATH from its output: the last line that starts with "/" (.zshrc may print other lines first).
func pathFromShellOutput(_ text: String) -> String? {
    text.split(separator: "\n").map { $0.trimmingCharacters(in: .whitespaces) }.last(where: { $0.hasPrefix("/") })
}

/// The newest Node version's bin folder under nvm, or nil (nvm's folder is not on a GUI app's PATH).
func newestNvmBin() -> String? {
    let root = ("~/.nvm/versions/node" as NSString).expandingTildeInPath
    let versions = ((try? FileManager.default.contentsOfDirectory(atPath: root)) ?? []).sorted { $0.localizedStandardCompare($1) == .orderedAscending }
    return versions.last.map { (root as NSString).appendingPathComponent($0 + "/bin") }
}

/// Where a CLI may be, in order: the login shell's PATH, this process's PATH, the usual folders, the newest nvm Node.
func searchDirs() -> [String] {
    let shell = (loginShellPath() ?? "").split(separator: ":").map(String.init)
    let own = (ProcessInfo.processInfo.environment["PATH"] ?? "").split(separator: ":").map(String.init)
    return shell + own + extraBinDirs.map { ($0 as NSString).expandingTildeInPath } + [newestNvmBin()].compactMap { $0 }
}

/// The first executable named `name` in searchDirs() (`name` may be a path, with ~). Each call checks the folders again,
/// so a CLI installed or removed while the app runs is seen on the next report.
func which(_ name: String) -> String? {
    let expanded = (name as NSString).expandingTildeInPath
    if expanded.hasPrefix("/") {
        return FileManager.default.isExecutableFile(atPath: expanded) ? expanded : nil
    }
    for dir in searchDirs() {
        let candidate = (dir as NSString).appendingPathComponent(name)
        if FileManager.default.isExecutableFile(atPath: candidate) { return candidate }
    }
    return nil
}

/// The environment for a CLI run: the CLI's own folder first on PATH, so a Node script beside it (nvm) finds its own node.
func withBinaryOnPath(_ env: [String: String], binary path: String) -> [String: String] {
    guard path.contains("/") else { return env }
    var out = env
    out["PATH"] = (path as NSString).deletingLastPathComponent + ":" + (env["PATH"] ?? "")
    return out
}

/// Every executable named `name` in searchDirs(), in that order, each real file once (a folder listed twice, a symlink).
func whichAll(_ name: String) -> [String] {
    let expanded = (name as NSString).expandingTildeInPath
    let candidates = expanded.hasPrefix("/") ? [expanded] : searchDirs().map { ($0 as NSString).appendingPathComponent(name) }
    var seen = Set<String>()
    return candidates.filter { FileManager.default.isExecutableFile(atPath: $0) && seen.insert(URL(fileURLWithPath: $0).resolvingSymlinksInPath().path).inserted }
}

/// The version numbers in a `--version` line ("codex-cli 0.39.0" → [0, 39, 0]); [] when it names none.
func versionNumbers(_ text: String) -> [Int] {
    guard let range = text.range(of: #"\d+(\.\d+)+"#, options: .regularExpression) else { return [] }
    return text[range].split(separator: ".").compactMap { Int($0) }
}

/// A CLI copy's version, read once per file (its path and change date): `--version` starts a process.
private var versionCache: [String: (changed: Date?, version: [Int])] = [:]
private let versionLock = NSLock()
func cliVersion(_ path: String) -> [Int] {
    let changed = (try? FileManager.default.attributesOfItem(atPath: URL(fileURLWithPath: path).resolvingSymlinksInPath().path))?[.modificationDate] as? Date
    versionLock.lock()
    let hit = versionCache[path]
    versionLock.unlock()
    if let hit, hit.changed == changed { return hit.version }
    let version = versionNumbers(runQuick(path, ["--version"], seconds: 5) ?? "")
    versionLock.lock()
    versionCache[path] = (changed, version)
    versionLock.unlock()
    return version
}

/// The newest of several copies, by version; the first found wins a tie (and when no copy names a version).
func newest(_ paths: [String], version: (String) -> [Int] = cliVersion) -> String? {
    guard paths.count > 1 else { return paths.first }
    var best = (path: paths[0], version: version(paths[0]))
    for path in paths.dropFirst() {
        let v = version(path)
        if v.lexicographicallyPrecedes(best.version) || v == best.version { continue }
        best = (path, v)
    }
    return best.path
}

/// A driver's CLI on this Mac (the Mac relay binary()). With more than one copy on the Mac (an old Homebrew Codex
/// beside the one this app installed in ~/.local/bin), the newest runs: today's models refuse an old Codex.
func binary(_ driver: String, home: URL) -> String? {
    var seen = Set<String>()
    let copies = (driverBinaries[driver] ?? []).flatMap(whichAll).filter { seen.insert($0).inserted }
    return newest(copies)
}

/// `<bin> <args>`'s output (stdout, else stderr), or nil when it can't start or runs past `seconds`.
func runQuick(_ path: String, _ args: [String], seconds: Double) -> String? {
    runResult(path, args, seconds: seconds)?.text
}

/// The same, with how it ended: status 0 is success (installInAI needs to know a command worked, not only what it said).
func runResult(_ path: String, _ args: [String], seconds: Double) -> (status: Int32, text: String)? {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: path)
    process.arguments = args
    process.environment = withBinaryOnPath(ProcessInfo.processInfo.environment, binary: path)
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
    return (process.terminationStatus, text.isEmpty ? String(decoding: err.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self) : text)
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
/// The sign-in probe reads each CLI's login (Claude's from the keychain), so it runs only with the plan-limits opt-in on
/// (Limits.swift). Off, a row has no signedIn or plan: the contract leaves both optional.
func driverReport(home: URL, signIn: Bool = limitsReadingOn()) -> [[String: Any]] {
    reportDrivers.map { driver in
        var row: [String: Any] = ["driver": driver.id, "installed": false]
        if let path = binary(driver.id, home: home) {
            row["installed"] = true
            row["path"] = path
            if let version = cliVersion(path) { row["version"] = version }
            if signIn, let args = signInArgs[driver.id], let out = runQuick(path, args, seconds: 5),
               let status = signInFrom(driver: driver.id, output: out) {
                row["signedIn"] = status.signedIn
                if let plan = status.plan { row["plan"] = plan }
            }
        }
        return row
    }
}

/// A Claude home for the report. `customEndpoint` says whether its settings.json env sets ANTHROPIC_BASE_URL (a custom
/// API endpoint, e.g. a gateway). Only that yes or no is reported: the URL and any token stay on this Mac.
func claudeHome(_ dir: URL) -> [String: Any] {
    ["driver": "claude", "home": dir.path, "customEndpoint": !(homeEnv(dir.path)["ANTHROPIC_BASE_URL"] ?? "").isEmpty]
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
        out.append(claudeHome(home.appendingPathComponent(".claude")))
    }
    let names = ((try? fm.contentsOfDirectory(atPath: home.path)) ?? []).filter { $0.hasPrefix(".claude-") }
    for name in names.sorted() {
        let dir = home.appendingPathComponent(name)
        let hasLogin = ["settings.json", ".credentials.json"].contains { fm.fileExists(atPath: dir.appendingPathComponent($0).path) }
        if isDir(dir) && hasLogin { out.append(claudeHome(dir)) }
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
func macReport(home: URL = FileManager.default.homeDirectoryForCurrentUser, now: Date = Date(), signIn: Bool = limitsReadingOn()) -> [String: Any] {
    [
        "at": Int(now.timeIntervalSince1970 * 1000),
        "drivers": driverReport(home: home, signIn: signIn),
        "homes": homeReport(home: home),
        "machine": machineReport(),
    ]
}

/// The filesystem types a network share mounts as.
private let networkFilesystems: Set<String> = ["smbfs", "cifs", "smb3", "nfs", "nfs4", "afpfs", "webdav", "fuse.sshfs"]

/// What the disk report needs to know about one mounted volume (read with statfs and the volume's URL keys).
struct VolumeFacts {
    var path: String
    var freeBytes: Int64
    var totalBytes: Int64
    var fstype: String
    var source: String
    var readOnly: Bool
    var browsable: Bool
}

/// The machine a share lives on, from its mount source ("//user@NAS-1._smb._tcp.local/TEAM" → "nas-1"); nil for a
/// source that is not a share.
func shareServer(_ source: String) -> String? {
    guard source.hasPrefix("//"), source.dropFirst(2).contains("/") else { return nil }
    var host = source.dropFirst(2).prefix { $0 != "/" }
    if let at = host.lastIndex(of: "@") { host = host[host.index(after: at)...] }
    var name = (String(host).removingPercentEncoding ?? String(host)).lowercased()
    for suffix in ["._smb._tcp.local", ".local"] where name.hasSuffix(suffix) {
        name.removeLast(suffix.count)
        break
    }
    return name.isEmpty ? nil : name
}

/// One disk for the report (`Disk` in apps/captions/contracts/storage.ts), or nil for a volume nobody keeps files on:
/// an installer image, a hidden volume, a tiny helper volume. The rules are the Python editor's `_mounts` and `_disks`.
func diskReport(_ v: VolumeFacts) -> [String: Any]? {
    guard v.path == "/" || v.path.hasPrefix("/Volumes/"), !v.readOnly, v.browsable else { return nil }
    let gigabyte: Int64 = 1_073_741_824
    guard v.totalBytes >= gigabyte else { return nil }
    let gb = { (bytes: Int64) in (Double(bytes) / Double(gigabyte) * 10).rounded() / 10 }
    var d: [String: Any] = [
        "path": v.path,
        "name": v.path == "/" ? "System disk" : (v.path as NSString).lastPathComponent,
        "freeGb": gb(v.freeBytes),
    ]
    // A share's quota can make the total smaller than the free space: then the total is left out.
    if v.totalBytes >= v.freeBytes { d["totalGb"] = gb(v.totalBytes) }
    if networkFilesystems.contains(v.fstype) {
        d["network"] = true
        if let server = shareServer(v.source) { d["server"] = server }
    }
    return d
}

/// The C string in a fixed-size tuple field of statfs (f_fstypename, f_mntfromname).
private func cField<T>(_ field: T) -> String {
    withUnsafeBytes(of: field) { raw in String(cString: raw.bindMemory(to: CChar.self).baseAddress!) }
}

/// Every mounted volume's disk report. A dead network share can hang a statfs call for minutes, so this runs only on
/// DiskCache's background queue, never on the report path.
func readDisks() -> [[String: Any]] {
    let urls = FileManager.default.mountedVolumeURLs(includingResourceValuesForKeys: [.volumeIsBrowsableKey], options: []) ?? []
    return urls.compactMap { url -> [String: Any]? in
        var st = statfs()
        guard statfs(url.path, &st) == 0 else { return nil }
        let browsable = (try? url.resourceValues(forKeys: [.volumeIsBrowsableKey]))?.volumeIsBrowsable ?? true
        let block = Int64(st.f_bsize)
        return diskReport(VolumeFacts(
            path: url.path,
            freeBytes: Int64(st.f_bavail) * block,
            totalBytes: Int64(st.f_blocks) * block,
            fstype: cField(st.f_fstypename),
            source: cField(st.f_mntfromname),
            readOnly: st.f_flags & UInt32(MNT_RDONLY) != 0,
            browsable: browsable))
    }
}

/// The disks for the report, read once a minute on a background queue. The first call starts the reading, so the first
/// report can go out without them; after that the report sends the last good list and never waits for a read.
final class DiskCache {
    static let shared = DiskCache()
    private let lock = NSLock()
    private var disks: [[String: Any]] = []
    private var started = false
    private let queue = DispatchQueue(label: "creatortoolset.disks", qos: .utility)

    func current() -> [[String: Any]] {
        lock.lock()
        let start = !started
        started = true
        let list = disks
        lock.unlock()
        if start { refresh() }
        return list
    }

    private func refresh() {
        queue.async { [self] in
            let fresh = readDisks()
            lock.lock()
            disks = fresh
            lock.unlock()
            queue.asyncAfter(deadline: .now() + 60) { [self] in refresh() }
        }
    }
}

/// This Mac for the site's Devices page (`Machine` in apps/captions/contracts/providers.ts): chip, cores, memory, load,
/// and the disks it keeps files on.
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
    out["disks"] = DiskCache.shared.current()
    return out
}
