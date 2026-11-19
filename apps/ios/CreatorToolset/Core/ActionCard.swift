import SwiftUI

// The card under a reply whose tool needs the person first (AssistantAction). A server that sends `actions` drives it
// whole: title, line, then its buttons in order. The phone knows no kinds; the server owns the state and the chat
// moves on when the action is done.

/// One button of a card: it sends a request (`call`), opens the folder browser (`browse`), or names a page that is
/// done on the computer (`open`).
struct CardAction: Decodable, Hashable {
    var id: String
    var label: String
    var primary: Bool?
    var call: Call?
    var browse: Browse?
    var open: String?

    struct Call: Decodable, Hashable {
        var method: String
        var path: String
        var body: [String: JSONValue]?
        /// Sent as X-CT-Workspace.
        var workspace: String?
    }

    struct Browse: Decodable, Hashable, Identifiable {
        var device: String
        /// "projects", "library" or "footage": the folder row the pick makes.
        var role: String
        var workspace: String
        var start: String?

        var id: String { [device, role, workspace, start ?? ""].joined(separator: "\u{1}") }
    }
}

/// A card's request as the chat's signed-in session (cookie or Bearer/DPoP), in `workspace` when given. A refusal
/// throws the server's `error` line.
enum CardRequest {
    @discardableResult
    static func send(_ method: String, _ path: String, body: [String: JSONValue]? = nil, workspace: String? = nil,
                     api: API, session: URLSession = API.session) async throws -> Data {
        var api = api
        if let workspace { api.workspace = workspace }
        var request = api.request(path, method: method)
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONEncoder().encode(body)
        }
        return try await api.data(request, session: session)
    }

    static func line(_ error: Error) -> String { (error as? APIError)?.message ?? error.localizedDescription }
}

/// What a card's buttons are doing: one request on its way, then working (taken: the card waits for the chat), or
/// refused, with the server's line and that button saying Retry.
@MainActor
final class ActionCardModel: ObservableObject {
    @Published private(set) var busy: Int?
    @Published private(set) var working = false
    @Published private(set) var failedIndex: Int?
    @Published private(set) var failure: String?

    let api: @MainActor () -> API?
    private let session: URLSession

    init(api: (@MainActor () -> API?)? = nil, session: URLSession = API.session) {
        self.api = api ?? { AssistantModel.shared.chatAPI }
        self.session = session
    }

    func label(_ action: CardAction, at index: Int) -> String { failedIndex == index ? "Retry" : action.label }

    /// Sends the button's call; Retry is the same button, so the same call again.
    func run(_ call: CardAction.Call, at index: Int) async {
        guard busy == nil, !working else { return }
        guard let api = api() else { return refused(index, APIError.signedOut.message) }
        busy = index
        defer { busy = nil }
        do {
            try await CardRequest.send(call.method, call.path, body: call.body, workspace: call.workspace, api: api, session: session)
            failedIndex = nil
            failure = nil
            working = true
        } catch {
            refused(index, CardRequest.line(error))
        }
    }

    /// The folder browser's pick was taken.
    func picked() {
        failedIndex = nil
        failure = nil
        working = true
    }

    private func refused(_ index: Int, _ line: String) {
        failedIndex = index
        failure = line
    }
}

/// A computer's folders, through the server (`GET /api/devices/:device/browse`): its places, then the folders in the
/// one shown, and "Use this folder", which makes the action's folder row with that path. The server's line shows when
/// it can't (the computer offline or too old, a folder outside home and the drives).
@MainActor
final class FolderBrowser: ObservableObject {
    struct Listing: Decodable, Equatable {
        struct Entry: Decodable, Hashable {
            var name: String
            var path: String
        }
        var device: String
        var deviceName: String
        var path: String
        var parent: String?
        var roots: [Entry]
        var dirs: [Entry]
    }

    let browse: CardAction.Browse
    @Published private(set) var listing: Listing?
    @Published private(set) var error: String?
    @Published private(set) var loading = false
    @Published private(set) var using = false
    private let api: API?
    private let session: URLSession

    init(browse: CardAction.Browse, api: API?, session: URLSession = API.session) {
        self.browse = browse
        self.api = api
        self.session = session
    }

    /// Shows the folder at `path`; nil is where the action starts (its `start`, else the home folder).
    func go(to path: String?) async {
        guard let api else { return error = APIError.signedOut.message }
        loading = true
        defer { loading = false }
        do {
            let data = try await CardRequest.send("GET", Self.address(browse.device, path ?? browse.start ?? "~"), api: api, session: session)
            listing = try JSONDecoder().decode(Listing.self, from: data)
            error = nil
        } catch {
            self.error = CardRequest.line(error)
        }
    }

    func up() async {
        if let parent = listing?.parent { await go(to: parent) }
    }

