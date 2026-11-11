import SwiftUI

/// The app's Assistant, the same chat as on the computer (`apps/captions/api/assistant.ts`): one open chat per
/// account, so a message sent here shows there too.
struct ChatView: View {
    struct Message: Decodable, Identifiable, Equatable {
        let id: String
        let role: String
        let text: String
        let status: String?
        let steps: [String]?
    }

    struct Chat: Decodable {
        let aiName: String
        let messages: [Message]
    }

    @EnvironmentObject private var servers: Servers
    @EnvironmentObject private var edits: PhoneEdits
    @State private var chat: Chat?
    /// `-newEdit YES` opens New edit at launch (simulator screenshots).
    @State private var newEdit = UserDefaults.standard.bool(forKey: "newEdit")
    @State private var draft = ""
    @State private var sending = false
    @State private var error: String?

    private var thinking: Bool { chat?.messages.last?.status == "thinking" }

    var body: some View {
        ScrollViewReader { scroll in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 12) {
                    ForEach(chat?.messages ?? []) { message in
                        Bubble(message: message).id(message.id)
                    }
                }
                .padding()
            }
            .defaultScrollAnchor(.bottom)
            .onChange(of: chat?.messages.last) { _, last in
                if let last { scroll.scrollTo(last.id, anchor: .bottom) }
            }
        }
        .overlay {
            if chat == nil && error == nil {
                ProgressView()
            } else if chat?.messages.isEmpty == true {
                ContentUnavailableView("Ask your AI", systemImage: "bubble.left.and.bubble.right")
            }
        }
        .safeAreaInset(edge: .top) { editRows }
        .safeAreaInset(edge: .bottom) { composer }
        .navigationTitle(chat?.aiName.isEmpty == false ? chat!.aiName : "Assistant")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button("New edit") { newEdit = true }
            }
        }
        .sheet(isPresented: $newEdit) { NewEditView() }
        .task { await follow() }
        .task {
            // ponytail: polls like the chat; the change stream when the phone keeps a live connection
            while !Task.isCancelled {
                await edits.refresh()
                try? await Task.sleep(for: .seconds(15))
            }
        }
    }

    /// The phone's New edits, the newest three.
    // ponytail: older ones are kept but not shown; a list of them when someone needs it
    @ViewBuilder private var editRows: some View {
        let mine = edits.list.filter { $0.server == servers.currentId }.prefix(3)
        if !mine.isEmpty {
            VStack(spacing: 8) {
                ForEach(mine) { PhoneEditRow(edit: $0) }
            }
            .padding(.horizontal)
            .padding(.vertical, 8)
            .background(.bar)
        }
    }

    private var composer: some View {
        VStack(spacing: 6) {
            if let error { Problem(text: error) }
            HStack(alignment: .bottom) {
                TextField("Message", text: $draft, axis: .vertical)
                    .lineLimit(1...6)
                    .textFieldStyle(.roundedBorder)
                Button { Task { await send() } } label: {
                    Image(systemName: "arrow.up.circle.fill").font(.title)
                }
                .accessibilityLabel("Send")
                .disabled(sending || thinking || draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }
        .padding()
        .background(.bar)
    }

    /// Reads the chat, then again every 2 seconds while a reply is being written, every 15 otherwise (a message
    /// sent from the computer shows up too).
    // ponytail: polls; switch to the change stream (/api/sync/events) when the phone keeps a live connection
    private func follow() async {
        while !Task.isCancelled {
            await load()
            try? await Task.sleep(for: .seconds(thinking ? 2 : 15))
        }
    }

    private func load() async {
        guard let api = servers.api else { return }
        do {
            chat = try await api.get("/api/assistant")
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func send() async {
        guard let api = servers.api else { return }
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        sending = true
        defer { sending = false }
        do {
            chat = try JSONDecoder().decode(Chat.self, from: try await api.send("/api/assistant/turn", json: ["text": text]))
            draft = ""
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
    }
}

private struct Bubble: View {
    let message: ChatView.Message

    var body: some View {
        let mine = message.role == "user"
        VStack(alignment: mine ? .trailing : .leading, spacing: 4) {
            if message.status == "thinking" {
                ForEach(message.steps ?? [], id: \.self) { Text($0).font(.caption).foregroundStyle(.secondary) }
                if message.text.isEmpty { ProgressView() }
            }
            if !message.text.isEmpty {
                Text(LocalizedStringKey(message.text))
                    .textSelection(.enabled)
                    .padding(mine ? 10 : 0)
                    .background(mine ? Color.accentColor.opacity(0.25) : .clear, in: RoundedRectangle(cornerRadius: 14))
                    .foregroundStyle(message.role == "note" ? .secondary : .primary)
            }
            if message.status == "error" { Text("Didn't finish").font(.caption).foregroundStyle(.orange) }
        }
        .frame(maxWidth: .infinity, alignment: mine ? .trailing : .leading)
    }
}

// The Chats list and the screens it opens, until they are built (they replace this file):

/// Chats: the rows of what is going on, each opening its own screen.
struct ChatsView: View {
    @ObservedObject private var nav = AppNavigator.shared

    var body: some View {
        List {
            Button { nav.open(.assistant) } label: {
                ChatListRow(title: "Assistant", detail: "", status: .none) {
                    Image(systemName: "sparkles").foregroundStyle(Color("AccentColor")).frame(width: 28)
                }
            }
            .buttonStyle(.plain)
        }
        .navigationTitle("Chats")
    }
}

/// What waits on the person in Chats (the tab's badge).
@MainActor
final class ChatsModel: ObservableObject {
    static let shared = ChatsModel()
    @Published private(set) var waiting = 0
}

/// The assistant's chat.
struct AssistantChatView: View {
    var body: some View { ChatView() }
}

/// A Review video, on a version when one is named.
struct ReviewRouteView: View {
    let id: String
    var version: Int?

    var body: some View { PageView(path: "/review/\(id)" + (version.map { "?v=\($0)" } ?? "")) }
}
