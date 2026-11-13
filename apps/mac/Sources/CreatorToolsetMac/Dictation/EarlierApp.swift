// The dictation app this one grew out of takes the same keys (F13–F16) and pastes too. While it runs, dictation here
// registers no keys and pastes nothing; it comes back by itself when that app quits (Dictation `apply`, which watches
// apps start and quit). Every place that registers a dictation key asks `EarlierDictationApp.isRunning()`.
import AppKit

enum EarlierDictationApp {
    /// Its CFBundleIdentifier, read from its Info.plist.
    static let bundleID = "com.humanitas.parrot"

    /// Whether it runs now.
    static func isRunning() -> Bool {
        running(among: NSWorkspace.shared.runningApplications.map(\.bundleIdentifier))
    }

    static func running(among ids: [String?]) -> Bool { ids.contains(bundleID) }

    /// Whether dictation here listens: on, and the earlier app not running. Pure, so it is tested.
    static func listens(on: Bool, earlierRunning: Bool) -> Bool { on && !earlierRunning }

    /// What Settings shows while it runs (`bridgeState` `paused`).
    static let pausedLine = "Off while your other dictation app is open"
}

/// Pasting, unless the earlier app runs (it opened while the words were being written down): then nothing is pasted,
/// and the words wait in History.
@MainActor
final class UnlessEarlierApp: Delivering {
    private let inner: Delivering
    private let running: () -> Bool

    init(_ inner: Delivering, running: @escaping () -> Bool = EarlierDictationApp.isRunning) {
        self.inner = inner
        self.running = running
    }

    func deliver(_ text: String, focusAtStart: FocusSnapshot?) throws {
        if running() { throw EarlierAppOpen() }
        try inner.deliver(text, focusAtStart: focusAtStart)
    }
}

struct EarlierAppOpen: UserFacingError {
    var userMessage: String { "Not pasted: your other dictation app is open · in History" }
}
