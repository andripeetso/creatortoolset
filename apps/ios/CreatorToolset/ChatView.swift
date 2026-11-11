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
    @State private var chat: Chat?
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
        .safeAreaInset(edge: .bottom) { composer }
        .navigationTitle(chat?.aiName.isEmpty == false ? chat!.aiName : "Assistant")
        .navigationBarTitleDisplayMode(.inline)
        .task { await follow() }
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
