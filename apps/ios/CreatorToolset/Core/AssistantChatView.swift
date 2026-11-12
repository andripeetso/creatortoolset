import PhotosUI
import SwiftUI

/// The assistant's conversation: the same one as on the computer. What he writes here shows
/// there, and a new chat or an earlier one opened here is the one open there too.
struct AssistantChatView: View {
    @ObservedObject private var model = AssistantModel.shared
    @ObservedObject private var outbox = AssistantModel.shared.outbox
    @ObservedObject private var draft = AssistantModel.shared.draft
    @ObservedObject private var nav = AppNavigator.shared
    /// Opened with the round New-message button: the box takes the keyboard.
    @State private var autofocus = AppNavigator.shared.composing || debugArg("AssistantCompose") != nil
    @State private var showsPast = debugArg("AssistantSheet") == "past"
    @State private var picking = false
    @State private var picked: [PhotosPickerItem] = []
    /// He is reading the newest message: the feed follows what arrives. Scrolled up, it stays put.
    @State private var atBottom = debugArg("AssistantScroll") != "top"
    /// The feed's last measure: tells his own scrolling from the feed growing under him.
    @State private var measured = Measured()

    static let starters = ["Where did I leave off?", "What can I finish right away?", "Find my next content idea"]
    private static let end = "end"

    private var messages: [AssistantMessage] { model.view?.messages ?? [] }
    private var thinking: AssistantMessage? { model.view?.thinking }
    /// No AI connected: nothing can be asked. Not known yet counts as connected, so he can write at once.
    private var connected: Bool { model.view?.connected ?? true }

