import AVKit
import SwiftUI

struct MoreView: View {
    @EnvironmentObject private var servers: Servers
    @AppStorage("wifiOnly") private var wifiOnly = false
    @State private var adding = false

    var body: some View {
        List {
            Section("Servers") {
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
                Button(servers.signedOut ? "Sign in again" : "Add server") { adding = true }
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
        .sheet(isPresented: $adding) {
            NavigationStack { AddServerView(prefill: servers.signedOut ? servers.current?.url.absoluteString : nil) }
        }
    }
}

/// Add a server: scan the code the computer shows, or type its address (and sign in when it asks).
struct AddServerView: View {
    var first = false
    var prefill: String?
    @EnvironmentObject private var servers: Servers
    @Environment(\.dismiss) private var dismiss
    @State private var address = ""
    @State private var username = ""
    @State private var password = ""
    @State private var needsPassword: SignIn.Target?
    @State private var scanning = false
    @State private var busy = false
    @State private var error: String?

    var body: some View {
        Form {
            Section {
                TextField("Address or sign-in link", text: $address)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .keyboardType(.URL)
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
            } footer: {
                Text("On the computer: Settings → Computers → Add your phone.")
            }
            if needsPassword != nil {
                Section("Sign in") {
                    TextField("Username", text: $username)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .textContentType(.username)
                    SecureField("Password", text: $password).textContentType(.password)
                }
            }
            if let error { Problem(text: error) }
            Button(needsPassword == nil ? "Connect" : "Sign in") { Task { await connect() } }
                .disabled(busy || address.isEmpty || (needsPassword != nil && (username.isEmpty || password.isEmpty)))
        }
        .navigationTitle(first ? "Creator Toolset" : "Add server")
        .toolbar {
            if !first { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
        }
        .onAppear { if let prefill, address.isEmpty { address = prefill } }
        .onChange(of: address) { needsPassword = nil }
        .sheet(isPresented: $scanning) {
            CodeScanner { text in
                scanning = false
                address = text
                Task { await connect() }
            }
            .ignoresSafeArea()
        }
    }

    private func connect() async {
        guard let target = SignIn.parse(address) else { return error = "That isn't an address" }
        busy = true
        defer { busy = false }
        do {
            let outcome = if let asked = needsPassword {
                try await SignIn.login(asked.origin, username: username, password: password)
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
