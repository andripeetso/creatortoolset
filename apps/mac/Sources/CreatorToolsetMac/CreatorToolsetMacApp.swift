// Creator Toolset, the Mac app: the site in a window, this Mac's AI in the menu bar, and
// Review notes as Mac notifications. The web app stays the one UI (see README.md).
import Sparkle
import SwiftUI
import WebKit

@main
struct CreatorToolsetMacApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @StateObject private var shell: Shell
    /// Sparkle: reads the appcast at FEED_URL every hour and installs what it finds (Info.plist keys from
    /// build-app.sh). A build without a feed (`swift run`) starts no updater.
    private let updater = SPUStandardUpdaterController(
        startingUpdater: Bundle.main.object(forInfoDictionaryKey: "SUFeedURL") != nil,
        updaterDelegate: UpdateWhenIdle.shared,
        userDriverDelegate: nil
    )

    init() {
        let shell = Shell()
        _shell = StateObject(wrappedValue: shell)
        AppDelegate.shell = shell   // links arrive at the delegate, also while the window is closed
    }

    var body: some Scene {
        Window("Creator Toolset", id: "main") {
            WebWindow(shell: shell)
        }
        // first open: most of the screen (the 960×640 minimum squeezed every page)
        .defaultSize(roomyWindowFrame(screen: NSScreen.main?.visibleFrame ?? CGRect(x: 0, y: 0, width: 1440, height: 900)).size)
        .windowStyle(.hiddenTitleBar)
        .commands {
            CommandGroup(after: .appInfo) {
                Button("Check for Updates…") { updater.checkForUpdates(nil) }
            }
            // the one Settings: the server's own (This Mac is a section there, and in the Servers menu)
            CommandGroup(replacing: .appSettings) {
                Button("Settings…") { shell.openSettings() }.keyboardShortcut(",", modifiers: .command)
            }
            CommandMenu("Record") {
                if Recorder.available {
                    // its shortcut is global and the user's own (RecordShortcut.swift), shown in Recording Shortcut
                    Button("New Recording…") { shell.recorder.openToolbar() }
                    Button("Stop Recording") { shell.recorder.stop() }.keyboardShortcut(".", modifiers: [.command, .option])
                    Divider()
                    Button("All Recordings") { shell.showWindow(href: "/record") }
                    RecordingMenu(recorder: shell.recorder)
                } else {
                    Text("Screen recording needs macOS 15")
                }
            }
            CommandMenu("Servers") {
                ServersMenu(shell: shell)
            }
            CommandMenu("Go") {
                AppToolItems(shell: shell)
                Divider()
                Button("Back") { shell.webView.goBack() }.keyboardShortcut("[", modifiers: .command)
                Button("Forward") { shell.webView.goForward() }.keyboardShortcut("]", modifiers: .command)
                Button("Reload") { shell.webView.reload() }.keyboardShortcut("r", modifiers: .command)
                PluginMenuItems(shell: shell)
            }
        }

        Window("This Mac", id: "this-mac") {
            ThisMacView(shell: shell)
        }
        .windowResizability(.contentMinSize)

        Window("Run your own server", id: "guide") {
            GuideView(shell: shell)
        }
        .windowResizability(.contentMinSize)

        MenuBarExtra {
            ActivityPanel(shell: shell, checkForUpdates: { updater.checkForUpdates(nil) })
        } label: {
            MenuBarLabel(shell: shell)
        }
        .menuBarExtraStyle(.window)
    }
}

/// Sparkle installs a downloaded update when the app quits, and this app lives in the menu bar and never quits, so
/// updates waited forever (a build two days old while newer ones shipped). Instead: install and relaunch while the
/// person is away (`updateMayInstall`), with no AI job on this Mac and no recording; or when they quit, as before.
final class UpdateWhenIdle: NSObject, SPUUpdaterDelegate {
    static let shared = UpdateWhenIdle()
    /// The quiet update found its idle moment itself: no question then.
    private var quiet = false

    func updater(_ updater: SPUUpdater, willInstallUpdateOnQuit item: SUAppcastItem,
                 immediateInstallationBlock install: @escaping () -> Void) -> Bool {
        whenIdle(every: 60, inBackground: true) { [weak self] in
            self?.quiet = true
            install()
        }
        return true
    }

