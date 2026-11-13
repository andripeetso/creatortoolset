// Dictation: talk, and the words are pasted where the cursor is. F13 starts and stops, holding fn (or the key chosen in
// Settings) talks while held, F14 opens History, F15 transcribes a file, F16 cancels. On from the first launch, but
// nothing asks for a permission and nothing downloads until the person first presses a talk key. Its settings live in
// the site's Settings → General → Dictation (ThisMacBridge.swift answers with `bridgeState`, `command` sets them).
// Speech is turned into text on this Mac by Whisper through WhisperKit (THIRD_PARTY_NOTICES.md).
import AppKit
import AVFoundation
import Carbon.HIToolbox
import WhisperKit

/// Dictation's lines in the app's log. Never transcript text: counts and timings only.
enum DictationLog {
    static func info(_ message: String) { AppLog.write("dictation: \(message.trimmingCharacters(in: .whitespaces))") }
    static func warning(_ message: String) { info("warning: \(message)") }
    static func error(_ message: String) { info(message) }
}

enum DictationPaths {
    private static var home: URL { FileManager.default.homeDirectoryForCurrentUser }
    /// This app's own folder: downloaded models and saved recordings.
    static var base: URL {
        home.appendingPathComponent("Library/Application Support/Creator Toolset\(AppIdentity.tag())/dictation", isDirectory: true)
    }
    static var recordings: URL { base.appendingPathComponent("recordings", isDirectory: true) }
    /// Where the dictation app this one grew out of kept its models. A model already there is loaded from there as it
    /// is, never downloaded again, changed or removed.
    static var earlier: URL { home.appendingPathComponent("Library/Application Support/parrot", isDirectory: true) }
}

/// Where a model's files are, under a WhisperKit download base.
enum ModelFiles {
    static func folder(_ variant: String, in base: URL) -> URL {
        base.appendingPathComponent("models/argmaxinc/whisperkit-coreml/\(variant)", isDirectory: true)
    }

    /// A download that finished has all three models; a folder without them is one that stopped halfway.
    static func isComplete(_ folder: URL) -> Bool {
        ["AudioEncoder.mlmodelc", "TextDecoder.mlmodelc", "MelSpectrogram.mlmodelc"].allSatisfy {
            FileManager.default.fileExists(atPath: folder.appendingPathComponent($0).path)
        }
    }

    /// The download base that holds a complete copy of `variant`: this app's first, then the earlier app's.
    static func base(holding variant: String, bases: [URL] = [DictationPaths.base, DictationPaths.earlier]) -> URL? {
        bases.first { isComplete(folder(variant, in: $0)) }
    }

    static func ownBase() throws -> URL {
        try FileManager.default.createDirectory(at: DictationPaths.base, withIntermediateDirectories: true,
                                                attributes: [.posixPermissions: 0o700])
        return DictationPaths.base
    }

    /// Whether this app downloaded `variant` itself (only those can be removed here).
    static func isOwn(_ variant: String, base: URL = DictationPaths.base) -> Bool {
        FileManager.default.fileExists(atPath: folder(variant, in: base).path)
    }

    /// Deletes this app's copy of `variant`, never the earlier app's.
    static func remove(_ variant: String, base: URL = DictationPaths.base) {
        try? FileManager.default.removeItem(at: folder(variant, in: base))
        try? FileManager.default.removeItem(at: base.appendingPathComponent(
            "models/argmaxinc/whisperkit-coreml/.cache/huggingface/download/\(variant)"))
    }
}

/// "1.6 GB", "490 MB".
func modelSize(_ mb: Int) -> String {
    mb >= 1000 ? String(format: "%.1f GB", Double(mb) / 1000) : "\(mb) MB"
}

/// Dictation's settings, kept in UserDefaults; Settings → General → Dictation only shows and sets them.
struct DictationPrefs: Equatable {
    var on = true
    /// The key held to talk; nil = off (F13 still starts and stops).
    var hold: HotkeyKey? = .fn
    var model = ModelRegistry.standardID
    /// Recordings kept in History.
    var keep = 10
    var sounds = true

    static let keys = (on: "dictation.on", hold: "dictation.hold", model: "dictation.model", keep: "dictation.keep",
                       sounds: "dictation.sounds", imported: "dictation.imported", used: "dictation.used")