    var body: some View {
        content
            .safeAreaInset(edge: .bottom, spacing: 0) { bottomBar }
            .navigationTitle("Assistant")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItemGroup(placement: .topBarTrailing) {
                    Button { showsPast = true } label: { Image(systemName: "clock") }
                        .accessibilityLabel("Earlier chats")
                        .disabled(model.unsent || model.view?.connected != true)
                    Button { Task { await model.newChat() } } label: { Image(systemName: "square.and.pencil") }
                        .accessibilityLabel("New chat")
                        .disabled(model.unsent || model.view?.connected != true || messages.isEmpty)
                }
            }
            .sheet(isPresented: $showsPast) { EarlierChats() }
            .photosPicker(isPresented: $picking, selection: $picked,
                          maxSelectionCount: AssistantDraft.maxPictures + AssistantDraft.maxVideos,
                          matching: .any(of: [.images, .videos]), preferredItemEncoding: .current)
            .onChange(of: picked) { _, items in
                guard !items.isEmpty else { return }
                picked = []
                Task { await draft.add(items) }
            }
            .onChange(of: model.view?.navigate, initial: true) { _, path in follow(path) }
            .onAppear {
                AppNavigator.shared.composing = false
                #if DEBUG
                AssistantFixtures.fill(draft)
                #endif
            }
            .task {
                await model.load()
                #if DEBUG
                await AssistantFixtures.act(model)
                #endif
            }
    }

    @ViewBuilder private var content: some View {
        if let view = model.view, !view.connected {
            line("Connect your AI in Creator Toolset on your computer.")
        } else if model.view == nil, outbox.items.isEmpty {
            if let error = model.error {
                line(error)
            } else {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        } else {
            feed
        }
    }

    private func line(_ text: String) -> some View {
        Text(text)
            .foregroundStyle(.secondary)
            .multilineTextAlignment(.center)
            .padding(.horizontal, 40)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    // MARK: The feed

    private var feed: some View {
        GeometryReader { box in
            ScrollViewReader { proxy in
                ScrollView {
                    // not lazy: at most 80 messages, and their true height is what keeps the feed on its newest one
                    VStack(alignment: .leading, spacing: 16) {
                        ForEach(Array(messages.enumerated()), id: \.element.id) { index, message in
                            row(message, at: index)
                        }
                        ForEach(outbox.shown) { queued in
                            AssistantQueuedBubble(message: queued, inFlight: outbox.sending == queued.id) {
                                model.takeBack(queued.id)
                            } onRetry: {
                                model.retry(queued.id)
                            }
                        }
                        if let error = model.error, model.view != nil {
                            Text(error).font(.footnote).foregroundStyle(.red)
                        }
                        Color.clear.frame(height: 1).id(Self.end)
                    }
                    .padding(.horizontal, 16)
                    .padding(.top, 8)
                    .background {
                        GeometryReader { content in
                            let shape = FeedShape(height: content.size.height, bottom: content.frame(in: .named(Self.end)).maxY,
                                                  window: box.size.height)
                            Color.clear.onChange(of: shape, initial: true) { _, shape in settle(shape, proxy) }
                        }
                    }
                }
                .coordinateSpace(name: Self.end)
                .scrollDismissesKeyboard(.interactively)
                .opensAtItsEnd(debugArg("AssistantScroll") != "top")
            }
        }
    }

    /// The feed or its window changed size (a message came, a picture loaded, the keyboard rose):
    /// when he was on the newest message he stays on it. Otherwise it was his own scrolling, which
    /// says whether he still is.
    private func settle(_ shape: FeedShape, _ proxy: ScrollViewProxy) {
        let resized = abs(shape.height - measured.shape.height) > 1 || abs(shape.window - measured.shape.window) > 1
        measured.shape = shape
        if !resized {
            let now = shape.bottom <= shape.window + 80
            if now != atBottom { atBottom = now }
        } else if atBottom {
            Task { @MainActor in proxy.scrollTo(Self.end, anchor: .bottom) }
        }
    }

    @ViewBuilder private func row(_ message: AssistantMessage, at index: Int) -> some View {
        switch message.role {
        case "user":
            AssistantUserMessage(message: message)
        case "note":
            Text(message.text)
                .font(.footnote)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .frame(maxWidth: .infinity)
        default:
            AssistantReply(message: message, retry: retry(at: index), choose: choose(at: index),
                           stop: message.status == "thinking" && message.wait != nil ? { Task { await model.stop(reply: message.id) } } : nil)
        }
    }

    /// The newest reply can be answered in one press, until something else is said.
    private func newest(_ index: Int) -> Bool {
        index == messages.count - 1 && outbox.shown.isEmpty
    }

    /// A failed reply at the end: its question can be sent again.
    private func retry(at index: Int) -> (() -> Void)? {
        guard newest(index), messages[index].status == "error", index > 0, messages[index - 1].role == "user" else { return nil }
        let asked = messages[index - 1]
        return { say(asked.text, quote: asked.quote) }
    }

    private func choose(at index: Int) -> ((String) -> Void)? {
        guard newest(index), messages[index].status == "done" else { return nil }
        return { say($0) }
    }

    // MARK: Under the feed

    private var bottomBar: some View {
        VStack(spacing: 8) {
            if model.view?.connected == true, messages.isEmpty, outbox.shown.isEmpty {
                VStack(alignment: .leading, spacing: 8) {
                    ForEach(Self.starters, id: \.self) { starter in
                        Button { say(starter) } label: {
                            Text(starter)
                                .font(.subheadline)
                                .padding(.horizontal, 16)
                                .frame(minHeight: 44)
                                .chatSurface(cornerRadius: 22)
                        }
                        .buttonStyle(.plain)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 12)
            }
            if model.offline { QuietNotice(text: "No connection").padding(.horizontal, 22) }
            if let notice = draft.notice { QuietNotice(text: notice).padding(.horizontal, 22) }
            if let thinking {
                // a reply held until its videos are in, or behind another: no clock until it is being written
                WorkingCapsule(label: thinking.wait == nil ? "Working" : "Waiting",
                               since: thinking.wait == nil ? model.view?.asked(thinking).map { date(ms: $0) } : nil) { Task { await model.stop() } }
            }
            // while a reply is being written the round button is a red Stop as long as the box is empty
            // (owner, 2026-11-11: he could find no way to stop, typed "Stop", and it went as a message)
            ChatComposer(text: $draft.text, working: thinking != nil, sending: draft.reading, hasAttachment: draft.hasAttachment,
                         autofocus: autofocus,
                         attachments: draft.hasAttachment ? AnyView(AssistantAttachmentChips(draft: draft)) : nil,
                         onSend: sendDraft, onStop: { Task { await model.stop() } }) {
                Menu {
                    Button { picking = true } label: { Label("Photo Library", systemImage: "photo.on.rectangle") }
                } label: {
                    Image(systemName: "plus")
                        .font(.system(size: 19, weight: .medium))
                        .foregroundStyle(.secondary)
                        .frame(width: 36, height: 44)
                        .contentShape(Rectangle())
                }
                .tint(.secondary)
                .accessibilityLabel("Add pictures or videos")
            }
            .disabled(!connected)
        }
    }

    private func sendDraft() {
        guard let message = draft.take() else { return }
        atBottom = true
        model.send(message)
    }

    /// A starter, a choice or a question asked again: its words go as his message.
    private func say(_ text: String, quote: String? = nil) {
        atBottom = true
        model.send(QueuedMessage(text: text, quote: quote))
    }

    /// A page the assistant opened for the person: go there once, and tell the server it was opened.
    private func follow(_ path: String?) {
        guard let path, !path.isEmpty, nav.tab == .chats, nav.chats.last?.isAssistant == true else { return }
        Task { await model.navigated() }
        if let route = Self.opensByItself(path) { nav.open(route) }
    }

    /// What the assistant may open without a press: only a page of the signed-in server. Another site's address is
    /// never opened (nor loaded) because a reply named it; a link in the reply opens it when the person presses it.
    nonisolated static func opensByItself(_ path: String) -> AppRoute? { AppRoute.from(path: path) }
}

/// How tall the feed is, where its end sits in the scroll view, and how tall that view is.
private struct FeedShape: Equatable {
    var height: CGFloat = 0
    var bottom: CGFloat = 0
    var window: CGFloat = 0
}

/// Kept without redrawing anything: it changes on every scrolled point.
private final class Measured {
    var shape = FeedShape()
}

private extension View {
    /// A chat opens on its newest message and stays on it as the feed or the keyboard grows;
    /// a short one still starts under the title, not above the box.
    @ViewBuilder func opensAtItsEnd(_ on: Bool) -> some View {
        if !on {
            self
        } else if #available(iOS 18.0, *) {
            defaultScrollAnchor(.bottom, for: .initialOffset).defaultScrollAnchor(.bottom, for: .sizeChanges)
        } else {
            defaultScrollAnchor(.bottom)
        }
    }
}

/// Earlier chats, newest first: a tap opens one (here and on the computer), a swipe deletes it after asking.
private struct EarlierChats: View {
    @ObservedObject private var model = AssistantModel.shared
    @Environment(\.dismiss) private var dismiss
    @State private var deleting: AssistantPast?

    private var past: [AssistantPast] { model.view?.past ?? [] }

    var body: some View {
        NavigationStack {
            List(past) { chat in
                Button {
                    Task {
                        await model.open(past: chat.id)
                        dismiss()
                    }
                } label: {
                    ChatListRow(title: chat.title, detail: chat.count == 1 ? "1 message" : "\(chat.count) messages",
                                status: .time(date(ms: chat.at)))
                }
                .buttonStyle(.plain)
                .swipeActions {
                    Button("Delete") { deleting = chat }.tint(.red)
                }
            }
            .listStyle(.plain)
            .disabled(model.unsent)
            .overlay {
                if past.isEmpty { Text("No earlier chats").foregroundStyle(.secondary) }
            }
            .navigationTitle("Earlier chats")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) { Button("Done") { dismiss() } }
            }
            .confirmationDialog("Delete this chat?", isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } }),
                                titleVisibility: .visible, presenting: deleting) { chat in
                Button("Delete", role: .destructive) { Task { await model.delete(past: chat.id) } }
            } message: { chat in
                Text(chat.title)
            }
        }
        .presentationDetents([.medium, .large])
    }
}

