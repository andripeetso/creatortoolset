import Photos
import SwiftUI

/// The last tab: the tools, each a tile with its icon (Scripts first, then the ones that work on a video from Photos), and under them the one row that opens Settings (tools and
/// settings in one list read as the same kind of thing).
struct MoreView: View {
    @ObservedObject private var access = ToolsetAccess.shared
    @ObservedObject private var plugins = ServerPlugins.shared
    /// A debug build opens Settings without a tap: -MoreOpen settings.
    @State private var settingsOpen = debugArg("MoreOpen") == "settings"

    private let columns = [GridItem(.flexible(), spacing: 12), GridItem(.flexible(), spacing: 12)]

    var body: some View {
        ScrollView {
            VStack(spacing: 24) {
                LazyVGrid(columns: columns, spacing: 12) {
                    // the tools' tiles, each only when the account has it
                    if ToolsetAccess.showsScripts(me: access.me) { ToolTile(title: "Scripts", systemImage: "doc.text") { ScriptsView() } }
                    if access.allows("stories") { ToolTile(title: "Story Splitter", systemImage: "scissors") { StorySplitterView() } }
                    if access.allows("captions") { ToolTile(title: "Caption Studio", systemImage: "captions.bubble") { CaptionStudioView() } }
                    if FaceBlurView.shows(plugins: plugins.known.plugins, me: access.me) { ToolTile(title: "Face Blur", systemImage: "face.dashed") { FaceBlurView() } }
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
                NavigationLink { ServersView() } label: {
                    LabeledContent("Computers", value: "\(Connections.shared.servers.count)")
                }
                if servers.signedOut { Button("Sign in again") { adding = true } }
            }
            if let profile = account.profile {
                Section("Account") { AccountRow(profile: profile) { account.signOut() } }
            }
            Section("Notifications") { NotificationsRow() }
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

/// A server signed in to by username and password (a team member's own login), with the sign-in code after it when
/// the account has one. Pairing codes and the account live on `AddServerView`.
struct PasswordSignInView: View {
    var prefill: String?
    @EnvironmentObject private var servers: Servers
    @Environment(\.dismiss) private var dismiss
    @State private var address = ""
    @State private var username = ""
    @State private var password = ""
    /// After a right password: the server that asks for the sign-in code, and its step (nil: set the code up first).
    @State private var codeAsk: (origin: URL, step: String?)?
    @State private var code = ""
    @State private var recovery = false
    @FocusState private var typing: Field?
    @State private var busy = false
    @State private var error: String?

    var body: some View {
        Form {
            Section {
                TextField("Address", text: $address)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .keyboardType(.URL)
            }
            if let codeAsk {
                Section("Sign-in code") {
                    if codeAsk.step == nil {
                        Text("This server asks for a code from an authenticator app. Set it up on its website first, then sign in here.")
                        Link("Open the sign-in page", destination: API(server: codeAsk.origin, cookie: nil).url("/login"))
                    } else {
                        // above the field: the keyboard comes up over what is below it
                        HStack {
                            Text(recovery ? "A recovery code you saved" : "From your authenticator app")
                                .foregroundStyle(.secondary)
                            Spacer()
                            Button(recovery ? "6-digit code" : "Recovery code") {
                                recovery.toggle()
                                code = ""
                            }
                            .buttonStyle(.borderless)
                        }
                        .font(.subheadline)
                        if let error { Problem(text: error) }
                        if recovery {
                            TextField("Recovery code", text: $code)
                                .textInputAutocapitalization(.never)
                                .autocorrectionDisabled()
                                .focused($typing, equals: .code)
                                .submitLabel(.go)
                                .onSubmit { if !blocked { Task { await connect() } } }
                        } else {
                            // no return key on the number pad: six digits sign in, typed or filled in from Passwords
                            TextField("6-digit code", text: $code)
                                .keyboardType(.numberPad)
                                .textContentType(.oneTimeCode)
                                .focused($typing, equals: .code)
                                .onChange(of: code) { if code.count == 6, !blocked { Task { await connect() } } }
                        }
                    }
                }
            } else {
                Section("Sign in") {
                    TextField("Username", text: $username)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .textContentType(.username)
                        .focused($typing, equals: .username)
                        .submitLabel(.next)
                        .onSubmit { typing = .password }
                    // the keyboard covers the button below, so its own key signs in
                    SecureField("Password", text: $password)
                        .textContentType(.password)
                        .focused($typing, equals: .password)
                        .submitLabel(.go)
                        .onSubmit { if !blocked { Task { await connect() } } }
                }
            }
            if let error, codeAsk?.step == nil { Problem(text: error) }
            Button("Sign in") { Task { await connect() } }
                .disabled(blocked)
        }
        .navigationTitle("Sign in")
        .onAppear {
            if let prefill, address.isEmpty { address = prefill }
            typing = .username
        }
        .onChange(of: address) { codeAsk = nil }
    }

    private enum Field { case username, password, code }

    private var blocked: Bool {
        busy || (codeAsk?.step != nil ? code.isEmpty : address.isEmpty || username.isEmpty || password.isEmpty)
    }

    private func connect() async {
        busy = true
        defer { busy = false }
        do {
            if let codeAsk, let step = codeAsk.step {
                return handle(try await SignIn.code(codeAsk.origin, step: step, code: code), from: codeAsk.origin)
            }
            guard let target = SignIn.parse(address) else { return error = "That isn't an address" }
            handle(try await SignIn.login(target.origin, username: username, password: password), from: target.origin)
        } catch let expired as SignIn.StepExpired {
            // back to the password, which is still filled in
            codeAsk = nil
            error = expired.localizedDescription
        } catch {
            // a wrong code keeps the field, empty for the next one
            if codeAsk?.step != nil { code = "" }
            self.error = error.localizedDescription
        }
    }

    /// What a sign-in answered: the server is on this phone, or the sign-in code is asked next.
    private func handle(_ outcome: SignIn.Outcome, from origin: URL) {
        error = nil
        switch outcome {
        case .signedIn(let cookie, let name):
            servers.add(Server(url: origin, username: name), cookie: cookie)
            dismiss()
        case .needsPassword:
            error = "Wrong username or password"
        case .needsCode(let step):
            codeAsk = (origin, step)
            code = ""
            recovery = false
            typing = .code
        case .setUpCode:
            codeAsk = (origin, nil)
        }
    }
}