    static func load(_ d: UserDefaults = .standard) -> DictationPrefs {
        var p = DictationPrefs()
        if let on = d.object(forKey: keys.on) as? Bool { p.on = on }
        if let hold = d.string(forKey: keys.hold) { p.hold = HotkeyKey(rawValue: hold) }
        if let model = d.string(forKey: keys.model), ModelRegistry.find(model) != nil { p.model = model }
        if let keep = d.object(forKey: keys.keep) as? Int { p.keep = max(1, keep) }
        if let sounds = d.object(forKey: keys.sounds) as? Bool { p.sounds = sounds }
        return p
    }

    func save(_ d: UserDefaults = .standard) {
        d.set(on, forKey: Self.keys.on)
        d.set(hold?.rawValue ?? "off", forKey: Self.keys.hold)
        d.set(model, forKey: Self.keys.model)
        d.set(keep, forKey: Self.keys.keep)
        d.set(sounds, forKey: Self.keys.sounds)
    }

    /// The earlier dictation app's choices on this Mac, taken over once: its talk key (F13 there means the hold key is
    /// off here, since F13 always talks), recordings kept, sounds and model. Its server address never comes over.
    /// `settings` is its settings.json, `legacyKey` its older `pushToTalkHotkey` default.
    func importing(settings: Data?, legacyKey: String?) -> DictationPrefs {
        var p = self
        let json = settings.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] } ?? [:]
        let hotkey = json["hotkey"] as? [String: Any]
        let extras = json["extras"] as? [String: Any]
        let model = json["model"] as? [String: Any]
        if let key = (hotkey?["key"] as? String) ?? legacyKey {
            if key == "f13" { p.hold = nil } else if let k = HotkeyKey(rawValue: key) { p.hold = k }
        }
        if let keep = extras?["keepRecordings"] as? Int { p.keep = max(1, keep) }
        if let sounds = extras?["sounds"] as? Bool { p.sounds = sounds }
        if let id = model?["id"] as? String, ModelRegistry.find(id) != nil { p.model = id }
        return p
    }
}

/// What a talk key means, given who started the recording in progress. Pure, so it is tested.
///
/// F13 (and the menu bar's Dictate) toggles: it stops any recording, whichever key started it. Holding the hold key
/// starts one only when nothing records, and its release stops only the recording it started, so a hold during an F13
/// recording does nothing. F16 cancels whatever runs.
struct TalkRouter {
    enum Input: Equatable { case toggle, holdDown, holdUp, holdCancel, cancel }
    enum Action: Equatable {
        /// `quiet`: a hold, shown only once it is long enough to be one.
        case start(quiet: Bool)
        case stop
        case cancelRecording
        case discard
    }
    enum Source: Equatable { case toggle, hold }

    private(set) var source: Source?

    mutating func route(_ input: Input, recording: Bool) -> Action? {
        if !recording, input != .cancel { source = nil }
        switch input {
        case .toggle:
            if recording { source = nil; return .stop }
            source = .toggle
            return .start(quiet: false)
        case .holdDown:
            guard !recording else { return nil }
            source = .hold
            return .start(quiet: true)
        case .holdUp, .holdCancel:
            guard recording, source == .hold else { return nil }
            source = nil
            return input == .holdUp ? .stop : .cancelRecording
        case .cancel:
            source = nil
            return .discard
        }
    }
}

/// Before Accessibility is granted no tap can see the hold key, so the first hold would go unnoticed. This reads the
/// modifier state ten times a second (no permission needed) and counts a hold of the key alone, long enough and with no
/// key typed meanwhile (fn with an arrow is Page Up, not talking), as the first press.
/// A second, longer than a talking hold needs once set up, so brushing fn doesn't start the setup and its download.
func firstHoldCounts(heldFor: TimeInterval, secondsSinceKeyDown: TimeInterval) -> Bool {
    heldFor >= 1 && heldFor < 30 && secondsSinceKeyDown > heldFor
}

@MainActor
final class Dictation: ObservableObject {
    static let shared = Dictation()
    nonisolated static let recordings = DictationRecordings(directory: DictationPaths.recordings)

    enum Phase: Equatable {
        case off
        case idle
        case recording
        case transcribing
    }

    /// For the menu bar: off, idle, recording or transcribing.
    @Published private(set) var phase: Phase = .off
    @Published private(set) var prefs = DictationPrefs.load()
    /// The model being downloaded and how far (0...1).
    @Published private(set) var download: (id: String, progress: Double)?

    /// How to talk, for the menu bar row: "F13 or hold fn".
    var talkKeyText: String { prefs.hold.map { "F13 or hold \($0.shortName)" } ?? "F13" }

