// Dictation: talk, and the words are pasted where the cursor is. The person's own keys (DictationKeys.swift) talk (tap to
// start and stop, or hold a modifier), open History, transcribe a file and cancel. On from the first launch, but nothing
// asks for a permission and nothing downloads until the person first presses the talk key (or the menu bar's Dictate,
// or Settings' Set up), which opens the setup page (SetupGuide.swift). A model already on this Mac loads at launch, so
// the keys work at once. Its settings live in the site's Settings → AI → Voice → Dictation (ThisMacBridge.swift answers
// with `bridgeState`, `command` sets them).
// Speech is turned into text by the person's own speech server when one is set, else (and when it doesn't answer) on
// this Mac by Whisper through WhisperKit (THIRD_PARTY_NOTICES.md).
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

    /// The download base that holds a complete copy of `variant`: this app's first, then the earlier app's (unless it
    /// was set aside, `SpeechModels.setAside`).
    static func base(holding variant: String, bases: [URL]? = nil) -> URL? {
        let all = bases ?? [DictationPaths.base] + (SpeechModels.isSetAside(variant) ? [] : [DictationPaths.earlier])
        return all.first { isComplete(folder(variant, in: $0)) }
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

/// Dictation's settings, kept in UserDefaults; Settings → AI → Voice → Dictation only shows and sets them.
struct DictationPrefs: Equatable {
    var on = true
    /// Saved apart, one per action (DictationKeys.save); until then, hold fn (`Dictation.start` picks the first keys).
    var keys = DictationKeys.holdFn
    var model = ModelRegistry.standardID
    /// Who writes the words down: this Mac's model (works with no server), or the server's engine (ServerDictation.swift).
    var engine = DictationEngine.thisMac
    /// Recordings kept in History.
    var keep = 10
    var sounds = true
    /// The person's own speech server, tried before this Mac's model (SpeechServerTranscriber); "" = none.
    var server = ""
    /// The languages ticked on the setup page; nil = the server's Voice languages, else the Mac's.
    var languages: [String]?

    static let keys = (on: "dictation.on", engine: "dictation.engine", model: "dictation.model", keep: "dictation.keep",
                       sounds: "dictation.sounds", imported: "dictation.imported", used: "dictation.used",
                       guided: "dictation.guided", server: "dictation.server", languages: "dictation.languages",
                       importedServer: "dictation.importedServer")

    static func load(_ d: UserDefaults = .standard) -> DictationPrefs {
        var p = DictationPrefs()
        if let on = d.object(forKey: keys.on) as? Bool { p.on = on }
        if let keys = DictationKeys.load(d) { p.keys = keys }
        if let engine = d.string(forKey: keys.engine).flatMap(DictationEngine.init) { p.engine = engine }
        if let model = d.string(forKey: keys.model), ModelRegistry.find(model) != nil { p.model = model }
        if let keep = d.object(forKey: keys.keep) as? Int { p.keep = max(1, keep) }
        if let sounds = d.object(forKey: keys.sounds) as? Bool { p.sounds = sounds }
        if let server = d.string(forKey: keys.server) { p.server = server }
        p.languages = d.stringArray(forKey: keys.languages)
        return p
    }

    func save(_ d: UserDefaults = .standard) {
        d.set(on, forKey: Self.keys.on)
        keys.save(d)
        d.set(engine.rawValue, forKey: Self.keys.engine)
        d.set(model, forKey: Self.keys.model)
        d.set(keep, forKey: Self.keys.keep)
        d.set(sounds, forKey: Self.keys.sounds)
        d.set(server, forKey: Self.keys.server)
        if let languages { d.set(languages, forKey: Self.keys.languages) } else { d.removeObject(forKey: Self.keys.languages) }
    }

    /// The earlier dictation app's choices on this Mac, taken over once: its keys (F13–F16, with its hold key, if it
    /// had one, to talk), recordings kept, sounds and model. Its speech server comes over apart (`earlierServer`).
    /// `settings` is its settings.json, `legacyKey` its older `pushToTalkHotkey` default.
    func importing(settings: Data?, legacyKey: String?) -> DictationPrefs {
        var p = self
        let json = settings.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] } ?? [:]
        let hotkey = json["hotkey"] as? [String: Any]
        let extras = json["extras"] as? [String: Any]
        let model = json["model"] as? [String: Any]
        if let key = (hotkey?["key"] as? String) ?? legacyKey, key == "f13" || HotkeyKey(rawValue: key) != nil {
            p.keys = .functionKeys
            if let k = HotkeyKey(rawValue: key) { p.keys.talk = .hold(k) }
        }
        if let keep = extras?["keepRecordings"] as? Int { p.keep = max(1, keep) }
        if let sounds = extras?["sounds"] as? Bool { p.sounds = sounds }
        if let id = model?["id"] as? String, ModelRegistry.find(id) != nil { p.model = id }
        return p
    }

    /// The earlier app's speech server address (its settings.json `extras.server`), when it is one.
    static func earlierServer(settings: Data?) -> String? {
        let json = settings.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
        guard let text = (json?["extras"] as? [String: Any])?["server"] as? String,
              SpeechServerTranscriber.url(text) != nil else { return nil }
        return text.trimmingCharacters(in: .whitespaces)
    }
}

