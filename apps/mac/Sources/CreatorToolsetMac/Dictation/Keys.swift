import AppKit
import ApplicationServices
import Carbon.HIToolbox
import CoreGraphics
import Foundation

/// Turns hotkey edges into dictation actions . Pure, so the rules
/// are tested without an event tap.
///
/// The tap sees modifier changes only, so it cannot see the C in ⌘C. Two
/// rules keep a shortcut typed on the hotkey from producing text:
/// - A hold shorter than `minimumHold` is discarded without transcribing.
/// - A recording is cancelled if another modifier changes while the hotkey
///   is held, and a press while another modifier is already held does not
///   record. Either way the rest of that hold is ignored.
///
/// Recording still starts on key-down, so press latency is unchanged; a
/// discarded hold just throws its audio away.
struct Gesture {
    /// Holds shorter than this are taps or shortcuts, not dictation.
    static let minimumHold: TimeInterval = 0.3

    enum Input: Equatable {
        /// The hotkey went down. `othersHeld`: another modifier was already
        /// down, so this is a chord.
        case hotkeyDown(othersHeld: Bool)
        /// The hotkey went up.
        case hotkeyUp
        /// Another modifier changed while the hotkey was down.
        case otherModifier
    }

    enum Action: Equatable {
        /// Start recording.
        case start
        /// Stop recording and transcribe.
        case transcribe
        /// Stop recording and discard it.
        case cancel
    }

    private enum Phase: Equatable {
        case idle
        /// Recording since this time.
        case recording(since: TimeInterval)
        /// The hotkey is down but this hold is a chord: ignore it until release.
        case ignoring
    }

    private var phase: Phase = .idle

    /// Whether the hotkey is down, as far as the edges seen so far say.
    var isHeld: Bool { phase != .idle }

    /// Feed one edge at `time` (seconds on a monotonic clock).
    mutating func handle(_ input: Input, at time: TimeInterval) -> Action? {
        switch (phase, input) {
        case (.idle, .hotkeyDown(let othersHeld)):
            if othersHeld {
                phase = .ignoring
                return nil
            }
            phase = .recording(since: time)
            return .start
        case (.recording(let since), .hotkeyUp):
            phase = .idle
            return time - since < Self.minimumHold ? .cancel : .transcribe
        case (.recording, .otherModifier):
            phase = .ignoring
            return .cancel
        case (.ignoring, .hotkeyUp):
            phase = .idle
            return nil
        default:
            // A repeated down, an up with no down seen, or a modifier change
            // outside a recording.
            return nil
        }
    }

    /// Forget the current hold, for a switch to another key. A recording in
    /// progress is cancelled.
    mutating func reset() -> Action? {
        defer { phase = .idle }
        if case .recording = phase { return .cancel }
        return nil
    }
}

/// The modifiers that can be held to talk. The raw value is what Settings and
/// UserDefaults store.
enum HotkeyKey: String, CaseIterable, Sendable {
    case fn
    case leftOption = "left-option"
    case rightOption = "right-option"
    case leftCommand = "left-command"
    case rightCommand = "right-command"
    case leftControl = "left-control"
    case rightControl = "right-control"
    case leftShift = "left-shift"
    case rightShift = "right-shift"

    /// How Settings names the key.
    var displayName: String {
        switch self {
        case .fn: return "fn (Globe)"
        case .leftOption: return "Left Option (⌥)"
        case .rightOption: return "Right Option (⌥)"
        case .leftCommand: return "Left Command (⌘)"
        case .rightCommand: return "Right Command (⌘)"
        case .leftControl: return "Left Control (⌃)"
        case .rightControl: return "Right Control (⌃)"
        case .leftShift: return "Left Shift (⇧)"
        case .rightShift: return "Right Shift (⇧)"
        }
    }

    /// The short name in "hold fn": "fn", "right ⌥".
    var shortName: String {
        switch self {
        case .fn: return "fn"
        case .leftOption: return "left ⌥"
        case .rightOption: return "right ⌥"
        case .leftCommand: return "left ⌘"
        case .rightCommand: return "right ⌘"
        case .leftControl: return "left ⌃"
        case .rightControl: return "right ⌃"
        case .leftShift: return "left ⇧"
        case .rightShift: return "right ⇧"
        }
    }

