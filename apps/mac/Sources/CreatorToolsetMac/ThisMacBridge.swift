// Settings → This Mac on the site (apps/captions ThisMacSection.tsx): the page sends `thismac-<what>` on the window
// handler (TitleBar.swift) and every message is answered with this app's state as a `mac-this` event. The app keeps
// all of it (servers, Take work from this server); the page only shows it. Worker buttons are plug-in rows (LaunchAgent.swift).
import AppKit
import Foundation

/// The questions the page may ask over the "thisMac" handler (TitleBar.swift); any other is answered as off.
/// "dropped" is answered by the window itself (AppWebView.dragItems). These have parts of their own:
/// "install:<claude|codex>:<key>" (installAsk), "ai-install:<id>" (aiInstallAsk), and the Media Library's "import:…" (Import.swift).
let thisMacAsks = ["state", "start", "access", "access:off", "folder", "download:location", "download:choose", "download:show", "cache:location", "cache:choose", "cache:show", "dropped", "files", "connect", "connect.link", "connect.unlink", "ai-install-progress", "pair"]

/// The files picked in this app's open panel for the page (Shell runOpenPanelWith), newest first, each once, at most
/// `cap`: the page asks where they are after the panel closes, and a second pick must not lose the first's while that
/// one is still being added.
func rememberPicks(_ new: [URL], in old: [URL], cap: Int = 1000) -> [URL] {
    let fresh = new.map(\.standardizedFileURL)
    return Array((fresh + old.filter { !fresh.contains($0) }).prefix(cap))
}

/// "files" from the page (src/lib/thisMac.ts pathOnMac): where each picked file is, so This Mac's server adds it in
/// place instead of taking an upload. { files: [{ path, name, size, modified (ms) }] }; none for a server that is not
/// this Mac (it cannot read them), and none for folders or files that are gone.
func pickedFilesReply(_ urls: [URL], here: Bool) -> [String: Any] {
    guard here else { return ["files": []] }
    let files: [[String: Any]] = urls.compactMap { url in
        guard let v = try? url.resourceValues(forKeys: [.isRegularFileKey, .fileSizeKey, .contentModificationDateKey]),
              v.isRegularFile == true, let size = v.fileSize else { return nil }
        return ["path": url.path, "name": url.lastPathComponent, "size": size,
                "modified": ((v.contentModificationDate?.timeIntervalSince1970 ?? 0) * 1000).rounded()]
    }
    return ["files": files]
}

/// "install:<claude|codex>:<key>" from Settings → Headless access, as its parts; nil for anything else. The key is the
/// one the page just made for that AI app (ctk_ and letters or digits), so nothing else can be put on a command line.
func installAsk(_ ask: String) -> (app: String, key: String)? {
    let parts = ask.split(separator: ":", omittingEmptySubsequences: false).map(String.init)
    guard parts.count == 3, parts[0] == "install", ["claude", "codex"].contains(parts[1]),
          parts[2].range(of: "^ctk_[A-Za-z0-9]{16,}$", options: .regularExpression) != nil else { return nil }
    return (parts[1], parts[2])
}

/// Codex's config.toml with one MCP server's table set to this address and key, and every other line as it was. Codex
/// has no flag for the header, so the table is written here: the same lines the page's own command writes.
func codexConfig(_ text: String, name: String, url: String, key: String) -> String {
    var kept: [Substring] = []
    var skipping = false
    for line in text.split(separator: "\n", omittingEmptySubsequences: false) {
        let t = line.trimmingCharacters(in: .whitespaces)
        if t.hasPrefix("[") { skipping = t == "[mcp_servers.\(name)]" || t.hasPrefix("[mcp_servers.\(name).") }
        if !skipping { kept.append(line) }
    }
    var out = kept.joined(separator: "\n")
    while out.hasSuffix("\n") { out.removeLast() }
    return (out.isEmpty ? "" : out + "\n\n") + "[mcp_servers.\(name)]\nurl = \"\(url)\"\nhttp_headers = { Authorization = \"Bearer \(key)\" }\n"
}

