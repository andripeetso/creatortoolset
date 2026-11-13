import AppKit
import ApplicationServices
import CoreGraphics
import XCTest
@testable import CreatorToolsetMac

// The dictation code's own tests, carried over with it (Sources/CreatorToolsetMac/Dictation).

final class GestureTests: XCTestCase {
    private let down = Gesture.Input.hotkeyDown(othersHeld: false)

    func testHoldStartsAndTranscribes() {
        var g = Gesture()
        XCTAssertEqual(g.handle(down, at: 10), .start)
        XCTAssertTrue(g.isHeld)
        XCTAssertEqual(g.handle(.hotkeyUp, at: 11.2), .transcribe)
        XCTAssertFalse(g.isHeld)
    }

    func testShortHoldIsDiscarded() {
        var g = Gesture()
        XCTAssertEqual(g.handle(down, at: 10), .start)
        XCTAssertEqual(g.handle(.hotkeyUp, at: 10.29), .cancel)
        XCTAssertFalse(g.isHeld)
    }

    func testHoldOfExactlyTheMinimumTranscribes() {
        var g = Gesture()
        _ = g.handle(down, at: 0)
        XCTAssertEqual(g.handle(.hotkeyUp, at: Gesture.minimumHold), .transcribe)
    }

    func testAnotherModifierCancelsAndTheRestOfTheHoldIsIgnored() {
        var g = Gesture()
        XCTAssertEqual(g.handle(down, at: 0), .start)
        XCTAssertEqual(g.handle(.otherModifier, at: 1), .cancel)
        XCTAssertNil(g.handle(.otherModifier, at: 2))
        XCTAssertTrue(g.isHeld)
        XCTAssertNil(g.handle(.hotkeyUp, at: 5))
        XCTAssertFalse(g.isHeld)
        // The next hold records again.
        XCTAssertEqual(g.handle(down, at: 6), .start)
    }

    func testPressWithAnotherModifierHeldDoesNotRecord() {
        var g = Gesture()
        XCTAssertNil(g.handle(.hotkeyDown(othersHeld: true), at: 0))
        XCTAssertTrue(g.isHeld)
        XCTAssertNil(g.handle(.hotkeyUp, at: 3))
        XCTAssertFalse(g.isHeld)
    }

    func testStrayEdgesDoNothing() {
        var g = Gesture()
        XCTAssertNil(g.handle(.hotkeyUp, at: 0))
        XCTAssertNil(g.handle(.otherModifier, at: 0))
        XCTAssertEqual(g.handle(down, at: 1), .start)
        XCTAssertNil(g.handle(down, at: 2))
        XCTAssertEqual(g.handle(.hotkeyUp, at: 3), .transcribe)
    }

    func testResetCancelsARecordingOnly() {
        var g = Gesture()
        XCTAssertNil(g.reset())
        _ = g.handle(down, at: 0)
        XCTAssertEqual(g.reset(), .cancel)
        XCTAssertFalse(g.isHeld)

        _ = g.handle(.hotkeyDown(othersHeld: true), at: 0)
        XCTAssertNil(g.reset())
        XCTAssertFalse(g.isHeld)
    }
}

final class HotkeyMatchTests: XCTestCase {
    private func input(_ keycode: Int64, _ flags: CGEventFlags, _ key: HotkeyKey, held: Bool) -> Gesture.Input? {
        HotkeyMonitor.input(keycode: keycode, flags: flags, key: key, held: held)
    }

    /// Device-dependent low bits, which vary by keyboard and must not matter.
    private let rightOptionDeviceBit = CGEventFlags(rawValue: 0x40)
    private let leftOptionDeviceBit = CGEventFlags(rawValue: 0x20)