    /// The virtual keycode a `flagsChanged` event carries for this key
    /// (`kVK_Function`, `kVK_Option`, `kVK_RightOption`, …).
    var keycode: Int64 {
        switch self {
        case .fn: return 63
        case .leftOption: return 58
        case .rightOption: return 61
        case .leftCommand: return 55
        case .rightCommand: return 54
        case .leftControl: return 59
        case .rightControl: return 62
        case .leftShift: return 56
        case .rightShift: return 60
        }
    }

    /// The device-independent flag this key sets. Left and right share it.
    var flag: CGEventFlags {
        switch self {
        case .fn: return .maskSecondaryFn
        case .leftOption, .rightOption: return .maskAlternate
        case .leftCommand, .rightCommand: return .maskCommand
        case .leftControl, .rightControl: return .maskControl
        case .leftShift, .rightShift: return .maskShift
        }
    }
}

/// Whether the hold key's tap is receiving events. Written to the log when it is not.
enum HotkeyHealth: Equatable {
    case ok
    /// Re-enabling keeps failing while Secure Input is on (a password field,
    /// or Terminal's Secure Keyboard Entry).
    case secureInputActive
    /// Re-enabling keeps failing for another reason.
    case tapDisabled

    static func degraded(secureInput: Bool) -> HotkeyHealth {
        secureInput ? .secureInputActive : .tapDisabled
    }
}

/// When to re-enable a disabled event tap. Pure, so the schedule is tested.
///
/// The first disable is re-enabled at once. A re-enable that fails, or that
/// macOS undoes within `stableInterval`, counts as a failure, and the next
/// attempt waits 1 s, doubling to 30 s. A tap that stays enabled for
/// `stableInterval` starts over from an immediate re-enable.
struct TapRecovery {
    static let firstDelay: TimeInterval = 1
    static let maxDelay: TimeInterval = 30
    static let stableInterval: TimeInterval = 10

    /// Consecutive re-enables that did not stick.
    private(set) var failures = 0
    /// When the last re-enable took, if it has not been undone since.
    private var enabledAt: Date?

    /// Seconds to wait before the next attempt after `failures` failures.
    static func delay(afterFailures failures: Int) -> TimeInterval {
        guard failures > 0 else { return 0 }
        let exponent = Double(min(failures - 1, 16))
        return min(firstDelay * pow(2, exponent), maxDelay)
    }

    /// The tap was found disabled. Returns seconds to wait before re-enabling.
    mutating func disabled(at now: Date) -> TimeInterval {
        if let enabledAt, now.timeIntervalSince(enabledAt) < Self.stableInterval {
            failures += 1
        } else {
            failures = 0
        }
        enabledAt = nil
        return Self.delay(afterFailures: failures)
    }

    /// `tapEnable` did not take. Returns seconds to wait before the next try.
    mutating func enableFailed() -> TimeInterval {
        failures += 1
        enabledAt = nil
        return Self.delay(afterFailures: failures)
    }

    /// `tapEnable` took and `tapIsEnabled` confirmed it.
    mutating func enabled(at now: Date) {
        enabledAt = now
    }
}

/// Watches a single modifier key (default: fn) and emits dictation edges.
/// Requires Accessibility permission. If the tap fails to register, callers
/// will see an error from `start()`.
///
/// Side-specific keys are matched by the keycode on each `flagsChanged`
/// event, because left and right share one `CGEventFlags` bit and the
/// device-dependent low bits vary by keyboard. Fn is matched by its flag, as
/// it always was. Edges go through `Gesture`, which discards short taps and
/// chords, so a shortcut typed on the hotkey produces no text.
///
/// macOS disables a tap that is slow to respond or that user input disables.
/// The monitor re-enables it, with backoff when that does not stick, checks
/// it on a watchdog timer in case a disable event is missed, and reports a
/// tap it cannot recover through `onHealthChange`.
///
/// Everything here runs on the main thread: the tap's run loop source, the
/// watchdog and the retries are all on the main run loop.
final class HotkeyMonitor {
    enum Event: Equatable {
        /// Start recording.
        case pressed
        /// Stop recording and transcribe.
        case released
        /// Stop recording and discard it: a short tap, a chord, or a key switch.
        case cancelled
    }
    enum HotkeyError: Error { case tapCreateFailed }