/// What a talk key means, given who started the recording in progress. Pure, so it is tested.
///
/// A tapped talk key (and the menu bar's Dictate) toggles: it stops any recording, whichever started it. Holding the
/// hold key starts one only when nothing records, and its release stops only the recording it started, so a hold during
/// a tapped recording does nothing. Cancel cancels whatever runs.
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

    /// The talk key, for the menu bar row: "F13", "⌥Space", "Hold fn"; nil = none.
    var talkKeyText: String? { prefs.keys.talk?.display }

    /// How to talk, in a sentence: "Press F13 to talk", "Hold fn to talk".
    var talkHint: String {
        switch prefs.keys.talk {
        case .key(let s)?: return "Press \(s.display) to talk"
        case .hold(let k)?: return "Hold \(k.shortName) to talk"
        case nil: return "Choose a talk key in Settings"
        }
    }

    /// The dictation app this one grew out of, by bundle id. While it runs it has the same keys and pastes too, so
    /// dictation here registers no key and pastes nothing until it quits.
    nonisolated static let earlierAppID = "com.humanitas.parrot"

    /// Whether the earlier dictation app is among these running apps' bundle ids.
    nonisolated static func earlierAppRunning(in bundleIDs: [String?]) -> Bool { bundleIDs.contains(earlierAppID) }

    /// Whether any key is registered: dictation on, no picker open, the earlier app not running.
    nonisolated static func keysLive(on: Bool, paused: Bool, earlierAppOpen: Bool) -> Bool { on && !paused && !earlierAppOpen }

    /// The menu bar's Dictate row: what it does from there; while the earlier app has the keys, a click switches to this one.
    nonisolated static func menuTitle(phase: Phase, earlierAppOpen: Bool) -> String {
        if earlierAppOpen { return EarlierDictationApp.switchLine }
        return phase == .recording ? "Stop Dictating" : phase == .transcribing ? "Writing it down…" : "Dictate"
    }

    /// The earlier dictation app is running (`earlierAppRunning`), kept current from NSWorkspace's launch and quit
    /// notifications. The one check for "another app has dictation's keys".
    @Published var earlierAppOpen = false

    private var runningWatch: NSKeyValueObservation?

    private func watchEarlierApp() {
        guard !AppLog.underTests else { return }
        // menu bar apps (that one is) don't always get launch and quit notifications: the running list does change
        runningWatch = NSWorkspace.shared.observe(\.runningApplications) { _, _ in
            DispatchQueue.main.async { MainActor.assumeIsolated { Dictation.shared.checkEarlierApp() } }
        }
        let center = NSWorkspace.shared.notificationCenter
        for name in [NSWorkspace.didLaunchApplicationNotification, NSWorkspace.didTerminateApplicationNotification] {
            center.addObserver(forName: name, object: nil, queue: .main) { _ in
                MainActor.assumeIsolated { Dictation.shared.checkEarlierApp() }
            }
        }
        checkEarlierApp()
    }

    private func checkEarlierApp() {
        let open = Self.earlierAppRunning(in: NSWorkspace.shared.runningApplications.map(\.bundleIdentifier))
        guard open != earlierAppOpen else { return }
        earlierAppOpen = open
        DictationLog.info(open ? "earlier dictation app open: keys off" : "earlier dictation app quit: keys on")
        // a recording or a transcription in progress pastes nothing
        if open { controllerStore?.discard() }
        // its quit brings everything back, the model's load too
        apply()
    }

    /// A key picker is open: no dictation key does anything.
    var keysPaused = false {
        didSet { if keysPaused != oldValue { applyKeys() } }
    }

    /// Which action's key picker is open, for Settings' "Press a key…".
    @Published private(set) var picking: DictationAction?

    /// The languages the person speaks (the server's Voice settings), or nil when it has none. Set by the Shell.
    var languages: (() async -> [String]?)?
    /// The site with the window's session, for the server's engine. Set by the Shell.
    var site: (() async -> Site?)?
    private var spoken: [String] = []
    private var spokenAt = Date.distantPast

    private var router = TalkRouter()
    private let monitor = HotkeyMonitor()
    private var monitorOn = false
    private var carbonKeys: [EventHotKeyRef] = []
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
        if !DictationKeys.isSaved(d) {
            // dictation ran here before the keys were the person's own: it had F13–F16
            let before = d.bool(forKey: DictationPrefs.keys.imported)
            prefs.keys = .first(hadDictation: before, keyboardHasF13: before || DictationKeys.keyboardHasF13())
            prefs.save()
        }
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
        if !d.bool(forKey: DictationPrefs.keys.importedServer) {
            d.set(true, forKey: DictationPrefs.keys.importedServer)
            let file = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".config/parrot/settings.json")
            if prefs.server.isEmpty, let server = DictationPrefs.earlierServer(settings: try? Data(contentsOf: file)) {
                prefs.server = server
                prefs.save()
                DictationLog.info("took over the earlier dictation app's speech server")
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
        watchEarlierApp()
        apply()
    }

    private func apply() {
        let paused = prefs.on && EarlierDictationApp.isRunning()
        guard EarlierDictationApp.listens(on: prefs.on, earlierRunning: paused) else {
            phase = .off
            needs = nil
            // paused for the earlier app: a model downloading goes on
            if !paused { fetching?.cancel() }
            if pillMade { pill.hide() }
            applyKeys()
            trustWatch?.invalidate(); trustWatch = nil
            if let transcriber { Task { await transcriber.unload() } }
            transcriber = nil
            controllerStore = nil
            return
        }
        if phase == .off { phase = .idle }
        applyKeys()
        // granted in System Settings whenever: the taps come on then, no relaunch
        if !AXIsProcessTrusted() { watchTrust() }
        warm()
    }

    /// Loads the model already on this Mac and opens the speech server's connection, in the background, so the first
    /// press after a launch doesn't wait (the first load in a new app takes minutes; the server answers meanwhile).
    /// A model not on this Mac is never downloaded here.
    func warm() {
        guard !AppLog.underTests, prefs.on else { return }
        if prefs.engine == .thisMac, modelOnDisk { Task { try? await currentTranscriber().warmUp() } }
        if prefs.engine == .thisMac, let server = speechServer { Task { await server.warmUp() } }
    }

    /// The person's own speech server, or nil when none is set.
    var speechServer: SpeechServerTranscriber? { SpeechServerTranscriber.url(prefs.server).map(SpeechServerTranscriber.init) }

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
            controllerStore?.replaceTranscriber(engineTranscriber())
            Task { await transcriber.unload() }
        }
        if prefs.engine != old.engine { controllerStore?.replaceTranscriber(engineTranscriber()) }
        if prefs.server != old.server || prefs.engine != old.engine {
            controllerStore?.remote = prefs.engine == .thisMac ? speechServer : nil
            warm()
        }
        if prefs.on != old.on || prefs.keys != old.keys { apply() }
    }

    // MARK: keys

    private var holdKey: HotkeyKey? {
        if case .hold(let k)? = prefs.keys.talk { return k }
        return nil
    }

    private func run(_ action: DictationAction) {
        switch action {
        case .talk: talk(.toggle)
        case .history: DictationHistory.toggle()
        case .file: TranscribeFile.toggle()
        case .cancel: talk(.cancel)
        }
    }

    /// The keys as they should be now. With Accessibility: the hold key on a listen-only tap, the other keys on the one
    /// that swallows them. Without: the keys through Carbon (no permission needed, so the first press can start the
    /// setup) and a watch for a first hold. Off, or a picker open: none.
    private func applyKeys() {
        guard !AppLog.underTests else { return }
        unregisterCarbon()
        let live = Self.keysLive(on: prefs.on, paused: keysPaused, earlierAppOpen: earlierAppOpen)
        let trusted = AXIsProcessTrusted()
        let pressed = DictationAction.allCases.compactMap { action -> (key: Shortcut, action: () -> Void)? in
            guard case .key(let s)? = prefs.keys[action] else { return nil }
            return (s, { [weak self] in self?.run(action) })
        }
        FunctionKeys.shared.bind(live && trusted ? pressed : [])
        holdWatch?.invalidate(); holdWatch = nil
        if live, !trusted { registerCarbon(); watchFirstHold() }
        guard live, trusted, let hold = holdKey else {
            if monitorOn { monitor.stop(); monitorOn = false }
            return
        }
        monitor.setKey(hold)
        guard !monitorOn else { return }
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

    private func registerCarbon() {
        if carbonHandler == nil {
            var spec = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
            InstallEventHandler(GetApplicationEventTarget(), { _, event, _ in
                var id = EventHotKeyID()
                GetEventParameter(event, EventParamName(kEventParamDirectObject), EventParamType(typeEventHotKeyID), nil,
                                  MemoryLayout<EventHotKeyID>.size, nil, &id)
                // only its own: the recording shortcut registers on the same target
                guard id.signature == Dictation.hotKeySignature else { return OSStatus(eventNotHandledErr) }
                let index = Int(id.id)
                DispatchQueue.main.async {
                    MainActor.assumeIsolated {
                        guard DictationAction.allCases.indices.contains(index) else { return }
                        Dictation.shared.run(DictationAction.allCases[index])
                    }
                }
                return noErr
            }, 1, &spec, nil, &carbonHandler)
        }
        for (index, action) in DictationAction.allCases.enumerated() {
            guard case .key(let s)? = prefs.keys[action] else { continue }
            var ref: EventHotKeyRef?
            let id = EventHotKeyID(signature: Self.hotKeySignature, id: UInt32(index))
            if RegisterEventHotKey(s.keyCode, s.carbonModifiers, id, GetApplicationEventTarget(), 0, &ref) == noErr, let ref {
                carbonKeys.append(ref)
            } else {
                DictationLog.info("\(action.name) key \(s.display) not available: another app has it")
            }
        }
    }

    nonisolated static let hotKeySignature = OSType(0x4354_4454)   // "CTDT"

    private func unregisterCarbon() {
        carbonKeys.forEach { UnregisterEventHotKey($0) }
        carbonKeys = []
    }

    /// Without Accessibility: a first real hold of the hold key starts the setup (see `firstHoldCounts`).
    private func watchFirstHold() {
        guard holdWatch == nil, holdKey != nil else { return }
        holdWatch = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.checkFirstHold() }
        }
    }

    private func checkFirstHold() {
        guard let key = holdKey else { return }
        let flags = CGEventSource.flagsState(.combinedSessionState)
        let others = flags.intersection(HotkeyMonitor.chordFlags).subtracting(key.flag)
        let held = flags.contains(key.flag) && others.isEmpty
        let now = ProcessInfo.processInfo.systemUptime
        if held {
            if holdDownAt == nil { holdDownAt = now }
        } else if let down = holdDownAt {
            holdDownAt = nil
            let sinceKey = CGEventSource.secondsSinceLastEventType(.combinedSessionState, eventType: .keyDown)
            if firstHoldCounts(heldFor: now - down, secondsSinceKeyDown: sinceKey) { firstPress() }
        }
    }

    // MARK: talking

    /// The menu bar's Dictate: starts or stops, the same as a tapped talk key.
    /// While the other dictation app has the keys, the click is "use this one": it quits, dictation here is switched
    /// on, and the keys come on once it has gone (`checkEarlierApp`).
    func toggle(quitEarlier: () -> Void = EarlierDictationApp.quit) {
        let earlier = earlierAppOpen
        if earlier { quitEarlier() }
        if !prefs.on { update { $0.on = true } }
        if !earlier { talk(.toggle) }
    }

    private func talk(_ input: TalkRouter.Input) {
        guard prefs.on, !earlierAppOpen else { return }
        let recording = controllerStore?.state == .recording
        if !recording, input != .cancel, input != .holdCancel, !ready {
            // a hold asks only once it was a real hold (its release), never on a stray tap of fn
            if input == .toggle || input == .holdUp { firstPress() }
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
            transcriber: engineTranscriber(),
            observers: [pill, sounds, PhaseObserver(), FailureAlert()],
            delivery: UnlessEarlierApp(TextDelivery(mode: .paste)),
            recordings: Self.recordings,
            context: { [weak self] in TranscriptionContext(spokenLanguages: self?.prefs.languages ?? self?.spoken ?? []) }
        )
        made.remote = prefs.engine == .thisMac ? speechServer : nil
        controllerStore = made
        return made
    }

    /// History and dropped files: on this Mac, once the model is here (a missing one starts downloading instead).
    private func onDevice(_ samples: [Float]) async throws -> String {
        guard prefs.engine == .server || modelOnDisk else {
            fetch(model)
            throw DictationSetupError.noModel
        }
        return try await controller().transcribeOnDevice(samples)
    }

    /// What the next dictation, History and a dropped file use: the server's engine, or this Mac's model.
    private func engineTranscriber() -> Transcriber {
        prefs.engine == .server ? ServerTranscriber(site: { await Dictation.shared.site?() }) : currentTranscriber()
    }

    private func currentTranscriber() -> WhisperKitTranscriber {
        if let transcriber { return transcriber }
        let made = WhisperKitTranscriber(model: ModelRegistry.model(prefs.model))
        transcriber = made
        return made
    }

    /// The setup page's Languages: the ticks, or nil to follow `defaults` (what it showed before any tick).
    func setLanguages(_ codes: [String], defaults: [String]) {
        update { $0.languages = Set(codes) == Set(defaults) ? nil : codes }
    }

    /// The server's Voice languages when it has them, else the Mac's: what dictation listens for with no ticks.
    func defaultLanguages() async -> [String] {
        let server = await languages?() ?? []
        let codes = server.isEmpty ? SpokenLanguage.preferredCodes() : server
        return codes.filter(SpokenLanguage.whisperLanguages.contains)
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

    var model: TranscriptionModel { ModelRegistry.model(prefs.model) }
    var modelOnDisk: Bool { model.whisperKitID.flatMap { ModelFiles.base(holding: $0) } != nil }

    var ready: Bool {
        MicrophoneAccess.status == .authorized && AXIsProcessTrusted()
            && (prefs.engine == .server || modelOnDisk || speechServer != nil)
    }

    /// The first press of the talk key (or the menu bar's Dictate) while something is missing: the setup page until it
    /// was gone through once, after that the pill's step-by-step `setUp`.
    private func firstPress() {
        guard SetupGuide.isOpen || !UserDefaults.standard.bool(forKey: DictationPrefs.keys.guided) else { return setUp() }
        SetupGuide.show()
    }

    /// The setup page opened: the model starts loading, or downloading when it isn't here and no speech server is set,
    /// so it is ready by the time the page is done.
    func prepareModel() {
        guard prefs.engine == .thisMac else { return }
        if modelOnDisk { warm() } else if speechServer == nil { fetch(model) }
    }

    /// The guide's Allow for the microphone: the system's question the first time, then its Settings pane.
    func allowMicrophone() {
        if MicrophoneAccess.status == .notDetermined {
            MicrophoneAccess.requestIfUndetermined()
        } else {
            openPane("Privacy_Microphone")
        }
    }

    /// The guide's Allow for Accessibility: the system's sheet the first time (it adds this app to the list), then the
    /// pane. The keys come on by themselves once it is given.
    func allowAccessibility() {
        if askedAccessibility {
            openPane("Privacy_Accessibility")
        } else {
            askedAccessibility = true
            _ = AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary)
        }
        watchTrust()
    }

    /// Sets one action's key; the caller checked it (DictationKeys.problem).
    func setKey(_ action: DictationAction, _ binding: KeyBinding?) {
        update { $0.keys[action] = binding }
    }

    func setEngine(_ engine: DictationEngine) {
        update { $0.engine = engine }
    }

    /// Settings' key button: the picker for one action, refusing a key another action or the recording shortcut has.
    func pick(_ action: DictationAction) {
        defer { picking = action }   // after show: it closes an open picker, whose close clears `picking`
        KeyPicker.show(
            title: action.name,
            prompt: "Press the key for \(action.name).\n"
                + (action == .talk ? "Tap it, or hold a key like fn on its own. " : "")
                + "Esc keeps \(prefs.keys[action]?.display ?? "none"), Delete clears it.",
            allowsHold: action == .talk,
            check: { [weak self] in self?.prefs.keys.problem($0, for: action, recording: RecordShortcut.shared.shortcut) },
            done: { [weak self] in self?.setKey(action, $0) },
            closed: { [weak self] in self?.picking = nil })
    }

    /// What the first press (or Settings' Allow) does: the model starts downloading, and the pill says the first thing
    /// the person has to allow, with the right System Settings pane. Pressing again after each step goes on.
    func setUp() {
        if prefs.engine == .thisMac, !modelOnDisk, download == nil { fetch(model) }
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
        guard trustWatch == nil, !AppLog.underTests else { return }
        trustWatch = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] timer in
            MainActor.assumeIsolated {
                guard let self, AXIsProcessTrusted() else { return }
                timer.invalidate()
                self.trustWatch = nil
                DictationLog.info("accessibility granted")
                self.applyKeys()
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
        if ready { pill.showMessage("Ready. \(talkHint)") }
    }

    func openPane(_ pane: String) {
        if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?\(pane)") { NSWorkspace.shared.open(url) }
    }

    /// Downloads `m` into this app's folder, with its progress in the pill (while setting up) and in Settings. The one
    /// Download: Settings' Dictation row, a first dictation and the Voice page's (through the server, SpeechModels.swift).
    /// `asked`: the person got it on this Mac, so the server keeps it. One set aside comes back without a download.
    func fetch(_ m: TranscriptionModel, asked: Bool = true) {
        guard download == nil, let variant = m.whisperKitID else { return }
        if asked { SpeechModels.shared.asked(m.id) }
        if SpeechModels.restore(variant) { return SpeechModels.shared.changed() }
        guard ModelFiles.base(holding: variant) == nil else { return }
        download = (m.id, 0)
        SpeechModels.shared.changed()
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
                SpeechModels.shared.finished(m.id, ok: true)
                if m.id == prefs.model {
                    if showing, needs == nil { pill.show(.message("Getting the speech model ready")) }
                    try? await currentTranscriber().warmUp()
                    if showing { showSetup() }
                }
            } catch {
                DictationLog.error("download of \(m.id) stopped: \(error)")
                download = nil
                fetching = nil
                SpeechModels.shared.finished(m.id, ok: false)
                if showing, prefs.on, !Task.isCancelled { pill.showMessage("The speech model didn't download. Press again to retry") }
            }
        }
    }

    // MARK: Settings (ThisMacBridge.swift)

    /// Settings → AI → Voice → Dictation, as the page shows it.
    func bridgeState() -> [String: Any] {
        [
            "on": prefs.on,
            // each action's key as shown ("" = none), and the one whose picker is open
            "keys": Dictionary(uniqueKeysWithValues: DictationAction.allCases.map { ($0.rawValue, prefs.keys[$0]?.display ?? "") }),
            "picking": picking?.rawValue ?? NSNull(),
            // why no key works right now, in one quiet line
            "paused": earlierAppOpen ? "Off while your earlier dictation app is open" : NSNull(),
            "engine": DictationEngine.serverWired ? prefs.engine.rawValue : NSNull(),
            "model": prefs.model,
            "models": ModelRegistry.shared.map { m -> [String: Any] in
                let variant = m.whisperKitID ?? ""
                let here = ModelFiles.base(holding: variant) != nil
                return [
                    "id": m.id, "name": m.displayName, "size": modelSize(m.sizeMB),
                    "here": here,
                    // the earlier app's copy is set aside, never deleted (`remove`)
                    "removable": here && download?.id != m.id,
                    "progress": (download?.id == m.id ? download?.progress : nil) ?? NSNull(),
                ]
            },
            "keep": prefs.keep,
            "sounds": prefs.sounds,
            "server": prefs.server,
            "needs": (!prefs.on ? nil
                : MicrophoneAccess.status != .authorized ? "Microphone"
                : !AXIsProcessTrusted() ? "Accessibility" : nil) ?? NSNull(),
        ]
    }

    /// One `thismac-dictation:<what>:<value>` from the page.
    func command(_ what: String, _ value: String) {
        switch what {
        case "on": update { $0.on = value == "1" }
        case "pick": if let action = DictationAction(rawValue: value) { pick(action) }
        case "guide": SetupGuide.show()
        case "model": if ModelRegistry.find(value) != nil { update { $0.model = value } }
        case "engine": if let e = DictationEngine(rawValue: value) { update { $0.engine = e } }
        case "download": if let m = ModelRegistry.find(value) { fetch(m) }
        case "remove": remove(value)
        case "keep": if let n = Int(value), (1...500).contains(n) { update { $0.keep = n } }
        case "sounds": update { $0.sounds = value == "1" }
        // an address, or "" for none; anything else is not a speech server and changes nothing
        case "server":
            let text = value.trimmingCharacters(in: .whitespaces)
            if text.isEmpty || SpeechServerTranscriber.url(text) != nil { update { $0.server = text } }
        case "history": DictationHistory.show()
        case "file": TranscribeFile.show()
        case "setup": setUp()
        default: break
        }
    }

    /// The one Remove (Settings' Dictation row, or the Voice page's through the server): this app's own copy is
    /// deleted; the earlier app's is set aside, never deleted.
    func remove(_ id: String) {
        guard let m = ModelRegistry.find(id), let variant = m.whisperKitID, download?.id != id else { return }
        let drop = { ModelFiles.remove(variant); SpeechModels.setAside(variant) }
        if id == prefs.model, let transcriber {
            self.transcriber = nil
            controllerStore?.replaceTranscriber(engineTranscriber())
            Task { await transcriber.unload(); drop(); SpeechModels.shared.changed() }
        } else {
            drop()
            SpeechModels.shared.changed()
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
