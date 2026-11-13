// The dictation setup guide: shown once, on the first press of the talk key, and again from Settings ("Set up
// dictation"). Four steps, each skippable: the talk key, the two permissions, where speech turns into text, and a box to
// try it in.
import AppKit
import SwiftUI

/// What the guide shows, as plain values, so the steps are drawn in a test (SetupGuideShotsTests).
struct GuideFacts: Equatable {
    var talkKey: String?
    var talkHint: String
    var picking = false
    var microphone = false
    var accessibility = false
    /// The server has an engine the person has a key for, and dictation can use it (DictationEngine.serverWired).
    var serverOffered = false
    var engine = DictationEngine.thisMac
    var modelName: String
    var modelSize: String
    var modelHere = false
    /// 0...1 while the model downloads.
    var progress: Double?

    /// What still keeps "Try it" from working, in one line; nil when nothing does.
    var missing: String? {
        if !microphone || !accessibility { return "Allow \(!microphone ? "the microphone" : "Accessibility") first (step 2)." }
        if engine == .thisMac || !serverOffered, !modelHere {
            return progress.map { "The speech model is downloading · \(Int($0 * 100))%" } ?? "Download the speech model first (step 3)."
        }
        return nil
    }
}

enum GuideAction {
    case pickTalk, allowMicrophone, allowAccessibility, engine(DictationEngine), download, close
}

struct SetupGuideView: View {
    static let steps = 4
    @Binding var step: Int
    let facts: GuideFacts
    let act: (GuideAction) -> Void
    @State private var tried = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Step \(step + 1) of \(Self.steps)").font(.caption).foregroundStyle(.secondary)
            content.frame(maxWidth: .infinity, alignment: .leading)
            Spacer(minLength: 0)
            HStack {
                if step < Self.steps - 1 { Button("Skip") { act(.close) } }
                Spacer()
                if step > 0 { Button("Back") { step -= 1 } }
                Button(step == Self.steps - 1 ? "Done" : "Next") {
                    if step == Self.steps - 1 { act(.close) } else { step += 1 }
                }
                .keyboardShortcut(.defaultAction)
            }
        }
        .padding(20)
        .frame(width: 440, height: 300)
    }

    @ViewBuilder private var content: some View {
        switch step {
        case 0:
            heading("Your talk key", "Press it to start talking and again to stop. Or hold a key like fn while you talk.")
            HStack(spacing: 12) {
                Text(facts.picking ? "Press a key…" : facts.talkKey ?? "None")
                    .font(.system(size: 15, weight: .medium, design: .rounded))
                    .padding(.horizontal, 14).padding(.vertical, 8)
                    .background(RoundedRectangle(cornerRadius: 8).fill(Color.secondary.opacity(0.12)))
                    .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Color.secondary.opacity(0.3)))
                Button("Change…") { act(.pickTalk) }.disabled(facts.picking)
            }
        case 1:
            heading("Allow two things", "The microphone hears you. Accessibility lets your key work in every app and puts the words where your cursor is.")
            VStack(spacing: 10) {
                permission("Microphone", granted: facts.microphone) { act(.allowMicrophone) }
                permission("Accessibility", granted: facts.accessibility) { act(.allowAccessibility) }
            }
        case 2:
            heading("Where speech turns into text", facts.serverOffered ? "Pick one. You can change it in Settings." : "On this Mac: private, and it works offline.")
            if facts.serverOffered {
                Picker("", selection: Binding(get: { facts.engine }, set: { act(.engine($0)) })) {
                    Text("This Mac").tag(DictationEngine.thisMac)
                    Text("Your server's engine").tag(DictationEngine.server)
                }
                .pickerStyle(.radioGroup)
                .labelsHidden()
            }
            if facts.engine == .thisMac || !facts.serverOffered {
                model
            } else {
                Text("Uses your speech key on the server. Nothing to download.").foregroundStyle(.secondary)
            }
        default:
            heading("Try it", facts.talkKey == nil ? "Click in the box, then choose Dictate in the menu bar."
                : "Click in the box, then \(facts.talkHint.prefix(1).lowercased() + facts.talkHint.dropFirst()).")
            TextField("Your words appear here", text: $tried, axis: .vertical)
                .lineLimit(3...5)
                .textFieldStyle(.roundedBorder)
            if let missing = facts.missing {
                Text(missing).font(.callout).foregroundStyle(.orange)
            }
        }
    }

    private var model: some View {
        HStack(spacing: 10) {
            VStack(alignment: .leading, spacing: 2) {
                Text(facts.modelName)
                Text(facts.modelSize).font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
            if facts.modelHere {
                Image(systemName: "checkmark.circle.fill").foregroundStyle(.green).accessibilityLabel("Downloaded")
            } else if let progress = facts.progress {
                ProgressView(value: progress).frame(width: 120)
                Text("\(Int(progress * 100))%").monospacedDigit().foregroundStyle(.secondary)
            } else {
                Button("Download") { act(.download) }
            }
        }
        .padding(12)
        .background(RoundedRectangle(cornerRadius: 8).fill(Color.secondary.opacity(0.08)))
    }

    private func heading(_ title: String, _ text: String) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title).font(.title2.weight(.semibold))
            Text(text).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
        }
    }

    private func permission(_ name: String, granted: Bool, allow: @escaping () -> Void) -> some View {
        HStack {
            Text(name)
            Spacer()
            if granted {
                Image(systemName: "checkmark.circle.fill").foregroundStyle(.green).accessibilityLabel("Allowed")
            } else {
                Button("Allow", action: allow)
            }
        }
        .padding(12)
        .background(RoundedRectangle(cornerRadius: 8).fill(Color.secondary.opacity(0.08)))
    }
}