    func testKeycodesAndFlags() {
        XCTAssertEqual(HotkeyKey.allCases.map(\.keycode), [63, 58, 61, 55, 54, 59, 62, 56, 60])
        XCTAssertEqual(HotkeyKey.fn.flag, .maskSecondaryFn)
        XCTAssertEqual(HotkeyKey.rightOption.flag, .maskAlternate)
        XCTAssertEqual(HotkeyKey.leftCommand.flag, .maskCommand)
        XCTAssertEqual(HotkeyKey.rightControl.flag, .maskControl)
        XCTAssertEqual(HotkeyKey.leftShift.flag, .maskShift)
    }

    func testRightOptionMatchesItsOwnSideOnly() {
        let key = HotkeyKey.rightOption
        XCTAssertEqual(input(61, [.maskAlternate, rightOptionDeviceBit], key, held: false), .hotkeyDown(othersHeld: false))
        // Left option sets the same flag; it is not the hotkey.
        XCTAssertNil(input(58, [.maskAlternate, leftOptionDeviceBit], key, held: false))
        // A keyboard that sets no device bits still matches by keycode.
        XCTAssertEqual(input(61, .maskAlternate, key, held: false), .hotkeyDown(othersHeld: false))
    }

    func testReleaseByKeycodeWithFlagClear() {
        XCTAssertEqual(input(61, [], .rightOption, held: true), .hotkeyUp)
    }

    func testReleaseWhileTheOtherSideHoldsTheSharedFlag() {
        XCTAssertEqual(input(54, .maskCommand, .rightCommand, held: true), .hotkeyUp)
    }

    func testFlagClearOnAnyEventWhileHeldIsARelease() {
        // A missed release: the next modifier event shows the flag gone.
        XCTAssertEqual(input(56, .maskShift, .rightCommand, held: true), .hotkeyUp)
    }

    func testOtherModifierWhileHeldIsAChord() {
        XCTAssertEqual(input(55, .maskCommand, .rightCommand, held: true), .otherModifier)
        XCTAssertEqual(input(56, [.maskCommand, .maskShift], .rightCommand, held: true), .otherModifier)
        XCTAssertEqual(input(58, [.maskSecondaryFn, .maskAlternate], .fn, held: true), .otherModifier)
    }

    func testCapsLockAndUnknownKeycodesAreNotChords() {
        XCTAssertNil(input(57, [.maskCommand, .maskAlphaShift], .rightCommand, held: true))
        XCTAssertNil(input(179, .maskSecondaryFn, .fn, held: true))
    }

    func testPressWithAnotherModifierDownIsAChord() {
        XCTAssertEqual(input(61, [.maskAlternate, .maskCommand], .rightOption, held: false), .hotkeyDown(othersHeld: true))
        XCTAssertEqual(input(63, [.maskSecondaryFn, .maskShift], .fn, held: false), .hotkeyDown(othersHeld: true))
    }

    func testFnMatchesByFlagAsBefore() {
        XCTAssertEqual(input(63, .maskSecondaryFn, .fn, held: false), .hotkeyDown(othersHeld: false))
        // Any event with the fn flag set is a press, whatever its keycode.
        XCTAssertEqual(input(179, .maskSecondaryFn, .fn, held: false), .hotkeyDown(othersHeld: false))
        XCTAssertNil(input(63, .maskSecondaryFn, .fn, held: true))
        XCTAssertEqual(input(63, [], .fn, held: true), .hotkeyUp)
        XCTAssertNil(input(63, [], .fn, held: false))
    }

    func testOtherKeysDoNothingWhenIdle() {
        XCTAssertNil(input(55, .maskCommand, .rightCommand, held: false))
        XCTAssertNil(input(54, [], .rightCommand, held: false))
    }
}

final class HotkeyRecoveryTests: XCTestCase {
    private let t0 = Date(timeIntervalSinceReferenceDate: 0)

    func testBackoffDoublesFromOneSecondToThirty() {
        let delays = (0...8).map { TapRecovery.delay(afterFailures: $0) }
        XCTAssertEqual(delays, [0, 1, 2, 4, 8, 16, 30, 30, 30])
        XCTAssertEqual(TapRecovery.delay(afterFailures: 10_000), 30)
    }

