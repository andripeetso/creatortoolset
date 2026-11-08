// Creator Toolset, the Mac app: the site in a window, this Mac's AI in the menu bar, and
// Review notes as Mac notifications. The web app stays the one UI (see README.md).
import Sparkle
import SwiftUI
import WebKit

@main
struct CreatorToolsetMacApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @StateObject private var shell: Shell
    /// Sparkle: reads the appcast at FEED_URL every 4 hours and installs what it finds (Info.plist keys from
    /// build-app.sh). A build without a feed (`swift run`) starts no updater.
    private let updater = SPUStandardUpdaterController(
        startingUpdater: Bundle.main.object(forInfoDictionaryKey: "SUFeedURL") != nil,
        updaterDelegate: nil,
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
            CommandMenu("Servers") {
                ServersMenu(shell: shell)
            }
            CommandMenu("Go") {
                Button("Home") { shell.open("/") }.keyboardShortcut("1", modifiers: .command)
                Button("Workshop") { shell.open("/workshop") }.keyboardShortcut("2", modifiers: .command)
                Button("Analyzer") { shell.open("/analyzer") }.keyboardShortcut("3", modifiers: .command)
                Divider()
                Button("Back") { shell.webView.goBack() }.keyboardShortcut("[", modifiers: .command)
                Button("Forward") { shell.webView.goForward() }.keyboardShortcut("]", modifiers: .command)
                Button("Reload") { shell.webView.reload() }.keyboardShortcut("r", modifiers: .command)
            }
        }

        Window("This Mac", id: "this-mac") {
            ThisMacView(shell: shell)
        }
        .windowResizability(.contentSize)

        Window("Run your own server", id: "guide") {
            GuideView(shell: shell)
        }
        .windowResizability(.contentSize)

        MenuBarExtra {
            ActivityPanel(shell: shell, checkForUpdates: { updater.checkForUpdates(nil) })
        } label: {
            MenuBarLabel(shell: shell)
        }
        .menuBarExtraStyle(.window)
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    @MainActor static var shell: Shell?

    /// The menu bar item stays up when the window is closed.
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        false
    }

    @MainActor func applicationDidFinishLaunching(_ notification: Notification) {
        LoginItem.setOnce()
        // the last window closed: out of the Dock and the app switcher, still in the menu bar (Shell.showWindow brings it back)
        NotificationCenter.default.addObserver(forName: NSWindow.willCloseNotification, object: nil, queue: .main) { note in
            let closing = note.object as? NSWindow
            DispatchQueue.main.async {
                if !NSApp.windows.contains(where: { $0 !== closing && $0.isVisible && $0.styleMask.contains(.titled) }) {
                    NSApp.setActivationPolicy(.accessory)
                }
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
            }
        }
        .frame(minWidth: 960, minHeight: 640)
        .onAppear { shell.openWindowID = { openWindow(id: $0) } }
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
    @Environment(\.openWindow) private var openWindow

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
            Button("Run your own server…") { openWindow(id: "guide") }
                .buttonStyle(.link)
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
            Text(problem ?? "Then sign in on its page in the window. A one-time sign-in link from that server works here too.")
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