/// Installs the open server (its /api/mcp address, with the key the page just made) in Claude Code or Codex on this Mac:
/// what the page's Install does on a server that is not this computer. nil when it is done, else one sentence.
func installInAI(app: String, name: String = "creator-toolset", url: String, key: String,
                 home: URL = FileManager.default.homeDirectoryForCurrentUser) -> String? {
    let label = app == "claude" ? "Claude Code" : "Codex"
    guard let bin = binary(app, home: home) else { return "\(label) isn't on this Mac." }
    if app == "claude" {
        _ = runResult(bin, ["mcp", "remove", "--scope", "user", name], seconds: 20)
        guard let added = runResult(bin, ["mcp", "add", "--transport", "http", "--scope", "user", name, url, "--header", "Authorization: Bearer \(key)"], seconds: 30) else {
            return "Claude Code did not answer. Try again."
        }
        if added.status == 0 { return nil }
        // its own words, without the key it may repeat
        let said = added.text.split(separator: "\n").first.map(String.init)?.replacingOccurrences(of: key, with: "…") ?? ""
        return said.isEmpty ? "Claude Code could not add it." : String(said.prefix(200))
    }
    let file = home.appendingPathComponent(".codex/config.toml")
    let old = (try? String(contentsOf: file, encoding: .utf8)) ?? ""
    do {
        try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        try codexConfig(old, name: name, url: url, key: key).write(to: file, atomically: true, encoding: .utf8)
        return nil
    } catch {
        return "Could not write Codex's settings at ~/.codex/config.toml."
    }
}

/// GET /api/voice-prefs' languages, the ones the person speaks (Settings → AI → Voice), for dictation's language
/// hint. A server without that page answers with an error, and dictation then chooses among the Mac's own languages.
struct VoiceLanguages: Decodable { let languages: [String] }

extension Shell {
    func voiceLanguages() async -> [String]? {
        guard let reply: VoiceLanguages = try? await client().get("/api/voice-prefs") else { return nil }
        return reply.languages.isEmpty ? nil : reply.languages
    }

    /// One `thismac-<what>` message: state, ai:on|off, select:<id>, add:<text>, rename:<id>:<name>, remove:<id>, forget,
    /// shortcut (opens the recording shortcut's chooser, RecordShortcut.swift), limits:on|off (Plan limits reading),
    /// dictation:<what>:<value> (Settings → AI → Voice → Dictation), shares:on|off (Settings → Computers → Shared drives).
    func thisMacCommand(_ what: String) {
        let parts = what.split(separator: ":", maxSplits: 2, omittingEmptySubsequences: false).map(String.init)
        let arg = parts.count > 1 ? parts[1] : ""
        var problem: String?
        switch parts[0] {
        case "ai": setAI(arg == "on")
        case "select": select(arg)
        // the address may hold colons itself (https://…): everything after "add:"
        case "add": problem = addServer(String(what.dropFirst(4)))
        case "rename": if parts.count > 2 { renameServer(arg, to: parts[2]) }
        case "remove": removeServer(arg)
        case "forget": forgetThisMac()
        case "shortcut": RecordShortcut.shared.choose()
        case "limits": UserDefaults.standard.set(arg == "on", forKey: limitsReadingKey)
        case "page": break  // an older page's page:calm|busy: nothing opens by itself
        // dictation:<what>:<value> (Dictation.swift `command`)
        case "dictation": Dictation.shared.command(arg, parts.count > 2 ? parts[2] : "")
        // recorder:<what>:<value> (Settings → Screen Recorder, RecordTypes.swift RecordPrefs)
        case "recorder": RecordPrefs.command(arg, parts.count > 2 ? parts[2] : "")
        // shares:on|off: connect the shared drives this Mac had when they answer (Places.swift)
        case "shares":
            Places.connectOn = arg == "on"
            if arg == "on" { Places.shared.lookAgain() }
        default: break
        }
        pushThisMac(problem: problem)
    }

    /// "access" from the page: turns on Network access (no password: phones pair with a link or the account).
    func accessFromOtherDevices() async -> [String: Any] {
        guard let server else { return thisMacState(problem: "There is no server on this Mac.") }
        if server.otherDevices { return thisMacState() }
        return thisMacState(problem: await setOtherDevices(true))
    }

