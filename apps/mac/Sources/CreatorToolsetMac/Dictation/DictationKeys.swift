// Dictation's keys, the person's own: one for each of Talk, History, Transcribe a file and Cancel, chosen in Settings →
// AI → Voice → Dictation or in the setup guide (SetupGuide.swift). The picker here is also the recording shortcut's.
import AppKit
import Carbon.HIToolbox
import IOKit.hid

extension HotkeyKey: Codable {
    /// The Carbon modifier this key sets (fn has none).
    var carbonModifier: UInt32? {
        switch flag {
        case .maskAlternate: return UInt32(optionKey)
        case .maskCommand: return UInt32(cmdKey)
        case .maskControl: return UInt32(controlKey)
        case .maskShift: return UInt32(shiftKey)
        default: return nil
        }
    }
}

/// One dictation key: a key or combination pressed (F13, ⌥Space), or, for Talk only, a modifier held while talking.
enum KeyBinding: Codable, Equatable {
    case key(Shortcut)
    case hold(HotkeyKey)

    /// "F13", "⌥Space", "Hold fn"
    var display: String {
        switch self {
        case .key(let s): return s.display
        case .hold(let k): return "Hold \(k.shortName)"
        }
    }

    /// Whether these two can't both be keys: the same combination, the same held key, or a held modifier that a
    /// combination uses (holding it would start talking on the way to the combination).
    func clashes(with other: KeyBinding) -> Bool {
        switch (self, other) {
        case let (.key(a), .key(b)): return a.keyCode == b.keyCode && a.carbonModifiers == b.carbonModifiers
        case let (.hold(a), .hold(b)): return a == b
        case let (.hold(k), .key(s)), let (.key(s), .hold(k)):
            return k.carbonModifier.map { s.carbonModifiers & $0 != 0 } ?? false
        }
    }
}

enum DictationAction: String, CaseIterable {
    case talk, history, file, cancel

    var name: String {
        switch self {
        case .talk: return "Talk"
        case .history: return "History"
        case .file: return "Transcribe a file"
        case .cancel: return "Cancel"
        }
    }
}

extension Shortcut {
    static func function(_ code: Int, _ name: String) -> Shortcut { Shortcut(keyCode: UInt32(code), carbonModifiers: 0, display: name) }
}

struct DictationKeys: Equatable {
    var talk: KeyBinding?
    var history: KeyBinding?
    var file: KeyBinding?
    var cancel: KeyBinding?

    subscript(action: DictationAction) -> KeyBinding? {
        get {
            switch action {
            case .talk: return talk
            case .history: return history
            case .file: return file
            case .cancel: return cancel
            }
        }
        set {
            switch action {
            case .talk: talk = newValue
            case .history: history = newValue
            case .file: file = newValue
            case .cancel: cancel = newValue
            }
        }
    }

    static let functionKeys = DictationKeys(
        talk: .key(.function(kVK_F13, "F13")), history: .key(.function(kVK_F14, "F14")),
        file: .key(.function(kVK_F15, "F15")), cancel: .key(.function(kVK_F16, "F16")))
    /// For a keyboard without F13: hold fn to talk; History and Transcribe a file are in the menu bar panel and Settings.
    static let holdFn = DictationKeys(talk: .hold(.fn))

    /// The keys the first time: F13–F16 where dictation ran before with them, or the keyboard has them; else hold fn.
    static func first(hadDictation: Bool, keyboardHasF13: Bool) -> DictationKeys {
        hadDictation || keyboardHasF13 ? .functionKeys : .holdFn
    }

    /// Why `binding` can't be `action`'s key (nil: the recording shortcut's), in one sentence; nil when it can.
    func problem(_ binding: KeyBinding, for action: DictationAction?, recording: Shortcut?) -> String? {
        if case .hold = binding, action != .talk { return "Only Talk can be a key you hold." }
        for other in DictationAction.allCases where other != action {
            if let theirs = self[other], binding.clashes(with: theirs) {
                return "That clashes with \(other.name) (\(theirs.display))."
            }
        }
        if action != nil, let recording, binding.clashes(with: .key(recording)) {
            return "That clashes with the recording shortcut (\(recording.display))."
        }
        return nil
    }

    // UserDefaults: one JSON value per action; null = none chosen, missing = never set.
    static func defaultsKey(_ action: DictationAction) -> String { "dictation.key.\(action.rawValue)" }

    static func isSaved(_ d: UserDefaults) -> Bool { d.object(forKey: defaultsKey(.talk)) != nil }

    static func load(_ d: UserDefaults) -> DictationKeys? {
        guard isSaved(d) else { return nil }
        var keys = DictationKeys()
        for action in DictationAction.allCases {
            if let data = d.data(forKey: defaultsKey(action)) { keys[action] = try? JSONDecoder().decode(KeyBinding?.self, from: data) ?? nil }
        }
        return keys
    }

    func save(_ d: UserDefaults) {
        for action in DictationAction.allCases {
            d.set(try? JSONEncoder().encode(self[action]), forKey: Self.defaultsKey(action))
        }
    }

    /// Whether a keyboard with F13 is plugged in.
    /// ponytail: by name, Apple's full-size keyboards ("… with Numeric Keypad"); key descriptors list F13 on every
    /// keyboard and mouse alike. A third-party keyboard with F13 isn't recognised: its owner picks the key in the guide.
    static func keyboardHasF13() -> Bool {
        let manager = IOHIDManagerCreate(kCFAllocatorDefault, 0)
        let match: [String: Any] = [kIOHIDDeviceUsagePageKey as String: kHIDPage_GenericDesktop,
                                    kIOHIDDeviceUsageKey as String: kHIDUsage_GD_Keyboard]
        IOHIDManagerSetDeviceMatching(manager, match as CFDictionary)
        let devices = IOHIDManagerCopyDevices(manager) as? Set<IOHIDDevice> ?? []
        return devices.contains { (IOHIDDeviceGetProperty($0, kIOHIDProductKey as CFString) as? String)?.contains("Numeric Keypad") == true }
    }
}