    /// Every install and relaunch passes here once. Something the relaunch would
    /// cut off: ask first. Update When Done waits for it; Update Now goes ahead.
    func updater(_ updater: SPUUpdater, shouldPostponeRelaunchForUpdate item: SUAppcastItem,
                 untilInvokingBlock install: @escaping () -> Void) -> Bool {
        MainActor.assumeIsolated {
            guard !quiet, let shell = AppDelegate.shell else { return false }
            let cut = Self.wouldInterrupt(shell)
            guard !cut.isEmpty else { return false }
            let a = NSAlert()
            a.messageText = "Updating now stops what's running"
            a.informativeText = cut.map { "• \($0)" }.joined(separator: "\n")
                + (shell.runsHere ? "\n\nAI Editor steps start again by themselves after the update." : "")
            a.addButton(withTitle: "Update When Done")
            a.addButton(withTitle: "Update Now")
            NSApp.activate()
            guard a.runModal() == .alertFirstButtonReturn else { return false }
            whenIdle(every: 5, inBackground: false, install)
            return true
        }
    }

    /// One line per thing a relaunch cuts off. The server's own work only counts when it runs on this Mac.
    @MainActor static func wouldInterrupt(_ shell: Shell) -> [String] {
        var cut: [String] = []
        if shell.recorder.busy && shell.recorder.phase != .toolbar { cut.append("Your screen recording") }
        if shell.ai.running > 0 { cut.append("\(shell.ai.running) AI request\(shell.ai.running == 1 ? "" : "s") on this Mac") }
        if shell.runsHere { cut += shell.rows.active.filter { $0.id != "mac" }.map { "\($0.title) (\($0.detail))" } }
        return cut
    }

    /// Calls `go` once no AI job runs on this Mac and nothing records; for the quiet updates also only while nobody is
    /// at the Mac (`updateMayInstall`).
    private func whenIdle(every seconds: TimeInterval, inBackground: Bool, _ go: @escaping () -> Void) {
        Timer.scheduledTimer(withTimeInterval: seconds, repeats: true) { timer in
            MainActor.assumeIsolated {
                guard let shell = AppDelegate.shell, shell.ai.running == 0, !shell.recorder.busy else { return }
                if inBackground {
                    let away = CGEventSource.secondsSinceLastEventType(.combinedSessionState, eventType: CGEventType(rawValue: ~0)!)
                    guard updateMayInstall(appActive: NSApp.isActive, aiJobs: shell.ai.running, recording: shell.recorder.busy,
                                           secondsSinceInput: away) else { return }
                } else {
                    guard Self.wouldInterrupt(shell).isEmpty else { return }
                }
                timer.invalidate()
                go()
            }
        }
    }
}

/// Whether a downloaded update may quit and relaunch the app now: the app is in the background, nothing runs in it,
/// and nobody has touched the keyboard or the mouse for 5 minutes. In the background alone was not enough: a minute
/// in another app (the owner, 11-11, with a release about every hour) closed this one while he was working with it,
/// three times in an afternoon, and each looked like a crash.
func updateMayInstall(appActive: Bool, aiJobs: Int, recording: Bool, secondsSinceInput: Double) -> Bool {
    !appActive && aiJobs == 0 && !recording && secondsSinceInput >= 300
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    @MainActor static var shell: Shell?

    /// Set when the app starts quitting: quitting (and the relaunches that quit) closes the windows too.
    static var quitting = false

    /// The menu bar item stays up when the window is closed.
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        false
    }

    @MainActor func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        AppDelegate.quitting = true
        return .terminateNow
    }

    @MainActor func applicationDidFinishLaunching(_ notification: Notification) {
        // the last window closed: out of the Dock and the app switcher, still in the menu bar (Shell.showWindow brings it back)
        NotificationCenter.default.addObserver(forName: NSWindow.willCloseNotification, object: nil, queue: .main) { note in
            let closing = note.object as? NSWindow
            DispatchQueue.main.async {
                guard !NSApp.windows.contains(where: { $0 !== closing && $0.isVisible && $0.styleMask.contains(.titled) }) else { return }
                NSApp.setActivationPolicy(.accessory)
                let key = "keepsRunningSaid"
                guard closeNoticeNeeded(quitting: AppDelegate.quitting, said: UserDefaults.standard.bool(forKey: key)) else { return }
                UserDefaults.standard.set(true, forKey: key)
                let a = NSAlert()
                a.messageText = "Creator Toolset keeps running"
                a.informativeText = "It stays in the menu bar. Click its icon there to open the window again, or choose Quit to stop it."
                a.runModal()
            }
        }
    }

    /// A creatortoolset:// link (or the site's own https link) opened anywhere: that page in the window, brought forward.
    @MainActor func application(_ application: NSApplication, open urls: [URL]) {
        guard let shell = Self.shell else { return }
        for url in urls {
            // an account sign-in's one-time code: swapped for the account, never loaded as a page
            if let code = accountCode(from: url) {
                shell.accountLink(code)
                continue
            }
            if isConnectDone(url) {
                shell.showWindow()
                continue
            }
            if let href = appHref(from: url, site: shell.base) { shell.showWindow(href: href) }
        }
    }
}

