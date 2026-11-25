import Photos
import SwiftUI

/// The last tab: Upload media first, then the tools that work on a video from Photos, then Settings, a row each that
/// opens its page.
struct ToolsView: View {
    @EnvironmentObject private var servers: Servers
    @ObservedObject private var access = ToolsetAccess.shared
    @ObservedObject private var plugins = ServerPlugins.shared
    @ObservedObject private var account = Account.shared
    @AppStorage("wifiOnly") private var wifiOnly = false
    @AppStorage(Appearance.key) private var appearance = Appearance.system.rawValue
    /// A debug build opens Computers without a tap: -MoreOpen settings.
    @State private var computersOpen = debugArg("MoreOpen") == "settings"

    var body: some View {
        List {
            if servers.api != nil {
                Section {
                    // the same camera roll and upload as Media's Upload button, into the workspace's Media Library
                    NavigationLink { UploadMediaView() } label: {
                        Label("Upload media", systemImage: "arrow.up.circle.fill")
                            .font(.title3.weight(.semibold))
                            .frame(minHeight: 52)
                    }
                }
            }
            Section("Tools") {
                if access.allows("stories") { row("Story Splitter", "scissors") { StorySplitterView() } }
                if access.allows("captions") { row("Caption Studio", "captions.bubble") { CaptionStudioView() } }
                if FaceBlurView.shows(plugins: plugins.known.plugins, me: access.me) { row("Face Blur", "face.dashed") { FaceBlurView() } }
            }
            Section("Settings") {
                if let profile = account.profile {
                    row("Account", "person.crop.circle", value: profile.title) { AccountSettings() }
                }
                row("Computers", "desktopcomputer", value: servers.current?.name) { ServersView() }
                row("Notifications", "bell") { Form { NotificationsRow() }.navigationTitle("Notifications").navigationBarTitleDisplayMode(.inline) }
                row("Uploads", "arrow.up.circle", value: wifiOnly ? "Wi-Fi only" : "Any network") { UploadSettings() }
                row("Appearance", "circle.lefthalf.filled", value: Appearance(rawValue: appearance)?.title) { AppearanceSettings() }
                LabeledContent {
                    Text(Self.version)
                } label: {
                    Label("Version", systemImage: "info.circle")
                }
                Link(destination: Account.site.appendingPathComponent("privacy")) { Label("Privacy Policy", systemImage: "hand.raised") }
                Link(destination: Account.site.appendingPathComponent("terms")) { Label("Terms", systemImage: "doc.text") }
            }
        }
        .listStyle(.insetGrouped)
        .navigationTitle("Tools")
        .connectionHeader()
        .navigationDestination(isPresented: $computersOpen) { ServersView() }
    }

    private func row<Destination: View>(_ title: String, _ systemImage: String, value: String? = nil,
                                        @ViewBuilder destination: @escaping () -> Destination) -> some View {
        NavigationLink(destination: destination) {
            LabeledContent {
                if let value { Text(value).lineLimit(1) }
            } label: {
                Label(title, systemImage: systemImage)
            }
        }
    }

    /// "1.0 (12)": the version and the build, as TestFlight names them.
    static var version: String {
        let info = Bundle.main.infoDictionary ?? [:]
        let version = info["CFBundleShortVersionString"] as? String ?? ""
        let build = info["CFBundleVersion"] as? String ?? ""
        return build.isEmpty ? version : "\(version) (\(build))"
    }
}

/// The account the phone signed in with, Sign out and Delete account.
private struct AccountSettings: View {
    @ObservedObject private var account = Account.shared
    @Environment(\.dismiss) private var dismiss
    @State private var confirming = false
    @State private var deleting = false
    @State private var problem: String?

    var body: some View {
        Form {
            if let profile = account.profile {
                Section {
                    LabeledContent("Signed in with", value: profile.provider.capitalized)
                    if !profile.email.isEmpty { LabeledContent("Email", value: profile.email) }
                }
                Section {
                    Button("Sign out", role: .destructive) {
                        account.signOut()
                        dismiss()
                    }
                }
                Section {
                    Button(role: .destructive) { confirming = true } label: {
                        HStack {
                            Text("Delete account")
                            if deleting { Spacer(); ProgressView() }
                        }
                    }
                    .disabled(deleting)
                }
            }
            // outside `if let profile`: a refused sign-in signs the phone out, and the error must still show
            if let problem { Section { Text(problem).foregroundStyle(.red) } }
        }
        .confirmationDialog("Delete account", isPresented: $confirming, titleVisibility: .visible) {
            Button("Delete account", role: .destructive) { Task { await delete() } }
        } message: {
            Text("The account and its sign-ins are deleted from creatortoolset.com; your servers and their files are kept.")
        }
        .navigationTitle("Account")
        .navigationBarTitleDisplayMode(.inline)
    }

    private func delete() async {
        problem = nil
        deleting = true
        defer { deleting = false }
        do {
            try await account.deleteAccount()
            dismiss()
        } catch APIError.server(let code, _) where code == 401 || code == 403 {
            problem = "Sign in again to delete the account"
        } catch {
            problem = "Could not delete account"
        }
    }
}

/// Wi-Fi-only uploads, and how much of Photos the app may read.
private struct UploadSettings: View {
    @ObservedObject private var library = PhotoLibrary.shared
    @Environment(\.scenePhase) private var scenePhase
    @AppStorage("wifiOnly") private var wifiOnly = false

    var body: some View {
        Form {
            Section {
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
        }
        .navigationTitle("Uploads")
        .navigationBarTitleDisplayMode(.inline)
        // back from the iPhone's own Settings: what was changed there shows here
        .onChange(of: scenePhase) { _, phase in if phase == .active { library.refreshAccess() } }
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

/// Automatic, Light or Dark: a list with a check on the one in use.
private struct AppearanceSettings: View {
    @AppStorage(Appearance.key) private var appearance = Appearance.system.rawValue

    var body: some View {
        Form {
            ForEach(Appearance.allCases) { option in
                Button {
                    appearance = option.rawValue
                } label: {
                    HStack {
                        Text(option.title).foregroundStyle(.primary)
                        Spacer()
                        if option.rawValue == appearance {
                            Image(systemName: "checkmark").foregroundStyle(Color.accentColor)
                        }
                    }
                    .contentShape(Rectangle())
                }
                .accessibilityAddTraits(option.rawValue == appearance ? .isSelected : [])
            }
        }
        .navigationTitle("Appearance")
        .navigationBarTitleDisplayMode(.inline)
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