    /// The languages the person speaks (the server's Voice settings), or nil when it has none. Set by the Shell.
    var languages: (() async -> [String]?)?
    private var spoken: [String] = []
    private var spokenAt = Date.distantPast

    private var router = TalkRouter()
    private let monitor = HotkeyMonitor()
    private var monitorOn = false
    private var carbonF13: EventHotKeyRef?
    private var carbonHandler: EventHandlerRef?
    private var holdWatch: Timer?
    private var holdDownAt: TimeInterval?
    private var trustWatch: Timer?
    private var askedAccessibility = false
    /// A permission the person has to give, shown in the pill until it is given.
    private var needs: String?

    private lazy var pill: DictationPill = { pillMade = true; return DictationPill() }()
    private var pillMade = false
    private var fetching: Task<Void, Never>?
    private lazy var sounds = DictationSounds()
    private var transcriber: WhisperKitTranscriber?
    private var controllerStore: DictationController?

    private init() {}

    // MARK: launch and switching

    /// Once, at launch: takes over the earlier app's choices the first time, then listens if dictation is on.
    func start() {
        let d = UserDefaults.standard
        if !d.bool(forKey: DictationPrefs.keys.imported) {
            d.set(true, forKey: DictationPrefs.keys.imported)
            let file = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".config/parrot/settings.json")
            let legacy = CFPreferencesCopyAppValue("pushToTalkHotkey" as CFString, "parrot" as CFString) as? String
            let settings = try? Data(contentsOf: file)
            if settings != nil || legacy != nil {
                prefs = prefs.importing(settings: settings, legacyKey: legacy)
                prefs.save()
                DictationLog.info("took over the earlier dictation app's settings")
            }
        }
        Self.recordings.keep = prefs.keep
        // History and Transcribe a file work from the first F14/F15, before any dictation
        DictationHistory.model.transcribe = { [weak self] url in
            guard let self else { throw TranscriberError.notLoaded }
            let samples = try await Task.detached { try AudioFileLoader.load(url: url) }.value
            guard !samples.isEmpty else { throw AudioFileLoader.LoaderError.invalidFormat }
            return try await self.onDevice(samples)
        }
        TranscribeFile.model.transcribe = { [weak self] samples in
            guard let self else { throw TranscriberError.notLoaded }
            return try await self.onDevice(samples)
        }
        apply()
    }

    private func apply() {
        guard prefs.on else {
            phase = .off
            needs = nil
            fetching?.cancel()
            if pillMade { pill.hide() }
            FunctionKeys.shared.bind([])
            if monitorOn { monitor.stop(); monitorOn = false }
            unregisterF13()
            holdWatch?.invalidate(); holdWatch = nil
            trustWatch?.invalidate(); trustWatch = nil
            if let transcriber { Task { await transcriber.unload() } }
            transcriber = nil
            controllerStore = nil
            return
        }
        if phase == .off { phase = .idle }
        if AXIsProcessTrusted() {
            installTaps()
        } else {
            registerF13()
            watchFirstHold()
            // granted in System Settings whenever: the taps come on then, no relaunch
            watchTrust()
        }
        // used here before: load the model now, so the first dictation after a launch doesn't wait for it
        if UserDefaults.standard.bool(forKey: DictationPrefs.keys.used), modelOnDisk { Task { try? await currentTranscriber().warmUp() } }
    }

    private func update(_ change: (inout DictationPrefs) -> Void) {
        let old = prefs
        change(&prefs)
        guard prefs != old else { return }
        prefs.save()
        Self.recordings.keep = prefs.keep
        Self.recordings.prune()
        sounds.enabled = prefs.sounds
        if prefs.model != old.model, let transcriber {
            // the next dictation loads the new one; one running finishes with the old
            self.transcriber = nil
            controllerStore?.replaceTranscriber(currentTranscriber())
            Task { await transcriber.unload() }
        }
        if prefs.hold != old.hold, let hold = prefs.hold { monitor.setKey(hold) }
        if prefs.on != old.on || prefs.hold != old.hold { apply() }
    }

    // MARK: keys

    /// The taps need Accessibility: the hold key on a listen-only tap, F13–F16 on the one that swallows them.
    private func installTaps() {
        unregisterF13()
        holdWatch?.invalidate(); holdWatch = nil
        FunctionKeys.shared.bind([
            (FunctionKeyCode.f13, { [weak self] in self?.talk(.toggle) }),
            (FunctionKeyCode.f14, { DictationHistory.toggle() }),
            (FunctionKeyCode.f15, { TranscribeFile.toggle() }),
            (FunctionKeyCode.f16, { [weak self] in self?.talk(.cancel) }),
        ])
        if let hold = prefs.hold {
            monitor.setKey(hold)
            if !monitorOn {
                do {
                    monitor.onHealthChange = { health in DictationLog.info("hold key: \(health)") }
                    try monitor.start { [weak self] event in
                        MainActor.assumeIsolated {
                            switch event {
                            case .pressed: self?.talk(.holdDown)
                            case .released: self?.talk(.holdUp)
                            case .cancelled: self?.talk(.holdCancel)
                            }
                        }
                    }
                    monitorOn = true
                } catch {
                    DictationLog.error("hold key unavailable: \(error)")
                }
            }
        } else if monitorOn {
            monitor.stop()
            monitorOn = false
        }
    }

    /// F13 through Carbon, which needs no permission, so the first press can start the setup.
    private func registerF13() {
        guard carbonF13 == nil else { return }
        if carbonHandler == nil {
            var spec = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
            InstallEventHandler(GetApplicationEventTarget(), { _, event, _ in
                var id = EventHotKeyID()
                GetEventParameter(event, EventParamName(kEventParamDirectObject), EventParamType(typeEventHotKeyID), nil,
                                  MemoryLayout<EventHotKeyID>.size, nil, &id)
                guard id.signature == Dictation.hotKeySignature else { return OSStatus(eventNotHandledErr) }
                DispatchQueue.main.async { MainActor.assumeIsolated { Dictation.shared.talk(.toggle) } }
                return noErr
            }, 1, &spec, nil, &carbonHandler)
        }
        let id = EventHotKeyID(signature: Self.hotKeySignature, id: 1)
        RegisterEventHotKey(UInt32(kVK_F13), 0, id, GetApplicationEventTarget(), 0, &carbonF13)
    }

    nonisolated static let hotKeySignature = OSType(0x4354_4454)   // "CTDT"

    private func unregisterF13() {
        if let carbonF13 { UnregisterEventHotKey(carbonF13) }
        carbonF13 = nil
    }

    /// Without Accessibility: a first real hold of the hold key starts the setup (see `firstHoldCounts`).
    private func watchFirstHold() {
        guard holdWatch == nil, prefs.hold != nil else { return }
        holdWatch = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.checkFirstHold() }
        }
    }

    private func checkFirstHold() {
        guard let key = prefs.hold else { return }
        let flags = CGEventSource.flagsState(.combinedSessionState)
        let others = flags.intersection(HotkeyMonitor.chordFlags).subtracting(key.flag)
        let held = flags.contains(key.flag) && others.isEmpty
        let now = ProcessInfo.processInfo.systemUptime
        if held {
            if holdDownAt == nil { holdDownAt = now }
        } else if let down = holdDownAt {
            holdDownAt = nil
            let sinceKey = CGEventSource.secondsSinceLastEventType(.combinedSessionState, eventType: .keyDown)
            if firstHoldCounts(heldFor: now - down, secondsSinceKeyDown: sinceKey) { setUp() }
        }
    }

    // MARK: talking

    /// The menu bar's Dictate: starts or stops, the same as F13.
    func toggle() {
        if !prefs.on { update { $0.on = true } }
        talk(.toggle)
    }

    private func talk(_ input: TalkRouter.Input) {
        guard prefs.on else { return }
        let recording = controllerStore?.state == .recording
        if !recording, input != .cancel, input != .holdCancel, !ready {
            // a hold asks only once it was a real hold (its release), never on a stray tap of fn
            if input == .toggle || input == .holdUp { setUp() }
            return
        }
        let controller = self.controller()
        guard let action = router.route(input, recording: controller.state == .recording) else { return }
        switch action {
        case .start(let quiet):
            refreshLanguages()
            controller.press(announce: !quiet)
            if quiet {
                DispatchQueue.main.asyncAfter(deadline: .now() + Gesture.minimumHold) { [weak self] in
                    guard let self, self.router.source == .hold else { return }
                    controller.announce()
                }
            }
        case .stop: controller.release()
        case .cancelRecording: controller.cancel()
        case .discard: controller.discard()
        }
        phase = Self.phase(controller.state)
    }

    static func phase(_ state: DictationController.State) -> Phase {
        switch state {
        case .idle: return .idle
        case .recording: return .recording
        case .transcribing: return .transcribing
        }
    }

    private func controller() -> DictationController {
        if let controllerStore { return controllerStore }
        let capture = AudioCapture()
        let pill = self.pill
        capture.onLevel = { level in pill.pushLevel(level) }
        sounds.enabled = prefs.sounds
        let made = DictationController(
            capture: capture,
            transcriber: currentTranscriber(),
            observers: [pill, sounds, PhaseObserver(), FailureAlert()],
            delivery: TextDelivery(mode: .paste),
            recordings: Self.recordings,
            context: { [weak self] in TranscriptionContext(spokenLanguages: self?.spoken ?? []) }
        )
        controllerStore = made
        return made
    }

    /// History and dropped files: on this Mac, once the model is here (a missing one starts downloading instead).
    private func onDevice(_ samples: [Float]) async throws -> String {
        guard modelOnDisk else {
            fetch(model)
            throw DictationSetupError.noModel
        }
        return try await controller().transcribeOnDevice(samples)
    }

    private func currentTranscriber() -> WhisperKitTranscriber {
        if let transcriber { return transcriber }
        let made = WhisperKitTranscriber(model: ModelRegistry.model(prefs.model))
        transcriber = made
        return made
    }

    /// The server's languages for Whisper, at most every five minutes; none = the Mac's own languages.
    private func refreshLanguages() {
        guard Date().timeIntervalSince(spokenAt) > 300, let languages else { return }
        spokenAt = Date()
        Task { spoken = await languages() ?? [] }
    }

    fileprivate func sync() {
        phase = prefs.on ? Self.phase(controllerStore?.state ?? .idle) : .off
    }

    // MARK: first press: permissions and the model

    private var model: TranscriptionModel { ModelRegistry.model(prefs.model) }
    private var modelOnDisk: Bool { model.whisperKitID.flatMap { ModelFiles.base(holding: $0) } != nil }

    private var ready: Bool {
        MicrophoneAccess.status == .authorized && AXIsProcessTrusted() && modelOnDisk
    }

    /// What the first press (or Settings' Allow) does: the model starts downloading, and the pill says the first thing
    /// the person has to allow, with the right System Settings pane. Pressing again after each step goes on.
    func setUp() {
        if !modelOnDisk, download == nil { fetch(model) }
        switch MicrophoneAccess.status {
        case .notDetermined:
            needs = "Allow the microphone to dictate"
            showSetup()
            AVCaptureDevice.requestAccess(for: .audio) { _ in
                DispatchQueue.main.async { MainActor.assumeIsolated { Dictation.shared.needs = nil; Dictation.shared.setUp() } }
            }
            return
        case .denied, .restricted:
            needs = "Turn on Creator Toolset under Microphone"
            showSetup()
            openPane("Privacy_Microphone")
            return
        default: break
        }
        guard AXIsProcessTrusted() else {
            needs = "Turn on Creator Toolset under Accessibility"
            showSetup()
            if askedAccessibility {
                openPane("Privacy_Accessibility")
            } else {
                // the system's own sheet, which adds this app to the list and opens the pane
                askedAccessibility = true
                _ = AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary)
            }
            watchTrust()
            return
        }
        needs = nil
        showSetup()
    }

    private func watchTrust() {
        guard trustWatch == nil else { return }
        trustWatch = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] timer in
            MainActor.assumeIsolated {
                guard let self, AXIsProcessTrusted() else { return }
                timer.invalidate()
                self.trustWatch = nil
                DictationLog.info("accessibility granted")
                if self.prefs.on { self.installTaps() }
                // only a setup in progress says Ready
                if self.needs != nil {
                    self.needs = nil
                    self.showSetup()
                }
            }
        }
    }

    /// The pill during setup: what to allow first, else the download, else ready.
    private func showSetup() {
        // a minute, then it goes: declining must not leave it on every Space
        if let needs { return pill.showMessage(needs, for: 60) }
        if let download {
            let m = ModelRegistry.model(download.id)
            return pill.show(.message("Downloading the speech model · \(modelSize(m.sizeMB)) · \(Int(download.progress * 100))%"))
        }
        if ready { pill.showMessage("Ready. Press \(talkKeyText) to talk") }
    }

    private func openPane(_ pane: String) {
        if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?\(pane)") { NSWorkspace.shared.open(url) }
    }

    /// Downloads `m` into this app's folder, with its progress in the pill (while setting up) and in Settings.
    func fetch(_ m: TranscriptionModel) {
        guard download == nil, let variant = m.whisperKitID, ModelFiles.base(holding: variant) == nil else { return }
        download = (m.id, 0)
        let showing = m.id == prefs.model
        fetching = Task {
            do {
                let base = try ModelFiles.ownBase()
                var last = -1
                _ = try await WhisperKit.download(variant: variant, downloadBase: base) { p in
                    let pct = Int(p.fractionCompleted * 100)
                    DispatchQueue.main.async {
                        MainActor.assumeIsolated {
                            // a cancelled download (dictation switched off) shows nothing more
                            guard pct != last, Dictation.shared.download?.id == m.id else { return }
                            last = pct
                            Dictation.shared.download = (m.id, p.fractionCompleted)
                            if showing { Dictation.shared.showSetup() }
                        }
                    }
                }
                DictationLog.info("downloaded \(m.id)")
                download = nil
                fetching = nil
                if m.id == prefs.model {
                    if showing, needs == nil { pill.show(.message("Getting the speech model ready")) }
                    try? await currentTranscriber().warmUp()
                    if showing { showSetup() }
                }
            } catch {
                DictationLog.error("download of \(m.id) stopped: \(error)")
                download = nil
                fetching = nil
                if showing, prefs.on, !Task.isCancelled { pill.showMessage("The speech model didn't download. Press again to retry") }
            }
        }
    }

    // MARK: Settings (ThisMacBridge.swift)

    /// Settings → General → Dictation, as the page shows it.
    func bridgeState() -> [String: Any] {
        [
            "on": prefs.on,
            "hold": prefs.hold?.rawValue ?? "off",
            "holdKeys": HotkeyKey.allCases.map { ["id": $0.rawValue, "name": $0.displayName] },
            "model": prefs.model,
            "models": ModelRegistry.shared.map { m -> [String: Any] in
                let variant = m.whisperKitID ?? ""
                return [
                    "id": m.id, "name": m.displayName, "size": modelSize(m.sizeMB),
                    "here": ModelFiles.base(holding: variant) != nil,
                    // only this app's own download can be removed here
                    "removable": ModelFiles.isOwn(variant) && download?.id != m.id,
                    "progress": (download?.id == m.id ? download?.progress : nil) ?? NSNull(),
                ]
            },
            "keep": prefs.keep,
            "sounds": prefs.sounds,
            "needs": (!prefs.on ? nil
                : MicrophoneAccess.status != .authorized ? "Microphone"
                : !AXIsProcessTrusted() ? "Accessibility" : nil) ?? NSNull(),
        ]
    }

    /// One `thismac-dictation:<what>:<value>` from the page.
    func command(_ what: String, _ value: String) {
        switch what {
        case "on": update { $0.on = value == "1" }
        case "hold": update { $0.hold = HotkeyKey(rawValue: value) }
        case "model": if ModelRegistry.find(value) != nil { update { $0.model = value } }
        case "download": if let m = ModelRegistry.find(value) { fetch(m) }
        case "remove": remove(value)
        case "keep": if let n = Int(value), (1...500).contains(n) { update { $0.keep = n } }
        case "sounds": update { $0.sounds = value == "1" }
        case "history": DictationHistory.show()
        case "file": TranscribeFile.show()
        case "setup": setUp()
        default: break
        }
    }

    private func remove(_ id: String) {
        guard let m = ModelRegistry.find(id), let variant = m.whisperKitID, download?.id != id else { return }
        if id == prefs.model, let transcriber {
            self.transcriber = nil
            controllerStore?.replaceTranscriber(currentTranscriber())
            Task { await transcriber.unload(); ModelFiles.remove(variant) }
        } else {
            ModelFiles.remove(variant)
        }
    }
}

enum DictationSetupError: LocalizedError {
    case noModel
    var errorDescription: String? { "The speech model is downloading. Try again when it's done." }
}

/// Keeps `Dictation.phase` in step with the loop.
@MainActor
private final class PhaseObserver: DictationObserver {
    func dictationStarted() { Dictation.shared.sync() }
    func dictationTranscribing() { Dictation.shared.sync() }
    func dictationFinished(_ result: DictationResult) {
        UserDefaults.standard.set(true, forKey: DictationPrefs.keys.used)
        Dictation.shared.sync()
    }
    func dictationFailed(_ error: Error) { Dictation.shared.sync() }
}
