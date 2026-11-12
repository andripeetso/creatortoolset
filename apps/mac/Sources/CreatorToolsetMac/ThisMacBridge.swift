// Settings → This Mac on the site (apps/captions ThisMacSection.tsx): the page sends `thismac-<what>` on the window
// handler (TitleBar.swift) and every message is answered with this app's state as a `mac-this` event. The app keeps
// all of it (servers, Use this Mac for my AI); the page only shows it. Worker buttons are plug-in rows (LaunchAgent.swift).
import AppKit
import Foundation

/// The questions the page may ask over the "thisMac" handler (TitleBar.swift); any other is answered as off.
/// "dropped" is answered by the window itself (AppWebView.dragItems). One more has parts of its own:
/// "install:<claude|codex>:<key>" (installAsk).
let thisMacAsks = ["state", "start", "access", "folder", "dropped", "files", "connect"]

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

extension Shell {
    /// One `thismac-<what>` message: state, ai:on|off, select:<id>, add:<text>, rename:<id>:<name>, remove:<id>, forget,
    /// shortcut (opens the recording shortcut's chooser, RecordShortcut.swift), limits:on|off (Plan limits reading).
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
        default: break
        }
        pushThisMac(problem: problem)
    }

    /// "access" from the page: turns on Access from other devices. Without the owner's password yet, this app asks for
    /// one in a sheet (the page never sees it). The reply carries the problem, or none when it is on.
    func accessFromOtherDevices() async -> [String: Any] {
        guard let server else { return thisMacState(problem: "There is no server on this Mac.") }
        if server.otherDevices { return thisMacState() }
        var password: String?
        if !server.hasOwnerPassword {
            guard let typed = askNewOwnerPassword() else { return thisMacState(problem: "Choose this computer's password to turn it on.") }
            password = typed
        }
        return thisMacState(problem: await setOtherDevices(true, password: password))
    }

    /// "folder" from the page (FootageFolderCard, "Choose a folder"): this Mac's own open panel for one folder. The reply is
    /// { path }, or { path: null } when cancelled. Choosing it is what lets this app read the folder; the server then adds it
    /// to the Library's watch list (api/library/watch.ts), which reads it in place.
    @MainActor func chooseFolder() -> [String: Any] {
        let open = NSOpenPanel()
        open.canChooseDirectories = true
        open.canChooseFiles = false
        open.canCreateDirectories = true
        open.prompt = "Choose"
        open.message = "Choose the folder with your videos. Nothing is moved."
        guard open.runModal() == .OK, let url = open.url else { return ["path": NSNull()] }
        return ["path": url.path]
    }

    /// The owner's new password for other devices, typed in a sheet of this app (nil: cancelled or too short).
    @MainActor private func askNewOwnerPassword() -> String? {
        let field = NSSecureTextField(frame: NSRect(x: 0, y: 0, width: 260, height: 24))
        let alert = NSAlert()
        alert.messageText = "Choose this computer's password"
        alert.informativeText = "Phones and other computers ask for it once, when they first sign in. Ten characters or more."
        alert.accessoryView = field
        alert.addButton(withTitle: "Turn on")
        alert.addButton(withTitle: "Cancel")
        alert.window.initialFirstResponder = field
        guard alert.runModal() == .alertFirstButtonReturn, field.stringValue.count >= 10 else { return nil }
        return field.stringValue
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
            // on an account through the connect service (setup's Add this computer hides once it is); none = no service set
            "linked": connectService == nil ? NSNull() : linkedHere,
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
        ]
    }
}
