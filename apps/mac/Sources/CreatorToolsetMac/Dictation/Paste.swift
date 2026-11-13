import AppKit
import ApplicationServices
import CoreGraphics
import Foundation

/// How a transcript is inserted at the cursor. Paste is the default.
///
/// Paste works in every app that supports paste, including the terminals and
/// Electron editors that ignore `type-unicode` and drop its text with no
/// error. It borrows the clipboard until the target app has read it, at
/// least `TextInjector.settleDelay`, and always restores it. `type-unicode` leaves the clipboard alone.
enum InjectMode: String, CaseIterable, Sendable {
    case paste
    case typeUnicode = "type-unicode"
}

/// Inserts text at the current cursor location by synthesizing keyboard
/// events: ⌘V over the clipboard (`.paste`) or Unicode key events
/// (`.typeUnicode`).
///
/// Every event comes from a private `CGEventSource` with its flags set
/// explicitly. An event with a nil source inherits the modifiers the user is
/// holding, so a held Control or Fn turned typed text into shortcuts.
@MainActor
final class TextInjector {
    /// Where every synthesized event is posted. One constant, so the app
    /// matrix in #38 can switch it in one line if a location fails there.
    ///
    /// `.cgSessionEventTap` enters where hardware events enter the login
    /// session, so the event reaches the focused app exactly as a key press
    /// would. Our own tap is `.listenOnly` and returns every event
    /// unchanged, so it cannot swallow what we post. `.cghidEventTap` posts
    /// below the session, where the window server can merge in the physical
    /// modifier state; `.cgAnnotatedSessionEventTap` skips the session taps
    /// other tools install. Neither has a reason we can verify.
    static let postLocation: CGEventTapLocation = .cgSessionEventTap

    /// The least time the clipboard is borrowed for, even once it has been
    /// read, in case the first reader was not the target app.
    static let settleDelay: TimeInterval = 0.25

    /// Virtual keycode for V on ANSI layouts (kVK_ANSI_V).
    private static let keycodeV: CGKeyCode = 9

    /// `CGEventKeyboardSetUnicodeString` takes about 20 UTF-16 units per event.
    private static let chunkSize = 20

    let mode: InjectMode
    private let clipboard: PasteboardSession

    init(mode: InjectMode, pasteboard: NSPasteboard = .general) {
        self.mode = mode
        self.clipboard = PasteboardSession(
            pasteboard: SystemPasteboard(pasteboard),
            settleDelay: Self.settleDelay,
            postPaste: Self.postCommandV
        )
    }

    /// Inserts `text` at the cursor.
    func inject(_ text: String) {
        guard !text.isEmpty else { return }
        switch mode {
        case .paste: clipboard.paste(text)
        case .typeUnicode: Self.typeUnicode(text)
        }
    }

    private static func postCommandV() {
        let source = CGEventSource(stateID: .privateState)
        guard
            let down = CGEvent(keyboardEventSource: source, virtualKey: keycodeV, keyDown: true),
            let up = CGEvent(keyboardEventSource: source, virtualKey: keycodeV, keyDown: false)
        else { return }
        down.flags = .maskCommand
        up.flags = .maskCommand
        down.post(tap: postLocation)
        up.post(tap: postLocation)
    }

    private static func typeUnicode(_ text: String) {
        let source = CGEventSource(stateID: .privateState)
        let utf16 = Array(text.utf16)
        var index = 0
        while index < utf16.count {
            var end = min(index + chunkSize, utf16.count)
            // Keep a surrogate pair in one event.
            if end < utf16.count, UTF16.isLeadSurrogate(utf16[end - 1]) {
                end -= 1
            }
            var chunk = Array(utf16[index..<end])
            guard
                let down = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: true),
                let up = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: false)
            else { return }
            down.flags = []
            up.flags = []
            // Payload on key-down only: some apps insert a key-up payload too,
            // which typed every chunk twice.
            down.keyboardSetUnicodeString(stringLength: chunk.count, unicodeString: &chunk)
            down.post(tap: postLocation)
            up.post(tap: postLocation)
            index = end
        }
    }
}

// MARK: - Clipboard

/// One representation of one pasteboard item.
struct PasteboardRepresentation: Equatable {
    var type: String
    var data: Data
}

/// Every representation of every item on a pasteboard, so text, images and
/// copied Finder files all come back.
struct PasteboardSnapshot: Equatable {
    var items: [[PasteboardRepresentation]]
}