    func testFirstDisableReenablesAtOnce() {
        var recovery = TapRecovery()
        XCTAssertEqual(recovery.disabled(at: t0), 0)
        XCTAssertEqual(recovery.failures, 0)
    }

    func testFailedEnableBacksOff() {
        var recovery = TapRecovery()
        XCTAssertEqual(recovery.disabled(at: t0), 0)
        XCTAssertEqual(recovery.enableFailed(), 1)
        XCTAssertEqual(recovery.enableFailed(), 2)
        XCTAssertEqual(recovery.enableFailed(), 4)
    }

    /// Secure Input can undo each re-enable at once. That must back off
    /// rather than loop.
    func testReenableUndoneQuicklyCountsAsFailure() {
        var recovery = TapRecovery()
        XCTAssertEqual(recovery.disabled(at: t0), 0)
        recovery.enabled(at: t0)
        XCTAssertEqual(recovery.disabled(at: t0 + 0.1), 1)
        recovery.enabled(at: t0 + 1.1)
        XCTAssertEqual(recovery.disabled(at: t0 + 1.2), 2)
        recovery.enabled(at: t0 + 3.2)
        XCTAssertEqual(recovery.disabled(at: t0 + 3.3), 4)
    }

    func testStableTapStartsOver() {
        var recovery = TapRecovery()
        _ = recovery.disabled(at: t0)
        _ = recovery.enableFailed()
        _ = recovery.enableFailed()
        recovery.enabled(at: t0 + 10)
        let later = t0 + 10 + TapRecovery.stableInterval
        XCTAssertEqual(recovery.disabled(at: later), 0)
        XCTAssertEqual(recovery.failures, 0)
    }

    func testResyncEmitsOnlyAMissedRelease() {
        XCTAssertEqual(HotkeyMonitor.resyncEvent(wasPressed: true, heldNow: false), .released)
        XCTAssertNil(HotkeyMonitor.resyncEvent(wasPressed: true, heldNow: true))
        XCTAssertNil(HotkeyMonitor.resyncEvent(wasPressed: false, heldNow: true))
        XCTAssertNil(HotkeyMonitor.resyncEvent(wasPressed: false, heldNow: false))
    }

}

final class DeliveryTests: XCTestCase {
    private func element(_ pid: pid_t) -> FocusedElement {
        FocusedElement(AXUIElementCreateApplication(pid))
    }

    private func focus(pid: pid_t? = 100, element: FocusedElement? = nil, secure: Bool = false) -> FocusSnapshot {
        FocusSnapshot(pid: pid, element: element, isSecure: secure)
    }

    func testUnchangedFocusInjects() {
        let start = focus(element: element(1))
        XCTAssertEqual(DeliveryDecision.decide(start: start, now: focus(element: element(1))), .inject)
    }

    func testSecureFieldAtStartOrDeliveryDiscards() {
        XCTAssertEqual(DeliveryDecision.decide(start: focus(secure: true), now: focus()), .discardSecure)
        XCTAssertEqual(DeliveryDecision.decide(start: focus(), now: focus(secure: true)), .discardSecure)
        XCTAssertEqual(DeliveryDecision.decide(start: nil, now: focus(secure: true)), .discardSecure)
    }

    /// Secure wins over drift: a password field never gets the clipboard.
    func testSecureFieldAfterDriftStillDiscards() {
        XCTAssertEqual(DeliveryDecision.decide(start: focus(pid: 1), now: focus(pid: 2, secure: true)), .discardSecure)
    }

    /// Clicking around while talking: the text goes where focus is at the end.
    func testMovedFocusStillInjects() {
        XCTAssertEqual(DeliveryDecision.decide(start: focus(pid: 1), now: focus(pid: 2)), .inject)
        XCTAssertEqual(DeliveryDecision.decide(start: focus(element: element(1)), now: focus(element: element(2))), .inject)
    }

