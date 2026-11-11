import AVKit
import SwiftUI

struct MoreView: View {
    @EnvironmentObject private var servers: Servers
    @ObservedObject private var account = Account.shared
    @AppStorage("wifiOnly") private var wifiOnly = false
    @State private var adding = false

    var body: some View {
        List {
            Section("Computers") {
                ForEach(servers.list) { server in
                    Button { servers.use(server.id) } label: {
                        HStack {
                            VStack(alignment: .leading) {
                                Text(server.name)
                                if let username = server.username { Text(username).font(.caption).foregroundStyle(.secondary) }
                            }
                            Spacer()
                            if server.id == servers.currentId {
                                if servers.signedOut {
                                    Text("Signed out").font(.caption).foregroundStyle(.orange)
                                } else {
                                    Image(systemName: "checkmark")
                                }
                            }
                        }
                    }
                    .foregroundStyle(.primary)
                    .swipeActions { Button("Remove", role: .destructive) { servers.remove(server.id) } }
                }
                Button(servers.signedOut ? "Sign in again" : "Add a computer") { adding = true }
            }
            if let profile = account.profile {
                Section("Account") { AccountRow(profile: profile) { account.signOut() } }
            }
            if let api = servers.api {
                Section {
                    NavigationLink("Media Library") { LibraryView() }
                    NavigationLink("Everything else") {
                        WebAppView(api: api).ignoresSafeArea(edges: .bottom).navigationBarTitleDisplayMode(.inline)
                    }
                }
            }
            Section {
                Toggle("Upload on Wi-Fi only", isOn: $wifiOnly)
            }
        }
        .navigationTitle("More")
        #if DEBUG
        .onAppear { if Account.demo == "add" { adding = true } }
        #endif
        .sheet(isPresented: $adding) {
            NavigationStack { AddServerView(prefill: servers.signedOut ? servers.current?.url.absoluteString : nil) }
        }
    }
}

/// Add a computer: sign in with the account and pick one of its computers, scan the code a computer shows, or type its
/// address (and sign in when it asks).
struct AddServerView: View {
    var first = false
    var prefill: String?
    @EnvironmentObject private var servers: Servers
    @ObservedObject private var account = Account.shared
    @Environment(\.dismiss) private var dismiss
    @State private var address = ""
    @State private var username = ""
    @State private var password = ""
    @State private var needsPassword: SignIn.Target?
    /// The account's computers, once read, and what went wrong with the account or one of them.
    @State private var computers: [Computer]?
    @State private var problem: String?
    /// The computer added to the account whose own password is asked.
    @State private var asked: Computer?
    @FocusState private var typing: Field?
    @State private var scanning = false
    @State private var busy = false
    @State private var error: String?