/// The pasteboard operations paste mode needs. `NSPasteboard` in the app,
/// a fake in tests.
protocol PasteboardAccess: AnyObject {
    var changeCount: Int { get }
    func snapshot() -> PasteboardSnapshot
    func restore(_ snapshot: PasteboardSnapshot)
    /// Replaces the contents with `text`, plus an empty item of each marker type.
    func write(_ text: String, markers: [String])
    /// Like `write`, but the text is only handed over when an app asks for
    /// it, and `onRead` runs then.
    func promise(_ text: String, markers: [String], onRead: @escaping () -> Void)
}

/// Borrows the clipboard for a paste and gives it back.
///
/// `paste` saves the clipboard, promises the text, posts ⌘V and restores the
/// saved clipboard once the text has been read and the settle delay has
/// passed, or after `maxWait` if nothing reads it. A fixed delay was not
/// enough: a busy app handled ⌘V after the restore and pasted the clipboard
/// from before, often an earlier transcript. A second paste before the
/// restore keeps the first snapshot, so the user's own clipboard comes back,
/// not an earlier transcript. If anything else writes the clipboard during
/// the window, that write wins and nothing is restored over it.
final class PasteboardSession {
    /// nspasteboard.org markers: clipboard managers skip these items.
    static let transientMarkers = ["org.nspasteboard.TransientType", "org.nspasteboard.ConcealedType"]
    /// A clipboard fallback is meant to stay, but is still kept out of history.
    static let concealedMarkers = ["org.nspasteboard.ConcealedType"]
    /// How long a paste waits to be read before the clipboard comes back anyway.
    static let maxWait: TimeInterval = 3

    typealias Schedule = (TimeInterval, @escaping () -> Void) -> Void

    private let pasteboard: PasteboardAccess
    private let settleDelay: TimeInterval
    private let postPaste: () -> Void
    private let schedule: Schedule

    /// The user's clipboard while a restore is pending.
    private var saved: PasteboardSnapshot?
    /// The change count right after our last write.
    private var ourChangeCount = 0
    /// Bumped on every write; only the latest scheduled restore runs.
    private var generation = 0
    /// Whether the latest paste has been read, and its settle delay has passed.
    private var read = false
    private var settled = false
    private var pastedAt: CFAbsoluteTime = 0

    init(
        pasteboard: PasteboardAccess,
        settleDelay: TimeInterval,
        postPaste: @escaping () -> Void,
        schedule: @escaping Schedule = { delay, work in
            DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: work)
        }
    ) {
        self.pasteboard = pasteboard
        self.settleDelay = settleDelay
        self.postPaste = postPaste
        self.schedule = schedule
    }

    var isRestorePending: Bool { saved != nil }

    func paste(_ text: String) {
        if saved == nil {
            saved = pasteboard.snapshot()
        }
        generation += 1
        let current = generation
        read = false
        settled = false
        pastedAt = CFAbsoluteTimeGetCurrent()
        pasteboard.promise(text, markers: Self.transientMarkers) { [weak self] in
            self?.didRead(current)
        }
        ourChangeCount = pasteboard.changeCount
        postPaste()
        schedule(settleDelay) { [weak self] in
            self?.didSettle(current)
        }
        schedule(Self.maxWait) { [weak self] in
            self?.giveUp(current)
        }
    }

    private func didRead(_ expected: Int) {
        guard expected == generation, !read else { return }
        read = true
        DictationLog.info(String(format: "  paste read after %.0f ms", (CFAbsoluteTimeGetCurrent() - pastedAt) * 1000))
        // Not from inside the read: the reader is still being handed the text.
        guard settled else { return }
        schedule(0) { [weak self] in
            self?.restore(ifGeneration: expected)
        }
    }

    private func didSettle(_ expected: Int) {
        guard expected == generation else { return }
        settled = true
        if read { restore(ifGeneration: expected) }
    }

    private func giveUp(_ expected: Int) {
        guard expected == generation, saved != nil else { return }
        if !read { DictationLog.info("  paste not read in \(Int(Self.maxWait)) s; clipboard restored") }
        restore(ifGeneration: expected)
    }

    /// Puts `text` on the clipboard to stay. Drops any pending restore, which
    /// would otherwise overwrite it.
    func copy(_ text: String) {
        saved = nil
        generation += 1
        pasteboard.write(text, markers: Self.concealedMarkers)
        ourChangeCount = pasteboard.changeCount
    }

    private func restore(ifGeneration expected: Int) {
        guard expected == generation, let snapshot = saved else { return }
        saved = nil
        guard pasteboard.changeCount == ourChangeCount else {
            DictationLog.info("  clipboard changed during paste; not restoring")
            return
        }
        pasteboard.restore(snapshot)
    }
}