/// What goes with the message, inside the box above the text: each can be taken off.
struct AssistantAttachmentChips: View {
    @ObservedObject var draft: AssistantDraft

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(draft.pictures) { picture in
                    Group {
                        if let small = AssistantPicture.small(picture) {
                            Image(uiImage: small).resizable().scaledToFill()
                        } else {
                            Color(.tertiarySystemFill)
                        }
                    }
                    .frame(width: 56, height: 56)
                    .clipShape(RoundedRectangle(cornerRadius: 12))
                    .overlay(alignment: .topTrailing) {
                        takeOff("Remove \(picture.name)") { draft.remove(picture: picture.id) }
                    }
                }
                ForEach(draft.files) { file in video(file.name) { draft.remove(file: file.id) } }
                ForEach(draft.videos) { picked in video(picked.name) { draft.remove(video: picked.id) } }
            }
        }
    }

    /// A video in the box: its name. It goes up once the message is sent.
    private func video(_ name: String, remove: @escaping () -> Void) -> some View {
        HStack(spacing: 8) {
            Image(systemName: "film").foregroundStyle(.secondary)
            Text(name).font(.footnote.weight(.medium)).lineLimit(1).frame(maxWidth: 170, alignment: .leading)
            takeOff("Remove \(name)", remove)
        }
        .padding(.leading, 12)
        .frame(height: 56)
        .background(Color(.tertiarySystemFill), in: RoundedRectangle(cornerRadius: 12))
    }

    private func takeOff(_ label: String, _ action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: "xmark.circle.fill")
                .font(.system(size: 18))
                .symbolRenderingMode(.palette)
                .foregroundStyle(.white, Color(.systemGray))
                .frame(width: 36, height: 36)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
    }
}