    var body: some View {
        Form {
            if let profile = account.profile {
                Section("Your computers") {
                    ForEach(computers ?? []) { computer in
                        Button { Task { await run { try await open(computer) } } } label: {
                            HStack {
                                Text(computer.name)
                                Spacer()
                                if computer.offline { Text("offline").font(.caption).foregroundStyle(.secondary) }
                            }
                        }
                        .foregroundStyle(.primary)
                        .swipeActions {
                            if computer.addedId == nil {
                                Button("Remove", role: .destructive) { Task { await run { try await forget(computer) } } }
                            }
                        }
                    }
                    if computers == nil, busy { ProgressView() }
                    if computers?.isEmpty == true { Text("No computers on this account yet").foregroundStyle(.secondary) }
                    if let problem { Problem(text: problem) }
                }
                .disabled(busy)
                Section {
                    AccountRow(profile: profile) {
                        account.signOut()
                        problem = nil
                    }
                }
                .disabled(busy)
            } else {
                // a section each, so each button gets the row's whole shape
                Section {
                    SignInButton(provider: "apple") { Task { await run { try await signIn("apple") } } }
                        .listRowInsets(EdgeInsets())
                }
                .listSectionSpacing(12)
                .disabled(busy)
                Section {
                    SignInButton(provider: "google") { Task { await run { try await signIn("google") } } }
                        .listRowInsets(EdgeInsets())
                } footer: {
                    if let problem { Problem(text: problem) }
                }
                .disabled(busy)
            }
            Section {
                if CodeScanner.supported {
                    Button("Scan the code on your computer", systemImage: "qrcode.viewfinder") {
                        Task {
                            if await CodeScanner.cameraAllowed() {
                                scanning = true
                            } else {
                                error = "Camera access is off: Settings → Creator Toolset → Camera"
                            }
                        }
                    }
                }
                TextField("Address or sign-in link", text: $address)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .keyboardType(.URL)
            } footer: {
                Text("On the computer: Settings → Computers → Add your phone.")
            }
            if needsPassword != nil || asked != nil {
                Section(asked?.name ?? "Sign in") {
                    if asked == nil {
                        TextField("Username", text: $username)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .textContentType(.username)
                            .focused($typing, equals: .username)
                            .submitLabel(.next)
                            .onSubmit { typing = .password }
                    }
                    // the keyboard covers the button below, so its own key signs in
                    SecureField("Password", text: $password)
                        .textContentType(.password)
                        .focused($typing, equals: .password)
                        .submitLabel(.go)
                        .onSubmit { if !blocked { Task { await connect() } } }
                }
            }
            if let error { Problem(text: error) }
            Button(needsPassword == nil && asked == nil ? "Connect" : "Sign in") { Task { await connect() } }
                .disabled(blocked)
        }
        .navigationTitle(first ? "Creator Toolset" : "Add a computer")
        .toolbar {
            if !first { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
        }
        .onAppear { if let prefill, address.isEmpty { address = prefill } }
        .onChange(of: address) {
            // typing an address leaves the computer that was picked; the password fields stay while the address is the one that asked
            asked = nil
            if SignIn.parse(address) != needsPassword { needsPassword = nil }
        }
        .onChange(of: account.profile == nil) { _, signedOut in
            if signedOut {
                computers = nil
                asked = nil
            }
        }
        .refreshable { if account.profile != nil { await run { try await load() } } }
        .task {
            #if DEBUG
            if Account.demo == "problem" { problem = AccountError.unreachable("creatortoolset.com").localizedDescription }
            #endif
            guard account.profile != nil, computers == nil else { return }
            await run { try await load() }
            #if DEBUG
            if Account.demo == "password", let computer = computers?.first(where: { $0.addedId != nil }) { ask(computer) }
            if Account.demo == "old", let computer = computers?.first { usePassword(computer) }
            #endif
        }
        .sheet(isPresented: $scanning) {
            CodeScanner { text in
                scanning = false
                // the code is what connects now, whatever was being asked before
                asked = nil
                needsPassword = nil
                address = text
                Task { await connect() }
            }
            .ignoresSafeArea()
        }
    }

    /// One job at a time with the account; what goes wrong is said in one line under it.
    private enum Field { case username, password }

    /// Nothing to send yet: a job is running, or what the form asks for is not filled in.
    private var blocked: Bool {
        busy || (asked != nil ? password.isEmpty
                 : address.isEmpty || (needsPassword != nil && (username.isEmpty || password.isEmpty)))
    }

    private func run(_ work: () async throws -> Void) async {
        busy = true
        problem = nil
        defer { busy = false }
        do {
            try await work()
        } catch {
            problem = error.localizedDescription
        }
    }

    /// Sign in with Apple or Google, then straight to the account's computer, or the list when there are several.
    private func signIn(_ provider: String) async throws {
        guard try await account.signIn(provider) else { return }
        try await load()
        if let one = Computer.only(computers ?? [], here: servers.list) { try await open(one) }
    }

    private func load() async throws {
        let found = try await account.computers()
        computers = found.list
        problem = found.problem
    }

    /// A press on one of the account's computers: one already on this phone is switched to, a hosted server signs in
    /// with the account, a computer added to the account asks for its own password.
    private func open(_ computer: Computer) async throws {
        if servers.list.contains(where: { $0.id == computer.id }), !(servers.signedOut && servers.currentId == computer.id) {
            servers.use(computer.id)
            return dismiss()
        }
        if computer.addedId != nil { return ask(computer) }
        switch try await account.signIn(to: computer) {
        case .signedIn(let cookie, let name):
            servers.add(Server(url: computer.url, username: name), cookie: cookie)
            dismiss()
        case .needsPassword:
            usePassword(computer)
        case nil:
            break
        }
    }

    private func ask(_ computer: Computer) {
        needsPassword = nil
        password = ""
        error = nil
        asked = computer
        typing = .password
    }

    /// A hosted server that does not sign in with the account: its address is filled in and the form asks for the
    /// username and password.
    private func usePassword(_ computer: Computer) {
        address = computer.name
        needsPassword = SignIn.parse(address)
        error = nil
        typing = .username
    }

    private func forget(_ computer: Computer) async throws {
        try await account.forget(computer)
        computers?.removeAll { $0.id == computer.id }
    }

    private func connect() async {
        busy = true
        defer { busy = false }
        do {
            if let asked {
                guard case .signedIn(let cookie, let name) = try await account.signIn(to: asked, password: password) else { return }
                servers.add(Server(url: asked.url, username: name, label: asked.name), cookie: cookie)
                return dismiss()
            }
            guard let target = SignIn.parse(address) else { return error = "That isn't an address" }
            let outcome = if let waiting = needsPassword {
                try await SignIn.login(waiting.origin, username: username, password: password)
            } else {
                try await SignIn.connect(target)
            }
            switch outcome {
            case .needsPassword:
                needsPassword = target
                error = nil
            case .signedIn(let cookie, let name):
                servers.add(Server(url: target.origin, username: name), cookie: cookie)
                dismiss()
            }
        } catch {
            self.error = error.localizedDescription
        }
    }
}

struct Asset: Decodable, Identifiable, Hashable {
    let id: String
    let kind: String
    let title: String
    let versionId: String
    let thumbUrl: String?
    let state: String
}

/// The Media Library, newest first, 60 at a time.
struct LibraryView: View {
    @EnvironmentObject private var servers: Servers
    @State private var library: LibrarySummary?
    @State private var assets: [Asset] = []
    @State private var next: String?
    @State private var loaded = false
    @State private var error: String?
    @State private var open: Asset?

