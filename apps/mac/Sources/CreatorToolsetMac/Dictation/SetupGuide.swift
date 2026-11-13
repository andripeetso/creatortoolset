// The dictation setup page: one page, opened by the first press of the talk key (or the menu bar's Dictate) before
// dictation was set up, and by Settings' Set up. The talk key, the languages, both permissions with their own Allow,
// where speech turns into text, and Get Started. Opening it starts loading (or downloading) the model, so it is ready
// by the time the page is done. From the site (the assistant's mic, Settings' Open setup) it opens as a sheet on the
// main window, with Not now. It never opens by itself.
import AppKit
import SwiftUI

/// What the page shows, as plain values, so it is drawn in a test (SetupGuideShotsTests).
struct SetupFacts: Equatable {
    var talkKey: String?
    /// "Press F13, speak, press again." (`line(for:)`).
    var line: String
    var picking = false
    /// Ticked languages as codes, in the order ticked.
    var languages: [String] = []
    var microphone = false
    /// The microphone was refused once: only System Settings can change it now.
    var microphoneDenied = false
    var accessibility = false
    /// Where speech turns into text: "This Mac · Whisper Large v3 Turbo", "Your server".
    var speech: String
    /// A speech server or the server's engine writes the words: they leave this Mac.
    var leavesMac = false
    var modelSize: String
    /// The Mac's model is here (or not needed): nothing to show beside Speech.
    var modelHere = false
    /// 0...1 while the model downloads.
    var progress: Double?

    var canStart: Bool { microphone && accessibility && !languages.isEmpty }

    /// The page's one line for the talk key.
    static func line(for talk: KeyBinding?) -> String {
        switch talk {
        case .key(let s)?: return "Press \(s.display), speak, press again."
        case .hold(let k)?: return "Hold \(k.shortName), speak, and let go."
        case nil: return "Choose a talk key, then speak."
        }
    }

    /// The Languages pill: "English", "English, Estonian", "English +2".
    static func summary(_ names: [String]) -> String {
        switch names.count {
        case 0: return "None"
        case 1, 2: return names.joined(separator: ", ")
        default: return "\(names[0]) +\(names.count - 1)"
        }
    }
}

enum SetupAction: Equatable {
    case pickTalk, language(String), allowMicrophone, allowAccessibility, model(String), getStarted
}

struct SetupPageView: View {
    let facts: SetupFacts
    var models: [TranscriptionModel] = ModelRegistry.shared
    var model = ModelRegistry.standardID
    let act: (SetupAction) -> Void
    @State private var showsLanguages = false
    @State private var showsSpeech = false