    func testNoStartSnapshotInjects() {
        XCTAssertEqual(DeliveryDecision.decide(start: nil, now: focus(pid: 7)), .inject)
    }

    func testUserMessagesNeverCarryText() {
        XCTAssertEqual(DeliveryError.secureField.userMessage, "password field, transcript discarded")
    }
}

final class SpacingTests: XCTestCase {
    private func spaced(_ text: String, after before: TextBeforeCursor = .unknown) -> String {
        Spacing.spaced(text, before: before)
    }

    func testTrailingSpaceAlways() {
        XCTAssertEqual(spaced("Hello world."), "Hello world. ")
        XCTAssertEqual(spaced("hello"), "hello ")
        XCTAssertEqual(spaced("Next", after: .start), "Next ")
    }

    func testNoTrailingSpaceAfterWhitespace() {
        XCTAssertEqual(spaced("Hello. "), "Hello. ")
        XCTAssertEqual(spaced("Hello\n"), "Hello\n")
    }

    /// A word typed by hand before the cursor.
    func testLeadingSpaceAfterAWordOrPunctuation() {
        XCTAssertEqual(spaced("world", after: .character("o")), " world ")
        XCTAssertEqual(spaced("apples", after: .character("3")), " apples ")
        XCTAssertEqual(spaced("Next", after: .character(".")), " Next ")
        XCTAssertEqual(spaced("next", after: .character(")")), " next ")
    }

    /// After a dictation the cursor follows its trailing space: no double space.
    func testNoLeadingSpaceAfterWhitespaceTheStartOrUnknown() {
        XCTAssertEqual(spaced("Next", after: .character(" ")), "Next ")
        XCTAssertEqual(spaced("Next", after: .character("\n")), "Next ")
        XCTAssertEqual(spaced("Next", after: .character("\t")), "Next ")
        XCTAssertEqual(spaced("Next", after: .start), "Next ")
        XCTAssertEqual(spaced("Next", after: .unknown), "Next ")
    }

    func testNoLeadingSpaceAfterAnOpener() {
        for opener: Character in ["(", "[", "\"", "“", "¿", "/", "@"] {
            XCTAssertEqual(spaced("next", after: .character(opener)), "next ", "after \(opener)")
        }
    }

    func testNoLeadingSpaceBeforePunctuationThatAttaches() {
        XCTAssertEqual(spaced(", and then", after: .character("o")), ", and then ")
        XCTAssertEqual(spaced("?", after: .character("o")), "? ")
        XCTAssertEqual(spaced(" already", after: .character("o")), " already ")
    }

    func testNoSpacesInChineseOrJapanese() {
        XCTAssertEqual(spaced("你好。", after: .character("。")), "你好。")
        XCTAssertEqual(spaced("こんにちは", after: .character("す")), "こんにちは")
        XCTAssertEqual(spaced("你好", after: .character("a")), "你好")
    }

    func testEmptyStaysEmpty() {
        XCTAssertEqual(spaced("", after: .character("o")), "")
    }
}

final class PasteboardSessionTests: XCTestCase {
    private final class FakePasteboard: PasteboardAccess {
        var changeCount = 0
        var contents = PasteboardSnapshot(items: [])
        var writes: [(text: String, markers: [String])] = []

        func snapshot() -> PasteboardSnapshot { contents }

        func restore(_ snapshot: PasteboardSnapshot) {
            contents = snapshot
            changeCount += 1
        }

        func write(_ text: String, markers: [String]) {
            writes.append((text, markers))
            contents = PasteboardSnapshot(items: [
                [PasteboardRepresentation(type: "public.utf8-plain-text", data: Data(text.utf8))]
                    + markers.map { PasteboardRepresentation(type: $0, data: Data()) },
            ])
            changeCount += 1
        }

        var onRead: (() -> Void)?

