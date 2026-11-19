import SwiftUI

/// The connection's dot.
struct ConnectionDot: View {
    let state: ConnectionState

    var body: some View {
        Circle()
            .fill(ConnectionWords.color(ConnectionWords.tone(state)))
            .frame(width: 9, height: 9)
            .accessibilityLabel(ConnectionWords.label(ConnectionWords.tone(state)))
    }
}

/// Computers: every server saved on this phone, each with its status and a switch (off = kept saved, not connected).
/// A tap opens its page; a long press removes it from this phone.
struct ServersView: View {
    @ObservedObject private var connections = Connections.shared
    @ObservedObject private var account = Account.shared
    @State private var adding = false
    @State private var removing: ServerEntry?

    var body: some View {
        List {
            Section {
                ForEach(connections.servers) { entry in
                    NavigationLink { ServerDetailView(serverId: entry.serverId) } label: { row(entry) }
                        .contextMenu {
                            Button("Remove from this device", systemImage: "trash", role: .destructive) { removing = entry }
                        }
                        .accessibilityHint("Long press to remove from this device")
                }
            } footer: {
                if !connections.servers.isEmpty { Text("Long press a computer to remove it from this phone.") }
            }
            if account.profile != nil {
                Section {
                    Button("Computers on your account") { AccountServers.shared.setupShown = true }
                }
            }
        }
        .overlay {
            if connections.servers.isEmpty {
                ContentUnavailableView {
                    Label("No computers connected", systemImage: "desktopcomputer")
                } description: {
                    Text("Add a computer to reach your chats, edits and footage.")
                } actions: {
                    Button("Add a computer") { adding = true }.buttonStyle(.borderedProminent)
                }
            }
        }
        .navigationTitle("Computers")
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button("Add a computer", systemImage: "plus") { adding = true }
            }
        }
        .sheet(isPresented: $adding) { NavigationStack { AddServerView() } }
        .alert("Remove from this device?", isPresented: Binding(get: { removing != nil }, set: { if !$0 { removing = nil } }), presenting: removing) { entry in
            Button("Cancel", role: .cancel) {}
            Button("Remove", role: .destructive) { connections.remove(entry.serverId) }
        } message: { entry in
            Text(removeMessage(entry))
        }
    }

    private func row(_ entry: ServerEntry) -> some View {
        let state = connections.state(entry.serverId)
        return HStack(spacing: 12) {
            ConnectionDot(state: state)
            VStack(alignment: .leading, spacing: 2) {
                Text(entry.label)
                Text(entry.enabled ? ConnectionWords.text(state) : "Switched off")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
                if state.phase == .backoff || (state.phase == .connecting && state.attempt > 1) {
                    Text("Retrying · attempt \(state.attempt)").font(.caption2).foregroundStyle(.secondary)
                }
            }
            Spacer()
            Toggle("Enable \(entry.label)", isOn: Binding(get: { entry.enabled }, set: { connections.setEnabled(entry.serverId, $0) }))
                .labelsHidden()
        }
    }

    private func removeMessage(_ entry: ServerEntry) -> String {
        var text = "Forget \(entry.label) and what this phone keeps of it. Switch it off instead to keep it saved."
        if entry.routes.contains(where: { $0.kind == .account }) {
            text += " It stays on your account and comes back in Computers on your account."
        }
        return text
    }
}

/// The header's connection line: after 800 ms of a state, so short reconnects never flash. A tap opens Computers.
struct ConnectionHeaderStatus: View {
    @ObservedObject private var connections = Connections.shared
    @State private var open = false

    var body: some View {
        TimelineView(.periodic(from: .now, by: 0.4)) { context in
            if let line = ConnectionWords.header(connections.servers, states: connections.states, offline: connections.offline, now: context.date) {
                Button { open = true } label: {
                    Label(line, systemImage: connections.offline ? "wifi.slash" : "arrow.triangle.2.circlepath")
                        .font(.caption.weight(.medium))
                        .foregroundStyle(.secondary)
                }
                .buttonStyle(.plain)
                .transition(.opacity)
            }
        }
        .sheet(isPresented: $open) { NavigationStack { ServersView() } }
    }
}

/// Over a screen that can't load from its server: offline, connecting, reconnecting, unavailable, with Retry now.
struct ConnectionNotice: View {
    let entry: ServerEntry
    /// What the screen would show: "chats", "footage".
    var thing = "page"
    @ObservedObject private var connections = Connections.shared

