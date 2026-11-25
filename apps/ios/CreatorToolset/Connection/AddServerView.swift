import AVFoundation
import SwiftUI

/// Add a computer, or a route to a saved one: scan the code the computer shows, or type its address and pairing code,
/// or use the account. The phone asks the address who it is before it spends the code.
struct AddServerView: View {
    var first = false
    /// An address to start from (signing in again to the server in use).
    var prefill: String?
    /// Add a route to this computer instead of a new computer.
    var routeFor: ServerEntry?
    /// A pairing link opened from outside: its address and code are filled in; Connect is the person's.
    var link: PairingTarget?

    @ObservedObject private var account = Account.shared
    @Environment(\.dismiss) private var dismiss
    @State private var address = ""
    @State private var code = ""
    @State private var scanning = false
    @State private var cameraDenied = false
    @State private var invalidScan = false
    @State private var busy = false
    @State private var error: String?
    @State private var password: SignIn.Target?
    @FocusState private var focus: Field?

    private enum Field { case address, code }

    /// The host (and port) of a pairing link's server when no saved server has it: nil for a known one or no link.
    private var unsavedLinkHost: String? {
        guard let link, let host = link.origin.host(percentEncoded: false) else { return nil }
        let known = Servers.shared.list.contains { $0.url.host(percentEncoded: false) == host && $0.url.port == link.origin.port }
        return known ? nil : host + (link.origin.port.map { ":\($0)" } ?? "")
    }

    var body: some View {
        Form {
            if let host = unsavedLinkHost {
                // a link from outside names a host the phone doesn't know yet: say it before Connect is tapped
                Section {
                    Text("Connect to \(host)?").font(.headline)
                }
            }
            Section {
                ScanCard(scanning: $scanning) { scanned in
                    guard let target = PairingTarget.parse(scanned), target.code != nil else {
                        invalidScan = true
                        return false
                    }
                    address = target.origin.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
                    code = target.code ?? ""
                    error = nil
                    UINotificationFeedbackGenerator().notificationOccurred(.success)
                    return true
                } denied: {
                    cameraDenied = true
                }
                .listRowInsets(EdgeInsets())
                .listRowBackground(Color.clear)
            }
            Section {
                TextField("Address", text: $address, prompt: Text("10.0.0.100:43190"))
                    .keyboardType(.URL)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .focused($focus, equals: .address)
                    .submitLabel(.next)
                    .onSubmit { focus = .code }
                TextField("Code", text: $code, prompt: Text("Pairing code"))
                    .textInputAutocapitalization(.characters)
                    .autocorrectionDisabled()
                    .focused($focus, equals: .code)
                    .submitLabel(.go)
                    .onSubmit { Task { await connect() } }
            } header: {
                Text("Or enter it")
            } footer: {
                Group {
                    if let error {
                        Text(error).foregroundStyle(.red)
                    } else {
                        Text(routeFor == nil
                             ? "For a computer on your network or tailnet, or a server's address. Make a code on the computer: Settings → Computers → Create link."
                             : "Another address of \(routeFor!.label): its tailnet address, or the address on another network.")
                    }
                }
                .accessibilityAddTraits(.updatesFrequently)
            }
            .listRowBackground(error == nil ? nil : Color.red.opacity(0.08))
            if routeFor == nil {
                Section {
                    if account.profile != nil {
                        NavigationLink("Computers on your account") { AccountComputersList() }
                    } else {
                        AccountSignInButtons(compact: true)
                    }
                } header: {
                    Text("Or use your account")
                } footer: {
                    if account.profile == nil { Text("Reach your computers from anywhere, no network setup.") }
                }
            }
        }
        .navigationTitle(routeFor == nil ? (first ? "Other ways to connect" : "Add a computer") : "Add route")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if !first { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
            ToolbarItem(placement: .confirmationAction) {
                if busy {
                    ProgressView()
                } else {
                    Button("Connect", systemImage: "checkmark") { Task { await connect() } }
                        .disabled(address.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            }
        }
        .onChange(of: address) { error = nil }
        .onChange(of: code) { error = nil }
        .onAppear {
            if let prefill, address.isEmpty { address = prefill }
            if let link, address.isEmpty {
                address = link.origin.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
                code = link.code ?? ""
            }
            #if DEBUG
            if ConnectionDemo.mode == "add" {
                address = "10.0.0.40"
                code = "ABCDEFGHJKLM"
                // after the typing's own clearing of the error
                Task { error = PairingError.differentServer("Office Mac mini").localizedDescription }
            }
            #endif
        }
        .alert("Invalid QR code", isPresented: $invalidScan) { Button("OK") {} } message: {
            Text("That code isn't a Creator Toolset pairing link.")
        }
        .alert("Camera access needed", isPresented: $cameraDenied) {
            Button("Cancel", role: .cancel) {}
            Button("Open Settings") { if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) } }
        } message: {
            Text("Camera access was denied for this app. Open Settings to enable it.")
        }
        .navigationDestination(item: $password) { target in PasswordSignInView(prefill: target.origin.absoluteString) }
    }