        func promise(_ text: String, markers: [String], onRead: @escaping () -> Void) {
            write(text, markers: markers)
            self.onRead = onRead
        }

        /// The app the paste went to reads the clipboard.
        func targetReads() { onRead?() }

        /// Another app or the user copies something.
        func externalCopy(_ text: String) {
            contents = PasteboardSnapshot(items: [[PasteboardRepresentation(type: "public.utf8-plain-text", data: Data(text.utf8))]])
            changeCount += 1
        }
    }

    private var pasteboard: FakePasteboard!
    private var pending: [() -> Void] = []
    private var pastes = 0
    private var session: PasteboardSession!

    private let original = PasteboardSnapshot(items: [
        [
            PasteboardRepresentation(type: "public.png", data: Data([0x89, 0x50, 0x4E, 0x47])),
            PasteboardRepresentation(type: "public.tiff", data: Data([0x4D, 0x4D])),
        ],
        [PasteboardRepresentation(type: "public.file-url", data: Data("file:///tmp/a".utf8))],
    ])

    override func setUp() {
        pasteboard = FakePasteboard()
        pasteboard.contents = original
        pending = []
        pastes = 0
        session = PasteboardSession(
            pasteboard: pasteboard,
            settleDelay: 0.25,
            postPaste: { [unowned self] in self.pastes += 1 },
            schedule: { [unowned self] _, work in self.pending.append(work) }
        )
    }

    private func runPending() {
        let work = pending
        pending = []
        work.forEach { $0() }
    }

    func testPasteWritesMarkedTextPostsOnceAndRestores() {
        session.paste("hello")
        XCTAssertEqual(pastes, 1)
        XCTAssertEqual(pasteboard.writes.first?.text, "hello")
        XCTAssertEqual(
            pasteboard.writes.first?.markers,
            ["org.nspasteboard.TransientType", "org.nspasteboard.ConcealedType"]
        )
        XCTAssertTrue(session.isRestorePending)
        runPending()
        XCTAssertEqual(pasteboard.contents, original)
        XCTAssertFalse(session.isRestorePending)
    }

    func testSecondPasteInsideSettleWindowDoesNotResnapshot() {
        session.paste("one")
        session.paste("two")
        XCTAssertEqual(pastes, 2)
        runPending()
        XCTAssertEqual(pasteboard.contents, original)
    }

    func testOnlyTheLatestRestoreRuns() {
        session.paste("one")
        let first = pending.removeFirst()
        session.paste("two")
        first()
        // The first window's restore is stale; "two" may not be read yet.
        XCTAssertEqual(pasteboard.writes.last?.text, "two")
        XCTAssertNotEqual(pasteboard.contents, original)
        runPending()
        XCTAssertEqual(pasteboard.contents, original)
    }

    func testExternalCopyDuringWindowIsKept() {
        session.paste("one")
        pasteboard.externalCopy("user copied this")
        let theirs = pasteboard.contents
        runPending()
        XCTAssertEqual(pasteboard.contents, theirs)
        XCTAssertFalse(session.isRestorePending)
    }

    func testNextPasteAfterRestoreSnapshotsAgain() {
        session.paste("one")
        runPending()
        pasteboard.externalCopy("new clipboard")
        let newer = pasteboard.contents
        session.paste("two")
        runPending()
        XCTAssertEqual(pasteboard.contents, newer)
    }

    func testCopyStaysAndCancelsPendingRestore() {
        session.paste("one")
        session.copy("fallback")
        XCTAssertEqual(pasteboard.writes.last?.markers, ["org.nspasteboard.ConcealedType"])
        runPending()
        XCTAssertEqual(pasteboard.writes.last?.text, "fallback")
        XCTAssertNotEqual(pasteboard.contents, original)
        XCTAssertFalse(session.isRestorePending)
    }