    var body: some View {
        if let notice = ConnectionWords.notice(entry.label, connections.state(entry.serverId), offline: connections.offline, thing: thing) {
            ContentUnavailableView {
                Label(notice.title, systemImage: connections.offline ? "wifi.slash" : "desktopcomputer.trianglebadge.exclamationmark")
            } description: {
                Text(notice.detail)
            } actions: {
                Button("Retry now") { connections.retry(entry.serverId) }.buttonStyle(.bordered)
            }
        }
    }
}

#if DEBUG
/// `-connectionDemo 1` at launch: made-up computers in every state, for screenshots. No server is asked anything.
/// `-connectionDemo first` shows the first-run screen; `-connectionDemo detail|diagnosis|add|setup` opens that screen.
enum ConnectionDemo {
    static let mode = UserDefaults.standard.string(forKey: "connectionDemo")
    static var on: Bool { mode != nil }

    static let saved: ServerRegistry.Saved = {
        guard mode != "first" else { return ServerRegistry.Saved() }
        let studio = URL(string: "https://studio.tinyacrobatics.example/")!
        let mac = ServerEntry(serverId: "mac-1", label: "Sam's MacBook Pro", routes: [
            Route(id: "learned:http://10.0.0.20:43190", url: URL(string: "http://10.0.0.20:43190/")!, learned: true, authorization: .account),
            Route(id: "learned:http://100.101.102.103:43190", url: URL(string: "http://100.101.102.103:43190/")!, learned: true, authorization: .account, network: "tailnet"),
            .account(URL(string: "https://mac-1.connect.example/")!),
        ], username: "sam", version: "0.15.63", platform: "mac", activeRouteId: "learned:http://10.0.0.20:43190", home: URL(string: "https://mac-1.connect.example/")!)
        let office = ServerEntry(serverId: "mac-2", label: "Office Mac mini", routes: [.account(URL(string: "https://mac-2.connect.example/")!)],
                                 username: "sam", version: "0.15.60", platform: "mac", home: URL(string: "https://mac-2.connect.example/")!)
        let hosted = ServerEntry(serverId: "studio", label: "Tiny Acrobatics studio", routes: [.paired(studio)], username: "sam",
                                 version: "0.15.63", platform: "hosted", home: studio)
        var old = ServerEntry(serverId: "linux", label: "Edit box", routes: [.paired(URL(string: "http://10.0.0.40:43190/")!)],
                              username: "sam", version: "0.14.2", home: URL(string: "http://10.0.0.40:43190/")!)
        old.enabled = false
        return ServerRegistry.Saved(servers: [mac, office, hosted, old], currentKey: mac.key)
    }()

    static let states: [String: ConnectionState] = [
        "mac-1": ConnectionState(phase: .connected, attempt: 1, routeId: "learned:http://10.0.0.20:43190", since: .distantPast),
        "mac-2": ConnectionState(phase: .backoff, attempt: 4,
                                 lastFailure: ConnectionFailure(reason: .remoteUnavailable, detail: "Office Mac mini's tunnel is offline.", hop: .tunnel,
                                                                via: .account, cause: "tunnel_down", httpStatus: 503, traceId: "7f3a9c21e0b4"),
                                 retryAt: Date().addingTimeInterval(42), routeId: Route.accountId, since: .distantPast),
        "studio": ConnectionState(phase: .connected, attempt: 1, routeId: "paired:https://studio.tinyacrobatics.example", since: .distantPast),
        "linux": ConnectionState(phase: .available, since: .distantPast),
    ]

    static let accountComputers: [AccountComputer] = [
        AccountComputer(id: "mac-1", name: "Sam's MacBook Pro", endpoint: URL(string: "https://mac-1.connect.example/"), status: .online),
        AccountComputer(id: "mac-2", name: "Office Mac mini", endpoint: URL(string: "https://mac-2.connect.example/"), status: .offline,
                        offlineReason: nil, endpointFailure: "tunnel_down", traceId: "7f3a9c21e0b4"),
        AccountComputer(id: "mac-3", name: "Kitchen iMac", endpoint: URL(string: "https://mac-3.connect.example/"), status: .online),
    ]
}
#endif