    /// "folder" from the page (FootageFolderCard, "Choose a folder", setup's Library folder): this Mac's own open panel for
    /// one folder. The reply is { path, children, siblings } (the folder names in it and beside it), or { path: null } when
    /// cancelled. Choosing it is what lets this app read the folder; the server then adds it
    /// to the Library's watch list (api/library/watch.ts), which reads it in place.
    @MainActor func chooseFolder() -> [String: Any] {
        let open = NSOpenPanel()
        open.canChooseDirectories = true
        open.canChooseFiles = false
        open.canCreateDirectories = true
        open.prompt = "Choose"
        open.message = "Choose the folder with your videos. Nothing is moved."
        guard open.runModal() == .OK, let url = open.url else { return ["path": NSNull()] }
        // another server's Blur faces Media folder never becomes this server's folder (its scans would send pictures of it)
        if let refused = MediaFiles.blurredElsewhere([url.path], server: MediaFiles.serverKey(base)) {
            (webView as? AppWebView)?.refuse(refused)
            return ["path": NSNull()]
        }
        Imports.chose(url.path)   // a Media Library copy may write into it (Import.swift)
        MediaFiles.add(url.path)  // and its videos are read here later: shot descriptions, transcripts, playing originals
        // the names of the folders in it and beside it: setup finds Source media, Project files and Final exports by them
        return ["path": url.path, "children": Imports.subfolders(url.path), "siblings": Imports.subfolders(url.deletingLastPathComponent().path)]
    }

    /// "download:choose" from the page (Settings → Storage › This computer, Download location › Change…): this Mac's open
    /// panel for the download cache's folder. Reply { path } or { path: null }. The worker reads it when it next starts.
    @MainActor func chooseDownloadFolder() -> [String: Any] {
        // the launch move to the default folder is still going: a second move now would split the files between the two
        if DownloadLocation.isMoving { return ["path": NSNull(), "error": "Your downloads are being moved. Try again in a minute."] }
        let open = NSOpenPanel()
        open.canChooseDirectories = true
        open.canChooseFiles = false
        open.canCreateDirectories = true
        open.prompt = "Choose"
        guard open.runModal() == .OK, let url = open.url else { return ["path": NSNull()] }
        // a disk event while the panel was open may have started one (from here on the main thread, none can start)
        if DownloadLocation.isMoving { return ["path": NSNull(), "error": "Your downloads are being moved. Try again in a minute."] }
        // the cache's files come along first (a kept proxy may be the only copy); the new folder is kept only once they are there
        let moves = DownloadLocation.path().map { [(URL(fileURLWithPath: $0), url)] } ?? cacheRoots(into: url.path)
        do {
            for (root, to) in moves { try ProxyCacheMove.move(from: root, to: to) }
        } catch ProxyCacheMoveError.noSpace(let needed, let free) {
            return ["path": NSNull(), "error": "That disk has \(workBytes(free)) free; the downloads need \(workBytes(needed))."]
        } catch ProxyCacheMoveError.inside {
            return ["path": NSNull(), "error": "Choose a folder outside the one your downloads are in now."]
        } catch {
            return ["path": NSNull(), "error": error.localizedDescription]
        }
        UserDefaults.standard.set(url.path, forKey: DownloadLocation.key)
        locationMoved()
        return ["path": url.path]
    }

    /// Settings → Storage › This computer (KeptRows.tsx): where the open server's download cache is, the Cache folder, and
    /// Change… / Show in Finder for each. Nil for any other ask.
    @MainActor func storageAsk(_ ask: String) -> [String: Any]? {
        switch ask {
        case "download:location": return ["path": downloadRoot().path]
        case "download:choose": return chooseDownloadFolder()
        case "download:show": return reveal(downloadRoot())
        case "cache:location": return CacheFolder.path().map { ["path": $0] } ?? ["path": NSNull()]
        case "cache:choose": return chooseCacheFolder()
        case "cache:show": return CacheFolder.path().map { reveal(URL(fileURLWithPath: $0)) } ?? ["ok": false]
        default: return nil
        }
    }

    /// The open server's download cache: the Download location, else its own default folder.
    @MainActor private func downloadRoot() -> URL {
        if let p = DownloadLocation.path() { return URL(fileURLWithPath: p) }
        let local = server.flatMap { $0.url.host == base.host && $0.url.port == base.port ? $0.dataDir : nil }
        return ProxyCache.defaultRoot(server: base, localData: local)
    }