/// The main window: the server's page, or, with no server picked, a screen to pick or add one.
struct WebWindow: View {
    @ObservedObject var shell: Shell
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        ZStack {
            WebViewHost(webView: shell.webView)
                .ignoresSafeArea()
            if !shell.hasServer {
                PickServerView(shell: shell)
            } else if shell.runsHere, let problem = shell.serverProblem {
                ServerProblemView(problem: problem, shell: shell)
            }
        }
        .frame(minWidth: 960, minHeight: 640)
        .onAppear {
            shell.openWindowID = { openWindow(id: $0) }
            // the first window shown: the login item is on for a copy in /Applications, and that is said once
            if LoginItem.setOnce() { Task { @MainActor in LoginItem.explainOnce() } }
        }
    }
}

/// The server on this Mac could not start: the plain words, Try again and the log (the technical reason is logged).
struct ServerProblemView: View {
    let problem: String
    @ObservedObject var shell: Shell

    var body: some View {
        VStack(spacing: 14) {
            Text(problem).multilineTextAlignment(.center)
            HStack {
                Button("Open log") { shell.openServerLog() }
                Button("Try again") { shell.retryServer() }
                    .keyboardShortcut(.defaultAction)
            }
        }
        .frame(width: 440)
        .padding(32)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(.background)
    }
}

struct WebViewHost: NSViewRepresentable {
    let webView: WKWebView

    func makeNSView(context: Context) -> WKWebView { webView }

    func updateNSView(_ nsView: WKWebView, context: Context) {}
}

/// "Pick or add a server": the window when no server is picked (This Mac's server off and none added, or the
/// picked one removed). There is no default site.
struct PickServerView: View {
    @ObservedObject var shell: Shell

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Pick or add a server").font(.title2.bold())
            Text("Creator Toolset runs on a server: the one this app runs on this Mac, or one of your own.")
                .foregroundStyle(.secondary)
            ForEach(shell.listed) { s in
                Button {
                    shell.select(s.id)
                } label: {
                    Label(s.id == thisMacID ? "Run the server on this Mac" : "\(s.name)  \(s.url)",
                          systemImage: s.id == thisMacID ? "laptopcomputer" : "server.rack")
                }
            }
            AddServerField(shell: shell)
        }
        .frame(width: 440)
        .padding(32)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(.background)
    }
}

/// An address (or a one-time sign-in link) and Add server.
struct AddServerField: View {
    @ObservedObject var shell: Shell
    @State private var address = ""
    @State private var problem: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                TextField("Server address, such as https://tools.example.com", text: $address)
                    .onSubmit { add() }
                Button("Add server") { add() }.disabled(address.trimmingCharacters(in: .whitespaces).isEmpty)
            }
            Text(problem ?? "Then sign in on its page in the window.")
                .font(.caption).foregroundStyle(problem == nil ? Color.secondary : Color.red)
        }
    }

    private func add() {
        problem = shell.addServer(address)
        if problem == nil { address = "" }
    }
}

/// The main menu's Servers: each server (⌥⌘1…⌥⌘9; ⌘⇧3–6 are the system's screenshot keys and ⌃⌘digits reach the
/// Workshop's list), Add server, Run your own server, This Mac.
struct ServersMenu: View {
    @ObservedObject var shell: Shell
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        ForEach(Array(shell.listed.enumerated()), id: \.element.id) { index, s in
            Toggle(s.name, isOn: Binding(get: { shell.current == s.id }, set: { _ in
                shell.select(s.id)
                openWindow(id: "main")
            }))
            .keyboardShortcut(index < 9 ? KeyboardShortcut(KeyEquivalent(Character(String(index + 1))), modifiers: [.command, .option]) : nil)
        }
        if !shell.listed.isEmpty { Divider() }
        // only with a connect service set: without one the server can't start the link, and the item did nothing
        if connectService != nil { Button("Add this Mac to my account…") { Task { await shell.connectThisComputer() } } }
        Button("Add server…") { open("this-mac") }
        Button("Run your own server…") { open("guide") }
        Button("This Mac…") { open("this-mac") }
    }

    private func open(_ id: String) {
        openWindow(id: id)
        NSApp.activate(ignoringOtherApps: true)
    }
}

struct MenuBarLabel: View {
    @ObservedObject var shell: Shell

    var body: some View {
        Image(nsImage: menuBarImage(shell.status, waiting: shell.rows.forYou.count))
            .accessibilityLabel(menuStatusLabel(shell.status, waiting: shell.rows.forYou.count))
    }
}