    /// With a code: pair (the address is asked who it is first). Without one: a server signed in to by username and
    /// password (a team member's), or one without sign-in.
    private func connect() async {
        guard !busy else { return }
        guard let target = PairingTarget.parse(address, code: code) else { return error = PairingError.invalid.localizedDescription }
        busy = true
        defer { busy = false }
        do {
            if target.code != nil {
                try await Pairing.pair(target, expected: routeFor?.serverId)
                UINotificationFeedbackGenerator().notificationOccurred(.success)
                return dismiss()
            }
            guard routeFor == nil else { return error = "Enter the pairing code from the computer." }
            guard let legacy = SignIn.parse(address) else { return error = PairingError.invalid.localizedDescription }
            switch try await SignIn.connect(legacy) {
            case .signedIn(let cookie, let username):
                Servers.shared.add(Server(url: legacy.origin, username: username), cookie: cookie)
                dismiss()
            default:
                password = legacy
            }
        } catch {
            UINotificationFeedbackGenerator().notificationOccurred(.error)
            self.error = error.localizedDescription
        }
    }
}

extension SignIn.Target: Hashable, Identifiable {
    var id: String { origin.absoluteString }
    func hash(into hasher: inout Hasher) { hasher.combine(origin) }
}

/// The scan card: "Tap to scan" asks for the camera, then the camera runs inside the card. A good scan fills the
/// fields and parks the camera, so it can't read again over later edits; it never connects by itself.
struct ScanCard: View {
    @Binding var scanning: Bool
    /// True when the scan was used (the camera parks); false re-arms it after a moment.
    let scanned: (String) -> Bool
    let denied: () -> Void
    @State private var paused = false

    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 26)
                .fill(RadialGradient(colors: [Color("AccentColor").opacity(0.25), Color(.secondarySystemGroupedBackground)],
                                     center: .center, startRadius: 10, endRadius: 220))
            if scanning, CodeScanner.supported, !paused {
                CodeScanner { text in
                    if scanned(text) {
                        scanning = false
                    } else {
                        paused = true
                        Task { try? await Task.sleep(for: .milliseconds(600)); paused = false }
                    }
                }
                .clipShape(RoundedRectangle(cornerRadius: 26))
            } else {
                VStack(spacing: 14) {
                    RoundedRectangle(cornerRadius: 30)
                        .strokeBorder(Color.primary.opacity(0.25), lineWidth: 2)
                        .frame(width: 150, height: 150)
                        .overlay {
                            VStack(spacing: 8) {
                                Image(systemName: "qrcode.viewfinder").font(.system(size: 44, weight: .light))
                                Text("Tap to scan").font(.headline)
                            }
                        }
                    Text("Scan the code from Settings → Computers on your computer")
                        .font(.footnote).foregroundStyle(.secondary).multilineTextAlignment(.center).padding(.horizontal, 24)
                }
            }
        }
        .frame(height: 250)
        .contentShape(Rectangle())
        .onTapGesture {
            guard !scanning else { return }
            Task {
                if AVCaptureDevice.authorizationStatus(for: .video) == .denied { return denied() }
                if await CodeScanner.cameraAllowed() { scanning = true } else { denied() }
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isButton)
        .accessibilityLabel("Tap to scan")
    }
}

/// Continue with Apple, Google or GitHub. Signing in then adds the account's computer by itself, or lists them.
struct AccountSignInButtons: View {
    var compact = false
    /// The provider whose sign-in is running: its button spins, the others keep their look and ignore presses.
    @State private var running: String?
    @State private var problem: String?