    var body: some View {
        VStack(spacing: 0) {
            Image(systemName: "waveform")
                .font(.system(size: 26, weight: .semibold))
                .foregroundStyle(Color(nsColor: .windowBackgroundColor))
                .frame(width: 64, height: 64)
                .background(Circle().fill(Color.primary))
            Text("Dictation")
                .font(.system(size: 24, weight: .semibold))
                .padding(.top, 16)
            // what it is for, before how: someone offered it has never heard of it
            Text("Your own dictation, in every app, any time. Free.")
                .padding(.top, 6)
            Text(facts.line)
                .foregroundStyle(.secondary)
                .padding(.top, 4)

            Grid(alignment: .leading, horizontalSpacing: 20, verticalSpacing: 12) {
                GridRow {
                    label("Talk key")
                    Button { act(.pickTalk) } label: { PillLabel(title: facts.picking ? "Press a key…" : facts.talkKey ?? "Choose") }
                        .buttonStyle(.plain)
                        .disabled(facts.picking)
                }
                GridRow {
                    label("Languages")
                    Button { showsLanguages.toggle() } label: {
                        PillLabel(title: SetupFacts.summary(facts.languages.map { SpokenLanguage.displayName($0) }), chevron: true)
                    }
                    .buttonStyle(.plain)
                    .popover(isPresented: $showsLanguages, arrowEdge: .bottom) {
                        LanguageChecklist(ticked: facts.languages) { act(.language($0)) }
                    }
                }
                GridRow {
                    label("Microphone")
                    permission(granted: facts.microphone, action: facts.microphoneDenied ? "Open Settings" : "Allow") { act(.allowMicrophone) }
                }
                .padding(.top, 8)
                GridRow {
                    label("Accessibility")
                    permission(granted: facts.accessibility, action: "Allow") { act(.allowAccessibility) }
                }
                GridRow(alignment: .top) {
                    label("Speech").padding(.top, 6)
                    VStack(alignment: .leading, spacing: 6) {
                        Button { showsSpeech.toggle() } label: { PillLabel(title: facts.speech, chevron: true) }
                            .buttonStyle(.plain)
                            .popover(isPresented: $showsSpeech, arrowEdge: .bottom) { modelList }
                        // under the pill, so a long model name and the download fit the page
                        if !facts.modelHere {
                            HStack(spacing: 8) {
                                if let progress = facts.progress {
                                    ProgressView(value: progress).frame(width: 120)
                                    Text("Downloading · \(Int(progress * 100))%").monospacedDigit()
                                } else {
                                    Text("Not downloaded · \(facts.modelSize)")
                                }
                            }
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .padding(.leading, 14)
                        }
                    }
                }
                .padding(.top, 8)
            }
            .fixedSize()
            .padding(.top, 32)

            Button("Get Started") { act(.getStarted) }
                .buttonStyle(PillButtonStyle(primary: true))
                .controlSize(.large)
                .keyboardShortcut(.defaultAction)
                .disabled(!facts.canStart)
                .padding(.top, 32)

            if !facts.leavesMac {
                Label("Audio and text never leave your Mac.", systemImage: "lock.fill")
                    .font(.caption)
                    .foregroundStyle(.tertiary)
                    .padding(.top, 14)
            }
        }
        .padding(.horizontal, 40)
        .padding(.top, 44)
        .padding(.bottom, 28)
        .frame(width: 420)
    }

    private func label(_ text: String) -> some View {
        Text(text).foregroundStyle(.secondary)
    }

