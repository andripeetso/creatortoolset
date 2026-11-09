// Screen recording permission. The first Record click asks macOS only (its own prompt, no app alert). While the switch
// is still off after that, a Record click shows one alert: open System Settings, or quit and reopen the app. macOS
// applies a new grant only to a process that starts after it, so after the user visits Settings the app offers the
// reopen once (on the next activation), never on every activation.
import AppKit
import CoreGraphics

/// What a Record click does next.
enum ScreenAccessStep: Equatable {
    case requestSystem   // first time ever: macOS's own prompt, nothing from the app
    case showAlert       // asked before and still off: the app's alert
    case proceed         // granted
}

/// The decision for a Record click (pure, so it is tested).
func screenAccessStep(requestedBefore: Bool, granted: Bool) -> ScreenAccessStep {
    if granted { return .proceed }
    return requestedBefore ? .showAlert : .requestSystem
}

/// After the app becomes active: offer the reopen once if the user went to Settings from our alert and it still reads off.
func offerReopenAfterSettings(awaiting: Bool, granted: Bool) -> Bool { awaiting && !granted }

@MainActor
enum ScreenPermission {
    private static let requestedKey = "screenCaptureRequested"
    private static let awaitingKey = "screenCaptureAwaitingSettings"
    private static let settingsURL = "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"
    private static var activation: NSObjectProtocol?

    static var granted: Bool { CGPreflightScreenCaptureAccess() }

    /// Runs the decision for a Record click. True = the app may record now.
    static func check() -> Bool {
        let defaults = UserDefaults.standard
        switch screenAccessStep(requestedBefore: defaults.bool(forKey: requestedKey), granted: granted) {
        case .proceed:
            return true
        case .requestSystem:
            defaults.set(true, forKey: requestedKey)
            CGRequestScreenCaptureAccess()
        case .showAlert:
            let a = alert("Allow screen recording",
                          "Turn on Creator Toolset in System Settings → Privacy & Security → Screen & System Audio Recording, then reopen the app.")
            a.addButton(withTitle: "Open System Settings")
            a.addButton(withTitle: "Quit & Reopen")
            a.addButton(withTitle: "Cancel")
            switch a.runModal() {
            case .alertFirstButtonReturn:
                defaults.set(true, forKey: awaitingKey)
                if let url = URL(string: settingsURL) { NSWorkspace.shared.open(url) }
            case .alertSecondButtonReturn:
                relaunch()
            default:
                break
            }
        }
        return false
    }

    /// Call once at launch: after the user comes back from Settings, one reopen offer if the switch still reads off.
    static func watchActivation() {
        guard activation == nil else { return }
        activation = NotificationCenter.default.addObserver(forName: NSApplication.didBecomeActiveNotification, object: nil, queue: .main) { _ in
            MainActor.assumeIsolated {
                let defaults = UserDefaults.standard
                let awaiting = defaults.bool(forKey: awaitingKey)
                defaults.set(false, forKey: awaitingKey)   // one offer per visit to Settings
                guard offerReopenAfterSettings(awaiting: awaiting, granted: granted) else { return }
                let a = alert("Quit and reopen to finish",
                              "Screen recording is still off for Creator Toolset. If you turned it on, macOS needs the app restarted to use it.")
                a.addButton(withTitle: "Quit & Reopen")
                a.addButton(withTitle: "Cancel")
                if a.runModal() == .alertFirstButtonReturn { relaunch() }
            }
        }
    }

    /// Quits, then opens this app again once the old process has gone (a new process gets the new grant).
    private static func relaunch() {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/sh")
        process.arguments = ["-c", "while kill -0 \"$1\" 2>/dev/null; do sleep 0.2; done; /usr/bin/open -n \"$2\"",
                             "sh", String(ProcessInfo.processInfo.processIdentifier), Bundle.main.bundleURL.path]
        try? process.run()
        NSApp.terminate(nil)
    }

    private static func alert(_ title: String, _ text: String) -> NSAlert {
        let a = NSAlert()
        a.messageText = title
        a.informativeText = text
        return a
    }
}
