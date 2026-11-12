import SwiftUI

/// One of the assistant's chats, opened from its row in Chats or from a notification about it. The server keeps one
/// chat open, the same one on the computer: an earlier chat is made the open one there first, then shown here. Once
/// shown, the screen follows the open chat (a new chat started from it shows the new one).
struct AssistantChatRoute: View {
    let id: String
    @ObservedObject private var model = AssistantModel.shared
    @State private var shown: Bool?

    var body: some View {
        Group {
            switch shown {
            case true?:
                AssistantChatView()
            case false?:
                VStack(spacing: 16) {
                    QuietNotice(text: model.error ?? "That chat isn't there any more.")
                    WideButton(title: "Open the current chat", kind: .plain) {
                        var path = AppNavigator.shared.chats
                        if path.last == .chat(id) { path.removeLast() }
                        AppNavigator.shared.chats = path + [.assistant]
                    }
                }
                .padding(16)
                .frame(maxHeight: .infinity, alignment: .top)
                .navigationTitle("Assistant")
                .navigationBarTitleDisplayMode(.inline)
            case nil:
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .task(id: id) {
            if model.view?.id != id {
                if model.view == nil { await model.load() }
                if model.view?.id != id {
                    // a message not gone yet would land in this chat instead of its own
                    if model.unsent {
                        model.error = "A message in your current chat hasn't gone yet. This chat opens once it has."
                    } else {
                        await model.open(past: id)
                    }
                }
            }
            shown = model.view?.id == id
        }
    }
}