    /// `pending` holds the settle-delay check, then the `maxWait` give-up.
    func testRestoresOnlyOnceTheTargetHasRead() {
        session.paste("hello")
        pending.removeFirst()()  // settle delay passes; a busy app hasn't read yet
        XCTAssertNotEqual(pasteboard.contents, original)
        XCTAssertTrue(session.isRestorePending)
        pasteboard.targetReads()
        pending.removeLast()()  // the restore scheduled by the read
        XCTAssertEqual(pasteboard.contents, original)
        XCTAssertFalse(session.isRestorePending)
    }

    func testAnEarlyReadStillWaitsForTheSettleDelay() {
        session.paste("hello")
        pasteboard.targetReads()
        XCTAssertTrue(session.isRestorePending)
        pending.removeFirst()()
        XCTAssertEqual(pasteboard.contents, original)
    }

    func testAPasteNobodyReadsIsRestoredAtMaxWait() {
        session.paste("hello")
        pending.removeFirst()()
        XCTAssertTrue(session.isRestorePending)
        pending.removeFirst()()
        XCTAssertEqual(pasteboard.contents, original)
    }

    func testAReadOfAnEarlierPasteDoesNotRestore() {
        session.paste("one")
        let firstRead = pasteboard.onRead
        session.paste("two")
        pending[2]()  // the second paste's settle delay
        firstRead?()
        XCTAssertNotEqual(pasteboard.contents, original)
    }

    func testEmptyClipboardRestoresEmpty() {
        pasteboard.contents = PasteboardSnapshot(items: [])
        session.paste("one")
        runPending()
        XCTAssertEqual(pasteboard.contents, PasteboardSnapshot(items: []))
    }
}

/// Round trip through a real, privately named `NSPasteboard`; the user's
/// clipboard is not touched.
final class SystemPasteboardTests: XCTestCase {
    func testSnapshotRestoresEveryRepresentationOfEveryItem() {
        let named = NSPasteboard(name: NSPasteboard.Name("dictation-test-\(UUID().uuidString)"))
        defer { named.releaseGlobally() }
        let first = NSPasteboardItem()
        first.setString("hello", forType: .string)
        first.setData(Data([1, 2, 3]), forType: NSPasteboard.PasteboardType("com.example.custom"))
        let second = NSPasteboardItem()
        second.setString("file:///tmp/a", forType: .fileURL)
        named.clearContents()
        named.writeObjects([first, second])

        let pasteboard = SystemPasteboard(named)
        let saved = pasteboard.snapshot()
        XCTAssertEqual(saved.items.count, 2)

        pasteboard.write("transcript", markers: PasteboardSession.transientMarkers)
        XCTAssertEqual(named.string(forType: .string), "transcript")
        XCTAssertNotNil(named.data(forType: NSPasteboard.PasteboardType("org.nspasteboard.TransientType")))

        var reads = 0
        pasteboard.promise("promised", markers: PasteboardSession.transientMarkers) { reads += 1 }
        let promisedCount = named.changeCount
        XCTAssertEqual(reads, 0)
        XCTAssertEqual(named.string(forType: .string), "promised")
        XCTAssertEqual(reads, 1)
        // Handing the text over is not a change, so the restore still runs.
        XCTAssertEqual(named.changeCount, promisedCount)

        pasteboard.restore(saved)
        XCTAssertEqual(pasteboard.snapshot(), saved)
        XCTAssertEqual(named.pasteboardItems?.first?.data(forType: NSPasteboard.PasteboardType("com.example.custom")), Data([1, 2, 3]))
        XCTAssertEqual(named.pasteboardItems?.last?.string(forType: .fileURL), "file:///tmp/a")
    }
}

final class SanitizeTests: XCTestCase {
    func testStripsNonSpeechTokens() {
        XCTAssertEqual(WhisperKitTranscriber.sanitize("[BLANK_AUDIO]"), "")
        XCTAssertEqual(WhisperKitTranscriber.sanitize("(silence)"), "")
        XCTAssertEqual(WhisperKitTranscriber.sanitize("<|nospeech|>"), "")
        XCTAssertEqual(WhisperKitTranscriber.sanitize("*background noise*"), "")
    }