    /// How often the watchdog checks that the tap is still enabled.
    static let watchdogInterval: TimeInterval = 5

    /// The modifier held to dictate. Change it with `setKey(_:)`.
    private(set) var key: HotkeyKey
    private var onEvent: ((Event) -> Void)?
    private var tap: CFMachPort?
    private var runLoopSource: CFRunLoopSource?
    private var gesture = Gesture()

    private var recovery = TapRecovery()
    private var pendingRetry: DispatchWorkItem?
    private var watchdog: Timer?

    /// Called on the main thread when the tap's health changes.
    var onHealthChange: ((HotkeyHealth) -> Void)?
    private(set) var health: HotkeyHealth = .ok {
        didSet {
            if health != oldValue { onHealthChange?(health) }
        }
    }

    init(key: HotkeyKey = .fn) {
        self.key = key
    }

    /// Switch to another key without recreating the tap; the next press of
    /// `newKey` records. A recording in progress on the old key is cancelled.
    func setKey(_ newKey: HotkeyKey) {
        guard newKey != key else { return }
        let action = gesture.reset()
        key = newKey
        if let action { emit(action) }
    }

    func start(onEvent: @escaping (Event) -> Void) throws {
        self.onEvent = onEvent

        // The caller waits for the grant before starting (Dictation.installTaps);
        // this is a guard, not the place that asks.
        if !AXIsProcessTrusted() {
            throw HotkeyError.tapCreateFailed
        }

        // flagsChanged only. Do not
        // widen this mask: keyDown/keyUp would route every keystroke,
        // password fields included, through a process that holds
        // Accessibility, and the extra work per keystroke makes macOS more
        // likely to disable the tap for being slow. The hotkey is a modifier,
        // so flagsChanged carries everything we need.
        let mask: CGEventMask = 1 << CGEventType.flagsChanged.rawValue
        let userInfo = Unmanaged.passUnretained(self).toOpaque()

        // .cgSessionEventTap is the right level for an accessibility-granted
        // user process (.cghidEventTap requires root).
        guard
            let tap = CGEvent.tapCreate(
                tap: .cgSessionEventTap,
                place: .headInsertEventTap,
                options: .listenOnly,
                eventsOfInterest: mask,
                callback: hotkeyCallback,
                userInfo: userInfo
            )
        else {
            throw HotkeyError.tapCreateFailed
        }

        let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
        CFRunLoopAddSource(CFRunLoopGetMain(), source, .commonModes)
        CGEvent.tapEnable(tap: tap, enable: true)

        self.tap = tap
        self.runLoopSource = source

        let watchdog = Timer(timeInterval: Self.watchdogInterval, repeats: true) { [weak self] _ in
            self?.checkTap()
        }
        RunLoop.main.add(watchdog, forMode: .common)
        self.watchdog = watchdog
    }

    func stop() {
        watchdog?.invalidate()
        watchdog = nil
        pendingRetry?.cancel()
        pendingRetry = nil
        if let tap {
            CGEvent.tapEnable(tap: tap, enable: false)
        }
        if let source = runLoopSource {
            CFRunLoopRemoveSource(CFRunLoopGetMain(), source, .commonModes)
        }
        tap = nil
        runLoopSource = nil
        onEvent = nil
    }

    fileprivate func handle(event: CGEvent) {
        let flags = event.flags
        // flagsChanged carries the modifier's keycode, never a character.
        let keycode = event.getIntegerValueField(.keyboardEventKeycode)
        guard let input = Self.input(keycode: keycode, flags: flags, key: key, held: gesture.isHeld) else { return }
        feed(input)
    }

    private func feed(_ input: Gesture.Input) {
        if let action = gesture.handle(input, at: ProcessInfo.processInfo.systemUptime) {
            emit(action)
        }
    }