    /// This Mac's models, the chosen one ticked. With a speech server it is what dictation falls back on.
    private var modelList: some View {
        VStack(alignment: .leading, spacing: 8) {
            if facts.leavesMac { Text("When your server doesn't answer:").font(.caption).foregroundStyle(.secondary) }
            ForEach(models, id: \.id) { m in
                Button {
                    showsSpeech = false
                    act(.model(m.id))
                } label: {
                    HStack {
                        Image(systemName: "checkmark").opacity(m.id == model ? 1 : 0)
                        Text(m.displayName)
                        Spacer()
                        Text(modelSize(m.sizeMB)).foregroundStyle(.secondary)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
        }
        .padding(14)
        .frame(width: 300)
    }

    @ViewBuilder
    private func permission(granted: Bool, action: String, allow: @escaping () -> Void) -> some View {
        if granted {
            Label("Allowed", systemImage: "checkmark.circle.fill")
                .foregroundStyle(.secondary)
                .symbolRenderingMode(.multicolor)
                .padding(.vertical, 6)
        } else {
            // filled, so what is still missing reads as the next thing to do
            Button(action, action: allow).buttonStyle(PillButtonStyle(primary: true))
        }
    }
}

/// The page as a sheet on the main window: the same page, with Not now (and Esc) to leave without setting anything up.
struct SetupOfferView: View {
    let facts: SetupFacts
    var model = ModelRegistry.standardID
    let act: (SetupAction) -> Void
    let notNow: () -> Void

    var body: some View {
        SetupPageView(facts: facts, model: model, act: act)
            .overlay(alignment: .topTrailing) {
                Button("Not now", action: notNow)
                    .buttonStyle(.plain)
                    .foregroundStyle(.secondary)
                    .keyboardShortcut(.cancelAction)
                    .padding(16)
            }
    }
}

/// The setup page's own model download. Opening the page starts it (so the model is ready by Get Started); leaving
/// without Get Started (Not now, Esc, the close button, ⌘W) stops it, and nothing starts once the page is gone. A download
/// that was already running, or one started from Settings, is not the page's and goes on.
struct SetupDownload: Equatable {
    private(set) var open = false
    /// the model id whose download this opening of the page started
    private(set) var started: String?

    mutating func opened() { open = true; started = nil }

    /// Whether the page may start a download now: only while it is open (the server's languages can answer late).
    var mayPrepare: Bool { open }

    /// What a prepare got for the page: the download it started, or the model it brought back with none (one set aside
    /// in the earlier app's folder, used again: `SpeechModels.restore`). Both are the page's own: kept while it is open,
    /// asked for at Get Started.
    static func pagesModel(download: String?, wasHere: Bool, isHere: Bool, model: String) -> String? {
        download ?? (!wasHere && isHere ? model : nil)
    }

    /// After a prepare: a download running now that was not before is the page's own.
    mutating func prepared(before: String?, after: String?) {
        if open, before == nil, let after { started = after }
    }

    /// Get Started: the page's own download becomes the person's wish (asked; the server keeps it for this Mac).
    var wish: String? { started }

    /// The page goes: the download to stop, if it is still the page's own and the person did not press Get Started.
    mutating func closed(gotStarted: Bool, running: String?) -> String? {
        defer { open = false; started = nil }
        return !gotStarted && running != nil && running == started ? started : nil
    }
}

/// A capsule with a light fill, with a chevron when it opens a list.
struct PillLabel: View {
    let title: String
    var chevron = false

    var body: some View {
        HStack(spacing: 6) {
            Text(title).font(.system(size: 13, weight: .medium))
            if chevron {
                Image(systemName: "chevron.down")
                    .font(.system(size: 9, weight: .semibold))
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 6)
        .background(Capsule().fill(Color.primary.opacity(0.08)))
        .contentShape(Capsule())
    }
}

/// A button drawn as a pill; `primary` is filled in the text colour, for the one thing to do next.
struct PillButtonStyle: ButtonStyle {
    var primary = false
    @Environment(\.isEnabled) private var isEnabled
    @Environment(\.controlSize) private var controlSize

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 13, weight: primary ? .semibold : .medium))
            .foregroundStyle(primary ? Color(nsColor: .windowBackgroundColor) : Color.primary)
            .padding(.horizontal, controlSize == .large ? 22 : 14)
            .padding(.vertical, controlSize == .large ? 9 : 6)
            .background(Capsule().fill(Color.primary.opacity(primary ? (configuration.isPressed ? 0.8 : 1) : (configuration.isPressed ? 0.14 : 0.08))))
            .contentShape(Capsule())
            .opacity(isEnabled ? 1 : 0.35)
    }
}

/// Checkboxes for the languages the person speaks, in a popover so ticks stay open between clicks: the Mac's
/// languages, the common ones, then More Languages.
struct LanguageChecklist: View {
    let ticked: [String]
    let toggle: (String) -> Void
    @State private var showsMore = false

    /// Languages many people dictate in, offered right after the Mac's own.
    static let common = ["en", "es", "fr", "de", "it", "pt", "zh", "ja", "ko", "hi", "ar"]

    /// The Mac's languages (and any ticked) first, the common ones next, every other Whisper language under More.
    static func menu(preferred: [String], ticked: [String]) -> (mac: [String], common: [String], more: [String]) {
        let known = SpokenLanguage.whisperLanguages
        var seen = Set<String>()
        let mac = (preferred + ticked).filter { known.contains($0) && seen.insert($0).inserted }
        let common = Self.common.filter { known.contains($0) && !seen.contains($0) }
        let more = known.subtracting(mac + common).sorted {
            SpokenLanguage.displayName($0).localizedStandardCompare(SpokenLanguage.displayName($1)) == .orderedAscending
        }
        return (mac, common, more)
    }

    var body: some View {
        let menu = Self.menu(preferred: SpokenLanguage.preferredCodes(), ticked: ticked)
        ScrollView {
            VStack(alignment: .leading, spacing: 6) {
                rows(menu.mac)
                Divider().padding(.vertical, 2)
                rows(menu.common)
                Divider().padding(.vertical, 2)
                DisclosureGroup("More Languages", isExpanded: $showsMore) {
                    VStack(alignment: .leading, spacing: 6) { rows(menu.more) }.padding(.top, 6)
                }
            }
            .padding(14)
        }
        .frame(width: 240, height: 340)
    }