    func testKeepsSpeechAndCollapsesWhitespace() {
        XCTAssertEqual(
            WhisperKitTranscriber.sanitize("  Hello [MUSIC]  there (music playing)\n world <|endoftext|> "),
            "Hello there world"
        )
    }

    func testLeavesPlainTextAlone() {
        XCTAssertEqual(WhisperKitTranscriber.sanitize("Ship it on Friday."), "Ship it on Friday.")
    }
}

final class SpokenLanguageTests: XCTestCase {
    private var base: TranscriptionModel { ModelRegistry.find("whisper-base.en")! }
    private var turbo: TranscriptionModel { ModelRegistry.find("whisper-large-v3-turbo")! }

    // MARK: Plan

    func testEnglishOnlyModelIsNeverGivenALanguageOrAskedToDetect() {
        XCTAssertEqual(SpokenLanguage.plan(setting: nil, spoken: ["en", "es"], model: base), .none)
        XCTAssertEqual(SpokenLanguage.plan(setting: "pt", spoken: [], model: base), .none)
        XCTAssertEqual(SpokenLanguage.plan(setting: "en", spoken: [], model: base), .none)
        XCTAssertFalse(base.isMultilingual)
    }

    func testExplicitLanguageIsFixed() {
        XCTAssertEqual(SpokenLanguage.plan(setting: "pt", spoken: ["en", "es"], model: turbo), .fixed("pt"))
        XCTAssertEqual(SpokenLanguage.plan(setting: "SR", spoken: [], model: turbo), .fixed("sr"))
    }

    func testAutomaticDetectsAmongTheSpokenLanguagesOnly() {
        XCTAssertEqual(SpokenLanguage.plan(setting: nil, spoken: ["en", "es"], model: turbo), .detect(among: ["en", "es"]))
    }

    func testOneSpokenLanguageNeedsNoDetection() {
        XCTAssertEqual(SpokenLanguage.plan(setting: nil, spoken: ["es"], model: turbo), .fixed("es"))
        // Repeats and codes the model doesn't know don't count.
        XCTAssertEqual(SpokenLanguage.plan(setting: nil, spoken: ["ES", "es", "tlh"], model: turbo), .fixed("es"))
    }

    func testWithNoUsableSpokenLanguageEveryLanguageCompetes() {
        XCTAssertEqual(SpokenLanguage.plan(setting: nil, spoken: [], model: turbo), .detect(among: []))
        XCTAssertEqual(SpokenLanguage.plan(setting: nil, spoken: ["tlh"], model: turbo), .detect(among: []))
    }

    func testUnknownCodeCountsAsAutomatic() {
        XCTAssertEqual(SpokenLanguage.plan(setting: "xx", spoken: ["en", "es"], model: turbo), .detect(among: ["en", "es"]))
        XCTAssertEqual(SpokenLanguage.plan(setting: "", spoken: ["en", "es"], model: turbo), .detect(among: ["en", "es"]))
    }

    func testMultilingualModelSupportsWhisperLanguages() {
        XCTAssertTrue(turbo.isMultilingual)
        XCTAssertTrue(turbo.supportedLanguages.isSuperset(of: ["en", "pt", "sr", "es", "sv"]))
        XCTAssertEqual(base.supportedLanguages, ["en"])
    }

    // MARK: Probabilities

    func testProbabilitiesAreSharedAmongTheGivenLanguagesOnly() {
        // Logits where Italian would win if it were allowed to compete: it
        // is not passed in, so Spanish takes it among English and Spanish.
        let ranked = SpokenLanguage.probabilities([("en", 1.0), ("es", 4.0)])
        XCTAssertEqual(ranked.map(\.code), ["es", "en"])
        XCTAssertEqual(ranked.map(\.probability).reduce(0, +), 1, accuracy: 1e-5)
        XCTAssertEqual(ranked[0].probability, 0.9526, accuracy: 1e-3)
    }

