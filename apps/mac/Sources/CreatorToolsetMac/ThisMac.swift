// This Mac: the app's own options, reached from the Servers menu, the menu bar
// and the picker in the window's top bar. Servers, AI on this Mac, the server here (port, log, data, other devices)
// and the optional account server. The guide "Run your own server" is the second window here.
import AppKit
import SwiftUI

struct ThisMacView: View {
    @ObservedObject var shell: Shell
    @Environment(\.openWindow) private var openWindow
    @State private var port = ""
    @AppStorage(limitsReadingKey) private var readLimits = false
    @State private var password = ""
    @State private var again = ""
    @State private var askPassword = false
    @State private var dataMessage: String?
    @State private var accessMessage: String?
    @State private var busy = false
    @State private var dataSize: String?
    @State private var accountServer = ""
    @State private var accountInvalid = false
    @State private var renaming: String?
    @State private var newName = ""

    var body: some View {
        Form {
            Section("Servers") {
                ForEach(shell.listed) { s in serverRow(s) }
                AddServerField(shell: shell)
                Button("Run your own server…") { openWindow(id: "guide") }
            }
            Section("AI on this Mac") {
                Toggle("Use this Mac for my AI", isOn: Binding(get: { shell.aiOn }, set: { shell.setAI($0) }))
                    .disabled(!shell.hasServer)
                Text("Runs the open server's AI jobs for your account with the Claude CLI on this Mac, signed in as you.")
                    .font(.caption).foregroundStyle(.secondary)
                Text(shell.aiLine)
                if let notice = shell.notice {
                    Text(notice).font(.caption).foregroundStyle(.secondary)
                }
                if shell.pairedHere {
                    Button("Remove this Mac from my account", role: .destructive) { shell.forgetThisMac() }
                }
            }
            Section("Plan limits") {
                Toggle("Read this Mac's Claude and Codex limits", isOn: $readLimits)
                Text("Undocumented: reads each CLI's login on this Mac (the Claude login from the Keychain, Codex's auth.json) and asks the CLI's usage page every five minutes. Off by default; off sends nothing and reads nothing.")
                    .font(.caption).foregroundStyle(.secondary)
            }
            if shell.server != nil {
                Section("Server on this Mac") {
                    Toggle("Run the server on this Mac", isOn: Binding(get: { shell.runsHere }, set: { shell.setRunsHere($0) }))
                    Text("Your data, account and projects stay on this Mac. Off: the window opens another server from the list.")
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
            Section("Account") {
                TextField("Account server", text: $accountServer)
                    .onSubmit { saveAccountServer() }
                Text(accountInvalid
                     ? "Use a full address, such as https://accounts.example.com, or leave it empty."
                     : "Optional: where the first run's Apple or Google sign-in happens. Empty: no account step.")
                    .font(.caption).foregroundStyle(accountInvalid ? .red : .secondary)
                HStack {
                    Spacer()
                    Button("Save") { saveAccountServer() }
                }
            }
        }
        .formStyle(.grouped)
        .frame(width: 560)
        .frame(minHeight: 420)
        .onAppear {
            accountServer = shell.account.serverText
            port = shell.server.map { String($0.port) } ?? ""
        }
    }

    /// One server: picked or Open, and for an added one Rename and Remove.
    @ViewBuilder private func serverRow(_ s: ServerEntry) -> some View {
        HStack {
            Image(systemName: s.id == shell.current ? "checkmark.circle.fill" : "circle")
                .foregroundStyle(s.id == shell.current ? Color.accentColor : Color.secondary)
            VStack(alignment: .leading) {
                if renaming == s.id {
                    TextField("Name", text: $newName)
                        .onSubmit { shell.renameServer(s.id, to: newName); renaming = nil }
                } else {
                    Text(s.name)
                }
                Text(s.id == thisMacID ? "The server this app runs on this Mac" : s.url)
                    .font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
            }
            Spacer()
            if s.id != shell.current {
                Button("Open") { shell.select(s.id); shell.showWindow() }
            }
            if s.id != thisMacID {
                Button(renaming == s.id ? "Done" : "Rename") {
                    if renaming == s.id {
                        shell.renameServer(s.id, to: newName)
                        renaming = nil
                    } else {
                        newName = s.name
                        renaming = s.id
                    }
                }
                Button("Remove", role: .destructive) { shell.removeServer(s.id) }
            }
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
            Text("Off: only this Mac reaches the server. On: devices on your network sign in at http://\(ProcessInfo.processInfo.hostName):\(server.port) as \(LocalServer.ownerName) with this computer's password.")
                .font(.caption).foregroundStyle(.secondary)
            if askPassword {
                SecureField("This computer's password (6 characters or more)", text: $password)
                SecureField("Type it again", text: $again)
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
}

/// Run your own server: the steps of SELF_HOSTING.md in short, each with the check this app can run.
struct GuideView: View {
    @ObservedObject var shell: Shell
    @State private var domain = ""
    @State private var https = GuideCheck.unknown("Not checked yet")
    @State private var reachable = GuideCheck.unknown("Not checked yet")
    @State private var signedIn = GuideCheck.unknown("Not checked yet")
    @State private var checking = false

    private var name: String {
        let host = serverInput(domain)?.url.host
        return host ?? "tools.example.com"
    }

    private var command: String {
        """
        git clone <the Creator Toolset repository> creator-toolset
        cd creator-toolset/apps/captions
        scripts/setup-server.sh \(name)
        """
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                Text("Run your own server").font(.title2.bold())
                Text("The same app as on this Mac, on a machine that stays on, so your phone and other computers reach it. It runs on your own keys and accounts: AI on your own Claude Code or Codex through this Mac, storage on its disk or your own S3-compatible bucket, research on your own Apify key.")
                    .foregroundStyle(.secondary)

                step(1, "A server") {
                    Text("Any small VPS, or a computer at home that stays on, running Linux on x86_64 (amd64) with Docker Engine and Docker Compose 2.24 or newer. Start with 4 vCPU and 8 GB of RAM: exports and audio work are heavy. Ports 80 and 443 must reach it from the internet; at home, forward them on the router. The image doesn't run on Apple-silicon Macs or ARM boards.")
                }
                step(2, "Your domain") {
                    Text("Pick a name such as tools.example.com and add a DNS A record for it with the server's public IPv4 address.")
                    TextField("Your server's name, such as tools.example.com", text: $domain)
                }
                step(3, "One command on the server") {
                    HStack(alignment: .top) {
                        Text(command).font(.system(.caption, design: .monospaced)).textSelection(.enabled)
                            .padding(8).frame(maxWidth: .infinity, alignment: .leading)
                            .background(Color.secondary.opacity(0.12), in: RoundedRectangle(cornerRadius: 6))
                        Button("Copy") {
                            NSPasteboard.general.clearContents()
                            NSPasteboard.general.setString(command, forType: .string)
                        }
                    }
                    Text("It writes .env (your name, a random APP_SECRET, readable only by you) and starts the app and Caddy with docker compose up -d --build. Caddy gets the HTTPS certificate for your name and renews it. The first build takes a while. Your first password is the APP_SECRET in .env.")
                        .font(.caption).foregroundStyle(.secondary)
                    checkRow("HTTPS is valid", https)
                    checkRow("The app answers (GET /api/health)", reachable)
                }
                step(4, "Add it here and sign in") {
                    Button("Add server") { shell.addServer(name) }.disabled(serverInput(domain) == nil)
                    Text("The window opens your server's sign-in: admin, with APP_SECRET as the password. Then set your own password in Settings → Account.")
                        .font(.caption).foregroundStyle(.secondary)
                    checkRow("Signed in", signedIn)
                }
                step(5, "Your own keys") {
                    Text("AI: with your server open, turn on Use this Mac for my AI; Settings → Your AI shows the install and sign-in commands. Storage: the server's disk, or your bucket's OBJECT_STORAGE_ values in .env. Research: your Apify key in Settings → Connectors. The Apple or Google sign-in on the first run is optional: leave This Mac → Account server empty to skip it.")
                }
                HStack {
                    Button(checking ? "Checking…" : "Check") { Task { await check() } }
                        .disabled(checking || serverInput(domain) == nil)
                        .keyboardShortcut(.defaultAction)
                    Text("Backups, updates and storage in full: SELF_HOSTING.md in the repository.")
                        .font(.caption).foregroundStyle(.secondary)
                }
            }
            .padding(24)
        }
        .frame(width: 600, height: 680)
    }

    private func check() async {
        guard let url = serverInput(domain)?.url else { return }
        checking = true
        (https, reachable) = await shell.probe(url)
        signedIn = await shell.signedIn(at: url)
            ? .ok("Signed in")
            : .failed(shell.servers.contains { $0.url == url.absoluteString } ? "Sign in on its page in the window" : "Add the server first")
        checking = false
    }

    @ViewBuilder private func step(_ n: Int, _ title: String, @ViewBuilder _ content: () -> some View) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("\(n). \(title)").font(.headline)
            content()
        }
    }

    @ViewBuilder private func checkRow(_ label: String, _ c: GuideCheck) -> some View {
        HStack(alignment: .firstTextBaseline) {
            Image(systemName: c.state == .ok ? "checkmark.circle.fill" : c.state == .failed ? "xmark.circle.fill" : "circle.dashed")
                .foregroundStyle(c.state == .ok ? Color.green : c.state == .failed ? Color.red : Color.secondary)
            VStack(alignment: .leading) {
                Text(label)
                Text(c.text).font(.caption).foregroundStyle(.secondary)
            }
        }
    }
}
