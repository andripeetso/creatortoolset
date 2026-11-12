import AVKit
import SwiftUI

// What the assistant's feed is made of: his message with what he sent along, a reply with what
// it did, its cards, its videos and what it asks to do on the Mac, and a message that waits to go.

/// What he wrote, with its pictures, files and the text he asked about.
struct AssistantUserMessage: View {
    let message: AssistantMessage
    /// How far this phone has got each video still going up, by its id.
    var uploading: [String: Double] = [:]
    /// Its reply still waits for its videos: one that was stopped shows them as plain names.
    var held = true

    var body: some View {
        VStack(alignment: .trailing, spacing: 6) {
            if let task = message.task {
                Text("Scheduled task · \(task.name)").font(.caption).foregroundStyle(.secondary)
            }
            if let quote = message.quote, !quote.isEmpty {
                Text(quote)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .lineLimit(3)
                    .multilineTextAlignment(.trailing)
                    .padding(.trailing, 10)
                    .overlay(alignment: .trailing) { Capsule().fill(Color(.systemGray3)).frame(width: 2) }
                    .padding(.leading, 48)
            }
            if let images = message.images, !images.isEmpty {
                // three to a row: six pictures never run off the screen
                VStack(alignment: .trailing, spacing: 6) {
                    ForEach(Array(stride(from: 0, to: images.count, by: 3)), id: \.self) { start in
                        HStack(spacing: 6) {
                            ForEach(images[start..<min(start + 3, images.count)]) { image in
                                ToolsetImage(path: "/api/assistant/images/\(image.id)", maxPixels: 300)
                                    .frame(width: 84, height: 84)
                                    .clipShape(RoundedRectangle(cornerRadius: 12))
                                    .accessibilityLabel(image.name)
                            }
                        }
                    }
                }
            }
            ForEach(message.files ?? []) { file in
                if file.uploading == true, held {
                    AssistantVideoChip(name: file.name, up: uploading[file.id] ?? 0, known: uploading[file.id] != nil)
                } else {
                    chip(file.name, "film")
                }
            }
            ForEach(message.pasted ?? [], id: \.self) { chip($0, "doc.text") }
            ForEach(message.folders ?? [], id: \.self) { chip(($0 as NSString).lastPathComponent, "folder") }
            if !message.text.isEmpty { UserBubble(text: message.text) }
        }
        .frame(maxWidth: .infinity, alignment: .trailing)
    }

    private func chip(_ name: String, _ symbol: String) -> some View {
        Label(name, systemImage: symbol)
            .font(.footnote)
            .lineLimit(1)
            .padding(.horizontal, 10)
            .frame(height: 30)
            .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 9))
            .padding(.leading, 48)
    }
}

/// A reply: what it is doing while it thinks, what it did once done, its words, then its cards,
/// videos and what it asks, and at the end of the chat the buttons that answer it.
struct AssistantReply: View {
    let message: AssistantMessage
    /// Sends the question again: only on a failed reply at the end of the chat.
    var retry: (() -> Void)?
    /// Sends one of the offered answers: only on the newest reply.
    var choose: ((String) -> Void)?
    /// Ends this reply before it starts: only on one that waits for its videos or its turn.
    var stop: (() -> Void)?