    private func emit(_ action: Gesture.Action) {
        switch action {
        case .start: onEvent?(.pressed)
        case .transcribe: onEvent?(.released)
        case .cancel: onEvent?(.cancelled)
        }
    }

    // MARK: - Matching

    /// The modifier keycodes that count as another key in a chord: both
    /// sides of ⌘ ⇧ ⌥ ⌃, and fn. Caps Lock and unknown keycodes do not.
    static let modifierKeycodes: Set<Int64> = [54, 55, 56, 58, 59, 60, 61, 62, 63]
    /// Flags that mean another modifier is down at the press.
    static let chordFlags: CGEventFlags = [.maskShift, .maskControl, .maskAlternate, .maskCommand]

    /// What one `flagsChanged` event means for `key`, given whether the key
    /// is already held. Pure, so the matching is tested without a tap.
    ///
    /// - Press: the key's keycode arrives with its flag set (fn: its flag is
    ///   set on any event).
    /// - Release: the key's keycode arrives again, or its flag is clear on
    ///   any event while held, which also covers a missed release.
    /// - Another modifier's keycode while held is a chord.
    static func input(keycode: Int64, flags: CGEventFlags, key: HotkeyKey, held: Bool) -> Gesture.Input? {
        let flagSet = flags.contains(key.flag)
        if held {
            if !flagSet { return .hotkeyUp }
            // Our side went up while the other side still holds the shared flag.
            if key != .fn, keycode == key.keycode { return .hotkeyUp }
            if keycode != key.keycode, modifierKeycodes.contains(keycode) { return .otherModifier }
            return nil
        }
        guard flagSet, key == .fn || keycode == key.keycode else { return nil }
        let others = flags.intersection(chordFlags).subtracting(key.flag)
        return .hotkeyDown(othersHeld: !others.isEmpty)
    }

    // MARK: - Recovery

    fileprivate func tapWasDisabled(_ type: CGEventType) {
        noteDisabled(reason: type == .tapDisabledByTimeout ? "timeout" : "user input")
    }

    /// The tap is off. Re-enable now, or later if earlier attempts did not
    /// stick. A retry already scheduled covers any further disable events.
    private func noteDisabled(reason: String) {
        guard tap != nil, pendingRetry == nil else { return }
        let delay = recovery.disabled(at: Date())
        if delay == 0 {
            reenable(reason: reason)
        } else {
            scheduleRetry(after: delay, reason: reason)
        }
    }

    private func reenable(reason: String) {
        pendingRetry = nil
        guard let tap else { return }
        CGEvent.tapEnable(tap: tap, enable: true)
        guard CGEvent.tapIsEnabled(tap: tap) else {
            scheduleRetry(after: recovery.enableFailed(), reason: reason)
            return
        }
        recovery.enabled(at: Date())
        DictationLog.info("hotkey tap disabled (\(reason)); re-enabled")
        health = .ok
        resync()
    }

    private func scheduleRetry(after delay: TimeInterval, reason: String) {
        let secureInput = IsSecureEventInputEnabled()
        health = .degraded(secureInput: secureInput)
        let detail = secureInput ? ", secure input active" : ""
        DictationLog.warning("hotkey tap disabled (\(reason)\(detail)); retrying in \(Int(delay))s")
        let retry = DispatchWorkItem { [weak self] in
            self?.reenable(reason: reason)
        }
        pendingRetry = retry
        DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: retry)
    }

    /// Watchdog tick: catches a disable whose event never arrived.
    private func checkTap() {
        guard let tap, pendingRetry == nil else { return }
        if !CGEvent.tapIsEnabled(tap: tap) {
            noteDisabled(reason: "watchdog")
        }
    }

    /// While the tap was off, the hotkey may have been released unseen.
    private func resync() {
        let held = CGEventSource.flagsState(.combinedSessionState).contains(key.flag)
        guard Self.resyncEvent(wasPressed: gesture.isHeld, heldNow: held) != nil else { return }
        feed(.hotkeyUp)
    }

    /// The edge to emit after re-enabling, given what the monitor last saw
    /// and what the keyboard holds now. Only a missed release is emitted: a
    /// press missed while the tap was off does not start a recording halfway
    /// through, and its release is then ignored because no press was seen.
    static func resyncEvent(wasPressed: Bool, heldNow: Bool) -> Event? {
        wasPressed && !heldNow ? .released : nil
    }
}