/// `PasteboardAccess` over an `NSPasteboard`.
final class SystemPasteboard: PasteboardAccess {
    private let pasteboard: NSPasteboard

    init(_ pasteboard: NSPasteboard) {
        self.pasteboard = pasteboard
    }

    var changeCount: Int { pasteboard.changeCount }

    func snapshot() -> PasteboardSnapshot {
        let items = (pasteboard.pasteboardItems ?? []).map { item in
            item.types.compactMap { type in
                item.data(forType: type).map { PasteboardRepresentation(type: type.rawValue, data: $0) }
            }
        }
        return PasteboardSnapshot(items: items)
    }

    func restore(_ snapshot: PasteboardSnapshot) {
        pasteboard.clearContents()
        let items = snapshot.items.map { representations -> NSPasteboardItem in
            let item = NSPasteboardItem()
            for representation in representations {
                item.setData(representation.data, forType: NSPasteboard.PasteboardType(representation.type))
            }
            return item
        }
        if !items.isEmpty {
            pasteboard.writeObjects(items)
        }
    }

    func write(_ text: String, markers: [String]) {
        pasteboard.clearContents()
        let item = NSPasteboardItem()
        item.setString(text, forType: .string)
        for marker in markers {
            item.setData(Data(), forType: NSPasteboard.PasteboardType(marker))
        }
        pasteboard.writeObjects([item])
    }

    /// Kept here as well as by the item, until the next write replaces it.
    private var provider: PromisedText?

    func promise(_ text: String, markers: [String], onRead: @escaping () -> Void) {
        pasteboard.clearContents()
        let item = NSPasteboardItem()
        let provider = PromisedText(text: text, onRead: onRead)
        item.setDataProvider(provider, forTypes: [.string])
        for marker in markers {
            item.setData(Data(), forType: NSPasteboard.PasteboardType(marker))
        }
        pasteboard.writeObjects([item])
        self.provider = provider
    }
}

/// Hands over the text when an app reads the clipboard. macOS calls it on
/// the main thread.
private final class PromisedText: NSObject, NSPasteboardItemDataProvider {
    let text: String
    let onRead: () -> Void

    init(text: String, onRead: @escaping () -> Void) {
        self.text = text
        self.onRead = onRead
    }

    func pasteboard(_ pasteboard: NSPasteboard?, item: NSPasteboardItem, provideDataForType type: NSPasteboard.PasteboardType) {
        item.setString(text, forType: type)
        onRead()
    }
}

/// A transcript that was not inserted at the cursor, with the line the
/// overlay shows.
enum DeliveryError: UserFacingError, Equatable {
    /// A password field had focus at start or at delivery. Nothing was typed
    /// or copied.
    case secureField

    var userMessage: String {
        switch self {
        case .secureField: return "password field, transcript discarded"
        }
    }
}

/// Where a finished transcript goes. Pure, so it is tested.
enum DeliveryDecision: Equatable {
    /// Insert at the cursor.
    case inject
    /// A secure field had focus at start or at delivery: drop the transcript.
    case discardSecure

    /// Goes wherever focus is at delivery, even if it moved during the
    /// dictation: clicking around while talking and back before stopping is
    /// normal. `start` is nil when no recording start was seen.
    static func decide(start: FocusSnapshot?, now: FocusSnapshot) -> DeliveryDecision {
        if start?.isSecure == true || now.isSecure { return .discardSecure }
        return .inject
    }
}

/// The delivery step of the dictation loop: checks for a password field at
/// recording start and now, then injects or discards. An
/// injected transcript gets a trailing space, and a leading one when the
/// text before the cursor needs it (`Spacing`).
@MainActor
final class TextDelivery {
    private let injector: TextInjector

    init(mode: InjectMode) {
        self.injector = TextInjector(mode: mode)
    }

