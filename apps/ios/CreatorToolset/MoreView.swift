import Photos
import SwiftUI

/// The last tab: the tools, each a tile with its icon, and under them the one row that opens Settings (tools and
/// settings in one list read as the same kind of thing).
struct MoreView: View {
    @ObservedObject private var access = ToolsetAccess.shared
    /// A debug build opens Settings without a tap: -MoreOpen settings.
    @State private var settingsOpen = debugArg("MoreOpen") == "settings"

    private let columns = [GridItem(.flexible(), spacing: 12), GridItem(.flexible(), spacing: 12)]

    var body: some View {
        ScrollView {
            VStack(spacing: 24) {
                LazyVGrid(columns: columns, spacing: 12) {
                    // The tools' tiles, each only when the account has it (lane 4 brings the screens):
                    // if access.allows("stories") { ToolTile(title: "Story Splitter", systemImage: "scissors") { StorySplitterView() } }
                    // if access.allows("captions") { ToolTile(title: "Caption Studio", systemImage: "captions.bubble") { CaptionStudioView() } }
                }
                Button {
                    settingsOpen = true
                } label: {
                    HStack(spacing: 12) {
                        Image(systemName: "gearshape")
                            .font(.system(size: 18, weight: .medium))
                            .foregroundStyle(.secondary)
                            .frame(width: 28)
                        Text("Settings").foregroundStyle(.primary)
                        Spacer()
                        Image(systemName: "chevron.right").font(.footnote.weight(.semibold)).foregroundStyle(.tertiary)
                    }
                    .padding(.horizontal, 16)
                    .frame(minHeight: 52)
                    .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 16))
                }
                .buttonStyle(.plain)
            }
            .padding(.horizontal, 16)
            .padding(.top, 8)
        }
        .navigationTitle("More")
        .navigationDestination(isPresented: $settingsOpen) { SettingsView() }
    }
}

/// A tool as a tile: its icon, big, and its name. A tap opens it.
struct ToolTile<Destination: View>: View {
    let title: String
    let systemImage: String
    @ViewBuilder var destination: () -> Destination

    var body: some View {
        NavigationLink {
            destination()
        } label: {
            VStack(spacing: 12) {
                Image(systemName: systemImage)
                    .font(.system(size: 30, weight: .medium))
                    .foregroundStyle(Color("AccentColor"))
                    .frame(height: 40)
                Text(title).font(.subheadline.weight(.semibold)).foregroundStyle(.primary).multilineTextAlignment(.center)
            }
            .frame(maxWidth: .infinity, minHeight: 124)
            .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 20))
        }
        .buttonStyle(.plain)
    }
}

/// Settings, on a screen of their own: the computers this phone is signed in to, the account, notifications, how the
/// app looks, uploads, Photos access, and which build this is.
struct SettingsView: View {
    @EnvironmentObject private var servers: Servers
    @ObservedObject private var account = Account.shared
    @ObservedObject private var library = PhotoLibrary.shared
    @Environment(\.scenePhase) private var scenePhase
    @AppStorage("wifiOnly") private var wifiOnly = false
    @State private var adding = false

    var body: some View {
        Form {
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
            // Notifications: lane 2's row goes here (Section("Notifications") { <its row> }).
            Section("Appearance") { AppearancePicker() }
            Section("Uploads") {
                Toggle("Only upload on Wi-Fi", isOn: $wifiOnly)
            }
            Section("Photos") {
                LabeledContent("Access", value: accessText)
                if library.access == .limited {
                    Button("Choose more clips…") { presentLimitedPicker() }
                }
                if library.access == .denied || library.access == .restricted || library.access == .limited {
                    Button("Open Settings") {
                        if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
                    }
                }
            }
            Section {
                LabeledContent("Version", value: Self.version)
            }
        }
        .navigationTitle("Settings")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar(.hidden, for: .tabBar)
        #if DEBUG
        .onAppear { if Account.demo == "add" { adding = true } }
        #endif
        .sheet(isPresented: $adding) {
            NavigationStack { AddServerView(prefill: servers.signedOut ? servers.current?.url.absoluteString : nil) }
        }
        // back from the iPhone's own Settings: what was changed there shows here
        .onChange(of: scenePhase) { _, phase in if phase == .active { library.refreshAccess() } }
    }

    /// "1.0 (12)": the version and the build, as TestFlight names them.
    static var version: String {
        let info = Bundle.main.infoDictionary ?? [:]
        let version = info["CFBundleShortVersionString"] as? String ?? ""
        let build = info["CFBundleVersion"] as? String ?? ""
        return build.isEmpty ? version : "\(version) (\(build))"
    }

    private var accessText: String {
        switch library.access {
        case .authorized: "All photos"
        case .limited: "Selected photos"
        case .denied, .restricted: "None"
        default: "Not asked yet"
        }
    }

    private func presentLimitedPicker() {
        guard let scene = UIApplication.shared.connectedScenes.first as? UIWindowScene,
              let root = scene.keyWindow?.rootViewController else { return }
        PHPhotoLibrary.shared().presentLimitedLibraryPicker(from: root)
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
