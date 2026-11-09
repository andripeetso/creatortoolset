// Settings → This Mac on the site (apps/captions ThisMacSection.tsx): the page sends `thismac-<what>` on the window
// handler (TitleBar.swift) and every message is answered with this app's state as a `mac-this` event. The app keeps
// all of it (servers, Use this Mac for my AI); the page only shows it. Worker buttons are plug-in rows (LaunchAgent.swift).
import Foundation

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
            "problem": problem ?? NSNull(),
            "servers": listed.map { ["id": $0.id, "name": $0.name, "url": $0.url, "current": $0.id == current] as [String: Any] },
        ]
    }
}