    /// Throws `DeliveryError` when the transcript did not reach the cursor.
    func deliver(_ text: String, focusAtStart: FocusSnapshot?) throws {
        guard !text.isEmpty else { return }
        let now = FocusSnapshot.capture()
        switch DeliveryDecision.decide(start: focusAtStart, now: now) {
        case .inject:
            let before = now.element?.textBeforeCursor() ?? .unknown
            let spaced = Spacing.spaced(text, before: before)
            // The kind of character only: the log never carries text.
            DictationLog.info("  before cursor: \(before.kind)\(spaced.first == " " && text.first != " " ? " · leading space" : "")")
            injector.inject(spaced)
        case .discardSecure:
            let when = focusAtStart?.isSecure == true ? "recording start" : "delivery"
            DictationLog.info("  secure field focused at \(when); transcript discarded")
            throw DeliveryError.secureField
        }
    }
}

/// What had keyboard focus at one moment: the frontmost app, its focused
/// element, and whether that element is a secure (password) field.
///
/// Taken at recording start and again right before delivery, over
/// Accessibility, so delivery needs no watch on keystrokes or clicks.
struct FocusSnapshot {
    /// The frontmost app, if any.
    var pid: pid_t?
    /// The focused element, if the app exposes one over Accessibility.
    var element: FocusedElement?
    /// The focused element is a secure text field or reports protected content.
    var isSecure: Bool

    /// Upper bound on each Accessibility call, so a hung app cannot stall
    /// the main thread (and with it the hotkey tap).
    private static let messagingTimeout: Float = 0.25

    @MainActor
    static func capture() -> FocusSnapshot {
        let pid = NSWorkspace.shared.frontmostApplication?.processIdentifier
        let systemWide = AXUIElementCreateSystemWide()
        // On the system-wide element, this sets the timeout for every element.
        AXUIElementSetMessagingTimeout(systemWide, messagingTimeout)

        var value: CFTypeRef?
        let status = AXUIElementCopyAttributeValue(systemWide, kAXFocusedUIElementAttribute as CFString, &value)
        guard status == .success, let value, CFGetTypeID(value) == AXUIElementGetTypeID() else {
            return FocusSnapshot(pid: pid, element: nil, isSecure: false)
        }
        let element = value as! AXUIElement
        return FocusSnapshot(pid: pid, element: FocusedElement(element), isSecure: isSecure(element))
    }

    /// Secure only when the element says so. An element that cannot be read
    /// is not treated as secure, or every app without Accessibility support
    /// would lose its dictation.
    private static func isSecure(_ element: AXUIElement) -> Bool {
        var subrole: CFTypeRef?
        if AXUIElementCopyAttributeValue(element, kAXSubroleAttribute as CFString, &subrole) == .success,
           let subrole = subrole as? String,
           subrole == kAXSecureTextFieldSubrole as String {
            return true
        }
        var protected: CFTypeRef?
        let attribute = NSAccessibility.Attribute.containsProtectedContent.rawValue as CFString
        if AXUIElementCopyAttributeValue(element, attribute, &protected) == .success,
           let protected = protected as? Bool {
            return protected
        }
        return false
    }
}

/// An Accessibility element compared by identity (`CFEqual`).
struct FocusedElement: Equatable {
    let ref: AXUIElement

    init(_ ref: AXUIElement) {
        self.ref = ref
    }

    static func == (lhs: FocusedElement, rhs: FocusedElement) -> Bool {
        CFEqual(lhs.ref, rhs.ref)
    }

    /// The character before the insertion point, for `Spacing`. Reads the
    /// selected range, then the text just before it. Ranges count UTF-16
    /// units, so two are read and the last character kept: one alone could
    /// be half an emoji. Falls back to the whole value for apps without
    /// `AXStringForRange`. Call after `FocusSnapshot.capture()`, which sets
    /// the timeout, and never on a secure field.
    func textBeforeCursor() -> TextBeforeCursor {
        var rangeValue: CFTypeRef?
        guard AXUIElementCopyAttributeValue(ref, kAXSelectedTextRangeAttribute as CFString, &rangeValue) == .success,
              let rangeValue, CFGetTypeID(rangeValue) == AXValueGetTypeID() else { return .unknown }
        var range = CFRange()
        guard AXValueGetValue(rangeValue as! AXValue, .cfRange, &range), range.location >= 0 else { return .unknown }
        // Terminals such as Ghostty report position 0 wherever the cursor
        // is, so 0 is the start only in a field that is empty.
        if range.location == 0 { return characterCount() == 0 ? .start : .unknown }

        let length = min(range.location, 2)
        var before = CFRange(location: range.location - length, length: length)
        var text: CFTypeRef?
        if let query = AXValueCreate(.cfRange, &before),
           AXUIElementCopyParameterizedAttributeValue(ref, kAXStringForRangeParameterizedAttribute as CFString, query, &text) == .success,
           let character = (text as? String)?.last {
            return .character(character)
        }

        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(ref, kAXValueAttribute as CFString, &value) == .success,
              let value = value as? String else { return .unknown }
        let units = value.utf16
        guard range.location <= units.count else { return .unknown }
        let end = units.index(units.startIndex, offsetBy: range.location)
        let start = units.index(end, offsetBy: -length)
        return String(units[start..<end]).flatMap { $0.last }.map(TextBeforeCursor.character) ?? .unknown
    }

