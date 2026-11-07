// Creator Toolset, the Mac app: the site in a window, this Mac's AI in the menu bar, and
// Review notes as Mac notifications. The web app stays the one UI (see README.md).
import Sparkle
import SwiftUI
import WebKit

@main
struct CreatorToolsetMacApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @StateObject private var shell = Shell()
    /// Sparkle: reads the site's appcast every 4 hours and installs what it finds (Info.plist keys from
    /// build-app.sh). A build without a feed (`swift run`) starts no updater.
    private let updater = SPUStandardUpdaterController(
        startingUpdater: Bundle.main.object(forInfoDictionaryKey: "SUFeedURL") != nil,
        updaterDelegate: nil,
        userDriverDelegate: nil
    )

    var body: some Scene {
        Window("Creator Toolset", id: "main") {
            WebWindow(shell: shell)
        }
        .windowStyle(.hiddenTitleBar)
        .commands {
            CommandGroup(after: .appInfo) {
                Button("Check for Updates…") { updater.checkForUpdates(nil) }
            }
            CommandGroup(replacing: .appSettings) {
                Button("Settings…") { shell.showWindow(href: "/settings") }.keyboardShortcut(",", modifiers: .command)
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

        MenuBarExtra {
            MenuBarMenu(shell: shell, checkForUpdates: { updater.checkForUpdates(nil) })
        } label: {
            Image(systemName: shell.menuSymbol)
        }
        .menuBarExtraStyle(.menu)

        Settings {
            SettingsView(shell: shell)
        }
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    /// The menu bar item stays up when the window is closed.
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        false
    }
}

struct WebWindow: View {
    let shell: Shell
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        WebViewHost(webView: shell.webView)
            .ignoresSafeArea()
            .frame(minWidth: 960, minHeight: 640)
            .onAppear { shell.openWindow = { openWindow(id: "main") } }
    }
}

struct WebViewHost: NSViewRepresentable {
    let webView: WKWebView

    func makeNSView(context: Context) -> WKWebView { webView }

    func updateNSView(_ nsView: WKWebView, context: Context) {}
}

struct MenuBarMenu: View {
    @ObservedObject var shell: Shell
    let checkForUpdates: () -> Void
    @Environment(\.openSettings) private var openSettings

    var body: some View {
        Text(shell.aiLine)
            .onAppear { Task { await shell.refresh() } }
        if let error = shell.ai.lastError {
            Text("Last AI error: \(error)")
        }
        if let notice = shell.notice {
            Text(notice)
        }
        if shell.runsHere, let line = shell.serverLine {
            Text(line)
        }
        Divider()
        Button("Open Creator Toolset") { shell.showWindow() }
        Button("Open Workshop") { shell.showWindow(href: "/workshop") }
        Button("Open app log") { shell.openAppLog() }
        if shell.runsHere {
            Button("Open server log") { shell.openServerLog() }
        }
        Toggle("Use this Mac for my AI", isOn: Binding(get: { shell.aiOn }, set: { shell.setAI($0) }))
        Divider()
        Button("Settings…") { shell.showWindow(href: "/settings") }
        Button("Mac settings…") {
            NSApp.activate(ignoringOtherApps: true)
            openSettings()
        }
        Button("Check for Updates…") { checkForUpdates() }
        Button("Quit Creator Toolset") { NSApp.terminate(nil) }
    }
}

struct SettingsView: View {
    @ObservedObject var shell: Shell
    @State private var address = ""
    @State private var invalid = false
    @State private var port = ""

    var body: some View {
        Form {
            Section("This Mac") {
                Toggle("Use this Mac for my AI", isOn: Binding(get: { shell.aiOn }, set: { shell.setAI($0) }))
                Text("Runs your AI jobs with the Claude CLI on this Mac, signed in as you. Off by default.")
                    .font(.caption).foregroundStyle(.secondary)
                Text(shell.aiLine)
                if let notice = shell.notice {
                    Text(notice).font(.caption).foregroundStyle(.secondary)
                }
                if shell.pairedHere {
                    Button("Forget this Mac", role: .destructive) { shell.forgetThisMac() }
                }
            }
            if shell.server != nil {
                Section("Server") {
                    Toggle("Run the server on this Mac", isOn: Binding(get: { shell.runsHere }, set: { shell.setRunsHere($0) }))
                    Text("Your data, accounts and projects stay on this Mac. Off: the window opens the site below.")
                        .font(.caption).foregroundStyle(.secondary)
                    if shell.runsHere {
                        Text(shell.serverLine ?? "")
                        HStack {
                            TextField("Port", text: $port)
                                .onSubmit { savePort() }
                            Button("Change port") { savePort() }
                            Button("Open server log") { shell.openServerLog() }
                        }
                    }
                }
            }
            if !shell.runsHere {
                Section("Site") {
                    TextField("Site address", text: $address)
                        .onSubmit { save() }
                    if invalid {
                        Text("Use a full address, such as https://creatortoolset.com or http://localhost:3000.")
                            .foregroundStyle(.red)
                    }
                    HStack {
                        Button("Use creatortoolset.com") { shell.setSite(productionSite) }
                        Spacer()
                        Button("Save") { save() }.keyboardShortcut(.defaultAction)
                    }
                }
            }
        }
        .padding()
        .frame(width: 520)
        .onAppear {
            address = shell.runsHere ? productionSite.absoluteString : shell.base.absoluteString
            port = shell.server.map { String($0.port) } ?? ""
        }
    }

    private func savePort() {
        guard let value = Int(port), (1024...65535).contains(value) else {
            port = shell.server.map { String($0.port) } ?? ""
            return
        }
        shell.setServerPort(value)
    }

    private func save() {
        guard let url = siteURL(from: address) else {
            invalid = true
            return
        }
        invalid = false
        shell.setSite(url)
    }
}