    /// Opens the folder in the Finder (made first: it may not exist before its first file).
    private func reveal(_ folder: URL) -> [String: Any] {
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        NSWorkspace.shared.activateFileViewerSelecting([folder])
        return ["ok": true]
    }

    /// Cache folder › Change…: this Mac's open panel. Nothing moves (the cache is disposable; the old folder can be deleted
    /// by hand); the open server hears of it at once (the editor worker reads it there). Reply { path } or { path: null }.
    @MainActor func chooseCacheFolder() -> [String: Any] {
        let open = NSOpenPanel()
        open.canChooseDirectories = true
        open.canChooseFiles = false
        open.canCreateDirectories = true
        open.prompt = "Choose"
        guard open.runModal() == .OK, let url = open.url else { return ["path": NSNull()] }
        UserDefaults.standard.set(url.path, forKey: CacheFolder.key)
        runner?.reportNow()
        return ["path": url.path]
    }

    /// What a Download location change moves when none was chosen: each server's default folder (ProxyCache.defaultRoot)
    /// to its own folder in the new one (ProxyCache.root).
    @MainActor private func cacheRoots(into location: String) -> [(URL, URL)] {
        let local = server.map { (ProxyCache.defaultRoot(server: $0.url, localData: $0.dataDir), ProxyCache.root(server: $0.url, location: location)) }
        return [local].compactMap { $0 } + servers.compactMap { URL(string: $0.url) }.map { (ProxyCache.root(server: $0, location: nil), ProxyCache.root(server: $0, location: location)) }
    }

    func pushThisMac(problem: String? = nil) {
        guard let data = try? JSONSerialization.data(withJSONObject: thisMacState(problem: problem)),
              let json = String(data: data, encoding: .utf8) else { return }
        webView.evaluateJavaScript("window.dispatchEvent(new CustomEvent('mac-this', {detail: \(json)}))")
    }

    func thisMacState(problem: String? = nil) -> [String: Any] {
        [
            "answer": aiLine,
            "aiOn": aiOn,
            "running": ai.running,
            "lastError": ai.lastError ?? NSNull(),
            "notice": notice ?? NSNull(),
            "paired": pairedHere,
            // answers "pair": adds this Mac to the open server with the AI left as it is (its folders, LocationAgent.swift)
            "pairs": true,
            // on an account through the connect service (setup's Add this computer hides once it is); none = no service set
            "linked": connectService == nil ? NSNull() : linkedHere,
            // Settings → Computers → Reach from anywhere (Connect.swift): signed-out | off | unreachable | available |
            // removed (the page has the words); none = no connect service set
            "reach": connectService == nil ? NSNull() : reach.rawValue,
            // this Mac's names as the site matches its records: the name it pairs with, and the host name its worker reports
            "computer": Host.current().localizedName ?? macHostName(),
            "host": macHostName(),
            // this Mac's device id on the open server: the page's Connect binds its AI to it (setup's AI step)
            "device": DeviceVault.deviceID(for: base.host ?? "") ?? NSNull(),
            "problem": problem ?? NSNull(),
            "servers": listed.map { ["id": $0.id, "name": $0.name, "url": $0.url, "current": $0.id == current] as [String: Any] },
            // the recording shortcut as shown ("" = none) and the plan-limits switch (Settings → General, Usage)
            "shortcut": RecordShortcut.shared.shortcut?.display ?? "",
            "limits": limitsReadingOn(),
            // Settings → General → Version
            "version": appVersion,
            // Settings → General → Dictation (Dictation.swift)
            "dictation": Dictation.shared.bridgeState(),
            // Settings → Screen Recorder
            "recorder": RecordPrefs.bridgeState(),
            // Settings → Computers → Shared drives (Places.swift)
            "shares": Places.connectOn,
        ]
    }
}

/// "ai-install:<claude|codex|gemini|antigravity>" from Settings → Providers on a server that is not this Mac: the AI's
/// id; nil for anything else. "ai-install-progress" (in thisMacAsks) answers { done, total } while it runs.
func aiInstallAsk(_ ask: String) -> String? {
    guard ask.hasPrefix("ai-install:") else { return nil }
    let id = String(ask.dropFirst("ai-install:".count))
    return ["claude", "codex", "gemini", "antigravity"].contains(id) ? id : nil
}

