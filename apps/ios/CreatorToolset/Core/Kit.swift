import SwiftUI

// The pieces every chat screen is made of: the list row and its one badge, the message box,
// the bubbles, the folded steps, the card that asks for an answer. One look for the whole app.

// MARK: Time

/// "<1m", "5m", "3h", "2d": how long ago, short enough for a row's edge.
func shortAgo(_ date: Date, now: Date = Date()) -> String {
    let s = max(0, now.timeIntervalSince(date))
    if s < 60 { return "<1m" }
    if s < 3600 { return "\(Int(s / 60))m" }
    if s < 86_400 { return "\(Int(s / 3600))h" }
    return "\(Int(s / 86_400))d"
}

/// "58s", "4m 12s", "1h 03m": how long something has been running.
func runningFor(_ seconds: TimeInterval) -> String {
    let s = Int(max(0, seconds))
    if s < 60 { return "\(s)s" }
    if s < 3600 { return "\(s / 60)m \(String(format: "%02d", s % 60))s" }
    return "\(s / 3600)h \(String(format: "%02d", s / 60 % 60))m"
}

/// The server's times are milliseconds since 1970.
func date(ms: Double) -> Date { Date(timeIntervalSince1970: ms / 1000) }

// MARK: Rows

/// What a row says at its right edge: one thing, and a word only when it needs the person.
enum RowStatus: Hashable {
    /// Something waits for the person's go.
    case yourGo
    /// The assistant asks to be allowed something.
    case approval
    /// A video waits for the person's review.
    case review
    case failed
    /// Finished since they last looked.
    case done
    case working(since: Date?)
    case time(Date)
    case none

    /// Counted on the tab's badge and sorted to the top.
    var waitsOnYou: Bool {
        switch self {
        case .yourGo, .approval, .review, .failed: true
        default: false
        }
    }
}

struct RowBadge: View {
    let status: RowStatus

    var body: some View {
        switch status {
        case .yourGo: label("Your go", "arrow.right.circle", .orange)
        case .approval: label("Approval", "exclamationmark.shield", .orange)
        case .review: label("Review", "eye", .blue)
        case .failed: label("Failed", "exclamationmark.circle", .red)
        case .done: label("Done", "checkmark.circle", .green)
        case .working(let since):
            TimelineView(.periodic(from: .now, by: 1)) { context in
                label(since.map { runningFor(context.date.timeIntervalSince($0)) } ?? "Working", "circle.dashed", .cyan)
            }
        case .time(let date):
            Text(shortAgo(date)).font(.footnote.monospacedDigit()).foregroundStyle(.secondary)
        case .none:
            EmptyView()
        }
    }

    private func label(_ text: String, _ symbol: String, _ color: Color) -> some View {
        HStack(spacing: 4) {
            Image(systemName: symbol).font(.caption.weight(.semibold))
            Text(text).font(.footnote.weight(.bold)).monospacedDigit()
        }
        .foregroundStyle(color)
        .lineLimit(1)
        .fixedSize()
    }
}

/// One row of a chat list: a title, one line under it, the badge.
struct ChatListRow<Leading: View>: View {
    let title: String
    let detail: String
    var detailIsError = false
    let status: RowStatus
    /// Working and finished rows step back, so the ones that wait stand out.
    var quiet = false
    @ViewBuilder var leading: () -> Leading

    var body: some View {
        HStack(spacing: 12) {
            leading()
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(.body.weight(quiet ? .regular : .semibold))
                    .lineLimit(2)
                if !detail.isEmpty {
                    Text(detail)
                        .font(.footnote)
                        .foregroundStyle(detailIsError ? Color.red : Color.secondary)
                        .lineLimit(1)
                }
            }
            Spacer(minLength: 8)
            RowBadge(status: status)
        }
        .padding(.vertical, 4)
        .opacity(quiet ? 0.6 : 1)
        .contentShape(Rectangle())
    }
}

extension ChatListRow where Leading == EmptyView {
    init(title: String, detail: String, detailIsError: Bool = false, status: RowStatus, quiet: Bool = false) {
        self.init(title: title, detail: detail, detailIsError: detailIsError, status: status, quiet: quiet) { EmptyView() }
    }
}

/// A line that says something is off, in amber, and nothing when all is well
/// ("MacBook is asleep", "No connection").
struct QuietNotice: View {
    let text: String

