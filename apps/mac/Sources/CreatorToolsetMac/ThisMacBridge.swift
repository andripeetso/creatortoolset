// Settings → This Mac on the site (apps/captions ThisMacSection.tsx): the page sends `thismac-<what>` on the window
// handler (TitleBar.swift) and every message is answered with this app's state as a `mac-this` event. The app keeps
// all of it (servers, Use this Mac for my AI); the page only shows it. Worker buttons are plug-in rows (LaunchAgent.swift).
import AppKit
import Foundation

/// The questions the page may ask over the "thisMac" handler (TitleBar.swift); any other is answered as off.
let thisMacAsks = ["state", "start", "access", "folder"]

extension Shell {
    /// One `thismac-<what>` message: state, ai:on|off, select:<id>, add:<text>, rename:<id>:<name>, remove:<id>, forget.
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
        open.message = "Choose the folder with your videos. Nothing is moved or uploaded."
        guard open.runModal() == .OK, let url = open.url else { return ["path": NSNull()] }
        return ["path": url.path]
    }

    /// The owner's new password for other devices, typed in a sheet of this app (nil: cancelled or too short).
    @MainActor private func askNewOwnerPassword() -> String? {
        let field = NSSecureTextField(frame: NSRect(x: 0, y: 0, width: 260, height: 24))
        let alert = NSAlert()
        alert.messageText = "Choose this computer's password"
        alert.informativeText = "Phones and other computers ask for it once, when they first sign in. Six characters or more."
        alert.accessoryView = field
        alert.addButton(withTitle: "Turn on")
        alert.addButton(withTitle: "Cancel")
        alert.window.initialFirstResponder = field
        guard alert.runModal() == .alertFirstButtonReturn, field.stringValue.count >= 6 else { return nil }
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
            // this Mac's device id on the open server: the page's Connect binds its AI to it (setup's AI step)
            "device": DeviceVault.deviceID(for: base.host ?? "") ?? NSNull(),
            "problem": problem ?? NSNull(),
            "servers": listed.map { ["id": $0.id, "name": $0.name, "url": $0.url, "current": $0.id == current] as [String: Any] },
        ]
    }
}