private func hotkeyCallback(
    proxy: CGEventTapProxy,
    type: CGEventType,
    event: CGEvent,
    userInfo: UnsafeMutableRawPointer?
) -> Unmanaged<CGEvent>? {
    guard let userInfo else { return Unmanaged.passUnretained(event) }
    let monitor = Unmanaged<HotkeyMonitor>.fromOpaque(userInfo).takeUnretainedValue()

    // Return at once and do the work on the next main run loop turn: a slow
    // callback is what gets a tap disabled by timeout.
    if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
        DispatchQueue.main.async {
            monitor.tapWasDisabled(type)
        }
        return Unmanaged.passUnretained(event)
    }

    guard type == .flagsChanged, let copy = event.copy() else {
        return Unmanaged.passUnretained(event)
    }
    DispatchQueue.main.async {
        monitor.handle(event: copy)
    }
    return Unmanaged.passUnretained(event)
}

/// System-wide dictation keys, the person's own (DictationKeys.swift): a key with its modifiers, F13 or ⌥Space.
/// An event tap rather than `RegisterEventHotKey`: macOS's
/// own shortcuts (F14/F15 are display brightness) win over Carbon hotkeys,
/// but a tap sees the key first. The tap is at the HID level, ahead of every
/// session tap: display tools re-create their session taps at the head on
/// each wake and display change, and would otherwise take F14/F15 for
/// brightness. Bound keys are swallowed, so nothing else also runs its
/// action; every other key passes straight through untouched, after one
/// set lookup.
///
/// The tap is an active one, so every key press on the Mac waits for its
/// callback. It runs on a thread of its own, never the main thread, where a
/// page or an alert could hold up typing everywhere; the callback only looks
/// the key up and hands the action to the main thread.
@MainActor
final class FunctionKeys {
    static let shared = FunctionKeys()

    private var actions: [UInt64: () -> Void] = [:]
    private var tap: CFMachPort?
    private var retry: Timer?
    private var watchdog: Timer?
    private var thread: Thread?

    /// Bound keys, read by the tap's thread.
    nonisolated let keycodes = KeycodeSet()

    /// Whether the tap is on (it needs Accessibility).
    var isOn: Bool { tap != nil }

    /// Replaces every binding. Empty: the tap stays but swallows nothing.
    func bind(_ bindings: [(key: Shortcut, action: () -> Void)]) {
        actions = Dictionary(bindings.map { (keyCombo($0.key.keyCode, $0.key.carbonModifiers), $0.action) }, uniquingKeysWith: { $1 })
        keycodes.set(Set(actions.keys))
        DictationLog.info("keys: \(bindings.map(\.key.display))")
        if !actions.isEmpty { installTap() }
    }

    fileprivate func fire(_ combo: UInt64) {
        actions[combo]?()
    }

    fileprivate func reenable() {
        if let tap, !CGEvent.tapIsEnabled(tap: tap) {
            DictationLog.info("function key tap disabled; re-enabled")
            CGEvent.tapEnable(tap: tap, enable: true)
        }
    }

    /// Needs Accessibility; until it's granted, tries again every 2 s.
    private func installTap() {
        guard tap == nil, retry == nil else { return }
        let mask: CGEventMask = (1 << CGEventType.keyDown.rawValue) | (1 << CGEventType.keyUp.rawValue)
        guard AXIsProcessTrusted(), let tap = CGEvent.tapCreate(
            tap: .cghidEventTap,
            place: .headInsertEventTap,
            options: .defaultTap,  // not listenOnly, so bound keys can be swallowed
            eventsOfInterest: mask,
            callback: functionKeyCallback,
            userInfo: Unmanaged.passUnretained(self).toOpaque()
        ) else {
            retry = Timer.scheduledTimer(withTimeInterval: 2, repeats: false) { [weak self] _ in
                MainActor.assumeIsolated {
                    self?.retry = nil
                    self?.installTap()
                }
            }
            return
        }
        // handed to the tap's thread once, and only used there
        nonisolated(unsafe) let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
        nonisolated(unsafe) let port = tap
        let thread = Thread {
            CFRunLoopAddSource(CFRunLoopGetCurrent(), source, .commonModes)
            CGEvent.tapEnable(tap: port, enable: true)
            CFRunLoopRun()
        }
        thread.name = "dictation.function-keys"
        thread.qualityOfService = .userInteractive
        thread.start()
        self.thread = thread
        self.tap = tap
        DictationLog.info("function key tap on")
        // macOS can switch a tap off without an event saying so.
        watchdog = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.reenable() }
        }
    }
}