    var body: some View {
        HStack(spacing: 7) {
            Circle().fill(.orange).frame(width: 7, height: 7)
            Text(text).font(.footnote).foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

// MARK: Messages

/// What the person wrote: a bubble at the right.
struct UserBubble: View {
    let text: String

    var body: some View {
        Text(text)
            .font(.callout)   // the size of the replies around it (Markdown.swift)
            .lineSpacing(3)
            .textSelection(.enabled)
            .padding(.horizontal, 14)
            .padding(.vertical, 9)
            .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 20))
            .frame(maxWidth: .infinity, alignment: .trailing)
            .padding(.leading, 48)
    }
}

/// What was done to get an answer, folded into one line ("Worked for 14s · 3 steps");
/// a tap shows the steps.
struct StepsFold: View {
    let title: String
    let steps: [String]
    @State private var open = false

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Button {
                open.toggle()
            } label: {
                HStack(spacing: 5) {
                    if !steps.isEmpty {
                        Image(systemName: "chevron.right")
                            .font(.caption2.weight(.semibold))
                            .rotationEffect(.degrees(open ? 90 : 0))
                    }
                    Text(title).font(.footnote)
                }
                .foregroundStyle(.secondary)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(steps.isEmpty)
            if open {
                ForEach(Array(steps.enumerated()), id: \.offset) { _, step in
                    Text(step)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.leading, 14)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// "Working 12s  Stop": sits above the message box while an answer is being made.
struct WorkingCapsule: View {
    var label = "Working"
    let since: Date?
    var onStop: (() -> Void)?

    var body: some View {
        HStack(spacing: 8) {
            ProgressView().controlSize(.mini)
            TimelineView(.periodic(from: .now, by: 1)) { context in
                Text(since.map { "\(label) \(runningFor(context.date.timeIntervalSince($0)))" } ?? label)
                    .font(.footnote.monospacedDigit())
            }
            if let onStop {
                Button("Stop", action: onStop)
                    .font(.footnote.weight(.semibold))
                    .buttonStyle(.plain)
            }
        }
        .padding(.horizontal, 14)
        .frame(height: 36)
        .chatSurface(cornerRadius: 18)
    }
}

/// A card that asks the person for an answer: a small heading, what it is about, its buttons.
struct AskCard<Actions: View>: View {
    let eyebrow: String
    let title: String
    var detail: String?
    @ViewBuilder var actions: () -> Actions

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(eyebrow.uppercased())
                .font(.caption2.weight(.bold))
                .kerning(0.8)
                .foregroundStyle(.orange)
            Text(title).font(.headline)
            if let detail, !detail.isEmpty {
                Text(detail).font(.subheadline).foregroundStyle(.secondary)
            }
            actions()
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 20))
    }
}

/// A full-width button of a card or a sheet: the main one filled, the others quiet.
struct WideButton: View {
    enum Kind { case main, plain, danger }

    let title: String
    var systemImage: String?
    var kind: Kind = .main
    var busy = false
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 7) {
                if busy {
                    ProgressView().controlSize(.small)
                } else if let systemImage {
                    Image(systemName: systemImage)
                }
                Text(title)
            }
            .font(.subheadline.weight(.semibold))
            .frame(maxWidth: .infinity, minHeight: 44)
            .foregroundStyle(kind == .main ? Color.white : kind == .danger ? Color.red : Color.primary)
            .background(kind == .main ? Color("AccentColor") : Color(.tertiarySystemFill), in: RoundedRectangle(cornerRadius: 12))
        }
        .buttonStyle(.plain)
        .disabled(busy)
    }
}

// MARK: The message box

/// The message box: a pill with what goes in front (attach, a time), the text, and one round
/// button that sends, or stops the answer being written while the box is empty.
struct ChatComposer<Leading: View>: View {
    @Binding var text: String
    var placeholder = "Message"
    /// An answer is being written.
    var working = false
    var sending = false
    /// Something besides text is ready to go (a picture, a file).
    var hasAttachment = false
    /// Opens with the keyboard up.
    var autofocus = false
    /// What goes with the message (pictures, files), drawn inside the box above the text.
    var attachments: AnyView?
    let onSend: () -> Void
    var onStop: (() -> Void)?
    @ViewBuilder var leading: () -> Leading
    @FocusState private var focused: Bool

    private var empty: Bool { text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !hasAttachment }
    private var stops: Bool { working && empty && onStop != nil }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if let attachments {
                attachments.padding(.top, 10).padding(.trailing, 12)
            }
            row
        }
        .padding(.leading, 14)
        .padding(.trailing, 2)
        .chatSurface(cornerRadius: 25)
        .padding(.horizontal, 12)
        .padding(.bottom, 8)
        .onAppear { if autofocus { focused = true } }
    }

    private var row: some View {
        HStack(alignment: .bottom, spacing: 6) {
            leading()
            TextField(placeholder, text: $text, axis: .vertical)
                .lineLimit(1...6)
                .focused($focused)
                .padding(.vertical, 11)
            Button {
                if stops { onStop?() } else { onSend() }
            } label: {
                Image(systemName: stops ? "stop.fill" : "arrow.up")
                    .font(.system(size: 15, weight: .bold))
                    .foregroundStyle(.white)
                    .frame(width: 32, height: 32)
                    .background(stops ? Color.red : empty ? Color(.systemGray3) : Color("AccentColor"), in: Circle())
                    .frame(width: 44, height: 44)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(sending || (empty && !stops))
            .accessibilityLabel(stops ? "Stop" : "Send")
        }
    }
}

extension ChatComposer where Leading == EmptyView {
    init(text: Binding<String>, placeholder: String = "Message", working: Bool = false, sending: Bool = false,
         hasAttachment: Bool = false, autofocus: Bool = false, onSend: @escaping () -> Void, onStop: (() -> Void)? = nil) {
        self.init(text: text, placeholder: placeholder, working: working, sending: sending, hasAttachment: hasAttachment,
                  autofocus: autofocus, onSend: onSend, onStop: onStop) { EmptyView() }
    }
}

/// A round button in front of the text in the message box (attach, a time): 44 points to tap.
struct ComposerButton: View {
    let systemImage: String
    let label: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: systemImage)
                .font(.system(size: 19, weight: .medium))
                .foregroundStyle(.secondary)
                .frame(width: 36, height: 44)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
    }
}

// MARK: Surfaces

extension View {
    /// The floating surface of the message box and the working line: glass where the iPhone has it.
    @ViewBuilder func chatSurface(cornerRadius: CGFloat) -> some View {
        if #available(iOS 26.0, *) {
            glassEffect(.regular, in: .rect(cornerRadius: cornerRadius))
        } else {
            background(.regularMaterial, in: RoundedRectangle(cornerRadius: cornerRadius))
                .overlay(RoundedRectangle(cornerRadius: cornerRadius).strokeBorder(Color(.separator).opacity(0.5)))
        }
    }
}
