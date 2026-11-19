import SwiftUI

/// The account's computers, each with a switch: on adds it to this phone and connects it with no code and no password;
/// off keeps it saved, not connected. Hosted servers the account signed in to are signed in to with the same account.
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
                    HStack {
                        Button("Try again") { Task { await accountServers.refresh() } }
                        if let trace = accountServers.traceId {
                            Button("Copy trace ID") { UIPasteboard.general.string = trace }
                        }
                    }
                    .buttonStyle(.bordered)
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
                    Toggle("Enable \(computer.name)", isOn: Binding(get: { connections.entry(computer.id)?.enabled == true },
                                                                   set: { accountServers.setAdded(computer, $0) }))
                        .labelsHidden()
                        .disabled(computer.endpoint == nil)
                }
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
        case .online: return connections.entry(computer.id) == nil ? "Online" : "Online · on this phone"
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

/// Shown once after a sign-in: the computers on the account, with switches.
struct AccountSetupSheet: View {
    @ObservedObject private var accountServers = AccountServers.shared
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    Text("Switch on the computers this phone should reach. Each connects by itself, at home or away.")
                        .foregroundStyle(.secondary)
                    AccountComputersRows()
                    Button("Don't show this again") {
                        accountServers.optedOut = true
                        dismiss()
                    }
                    .font(.subheadline)
                    .padding(.top, 8)
                }
                .padding(.horizontal, 20)
            }
            .refreshable { await accountServers.refresh() }
            .navigationTitle("Your computers")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }
    }
}

/// Puts the setup sheet over whatever is showing, so it stays up when the first computer switched on turns the first
/// screen into the tabs.
struct AccountSetupPresenter: ViewModifier {
    @ObservedObject private var accountServers = AccountServers.shared

    func body(content: Content) -> some View {
        content.sheet(isPresented: $accountServers.setupShown) { AccountSetupSheet() }
    }
}
