// The downloaded update shown where the person works: Restart to Update in the menus and on the page
// (NewVersionPill.tsx), and the checks that find the newest one. When it installs: UpdateWhenIdle.
import AppKit
import Sparkle
import SwiftUI

/// A check at launch (a restart onto an update may already be one behind) and on coming back to the app after 10
/// minutes, besides Sparkle's hourly one. A check does nothing while an update is held: the next one is looked for
/// after it installs.
@MainActor func watchForUpdates(_ updater: SPUUpdater) {
    guard Bundle.main.object(forInfoDictionaryKey: "SUFeedURL") != nil else { return }
    updater.checkForUpdatesInBackground()
    var last = Date()
    NotificationCenter.default.addObserver(forName: NSApplication.didBecomeActiveNotification, object: nil, queue: .main) { _ in
        MainActor.assumeIsolated {
            guard Date().timeIntervalSince(last) > 600 else { return }
            last = Date()
            updater.checkForUpdatesInBackground()
        }
    }
}

/// Sets or clears <html data-mac-update> (JSON: version, critical, since in ms, waiting) and tells the page
/// ('mac-update'), which shows Restart to update (NewVersionPill.tsx).
func macUpdateScript(_ held: UpdateWhenIdle.Held?) -> String {
    let value = held.flatMap { h -> String? in
        let dict: [String: Any] = ["version": h.version, "critical": h.critical,
                                   "since": Int(h.since.timeIntervalSince1970 * 1000), "waiting": h.waiting]
        return (try? JSONSerialization.data(withJSONObject: dict, options: .sortedKeys)).flatMap { String(data: $0, encoding: .utf8) }
    }
    // JSON text inside a JS string; "/" escaped so the text can never close a <script>
    let quoted = value.flatMap { String(data: (try? JSONEncoder().encode($0)) ?? Data(), encoding: .utf8) } ?? "null"
    return "(() => { const u = \(quoted); const d = document.documentElement.dataset; if (u) d.macUpdate = u; else delete d.macUpdate; dispatchEvent(new Event('mac-update')); })();"
}

/// "Check for Updates…", or "Restart to Update" while a downloaded update waits (a check would do nothing then).
struct UpdateMenuItem: View {
    @ObservedObject private var updates = UpdateWhenIdle.shared
    let check: () -> Void

    var body: some View {
        if let held = updates.held {
            Button(held.waiting ? "Updates When Done" : "Restart to Update") { updates.installNow() }.disabled(held.waiting)
        } else {
            Button("Check for Updates…", action: check)
        }
    }
}