    var body: some View {
        let steps = message.steps ?? []
        VStack(alignment: .leading, spacing: 10) {
            if message.status == "thinking" {
                HStack(spacing: 8) {
                    // nothing turns on a reply that has not started
                    if message.wait == nil { ProgressView().controlSize(.small).tint(.secondary) }
                    Text(message.wait?.text ?? steps.last ?? "Thinking").font(.footnote).foregroundStyle(.secondary)
                    if let stop {
                        Button(action: stop) {
                            Image(systemName: "xmark.circle.fill")
                                .font(.system(size: 18))
                                .foregroundStyle(.secondary)
                                .frame(width: 36, height: 44)
                                .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        // a full-size target that does not make the line taller than its words
                        .padding(.vertical, -12)
                        .accessibilityLabel("Stop this reply")
                    }
                }
            } else if steps.count == 1 {
                StepsFold(title: steps[0], steps: [])
            } else if !steps.isEmpty {
                StepsFold(title: "\(steps.count) steps", steps: steps)
            }
            if message.status == "error" {
                Text(message.text.isEmpty ? "That didn't work." : message.text)
                    .font(.callout)
                    .foregroundStyle(.red)
                    .frame(maxWidth: .infinity, alignment: .leading)
            } else if !message.text.isEmpty {
                MarkdownText(text: message.text)
            }
            ForEach(message.work ?? []) { AssistantWorkCard(work: $0) }
            ForEach(message.media ?? []) { AssistantVideoCard(media: $0) }
            ForEach(message.approvals ?? []) { AssistantApprovalCard(approval: $0) }
            ForEach(message.confirms ?? []) { AssistantConfirmCard(confirm: $0) }
            if let retry {
                WideButton(title: "Try again", systemImage: "arrow.clockwise", kind: .plain, action: retry)
            }
            if let choose {
                ForEach(message.choices ?? [], id: \.self) { choice in
                    WideButton(title: choice, kind: .plain) { choose(choice) }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// One thing a reply started or opened: a tap opens it.
struct AssistantWorkCard: View {
    let work: AssistantWork

    var body: some View {
        Button {
            AppNavigator.shared.open(href: work.href)
        } label: {
            HStack(spacing: 12) {
                Image(systemName: Self.symbol(work.kind))
                    .foregroundStyle(.secondary)
                    .frame(width: 36, height: 36)
                    .background(Color(.tertiarySystemFill), in: RoundedRectangle(cornerRadius: 9))
                VStack(alignment: .leading, spacing: 2) {
                    Text(work.title).font(.subheadline.weight(.semibold)).lineLimit(1)
                    if let detail = work.detail, !detail.isEmpty {
                        Text(detail)
                            .font(.footnote)
                            .foregroundStyle(work.status == "failed" ? Color.red : Color.secondary)
                            .lineLimit(2)
                            .multilineTextAlignment(.leading)
                    }
                }
                Spacer(minLength: 8)
                switch work.status {
                case "running": ProgressView().controlSize(.small).tint(.secondary).accessibilityLabel("Running")
                case "failed": Image(systemName: "exclamationmark.circle.fill").foregroundStyle(.red).accessibilityLabel("Failed")
                default: Image(systemName: "checkmark").font(.footnote.weight(.semibold)).foregroundStyle(.secondary).accessibilityLabel("Done")
                }
            }
            .padding(12)
            .frame(minHeight: 60)
            .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 16))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    static func symbol(_ kind: String) -> String {
        switch kind {
        case "workshop": "pencil.line"
        case "edit": "movieclapper"
        case "review": "play.rectangle"
        case "automation": "calendar.badge.clock"
        case "notes": "note.text"
        case "captions": "captions.bubble"
        default: "link"
        }
    }
}

/// A video a reply shows: it plays in place, and its title opens its page.
struct AssistantVideoCard: View {
    let media: AssistantMedia
    @State private var player: AVPlayer?
    @State private var poster: UIImage?
    /// One video of the chat plays at a time.
    private static weak var playing: AVPlayer?

    /// The video's shape, known from its still; wide until then.
    private var shape: CGFloat {
        guard let poster, poster.size.height > 0 else { return 16 / 9 }
        return poster.size.width / poster.size.height
    }

    var body: some View {
        VStack(spacing: 0) {
            ZStack {
                Color.black
                if let player {
                    NativePlayer(player: player)
                } else {
                    if let poster { Image(uiImage: poster).resizable().scaledToFit() }
                    Button(action: play) {
                        Image(systemName: "play.fill")
                            .font(.system(size: 28))
                            .foregroundStyle(.white)
                            .frame(width: 68, height: 68)
                            .background(.ultraThinMaterial, in: Circle())
                    }
                    .accessibilityLabel("Play \(media.title)")
                }
            }
            .aspectRatio(shape, contentMode: .fit)
            // an upright video at the full width would be taller than the screen
            .frame(maxHeight: 420)
            .frame(maxWidth: .infinity)
            .background(Color.black)
            Button {
                AppNavigator.shared.open(href: media.href)
            } label: {
                HStack(spacing: 8) {
                    Text(media.title).font(.subheadline.weight(.semibold)).lineLimit(1)
                    Spacer(minLength: 8)
                    if let duration = media.duration, duration > 0 {
                        Text(clock(duration)).font(.footnote.monospacedDigit()).foregroundStyle(.secondary)
                    }
                    Image(systemName: "chevron.right").font(.footnote.weight(.semibold)).foregroundStyle(.tertiary)
                }
                .padding(.horizontal, 14)
                .frame(minHeight: 48)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
        }
        .background(Color(.secondarySystemBackground))
        .clipShape(RoundedRectangle(cornerRadius: 16))
        .task(id: media.poster) {
            guard let path = media.poster else { return }
            poster = await ToolsetImages.shared.image(path, maxPixels: 900)
        }
        .onDisappear { player?.pause() }
        .onAppear {
            if debugArg("AssistantPlay") != nil, player == nil { play() }   // a check that it plays, without a tap
        }
    }

    private func play() {
        guard let api = ToolsetAPI.current else { return }
        Self.playing?.pause()
        let fresh = api.player(media.src)
        Self.playing = fresh
        player = fresh
        fresh.play()
    }
}

/// Something the reply asks to do on his Mac: what it is in plain words, the exact command,
/// Allow and Deny. Once answered it is one quiet line.
struct AssistantApprovalCard: View {
    let approval: AssistantApproval
    /// The button he pressed, until the server's answer shows.
    @State private var pressed: Bool?

    var body: some View {
        if approval.status == "waiting" {
            AskCard(eyebrow: "The assistant asks", title: approval.summary) {
                if !approval.detail.isEmpty {
                    Text(approval.detail)
                        .font(.caption.monospaced())
                        .foregroundStyle(.secondary)
                        .textSelection(.enabled)
                        .lineLimit(12)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(10)
                        .background(Color(.tertiarySystemFill), in: RoundedRectangle(cornerRadius: 10))
                }
                WideButton(title: "Allow", busy: pressed == true) { answer(true) }
                WideButton(title: "Deny", kind: .plain, busy: pressed == false) { answer(false) }
            }
            .disabled(pressed != nil)
        } else {
            HStack(spacing: 6) {
                Image(systemName: approval.status == "allowed" ? "checkmark" : approval.status == "denied" ? "xmark" : "clock")
                    .font(.caption.weight(.semibold))
                Text(Self.word(approval.status)).fontWeight(.medium)
                Text(approval.summary).lineLimit(1).truncationMode(.tail)
            }
            .font(.footnote)
            .foregroundStyle(.secondary)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    static func word(_ status: String) -> String {
        switch status {
        case "allowed": "Allowed"
        case "denied": "Denied"
        default: "Ran out"
        }
    }

    private func answer(_ allow: Bool) {
        pressed = allow
        Task {
            await AssistantModel.shared.answer(approval: approval.id, allow: allow)
            pressed = nil
        }
    }
}

/// A question the reply asks before it deletes, publishes or sends something: Yes does it, No
/// drops it. Once answered it is one quiet line that says how it went.
struct AssistantConfirmCard: View {
    let confirm: AssistantConfirm
    @State private var pressed: Bool?

    var body: some View {
        if confirm.status == "waiting" {
            AskCard(eyebrow: "The assistant asks", title: confirm.question) {
                WideButton(title: "Yes", busy: pressed == true) { answer(true) }
                WideButton(title: "No", kind: .plain, busy: pressed == false) { answer(false) }
            }
            .disabled(pressed != nil)
        } else if confirm.status == "failed" {
            // it went wrong: the reason, in red
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Image(systemName: "xmark").font(.caption.weight(.semibold))
                Text(confirm.result ?? "That didn't work.")
            }
            .font(.footnote)
            .foregroundStyle(.red)
            .frame(maxWidth: .infinity, alignment: .leading)
        } else {
            HStack(spacing: 6) {
                Image(systemName: confirm.status == "done" ? "checkmark" : "xmark").font(.caption.weight(.semibold))
                Text(confirm.status == "done" ? "Done" : "Not done").fontWeight(.medium)
                Text(confirm.question).lineLimit(1).truncationMode(.tail)
            }
            .font(.footnote)
            .foregroundStyle(.secondary)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private func answer(_ yes: Bool) {
        pressed = yes
        Task {
            await AssistantModel.shared.answer(confirm: confirm.id, yes: yes)
            pressed = nil
        }
    }
}

/// A message that has not gone yet, at the end of the feed: dimmed, each video with how far it has
/// gone up, and "Queued" while it waits its turn, or "Not sent" with the reason. The cross takes it
/// back into the message box.
struct AssistantQueuedBubble: View {
    let message: QueuedMessage
    /// On its way right now: drawn like a sent message.
    let inFlight: Bool
    /// How far each video going up right now has got, by its id.
    let progress: [String: Double]
    let onRemove: () -> Void
    let onRetry: () -> Void

    var body: some View {
        VStack(alignment: .trailing, spacing: 2) {
            VStack(alignment: .trailing, spacing: 6) {
                if !message.images.isEmpty {
                    Label(message.images.count == 1 ? "1 picture" : "\(message.images.count) pictures", systemImage: "photo")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .padding(.leading, 48)
                }
                ForEach(message.files) { AssistantVideoChip(name: $0.name) }
                ForEach(message.videos ?? []) { AssistantVideoChip(name: $0.name, up: progress[$0.id] ?? 0) }
                if !message.text.isEmpty { UserBubble(text: message.text) }
            }
            .opacity(inFlight ? 1 : 0.6)
            if !inFlight {
                HStack(spacing: 10) {
                    if let failed = message.failed {
                        Text("Not sent: \(failed)")
                            .foregroundStyle(.red)
                            .lineLimit(2)
                            .multilineTextAlignment(.trailing)
                        Button("Try again", action: onRetry).fontWeight(.semibold)
                    } else {
                        Text("Queued").foregroundStyle(.secondary)
                    }
                    Button(action: onRemove) {
                        Image(systemName: "xmark.circle.fill")
                            .font(.system(size: 18))
                            .foregroundStyle(.secondary)
                            .frame(width: 36, height: 44)
                            .contentShape(Rectangle())
                    }
                    .accessibilityLabel("Take back")
                }
                .font(.caption)
                .buttonStyle(.plain)
                .padding(.leading, 48)
            }
        }
        .frame(maxWidth: .infinity, alignment: .trailing)
    }
}

/// How far a video has gone up, as a small ring.
struct UploadRing: View {
    let up: Double

    var body: some View {
        Circle()
            .trim(from: 0, to: max(0.03, up))
            .stroke(Color("AccentColor"), style: StrokeStyle(lineWidth: 2.5, lineCap: .round))
            .rotationEffect(.degrees(-90))
            .background(Circle().stroke(Color(.systemGray4), lineWidth: 2.5))
            .frame(width: 14, height: 14)
    }
}

/// A video of his message: up already, or how far it has gone up (`known` false: going up from somewhere else).
struct AssistantVideoChip: View {
    let name: String
    var up: Double?
    var known = true

    var body: some View {
        HStack(spacing: 6) {
            if let up {
                UploadRing(up: up)
            } else {
                Image(systemName: "film")
            }
            Text(name).lineLimit(1)
            if let up, known {
                Text("\(Int(up * 100)) %").monospacedDigit().foregroundStyle(.secondary)
            }
        }
        .font(.footnote)
        .padding(.horizontal, 10)
        .frame(height: 30)
        .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 9))
        .padding(.leading, 48)
        .accessibilityElement(children: .combine)
    }
}