/// The key presses a picker sees, turned into a choice: a key or combination (⌘, ⌥ or ⌃ with a key, or a function key
/// alone), or, when `allowsHold`, a modifier pressed and let go on its own. Pure, so it is tested.
struct KeyCapture {
    enum Result: Equatable {
        case binding(KeyBinding)
        /// Esc: keep the key as it is.
        case keep
        /// Delete: no key.
        case clear
        case refused(String)
    }

    let allowsHold: Bool
    /// A modifier down with nothing else yet.
    private var lone: HotkeyKey?

    init(allowsHold: Bool) { self.allowsHold = allowsHold }

    mutating func keyDown(keyCode: UInt16, flags: NSEvent.ModifierFlags, characters: String?) -> Result {
        lone = nil
        let mods = flags.intersection([.command, .option, .control, .shift])
        if mods.isEmpty, Int(keyCode) == kVK_Escape { return .keep }
        if mods.isEmpty, Int(keyCode) == kVK_Delete || Int(keyCode) == kVK_ForwardDelete { return .clear }
        if let s = Shortcut.from(keyCode: keyCode, flags: flags, characters: characters) { return .binding(.key(s)) }
        return .refused(allowsHold
            ? "Add ⌘, ⌥ or ⌃, use a function key, or hold a key like fn on its own."
            : "Add ⌘, ⌥ or ⌃, or use a function key.")
    }

    mutating func flagsChanged(keyCode: UInt16, flags: NSEvent.ModifierFlags) -> Result? {
        guard allowsHold, let key = HotkeyKey.allCases.first(where: { $0.keycode == Int64(keyCode) }) else {
            lone = nil
            return nil
        }
        let cg = CGEventFlags(rawValue: UInt64(flags.rawValue))
        if cg.contains(key.flag) {
            // down: alone only when no other modifier is held
            let others = cg.intersection(HotkeyMonitor.chordFlags.union(.maskSecondaryFn)).subtracting(key.flag)
            lone = others.isEmpty && lone == nil ? key : nil
            return nil
        }
        defer { lone = nil }
        return lone == key ? .binding(.hold(key)) : nil
    }
}

/// A small window that takes the next key press as a key: Esc keeps the old one, Delete clears it. While it is open no
/// dictation key or recording shortcut works, so pressing one chooses it instead of running it.
@MainActor
enum KeyPicker {
    private static var panel: NSPanel?
    private static var watch: Any?
    private static var label: NSTextField?
    private static var onClose: (() -> Void)?

    /// `check` refuses a key with a sentence; `done` gets the new key, or nil for none. Esc closes without either.
    static func show(title: String, prompt: String, allowsHold: Bool,
                     check: @escaping (KeyBinding) -> String?, done: @escaping (KeyBinding?) -> Void,
                     closed: @escaping () -> Void = {}) {
        close()
        let text = NSTextField(wrappingLabelWithString: prompt)
        text.alignment = .center
        text.font = .systemFont(ofSize: 13)
        let p = NSPanel(contentRect: NSRect(x: 0, y: 0, width: 340, height: 100), styleMask: [.titled, .closable],
                        backing: .buffered, defer: false)
        p.title = title
        p.isReleasedWhenClosed = false
        text.frame = NSRect(x: 16, y: 16, width: 308, height: 68)
        p.contentView?.addSubview(text)
        p.center()
        p.level = .floating
        label = text
        panel = p
        onClose = closed
        pauseKeys(true)
        NSApp.activate(ignoringOtherApps: true)
        p.makeKeyAndOrderFront(nil)
        var capture = KeyCapture(allowsHold: allowsHold)
        watch = NSEvent.addLocalMonitorForEvents(matching: [.keyDown, .flagsChanged]) { event in
            guard let panel, event.window === panel else { return event }
            let result = event.type == .keyDown
                ? capture.keyDown(keyCode: event.keyCode, flags: event.modifierFlags, characters: event.charactersIgnoringModifiers)
                : capture.flagsChanged(keyCode: event.keyCode, flags: event.modifierFlags)
            switch result {
            case .keep: close()
            case .clear: done(nil); close()
            case .binding(let b):
                if let problem = check(b) {
                    NSSound.beep()
                    label?.stringValue = problem + "\nPress another key, or Esc."
                } else {
                    done(b)
                    close()
                }
            case .refused(let why):
                NSSound.beep()
                label?.stringValue = why
            case nil: return event
            }
            return nil
        }
        NotificationCenter.default.addObserver(forName: NSWindow.willCloseNotification, object: p, queue: .main) { _ in
            MainActor.assumeIsolated { if panel === p { close() } }
        }
    }

    static var isOpen: Bool { panel != nil }

    static func close() {
        guard let p = panel else { return }
        panel = nil
        if let watch { NSEvent.removeMonitor(watch) }
        watch = nil
        p.orderOut(nil)
        pauseKeys(false)
        let closed = onClose
        onClose = nil
        closed?()
    }

    /// Every dictation key and the recording shortcut off (true) or back on (false), so a picker sees the key pressed.
    static func pauseKeys(_ paused: Bool) {
        Dictation.shared.keysPaused = paused
        RecordShortcut.shared.pause(paused)
    }
}