    func testProbabilitiesSurviveLargeLogits() {
        let ranked = SpokenLanguage.probabilities([("en", 900), ("es", 899)])
        XCTAssertEqual(ranked[0].code, "en")
        XCTAssertFalse(ranked[0].probability.isNaN)
    }

    func testNoScoresNoProbabilities() {
        XCTAssertTrue(SpokenLanguage.probabilities([]).isEmpty)
    }

    // MARK: Preferred languages

    func testPreferredCodesReduceToISO6391InOrderWithoutRepeats() {
        let codes = SpokenLanguage.preferredCodes(["en-US", "pt-BR", "en-GB", "zh-Hans-CN", "sr-Latn-RS", "es"])
        XCTAssertEqual(codes, ["en", "pt", "zh", "sr", "es"])
    }

    // MARK: Names

    func testDisplayNameIsLocalized() {
        XCTAssertEqual(SpokenLanguage.displayName("pt", locale: Locale(identifier: "en_US")), "Portuguese")
        XCTAssertEqual(SpokenLanguage.displayName("pt", locale: Locale(identifier: "pt_BR")), "Português")
    }
}

final class SilenceTrimmerTests: XCTestCase {
    private func tone(_ seconds: Double, level: Float) -> [Float] {
        (0..<Int(seconds * 16_000)).map { level * sin(Float($0) * 2 * .pi * 220 / 16_000) }
    }

    private func noise(_ seconds: Double, level: Float) -> [Float] {
        var generator = SystemRandomNumberGenerator()
        return (0..<Int(seconds * 16_000)).map { _ in Float.random(in: -level...level, using: &generator) }
    }

    func testCutsQuietEdgesAndKeepsMargins() {
        let audio = noise(1.0, level: 0.002) + tone(2.0, level: 0.3) + noise(2.0, level: 0.002)
        let trimmed = SilenceTrimmer.trim(audio)
        let expected = 2.0 + SilenceTrimmer.leadMargin + SilenceTrimmer.trailMargin
        XCTAssertEqual(Double(trimmed.count) / 16_000, expected, accuracy: 0.02)
        let range = SilenceTrimmer.voicedRange(audio)!
        XCTAssertEqual(Double(range.lowerBound) / 16_000, 1.0 - SilenceTrimmer.leadMargin, accuracy: 0.02)
    }

    func testKeepsAudioWithNothingAboveTheFloor() {
        let silence = noise(2.0, level: 0.001)
        XCTAssertEqual(SilenceTrimmer.trim(silence), silence)
        XCTAssertEqual(SilenceTrimmer.trim([]), [])
    }

    func testLeavesSpeechToTheEdgesAlone() {
        let speech = tone(1.0, level: 0.3)
        XCTAssertEqual(SilenceTrimmer.trim(speech).count, speech.count)
    }

    func testKeepsQuietWordsBetweenLoudOnes() {
        // A soft word in the middle is inside the kept range whatever its level.
        let audio = noise(0.5, level: 0.001) + tone(0.5, level: 0.3) + tone(0.5, level: 0.004) + tone(0.5, level: 0.3) + noise(0.5, level: 0.001)
        let range = SilenceTrimmer.voicedRange(audio)!
        XCTAssertLessThanOrEqual(range.lowerBound, 8_000)
        XCTAssertGreaterThanOrEqual(range.upperBound, 32_000)
    }

    func testNoiseLoudEnoughToHideSpeechLeavesTheCaptureWhole() {
        // Noise above 5% of the peak counts as voiced, so nothing is cut.
        let audio = noise(1.0, level: 0.05) + tone(1.0, level: 0.3) + noise(1.0, level: 0.05)
        XCTAssertEqual(SilenceTrimmer.trim(audio).count, audio.count)
    }
}