/// One key with its modifiers, as the tap matches it: the keycode, and the Carbon modifiers above it.
func keyCombo(_ keyCode: UInt32, _ carbonModifiers: UInt32) -> UInt64 { UInt64(carbonModifiers) << 32 | UInt64(keyCode) }

/// An event's ⌘ ⌥ ⌃ ⇧ as Carbon modifiers; fn, the keypad and Caps Lock don't count (F13 arrives with fn set).
func carbonModifiers(_ flags: CGEventFlags) -> UInt32 {
    var m = 0
    if flags.contains(.maskCommand) { m |= cmdKey }
    if flags.contains(.maskAlternate) { m |= optionKey }
    if flags.contains(.maskControl) { m |= controlKey }
    if flags.contains(.maskShift) { m |= shiftKey }
    return UInt32(m)
}

/// The bound keys the tap's thread reads while the main thread may replace them, and the keys it swallowed a key-down
/// of: their key-up is swallowed too, even when a modifier was let go first.
final class KeycodeSet: @unchecked Sendable {
    private let lock = NSLock()
    private var combos: Set<UInt64> = []
    private var down: Set<Int64> = []

    func set(_ new: Set<UInt64>) {
        lock.lock()
        combos = new
        lock.unlock()
    }

    /// A key-down: whether it is bound (and is now down).
    func press(_ keycode: Int64, modifiers: UInt32) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        guard combos.contains(keyCombo(UInt32(keycode), modifiers)) else { return false }
        down.insert(keycode)
        return true
    }

    /// A key-up: whether its key-down was swallowed.
    func release(_ keycode: Int64) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        return down.remove(keycode) != nil
    }
}

/// What the tap does with one key event: swallow it or let it through, and whether to run the key's action (a first
/// key-down, not a repeat). `bound`: a bound key-down, or the key-up of one. Pure, so it is tested.
func functionKeyVerdict(bound: Bool, keyDown: Bool, autorepeat: Bool) -> (swallow: Bool, fire: Bool) {
    guard bound else { return (false, false) }
    return (true, keyDown && !autorepeat)
}

/// Runs on the tap's own thread.
private func functionKeyCallback(
    proxy: CGEventTapProxy, type: CGEventType, event: CGEvent, userInfo: UnsafeMutableRawPointer?
) -> Unmanaged<CGEvent>? {
    guard let userInfo else { return Unmanaged.passUnretained(event) }
    let keys = Unmanaged<FunctionKeys>.fromOpaque(userInfo).takeUnretainedValue()
    if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
        DispatchQueue.main.async { MainActor.assumeIsolated { keys.reenable() } }
        return Unmanaged.passUnretained(event)
    }
    let keycode = event.getIntegerValueField(.keyboardEventKeycode)
    let modifiers = carbonModifiers(event.flags)
    let keyDown = type == .keyDown
    let verdict = functionKeyVerdict(
        bound: keyDown ? keys.keycodes.press(keycode, modifiers: modifiers) : keys.keycodes.release(keycode),
        keyDown: keyDown,
        autorepeat: event.getIntegerValueField(.keyboardEventAutorepeat) != 0
    )
    if verdict.fire {
        let combo = keyCombo(UInt32(keycode), modifiers)
        DispatchQueue.main.async { MainActor.assumeIsolated { keys.fire(combo) } }
    }
    return verdict.swallow ? nil : Unmanaged.passUnretained(event)
}
