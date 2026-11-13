// Quick recording from anywhere: a keyboard shortcut that works in every app (start, and stop while recording) and a
// record button in the menu bar (the time while recording; a click stops). Both are the user's to change: the shortcut
// in "Recording Shortcut…", the button with "Record Button in Menu Bar" (the menu bar panel's gear → Screen Recordings).
import AppKit
import Carbon.HIToolbox
import Combine

/// A key with its modifiers, as Carbon registers it (works without Accessibility permission).
struct Shortcut: Codable, Equatable {
    var keyCode: UInt32
    var carbonModifiers: UInt32
    /// "⌥⇧R"
    var display: String

    static let standard = Shortcut(keyCode: UInt32(kVK_ANSI_R), carbonModifiers: UInt32(optionKey | shiftKey), display: "⌥⇧R")

    /// The shortcut a key press makes, or nil when it has no ⌘, ⌥ or ⌃ (a bare key would type nothing anywhere).
    static func from(keyCode: UInt16, flags: NSEvent.ModifierFlags, characters: String?) -> Shortcut? {
        let flags = flags.intersection([.command, .option, .control, .shift])
        guard !flags.intersection([.command, .option, .control]).isEmpty else { return nil }
        var carbon = 0
        var symbols = ""
        if flags.contains(.control) { carbon |= controlKey; symbols += "⌃" }
        if flags.contains(.option) { carbon |= optionKey; symbols += "⌥" }
        if flags.contains(.shift) { carbon |= shiftKey; symbols += "⇧" }
        if flags.contains(.command) { carbon |= cmdKey; symbols += "⌘" }
        return Shortcut(keyCode: UInt32(keyCode), carbonModifiers: UInt32(carbon), display: symbols + keyName(keyCode, characters))
    }

    private static let named: [Int: String] = [
        kVK_Space: "Space", kVK_Return: "↩", kVK_Tab: "⇥", kVK_F1: "F1", kVK_F2: "F2", kVK_F3: "F3", kVK_F4: "F4",
        kVK_F5: "F5", kVK_F6: "F6", kVK_F7: "F7", kVK_F8: "F8", kVK_F9: "F9", kVK_F10: "F10", kVK_F11: "F11", kVK_F12: "F12",
    ]

    private static func keyName(_ code: UInt16, _ characters: String?) -> String {
        named[Int(code)] ?? (characters ?? "?").uppercased()
    }
}

/// The shortcut and the menu bar button, kept in UserDefaults and applied at once when changed.
@MainActor
final class RecordShortcut: ObservableObject {
    static let shared = RecordShortcut()

    /// nil = no shortcut.
    @Published private(set) var shortcut: Shortcut?
    @Published var showsButton: Bool {
        didSet { UserDefaults.standard.set(showsButton, forKey: "recordMenuBarButton"); applyButton() }
    }

    nonisolated static let signature = OSType(0x4354_5243)   // "CTRC"
    private weak var recorder: Recorder?
    private var hotKey: EventHotKeyRef?
    private var handler: EventHandlerRef?
    private var item: NSStatusItem?
    private var watch: AnyCancellable?
    private var clock: Timer?

    private init() {
        let defaults = UserDefaults.standard
        if defaults.bool(forKey: "recordShortcutOff") {
            shortcut = nil
        } else if let data = defaults.data(forKey: "recordShortcut"), let saved = try? JSONDecoder().decode(Shortcut.self, from: data) {
            shortcut = saved
        } else {
            shortcut = .standard
        }
        showsButton = defaults.object(forKey: "recordMenuBarButton") as? Bool ?? true
    }

    /// Once, at launch: the shortcut and the button start or stop this recorder.
    func install(_ recorder: Recorder) {
        self.recorder = recorder
        var spec = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
        InstallEventHandler(GetApplicationEventTarget(), { _, event, _ in
            // only its own hotkey: dictation registers F13 on the same target
            var id = EventHotKeyID()
            GetEventParameter(event, EventParamName(kEventParamDirectObject), EventParamType(typeEventHotKeyID), nil,
                              MemoryLayout<EventHotKeyID>.size, nil, &id)
            guard id.signature == RecordShortcut.signature else { return OSStatus(eventNotHandledErr) }
            DispatchQueue.main.async { MainActor.assumeIsolated { RecordShortcut.shared.recorder?.toggle() } }
            return noErr
        }, 1, &spec, nil, &handler)
        register()
        applyButton()
        watch = recorder.$phase.sink { [weak self] _ in DispatchQueue.main.async { self?.drawButton() } }
    }