    /// The field's length in UTF-16 units, from `AXNumberOfCharacters` or
    /// else the value; nil when the app says neither.
    private func characterCount() -> Int? {
        var count: CFTypeRef?
        if AXUIElementCopyAttributeValue(ref, kAXNumberOfCharactersAttribute as CFString, &count) == .success,
           let count = count as? Int {
            return count
        }
        var value: CFTypeRef?
        if AXUIElementCopyAttributeValue(ref, kAXValueAttribute as CFString, &value) == .success,
           let value = value as? String {
            return value.utf16.count
        }
        return nil
    }
}

/// What comes right before the insertion point in the focused field, read
/// over Accessibility at delivery.
enum TextBeforeCursor: Equatable {
    /// The app did not say: no element, no selected range, or no text.
    case unknown
    /// The cursor is at the start of the field.
    case start
    /// The character just before the cursor, or before the selection a
    /// paste would replace.
    case character(Character)

    /// For the log, which never carries text: "letter", not the letter.
    var kind: String {
        switch self {
        case .unknown: return "unknown"
        case .start: return "start"
        case .character(let c) where c.isNewline: return "newline"
        case .character(let c) where c.isWhitespace: return "space"
        case .character(let c) where c.isLetter || c.isNumber: return "letter"
        case .character: return "punctuation"
        }
    }
}

/// Spaces around a transcript, so consecutive dictations don't run
/// together ("works well.The only thing"). Whisper never starts or ends a
/// transcript with one. Pure, so it is tested.
enum Spacing {
    /// Characters after which a word follows with no space: brackets and
    /// quotes that open, and the marks that start a handle or a path.
    private static let openers: Set<Character> = [
        "(", "[", "{", "<", "\"", "'", "“", "‘", "«", "‹", "¿", "¡", "/", "@", "#",
    ]

    /// Characters a transcript can start with that attach to the text before
    /// them: ", and then", "…".
    private static let attaching: Set<Character> = [
        ".", ",", ";", ":", "!", "?", ")", "]", "}", "…", "%", "”", "’", "»", "›",
    ]

    /// The text to insert. A trailing space always, so the next dictation
    /// or word follows on; it shows at once and needs nothing from the app.
    /// A leading space only when the app says the text before the cursor
    /// needs one, as after a word typed by hand. Unknown adds none: after
    /// a dictation, its trailing space is already there.
    static func spaced(_ text: String, before: TextBeforeCursor) -> String {
        var spaced = text
        if case .character(let preceding) = before, needsSpace(after: preceding, text: text) {
            spaced = " " + spaced
        }
        if let last = text.last, !last.isWhitespace, !isSpaceless(last) {
            spaced += " "
        }
        return spaced
    }

    /// Whether `text` needs a space to follow `preceding`.
    static func needsSpace(after preceding: Character, text: String) -> Bool {
        guard let first = text.first else { return false }
        if preceding.isWhitespace || first.isWhitespace { return false }
        if openers.contains(preceding) || attaching.contains(first) { return false }
        // Chinese, Japanese and Thai put no spaces between words.
        if isSpaceless(preceding) || isSpaceless(first) { return false }
        return true
    }

    private static func isSpaceless(_ character: Character) -> Bool {
        guard let scalar = character.unicodeScalars.first else { return false }
        switch scalar.value {
        case 0x0E00...0x0E7F, // Thai
             0x3000...0x303F, // CJK symbols and punctuation
             0x3040...0x30FF, // Hiragana and Katakana
             0x3400...0x4DBF, // CJK Extension A
             0x4E00...0x9FFF, // CJK Unified Ideographs
             0xFF00...0xFFEF, // Fullwidth forms
             0x20000...0x2FA1F: // CJK Extensions B and later
            return true
        default:
            return false
        }
    }
}
