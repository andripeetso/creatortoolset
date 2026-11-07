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
    @MainActor static var shell: Shell?

    /// The menu bar item stays up when the window is closed.
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        false
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
        if let line = shell.spaceLine {
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
    @State private var password = ""
    @State private var again = ""
    @State private var askPassword = false
    @State private var dataMessage: String?
    @State private var accessMessage: String?
    @State private var busy = false
    @State private var dataSize: String?
    @State private var accountServer = ""
    @State private var accountInvalid = false

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
                if shell.runsHere, let server = shell.server {
                    dataSection(server)
                    accessSection(server)
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
                        Spacer()
                        Button("Save") { save() }.keyboardShortcut(.defaultAction)
                    }
                }
            }
            Section("Account") {
                TextField("Account server", text: $accountServer)
                    .onSubmit { saveAccountServer() }
                Text(accountInvalid
                     ? "Use a full address, such as https://creatortoolset.com, or leave it empty."
                     : "Where you sign in with Apple or Google on the first run. Empty: no account step.")
                    .font(.caption).foregroundStyle(accountInvalid ? .red : .secondary)
                HStack {
                    Spacer()
                    Button("Save") { saveAccountServer() }
                }
            }
        }
        .padding()
        .frame(width: 520)
        .onAppear {
            accountServer = shell.account.serverText
            address = shell.runsHere ? productionSite.absoluteString : shell.base.absoluteString
            port = shell.server.map { String($0.port) } ?? ""
        }
    }

    /// Data location: the folder, its size and the disk's free space, Show in Finder, Move…, Remove old copy.
    @ViewBuilder private func dataSection(_ server: LocalServer) -> some View {
        Section("Data location") {
            Text(server.dataDir.path).textSelection(.enabled)
            Text([dataSize.map { "Uses \($0)" }, freeBytes(server.dataDir).map { "\(bytesText($0)) free on its disk" }].compactMap { $0 }.joined(separator: " · "))
                .font(.caption).foregroundStyle(.secondary)
            if let line = shell.spaceLine {
                Text(line).foregroundStyle(.orange)
            }
            HStack {
                Button("Show in Finder") { NSWorkspace.shared.activateFileViewerSelecting([server.dataDir]) }
                Button("Move…") { pickFolder { url in
                    busy = true
                    dataMessage = "Moving… the server is stopped until it's done."
                    Task {
                        dataMessage = await shell.moveData(to: url)
                        busy = false
                        measure(server)
                    }
                } }
                if server.dataProblem() != nil {
                    Button("Choose another folder…") { pickFolder { shell.useDataFolder($0) } }
                }
            }
            .disabled(busy)
            if let old = server.oldDataDir {
                HStack {
                    Text("The old copy is still in \(old.path).").font(.caption)
                    Button("Remove old copy") { server.removeOldCopy(); dataMessage = nil }
                }
            }
            if let dataMessage {
                Text(dataMessage).font(.caption).foregroundStyle(.secondary)
            }
        }
        .onAppear { measure(server) }
    }

    /// Access from other devices: a password of the owner's own first, then the server listens beyond this Mac.
    @ViewBuilder private func accessSection(_ server: LocalServer) -> some View {
        Section("Access from other devices") {
            Toggle("Let phones and other computers sign in", isOn: Binding(get: { server.otherDevices }, set: { on in
                if on && !server.hasOwnerPassword {
                    askPassword = true
                } else {
                    Task { accessMessage = await shell.setOtherDevices(on) }
                }
            }))
            Text("Off: only this Mac reaches the server. On: devices on your network sign in at http://\(ProcessInfo.processInfo.hostName):\(server.port) as \(LocalServer.ownerName) with your password.")
                .font(.caption).foregroundStyle(.secondary)
            if askPassword {
                SecureField("Choose a password (6 characters or more)", text: $password)
                SecureField("Again", text: $again)
                HStack {
                    Button("Cancel") { askPassword = false; password = ""; again = "" }
                    Button("Set password and turn on") {
                        guard password == again else { accessMessage = "The two passwords differ."; return }
                        Task {
                            accessMessage = await shell.setOtherDevices(true, password: password)
                            if accessMessage == nil { askPassword = false; password = ""; again = "" }
                        }
                    }
                    .disabled(password.count < 6)
                }
            }
            if let accessMessage {
                Text(accessMessage).font(.caption).foregroundStyle(.red)
            }
        }
    }

    private func measure(_ server: LocalServer) {
        let dir = server.dataDir
        Task {
            let stats = await Task.detached { folderStats(dir) }.value
            dataSize = bytesText(stats.bytes)
        }
    }

    private func pickFolder(_ done: @escaping (URL) -> Void) {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.canCreateDirectories = true
        panel.prompt = "Choose"
        panel.message = "An empty folder, on this Mac or an external disk"
        if panel.runModal() == .OK, let url = panel.url { done(url) }
    }

    private func savePort() {
        guard let value = Int(port), (1024...65535).contains(value) else {
            port = shell.server.map { String($0.port) } ?? ""
            return
        }
        shell.setServerPort(value)
    }

    private func saveAccountServer() {
        let text = accountServer.trimmingCharacters(in: .whitespaces)
        accountInvalid = !text.isEmpty && siteURL(from: text) == nil
        if !accountInvalid { shell.account.setServer(text) }
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
