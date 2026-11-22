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

/// Computers: every server saved on this phone and its status. Every one connects; a tap opens its page. Which
/// computers are on the account is decided on the computers themselves, so nothing here switches one off.
struct ServersView: View {
    @ObservedObject private var connections = Connections.shared
    @ObservedObject private var accountServers = AccountServers.shared
    @EnvironmentObject private var servers: Servers
    @State private var adding = false
    /// The address Add opens with: a paired computer that signed this phone out signs in again by pairing.
    @State private var prefill: String?

    var body: some View {
        List {
            Section {
                ForEach(connections.servers) { entry in
                    NavigationLink { ServerDetailView(serverId: entry.serverId) } label: { row(entry) }
                }
            }
            if servers.signedOut, connections.current?.signedOut != true {
                Section { Button("Sign in again") { open(servers.current?.url.absoluteString) } }
            }
        }
        .overlay {
            if connections.servers.isEmpty {
                ContentUnavailableView {
                    Label("No computers connected", systemImage: "desktopcomputer")
                } description: {
                    Text("Add a computer to reach your chats, edits and footage.")
                } actions: {
                    Button("Add a computer") { open(nil) }.buttonStyle(.borderedProminent)
                }
            }
        }
        .navigationTitle("Computers")
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button("Add a computer", systemImage: "plus") { open(nil) }
            }
        }
        .sheet(isPresented: $adding) { NavigationStack { AddServerView(prefill: prefill) } }
    }

    private func open(_ address: String?) {
        prefill = address
        adding = true
    }

    private func row(_ entry: ServerEntry) -> some View {
        let state = connections.state(entry.serverId)
        return HStack(spacing: 12) {
            ConnectionDot(state: state)
            VStack(alignment: .leading, spacing: 2) {
                Text(entry.label)
                if let kind = entry.kindName { Text(kind).font(.caption).foregroundStyle(.secondary) }
                Text(ConnectionWords.status(entry, state, account: accountServers.computers.first { $0.id == entry.serverId }))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
                if entry.signedOut != true, state.phase == .backoff || (state.phase == .connecting && state.attempt > 1) {
                    Text("Retrying · attempt \(state.attempt)").font(.caption2).foregroundStyle(.secondary)
                }
            }
            Spacer()
            if entry.signedOut == true {
                Button("Sign in again") {
                    if entry.onAccount { connections.signInAgain(entry.serverId) } else { open(entry.home.absoluteString) }
                }
                .buttonStyle(.bordered)
                .font(.caption)
            }
        }
    }
}

/// The connection's banner under the bar: a capsule saying what is off ("Reconnecting to Sam's MacBook Pro", "You are
/// offline"), with a spinner while it tries again. After 800 ms of a state, so short reconnects never flash. A tap opens
/// Computers. When every computer looks connected but the reads fail, it says `fallback`, else "No connection".
struct ConnectionHeaderStatus: View {
    var fallback: String? = nil
    @ObservedObject private var connections = Connections.shared
    @ObservedObject private var chats = ChatsModel.shared
    @State private var open = false

    var body: some View {
        TimelineView(.periodic(from: .now, by: 0.4)) { context in
            let line = ConnectionWords.header(connections.servers, states: connections.states, offline: connections.offline, now: context.date)
            if let text = line ?? fallback ?? (chats.offline ? "No connection" : nil) {
                Button { open = true } label: {
                    HStack(spacing: 8) {
                        if connections.offline {
                            Image(systemName: "wifi.slash")
                        } else if text.hasPrefix("Reconnecting") {
                            ProgressView().controlSize(.small)
                        } else {
                            Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.orange)
                        }
                        Text(text).lineLimit(1)
                    }
                    .font(.footnote.weight(.semibold))
                    .padding(.horizontal, 14)
                    .frame(minHeight: 36)
                    .background(.regularMaterial, in: Capsule())
                    .overlay(Capsule().strokeBorder(Color(.separator), lineWidth: 0.5))
                    .shadow(color: .black.opacity(0.08), radius: 6, y: 2)
                }
                .buttonStyle(.plain)
                .accessibilityHint("Opens Computers")
                .frame(maxWidth: .infinity)
                .padding(.vertical, 4)
                .transition(.move(edge: .top).combined(with: .opacity))
            }
        }
        .animation(.easeOut(duration: 0.2), value: connections.offline)
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
        old.signedOut = true
        return ServerRegistry.Saved(servers: [mac, office, hosted, old], currentKey: mac.key)
    }()

    static let states: [String: ConnectionState] = [
        "mac-1": ConnectionState(phase: .connected, attempt: 1, routeId: "learned:http://10.0.0.20:43190", since: .distantPast),
        "mac-2": ConnectionState(phase: .backoff, attempt: 4,
                                 lastFailure: ConnectionFailure(reason: .remoteUnavailable, detail: "Office Mac mini's tunnel is offline.", hop: .tunnel,
                                                                via: .account, cause: "tunnel_down", httpStatus: 503, traceId: "7f3a9c21e0b4"),
                                 retryAt: Date().addingTimeInterval(42), routeId: Route.accountId, since: .distantPast),
        "studio": ConnectionState(phase: .connected, attempt: 1, routeId: "paired:https://studio.tinyacrobatics.example", since: .distantPast),
        "linux": ConnectionState(phase: .blocked, since: .distantPast),
    ]

    static let accountComputers: [AccountComputer] = [
        AccountComputer(id: "mac-1", name: "Sam's MacBook Pro", endpoint: URL(string: "https://mac-1.connect.example/"), status: .online),
        AccountComputer(id: "mac-2", name: "Office Mac mini", endpoint: URL(string: "https://mac-2.connect.example/"), status: .offline,
                        offlineReason: nil, endpointFailure: "tunnel_down", traceId: "7f3a9c21e0b4"),
        AccountComputer(id: "mac-3", name: "Kitchen iMac", endpoint: URL(string: "https://mac-3.connect.example/"), status: .online),
    ]
}
#endif