/// The JSON lines the install program printed (apps/captions api/install-bin.ts): the last { done, total }, and the
/// page's reply from its last { ok, message } ({ ok } or { ok: false, problem }; nil while there is none).
func aiInstallOutput(_ text: String) -> (progress: [String: Any]?, reply: [String: Any]?) {
    var progress: [String: Any]?, reply: [String: Any]?
    for line in text.split(separator: "\n") {
        guard let o = (try? JSONSerialization.jsonObject(with: Data(line.utf8))) as? [String: Any] else { continue }
        if let ok = o["ok"] as? Bool {
            reply = ok ? ["ok": true] : ["ok": false, "problem": o["message"] as? String ?? "Could not install it."]
        } else if o["done"] != nil, o["total"] != nil {
            progress = ["done": o["done"]!, "total": o["total"]!]
        }
    }
    return (progress, reply)
}

/// Installs an AI on this Mac with the server's own installer (server/dist/install.js on the bundled node), for a window
/// on another server: this Mac's server is not running then. One install at a time.
final class AiInstall: @unchecked Sendable {
    static let shared = AiInstall()
    private let lock = NSLock()
    private var output = ""
    private var running = false
    private var process: Process?

    private init() {
        // an installer is never left running once the app quits (a relaunch would start a second one beside it)
        NotificationCenter.default.addObserver(forName: NSApplication.willTerminateNotification, object: nil, queue: nil) { [weak self] _ in
            guard let self else { return }
            self.lock.lock(); defer { self.lock.unlock() }
            if self.process?.isRunning == true { self.process?.terminate() }
        }
    }

    /// { done, total } of the install running now (Antigravity's download); 0 of 0 when none runs.
    var progress: [String: Any] {
        lock.lock(); defer { lock.unlock() }
        return running ? (aiInstallOutput(output).progress ?? ["done": 0, "total": 0]) : ["done": 0, "total": 0]
    }

    func run(_ id: String, folder: URL, done: @escaping ([String: Any]) -> Void) {
        lock.lock()
        if running { lock.unlock(); return done(["ok": false, "problem": "An install is running. Try again when it ends."]) }
        running = true
        output = ""
        lock.unlock()
        let p = Process()
        p.executableURL = folder.appendingPathComponent("bin/node")
        p.arguments = ["dist/install.js", id]
        p.currentDirectoryURL = folder
        var env = ProcessInfo.processInfo.environment.filter { ["HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "LANG", "LC_ALL"].contains($0.key) }
        env["PATH"] = "/usr/bin:/bin:/usr/sbin:/sbin"
        env["NODE_ENV"] = "production"
        env["CT_LOCAL"] = "1"
        env["CT_APP_FOLDER"] = appSupport.path   // where Antigravity and the managed Node.js go, as for the server (Server.swift)
        p.environment = env
        let pipe = Pipe()
        p.standardOutput = pipe
        p.standardError = FileHandle.nullDevice
        // the output is read here only, and the answer is its last line: read once the installer closes its output,
        // so no second reader can take that line first
        pipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            guard let self else { handle.readabilityHandler = nil; return }
            self.lock.lock()
            guard data.isEmpty else {
                self.output += String(decoding: data, as: UTF8.self)
                return self.lock.unlock()
            }
            handle.readabilityHandler = nil
            let reply = aiInstallOutput(self.output).reply ?? ["ok": false, "problem": "Could not install it. Try again."]
            self.running = false
            self.process = nil
            self.lock.unlock()
            DispatchQueue.main.async { done(reply) }
        }
        do {
            try p.run()
            lock.lock(); process = p; lock.unlock()
            // as the page waits for it: an install that hangs is stopped after an hour, and its answer is then a failure
            DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + 60 * 60) { if p.isRunning { p.terminate() } }
        } catch {
            pipe.fileHandleForReading.readabilityHandler = nil
            lock.lock(); running = false; lock.unlock()
            done(["ok": false, "problem": "Could not start the installer."])
        }
    }
}