    /// Makes the folder row with the folder shown; true once the server took it.
    func use() async -> Bool {
        guard let api, let path = listing?.path else { return false }
        using = true
        defer { using = false }
        do {
            let body: [String: JSONValue] = ["role": .string(browse.role), "host": .string(browse.device), "path": .string(path), "make": .bool(true)]
            try await CardRequest.send("POST", "/api/devices/storage/folders", body: body, workspace: browse.workspace, api: api, session: session)
            error = nil
            return true
        } catch {
            self.error = CardRequest.line(error)
            return false
        }
    }

    static func address(_ device: String, _ path: String) -> String {
        let plain = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~")
        let inPath = plain.union(CharacterSet(charactersIn: "/"))
        return "/api/devices/\(device.addingPercentEncoding(withAllowedCharacters: plain) ?? device)/browse?path=\(path.addingPercentEncoding(withAllowedCharacters: inPath) ?? path)"
    }
}

/// The card for a reply's action: the server's own card when it sends `actions`, else what this app knows of the kind.
struct AssistantActionCard: View {
    let action: AssistantAction

    var body: some View {
        if let actions = action.actions {
            ServerActionCard(action: action, actions: actions).id(action)   // a fresh card starts over
        } else if let card = action.card {
            AskCard(eyebrow: "Needed first", title: card.title, detail: card.line) {
                if let page = card.page {
                    WideButton(title: "Open on the computer", systemImage: "desktopcomputer", kind: .plain) {
                        AppNavigator.shared.open(.page(page))
                    }
                }
            }
        }
    }
}

private struct ServerActionCard: View {
    let action: AssistantAction
    let actions: [CardAction]
    @StateObject private var model = ActionCardModel()
    @State private var browsing: CardAction.Browse?

    var body: some View {
        AskCard(eyebrow: "Needed first", title: action.title ?? "", detail: action.line) {
            if let failure = model.failure {
                Text(failure).font(.footnote).foregroundStyle(.red)
            }
            if model.working {
                HStack(spacing: 8) {
                    ProgressView().controlSize(.small)
                    Text("Working").font(.footnote).foregroundStyle(.secondary)
                }
            } else {
                ForEach(Array(actions.enumerated()), id: \.offset) { index, button in
                    if button.call == nil, button.browse == nil {
                        Text("Customise on the computer").font(.footnote).foregroundStyle(.secondary)
                    } else {
                        WideButton(title: model.label(button, at: index), kind: button.primary == true ? .main : .plain, busy: model.busy == index) {
                            if let call = button.call {
                                Task { await model.run(call, at: index) }
                            } else {
                                browsing = button.browse
                            }
                        }
                        .disabled(model.busy != nil)
                    }
                }
            }
        }
        .sheet(item: $browsing) { browse in
            FolderBrowserSheet(browser: FolderBrowser(browse: browse, api: model.api())) { model.picked() }
        }
    }
}

struct FolderBrowserSheet: View {
    @StateObject private var browser: FolderBrowser
    let picked: () -> Void
    @Environment(\.dismiss) private var dismiss

    init(browser: FolderBrowser, picked: @escaping () -> Void) {
        _browser = StateObject(wrappedValue: browser)
        self.picked = picked
    }

    var body: some View {
        NavigationStack {
            List {
                if let error = browser.error {
                    Text(error).font(.footnote).foregroundStyle(.red)
                }
                if let listing = browser.listing {
                    if !listing.roots.isEmpty {
                        Section("Places") {
                            ForEach(listing.roots, id: \.path) { row($0.name, "externaldrive", $0.path) }
                        }
                    }
                    Section {
                        if listing.parent != nil {
                            Button { Task { await browser.up() } } label: { Label("Back", systemImage: "arrow.turn.left.up") }
                        }
                        ForEach(listing.dirs, id: \.path) { row($0.name, "folder", $0.path) }
                        if listing.dirs.isEmpty {
                            Text("No folders in here").foregroundStyle(.secondary)
                        }
                    } header: {
                        Text(listing.path).lineLimit(1).truncationMode(.head)
                    }
                } else if browser.loading {
                    ProgressView().frame(maxWidth: .infinity)
                } else if browser.error != nil {
                    Button("Retry") { Task { await browser.go(to: nil) } }
                }
            }
            .disabled(browser.using)
            .navigationTitle(browser.listing?.deviceName ?? "Choose a folder")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
            }
            .safeAreaInset(edge: .bottom) {
                WideButton(title: "Use this folder", busy: browser.using) {
                    Task {
                        if await browser.use() {
                            picked()
                            dismiss()
                        }
                    }
                }
                .disabled(browser.listing == nil || browser.loading || browser.using)
                .padding()
                .background(.bar)
            }
            .task { if browser.listing == nil { await browser.go(to: nil) } }
        }
    }

    private func row(_ name: String, _ symbol: String, _ path: String) -> some View {
        Button { Task { await browser.go(to: path) } } label: { Label(name, systemImage: symbol) }
    }
}