    var body: some View {
        VStack(spacing: compact ? 8 : 12) {
            ForEach(Account.providers, id: \.self) { provider in
                SignInButton(provider: provider, busy: running == provider) {
                    guard let next = Self.start(provider, running: running) else { return }
                    running = next
                    Task { await signIn(provider) }
                }
                .clipShape(RoundedRectangle(cornerRadius: 12))
            }
            if let problem { Problem(text: problem) }
            Text("[Terms](https://creatortoolset.com/terms) · [Privacy Policy](https://creatortoolset.com/privacy)")
                .font(.footnote)
                .tint(.secondary)
        }
        .padding(.vertical, compact ? 6 : 0)
    }

    /// A press starts its sign-in only when none is running; nil = ignored.
    nonisolated static func start(_ provider: String, running: String?) -> String? { running == nil ? provider : nil }

    private func signIn(_ provider: String) async {
        problem = nil
        defer { running = nil }
        do {
            guard try await Account.shared.signIn(provider) else { return }
            await AccountServers.shared.afterSignIn()
        } catch {
            problem = error.localizedDescription
        }
    }
}

/// The first screen, with nothing saved: sign in with the account the computer uses, and the phone finds the
/// computer; scanning a code or typing an address sit behind "Other ways to connect".
struct FirstRunView: View {
    @ObservedObject private var account = Account.shared
    @ObservedObject private var accountServers = AccountServers.shared

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 28) {
                if account.profile != nil, !accountServers.loading, accountServers.problem == nil, accountServers.computers.isEmpty, accountServers.hosted.isEmpty {
                    NoComputerYet()
                } else if account.profile != nil {
                    VStack(alignment: .leading, spacing: 10) {
                        Text("Your computers").font(.largeTitle.bold())
                        Text("Each connects by itself, at home or away.").foregroundStyle(.secondary)
                    }
                    AccountComputersRows()
                } else {
                    VStack(alignment: .leading, spacing: 10) {
                        Text("Connect to your computer").font(.largeTitle.bold())
                        Text("Sign in with the account you use on your computer. Your chats, cuts, footage and finals follow.")
                            .foregroundStyle(.secondary)
                    }
                    AccountSignInButtons()
                }
                NavigationLink { AddServerView(first: true) } label: {
                    Text("Other ways to connect")
                        .font(.body.weight(.semibold))
                        .frame(maxWidth: .infinity, minHeight: 50)
                }
                .buttonStyle(.bordered)
            }
            .padding(.horizontal, 20)
            .padding(.top, 48)
        }
        .toolbar(.hidden, for: .navigationBar)
        .task { if account.profile != nil { await accountServers.refresh() } }
    }
}

/// Signed in, and the account has no computer yet: install it there; this keeps checking while it's open.
struct NoComputerYet: View {
    @ObservedObject private var accountServers = AccountServers.shared

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Set it up on your computer first").font(.largeTitle.bold())
            Text("Creator Toolset runs on your Mac. Install it there, sign in with the same account, and this phone connects by itself.")
                .foregroundStyle(.secondary)
            Link(destination: URL(string: "https://creatortoolset.com/download")!) {
                Label("creatortoolset.com/download", systemImage: "desktopcomputer.and.arrow.down")
            }
            HStack(spacing: 10) {
                ProgressView()
                Text("Looking for your computer…").foregroundStyle(.secondary)
            }
            ShareLinkButton()
        }
        .task {
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(10))
                await accountServers.afterSignIn()
            }
        }
    }
}

private struct ShareLinkButton: View {
    var body: some View {
        SwiftUI.ShareLink(item: URL(string: "https://creatortoolset.com/download")!) {
            Label("Send the link to my computer", systemImage: "square.and.arrow.up")
        }
        .buttonStyle(.bordered)
    }
}

/// Opens the Add screen for a pairing link the app was opened with (`PairingLinks`), filled in, never connecting.
struct PairingLinkPresenter: ViewModifier {
    @ObservedObject private var links = PairingLinks.shared

    func body(content: Content) -> some View {
        content
            .onOpenURL { url in
                let opened = links.open(url)
                #if DEBUG
                NSLog("pairing link opened: %@", opened ? "yes" : "no")
                #endif
            }
            .sheet(item: Binding(get: { links.pending.map(PendingLink.init) }, set: { if $0 == nil { links.pending = nil } })) { pending in
                NavigationStack { AddServerView(link: pending.target) }
            }
    }

    private struct PendingLink: Identifiable {
        let target: PairingTarget
        var id: String { target.origin.absoluteString + (target.code ?? "") }
    }
}
