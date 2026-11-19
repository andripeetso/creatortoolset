import SwiftUI

/// The account's computers and their status: each is on this phone and connects with no code and no password.
/// Hosted servers the account signed in to are signed in to with the same account.
struct AccountComputersRows: View {
    @ObservedObject private var accountServers = AccountServers.shared
    @ObservedObject private var connections = Connections.shared
    @State private var signingIn: String?
    @State private var problem: String?
    @State private var password: SignIn.Target?

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if accountServers.loading, accountServers.computers.isEmpty {
                HStack(spacing: 10) {
                    ProgressView()
                    Text("Loading your computers.").foregroundStyle(.secondary)
                }
                .padding(.vertical, 12)
            } else if let failed = accountServers.problem {
                VStack(alignment: .leading, spacing: 8) {
                    Problem(text: failed)
                    Button("Try again") { Task { await accountServers.refresh() } }
                        .buttonStyle(.bordered)
                    if let trace = accountServers.traceId {
                        DisclosureGroup("Details") {
                            HStack {
                                Text(trace).font(.caption.monospaced()).textSelection(.enabled)
                                Spacer()
                                Button("Copy") { UIPasteboard.general.string = trace }.font(.caption)
                            }
                        }
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    }
                }
                .padding(.vertical, 8)
            } else if accountServers.computers.isEmpty, accountServers.hosted.isEmpty {
                Text("No computers on your account yet. Turn on Reach from anywhere in Settings → Computers on your Mac.")
                    .foregroundStyle(.secondary).padding(.vertical, 12)
            }
            ForEach(accountServers.computers) { computer in
                HStack(spacing: 12) {
                    Circle().fill(computer.status == .online ? Color.green : computer.status == .offline ? Color.red : Color.gray)
                        .frame(width: 9, height: 9)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(computer.name)
                        Text(statusLine(computer)).font(.caption).foregroundStyle(.secondary)
                    }
                    Spacer()
                }
                .accessibilityElement(children: .combine)
                .padding(.vertical, 10)
                Divider()
            }
            ForEach(accountServers.hosted) { server in
                HStack {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(server.name)
                        Text("Server").font(.caption).foregroundStyle(.secondary)
                    }
                    Spacer()
                    if connections.servers.contains(where: { $0.routes.contains { Routes.origin($0.url) == Routes.origin(server.url) } }) {
                        Text("Added").font(.caption).foregroundStyle(.secondary)
                    } else if signingIn == server.id {
                        ProgressView()
                    } else {
                        Button("Sign in") { Task { await signIn(server) } }.buttonStyle(.bordered)
                    }
                }
                .padding(.vertical, 10)
                Divider()
            }
            if let problem { Problem(text: problem).padding(.top, 8) }
        }
        .navigationDestination(item: $password) { target in PasswordSignInView(prefill: target.origin.absoluteString) }
    }

    private func statusLine(_ computer: AccountComputer) -> String {
        switch computer.status {
        case .checking: return "Checking…"
        case .online: return "Online"
        case .offline: return computer.offlineReason == "tunnel_released" ? "Offline · asleep" : "Offline"
        }
    }

    /// A hosted server, signed in to with the account's own provider; one that doesn't take it asks for a password.
    private func signIn(_ server: Computer) async {
        signingIn = server.id
        problem = nil
        defer { signingIn = nil }
        do {
            switch try await Account.shared.signIn(to: server) {
            case .signedIn(let cookie, let username)?:
                Servers.shared.add(Server(url: server.url, username: username, label: server.name), cookie: cookie)
            case .some:
                password = SignIn.Target(origin: server.url, linkPath: nil)
            case nil:
                break
            }
        } catch {
            problem = error.localizedDescription
        }
    }
}

/// The same list on its own page (Add a computer → Computers on your account).
struct AccountComputersList: View {
    @ObservedObject private var accountServers = AccountServers.shared

    var body: some View {
        ScrollView { AccountComputersRows().padding(.horizontal, 20) }
            .navigationTitle("Your computers")
            .refreshable { await accountServers.refresh() }
            .task { await accountServers.refresh() }
    }
}

/// The connection screens' made-up states for screenshots (`-connectionDemo`), over whatever is showing.
struct ConnectionDemoPresenter: ViewModifier {
    func body(content: Content) -> some View {
        #if DEBUG
        content.fullScreenCover(isPresented: .constant(ConnectionDemo.screen)) { NavigationStack { ConnectionDemo.view } }
        #else
        content
        #endif
    }
}

#if DEBUG
extension ConnectionDemo {
    /// `list`, `add`, `detail`, `diagnosis`, `paired` and `signedout` open their screen over the app.
    static var screen: Bool { ["list", "add", "detail", "diagnosis", "paired", "signedout"].contains(mode ?? "") }

    @MainActor @ViewBuilder static var view: some View {
        switch mode {
        case "add": AddServerView()
        case "detail": ServerDetailView(serverId: "mac-1")
        case "diagnosis": ServerDetailView(serverId: "mac-2")
        case "paired": ServerDetailView(serverId: "studio")
        case "signedout": ServerDetailView(serverId: "linux")
        default: ServersView()
        }
    }
}
#endif