    private func rows(_ codes: [String]) -> some View {
        ForEach(codes, id: \.self) { code in
            Toggle(SpokenLanguage.displayName(code), isOn: Binding(get: { ticked.contains(code) }, set: { _ in toggle(code) }))
                .toggleStyle(.checkbox)
        }
    }
}

/// The page's window and what it reads from dictation, refreshed while it is open (a permission given in System
/// Settings ticks without a click). One window, reused.
@MainActor
final class SetupGuide: ObservableObject {
    private static var window: NSWindow?
    /// The page as a sheet on the main window (`showFromPage`).
    private static var sheet: NSWindow?
    private static let guide = SetupGuide()
    private static let delegate = Delegate()

    @Published private(set) var facts = SetupGuide.read(languages: [])
    private var languages: [String] = []
    /// What dictation listens for with no ticks (the server's Voice languages, else the Mac's).
    private var defaults: [String] = []
    /// A language was ticked or unticked since the page opened: the server's answer doesn't replace the ticks.
    private var touched = false
    private var tick: Timer?
    private var own = SetupDownload()
    /// Get Started was pressed: the page's download goes on after it closes.
    private var gotStarted = false

    static var isOpen: Bool { window?.isVisible == true || sheet != nil }

    static func show() {
        if let parent = sheet?.sheetParent {
            NSApp.activate(ignoringOtherApps: true)
            return parent.makeKeyAndOrderFront(nil)
        }
        let g = guide
        if window == nil {
            let host = NSHostingView(rootView: SetupGuideHost(guide: g))
            let w = NSWindow(contentRect: NSRect(origin: .zero, size: host.fittingSize),
                             styleMask: [.titled, .closable, .fullSizeContentView], backing: .buffered, defer: false)
            w.contentView = host
            w.title = "Dictation"
            w.titleVisibility = .hidden
            w.titlebarAppearsTransparent = true
            w.isMovableByWindowBackground = true
            w.isReleasedWhenClosed = false
            w.delegate = delegate
            w.center()
            window = w
        }
        g.start()
        NSApp.activate(ignoringOtherApps: true)
        window?.makeKeyAndOrderFront(nil)
        window?.orderFrontRegardless()  // a shortcut can't activate an accessory app on macOS 14+
    }

    /// From the site (the assistant's mic, Settings' Open setup): a sheet on the main window; with no window, the page's own.
    static func showFromPage() {
        guard let main = AppDelegate.shell?.webView.window, main.isVisible, main.attachedSheet == nil, !isOpen else { return show() }
        let g = guide
        g.start()
        let host = NSHostingView(rootView: SetupOfferHost(guide: g))
        let s = NSWindow(contentRect: NSRect(origin: .zero, size: host.fittingSize),
                         styleMask: [.titled, .fullSizeContentView], backing: .buffered, defer: false)
        s.contentView = host
        sheet = s
        NSApp.activate(ignoringOtherApps: true)
        main.makeKeyAndOrderFront(nil)
        main.beginSheet(s) { _ in
            MainActor.assumeIsolated {
                Self.sheet = nil
                Self.guide.stop()
            }
        }
    }

    /// Not now: the sheet goes, dictation stays not set up (the mic and the talk key's first press still open the page).
    fileprivate static func notNow() {
        if let sheet { sheet.sheetParent?.endSheet(sheet) }
    }

    static func read(languages: [String]) -> SetupFacts {
        let d = Dictation.shared
        let m = d.model
        let server = d.prefs.engine == .thisMac && d.speechServer != nil
        let engine = d.prefs.engine == .server
        return SetupFacts(
            talkKey: d.talkKeyText, line: SetupFacts.line(for: d.prefs.keys.talk), picking: d.picking == .talk,
            languages: languages,
            microphone: MicrophoneAccess.status == .authorized,
            microphoneDenied: [.denied, .restricted].contains(MicrophoneAccess.status),
            accessibility: AXIsProcessTrusted(),
            speech: engine ? "Deepgram or OpenAI (your key)" : server ? "Your server" : "This Mac · \(m.displayName)",
            leavesMac: server || engine,
            modelSize: modelSize(m.sizeMB),
            modelHere: engine || d.modelOnDisk,
            progress: d.download?.id == m.id ? d.download?.progress : nil)
    }