    private let columns = [GridItem(.adaptive(minimum: 104), spacing: 2)]

    var body: some View {
        ScrollView {
            if let error { Problem(text: error).padding() }
            LazyVGrid(columns: columns, spacing: 2) {
                ForEach(assets) { asset in
                    Button { open = asset } label: {
                        RemoteImage(path: asset.thumbUrl ?? "")
                            .aspectRatio(1, contentMode: .fit)
                            .overlay(alignment: .bottomTrailing) {
                                if asset.state == "processing" {
                                    ProgressView().padding(4)
                                } else if asset.kind == "video" {
                                    Image(systemName: "play.fill").font(.caption).padding(4).shadow(radius: 2)
                                }
                            }
                    }
                    .onAppear { if asset == assets.last, next != nil { Task { await load(more: true) } } }
                }
            }
        }
        .overlay {
            if !loaded {
                ProgressView()
            } else if assets.isEmpty && error == nil {
                ContentUnavailableView("Nothing here yet", systemImage: "photo.on.rectangle",
                                       description: Text("Upload clips and they show here."))
            }
        }
        .navigationTitle(library?.name ?? "Media Library")
        .navigationBarTitleDisplayMode(.inline)
        .task { await load(more: false) }
        .refreshable { await load(more: false) }
        .sheet(item: $open) { AssetView(asset: $0) }
    }

    private struct Page: Decodable {
        let items: [Asset]
        let next: String?
    }

    private func load(more: Bool) async {
        guard let api = servers.api else { return }
        defer { loaded = true }
        do {
            if library == nil { library = try await api.firstLibrary() }
            guard let library else { return }
            var path = "/api/library/\(library.id)/assets?limit=60"
            if more, let next { path += "&cursor=\(next.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? next)" }
            let page: Page = try await api.get(path)
            assets = more ? assets + page.items : page.items
            next = page.next
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
    }
}

private struct AssetView: View {
    let asset: Asset
    @EnvironmentObject private var servers: Servers
    @State private var player: AVPlayer?

    var body: some View {
        NavigationStack {
            Group {
                if asset.kind == "video" || asset.kind == "audio", let player {
                    NativePlayer(player: player)
                } else {
                    RemoteImage(path: "/api/library/media/\(asset.versionId)/source").scaledToFit()
                }
            }
            .navigationTitle(asset.title)
            .navigationBarTitleDisplayMode(.inline)
        }
        .onAppear {
            player = servers.api?.player("/api/library/media/\(asset.versionId)/play")
            player?.play()
        }
        .onDisappear { player?.pause() }
    }
}