    func set(_ new: Shortcut?) {
        shortcut = new
        let defaults = UserDefaults.standard
        defaults.set(new == nil, forKey: "recordShortcutOff")
        if let new, let data = try? JSONEncoder().encode(new) { defaults.set(data, forKey: "recordShortcut") }
        register()
    }

    private func register() {
        if let hotKey { UnregisterEventHotKey(hotKey) }
        hotKey = nil
        guard let shortcut else { return }
        let id = EventHotKeyID(signature: Self.signature, id: 1)
        let status = RegisterEventHotKey(shortcut.keyCode, shortcut.carbonModifiers, id, GetApplicationEventTarget(), 0, &hotKey)
        if status != noErr { AppLog.write("recording shortcut \(shortcut.display) not available (\(status)): another app has it") }
    }

    // MARK: the menu bar button

    private func applyButton() {
        if showsButton, item == nil {
            let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
            item.button?.target = self
            item.button?.action = #selector(clicked)
            self.item = item
            drawButton()
        } else if !showsButton, let item {
            NSStatusBar.system.removeStatusItem(item)
            self.item = nil
        }
    }

    @objc private func clicked() { recorder?.toggle() }

    private func drawButton() {
        guard let button = item?.button, let recorder else { return }
        let live = recorder.phase == .recording || recorder.phase == .paused
        let symbol = live ? "stop.circle.fill" : "record.circle"
        button.image = NSImage(systemSymbolName: symbol, accessibilityDescription: live ? "Stop recording" : "Record screen")
        button.contentTintColor = live ? .systemRed : nil
        button.imagePosition = .imageLeading
        button.toolTip = live ? "Stop recording" : "Record screen" + (shortcut.map { " (\($0.display))" } ?? "")
        clock?.invalidate()
        clock = nil
        if live {
            let tick = { [weak button, weak recorder] in
                guard let button, let recorder else { return }
                let s = Int(recorder.elapsed)
                button.title = String(format: " %d:%02d", s / 60, s % 60)
            }
            tick()
            clock = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { _ in MainActor.assumeIsolated { tick() } }
        } else {
            button.title = ""
        }
    }

    // MARK: choosing the shortcut

    private var picker: NSPanel?
    private var keyWatch: Any?

    /// A small window that takes the next key press as the shortcut. Esc keeps the old one, Delete turns it off.
    func choose() {
        closePicker()
        let label = NSTextField(wrappingLabelWithString: "Press the new shortcut for recording.\nEsc keeps \(shortcut?.display ?? "none"), Delete turns it off.")
        label.alignment = .center
        label.font = .systemFont(ofSize: 13)
        let panel = NSPanel(contentRect: NSRect(x: 0, y: 0, width: 320, height: 90), styleMask: [.titled, .closable], backing: .buffered, defer: false)
        panel.title = "Recording Shortcut"
        label.frame = NSRect(x: 16, y: 16, width: 288, height: 58)
        panel.contentView?.addSubview(label)
        panel.center()
        panel.level = .floating
        NSApp.activate(ignoringOtherApps: true)
        panel.makeKeyAndOrderFront(nil)
        picker = panel
        // the old shortcut would fire instead of being chosen again
        if let hotKey { UnregisterEventHotKey(hotKey); self.hotKey = nil }
        keyWatch = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            guard let self, event.window === self.picker else { return event }
            switch Int(event.keyCode) {
            case kVK_Escape: self.closePicker()
            case kVK_Delete, kVK_ForwardDelete:
                self.set(nil)
                self.closePicker()
            default:
                guard let new = Shortcut.from(keyCode: event.keyCode, flags: event.modifierFlags, characters: event.charactersIgnoringModifiers) else {
                    NSSound.beep()   // needs ⌘, ⌥ or ⌃
                    return nil
                }
                self.set(new)
                self.closePicker()
            }
            return nil
        }
    }

    private func closePicker() {
        if let keyWatch { NSEvent.removeMonitor(keyWatch) }
        keyWatch = nil
        picker?.orderOut(nil)
        picker = nil
        register()
        drawButton()
    }
}