    func act(_ action: SetupAction) {
        let d = Dictation.shared
        switch action {
        case .pickTalk: d.pick(.talk)
        case .language(let code):
            touched = true
            if let at = languages.firstIndex(of: code) { languages.remove(at: at) } else { languages.append(code) }
            d.setLanguages(languages, defaults: defaults)
            prepare()  // the languages may choose another default model
        case .allowMicrophone: d.allowMicrophone()
        case .allowAccessibility: d.allowAccessibility()
        case .model(let id):
            d.command("model", id)
            prepare()
        case .getStarted:
            if !d.prefs.on { d.command("on", "1") }  // opened from the site's mic while dictation was off
            gotStarted = true
            if let id = own.wish {
                SpeechModels.shared.asked(id)
                SpeechModels.shared.changed()
            }
            Self.done()
            if let sheet = Self.sheet { sheet.sheetParent?.endSheet(sheet) } else { Self.window?.close() }
        }
        refresh()
    }

    /// Get Started, or the window closed by hand: set up, so later presses use the pill's steps.
    fileprivate static func done() {
        UserDefaults.standard.set(true, forKey: DictationPrefs.keys.guided)
        Dictation.shared.keepModel()
    }

    private func refresh() {
        let new = Self.read(languages: languages)
        if new != facts { facts = new }
    }

    /// The model loads, or downloads when it isn't here: only while the page is open, and a download it starts is its own.
    private func prepare() {
        guard own.mayPrepare else { return }
        let d = Dictation.shared
        let before = d.download?.id
        let wasHere = d.modelOnDisk
        // not a wish yet: only Get Started makes it one, so a page left with Not now leaves none behind
        d.prepareModel(asked: false)
        own.prepared(before: before, after: SetupDownload.pagesModel(download: d.download?.id, wasHere: wasHere,
                                                                     isHere: d.modelOnDisk, model: d.model.id))
        if let id = own.started { SpeechModels.shared.pageHolds = id }
    }

    private func start() {
        if !own.open {
            own.opened()
            gotStarted = false
        }
        refresh()
        if tick == nil {
            tick = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [weak self] _ in
                MainActor.assumeIsolated { self?.refresh() }
            }
        }
        // the Mac's languages at once, then the server's Voice languages when it answers
        touched = false
        defaults = SpokenLanguage.preferredCodes().filter(SpokenLanguage.whisperLanguages.contains)
        languages = Dictation.shared.prefs.languages ?? defaults
        refresh()
        Task {
            defaults = await Dictation.shared.defaultLanguages()
            if !touched { languages = Dictation.shared.prefs.languages ?? defaults }
            // once the languages are known, which choose the default model; not if the page has gone meanwhile
            prepare()
            refresh()
        }
    }

    fileprivate func stop() {
        if let id = own.closed(gotStarted: gotStarted, running: Dictation.shared.download?.id) {
            Dictation.shared.cancelDownload(id)
        }
        gotStarted = false
        SpeechModels.shared.pageHolds = nil
        tick?.invalidate()
        tick = nil
        KeyPicker.close()
    }

    private final class Delegate: NSObject, NSWindowDelegate {
        /// Asked for the close button and ⌘W only, not for Get Started's `close()`.
        func windowShouldClose(_ sender: NSWindow) -> Bool {
            MainActor.assumeIsolated { SetupGuide.done() }
            return true
        }

        func windowWillClose(_ notification: Notification) {
            MainActor.assumeIsolated { SetupGuide.guide.stop() }
        }
    }
}

private struct SetupGuideHost: View {
    @ObservedObject var guide: SetupGuide
    @ObservedObject private var dictation = Dictation.shared
    var body: some View {
        SetupPageView(facts: guide.facts, model: dictation.model.id) { guide.act($0) }
    }
}

private struct SetupOfferHost: View {
    @ObservedObject var guide: SetupGuide
    @ObservedObject private var dictation = Dictation.shared
    var body: some View {
        SetupOfferView(facts: guide.facts, model: dictation.model.id, act: { guide.act($0) }, notNow: SetupGuide.notNow)
    }
}