/// The guide's window and what it reads from dictation, refreshed while it is open (a permission given in System
/// Settings ticks without a click).
@MainActor
final class SetupGuide: ObservableObject {
    private static var window: NSWindow?
    private static let guide = SetupGuide()

    @Published var step = 0
    @Published private(set) var facts = SetupGuide.read(serverOffered: false)
    private var serverOffered = false
    private var tick: Timer?

    static var isOpen: Bool { window?.isVisible == true }

    static func show() {
        UserDefaults.standard.set(true, forKey: DictationPrefs.keys.guided)
        let g = guide
        if window == nil {
            let host = NSHostingController(rootView: SetupGuideHost(guide: g))
            let w = NSWindow(contentViewController: host)
            w.title = "Set Up Dictation"
            w.styleMask.remove(.resizable)
            w.isReleasedWhenClosed = false
            NotificationCenter.default.addObserver(forName: NSWindow.willCloseNotification, object: w, queue: .main) { _ in
                MainActor.assumeIsolated { g.stopWatching() }
            }
            window = w
        }
        if !isOpen { g.step = 0; window?.center() }
        g.startWatching()
        NSApp.activate(ignoringOtherApps: true)
        window?.makeKeyAndOrderFront(nil)
        window?.orderFrontRegardless()  // a shortcut can't activate an accessory app on macOS 14+
    }

    static func read(serverOffered: Bool) -> GuideFacts {
        let d = Dictation.shared
        let m = d.model
        return GuideFacts(
            talkKey: d.talkKeyText, talkHint: d.talkHint, picking: d.picking == .talk,
            microphone: MicrophoneAccess.status == .authorized, accessibility: AXIsProcessTrusted(),
            serverOffered: serverOffered, engine: d.prefs.engine,
            modelName: m.displayName, modelSize: modelSize(m.sizeMB), modelHere: d.modelOnDisk,
            progress: d.download?.id == m.id ? d.download?.progress : nil)
    }

    func act(_ action: GuideAction) {
        let d = Dictation.shared
        switch action {
        case .pickTalk: d.pick(.talk)
        case .allowMicrophone: d.allowMicrophone()
        case .allowAccessibility: d.allowAccessibility()
        case .engine(let e): d.setEngine(e)
        case .download: d.fetch(d.model)
        case .close: Self.window?.close()
        }
        refresh()
    }

    private func refresh() {
        let new = Self.read(serverOffered: serverOffered)
        if new != facts { facts = new }
    }

    private func startWatching() {
        refresh()
        if tick == nil {
            tick = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [weak self] _ in
                MainActor.assumeIsolated { self?.refresh() }
            }
        }
        guard DictationEngine.serverWired, let engines = Dictation.shared.serverEngines else { return }
        Task {
            serverOffered = !(await engines()).isEmpty
            refresh()
        }
    }

    private func stopWatching() {
        tick?.invalidate()
        tick = nil
        KeyPicker.close()
    }
}

private struct SetupGuideHost: View {
    @ObservedObject var guide: SetupGuide
    var body: some View {
        SetupGuideView(step: $guide.step, facts: guide.facts) { guide.act($0) }
    }
}
