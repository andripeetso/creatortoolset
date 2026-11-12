import AVKit
import SwiftUI

/// A Review video opened by its id (a row in Chats, a card in a chat, a link), on the version the link names.
struct ReviewRouteView: View {
    let id: String
    var version: Int?

    var body: some View {
        ReviewAssetView(id: id, wanted: version)
    }
}

/// One video in Review: watch a version, say Approve or Request changes, and talk about it in
/// comments pinned to moments of the video. What others write and decide shows up by itself.
struct ReviewAssetView: View {
    let id: String
    /// The version a link asked for; the newest when it names none, or one the video hasn't got.
    var wanted: Int?

    @Environment(\.scenePhase) private var scenePhase
    @State private var asset: ReviewAsset?
    @State private var comments: [ReviewComment] = []
    @State private var manage = false
    @State private var version = 0
    @State private var player: AVPlayer?
    @State private var draft = ""
    /// The next comment is pinned to the moment the player is at.
    @State private var atTime = debugArg("ReviewNoTime") == nil   // the argument: a simulator picture of "No time"
    @State private var replyTo: ReviewComment?
    /// Goes up when a reply starts: the message box takes the keyboard.
    @State private var focus = 0
    @State private var sending = false
    @State private var deciding: ReviewStatus?
    @State private var deleting: ReviewComment?
    /// The comment just written, or the one being answered: the list scrolls to it.
    @State private var scrollTarget: String?
    @State private var loadError: String?
    @State private var writeError: String?

    private var shown: ReviewAsset.Version? { asset?.versions.first { $0.n == version } }
    /// Where the player is, in seconds.
    private var now: Double {
        let seconds = player?.currentTime().seconds ?? 0
        return seconds.isFinite ? seconds : 0
    }

    var body: some View {
        Group {
            if let asset {
                content(asset)
            } else if let loadError {
                VStack(spacing: 16) {
                    Text(loadError).font(.subheadline).foregroundStyle(.secondary).multilineTextAlignment(.center)
                    Button("Try again") { Task { await load() } }
                        .buttonStyle(.bordered)
                        .controlSize(.large)
                }
                .padding(32)
            } else {
                ProgressView().controlSize(.large)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .navigationTitle(asset?.name ?? "")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if shown != nil {
                if (asset?.versions.count ?? 0) > 1 {
                    ToolbarItem(placement: .topBarTrailing) { versionMenu }
                } else if #available(iOS 26.0, *) {
                    // one version: a word, not something that looks pressable
                    ToolbarItem(placement: .topBarTrailing) { versionWord }.sharedBackgroundVisibility(.hidden)
                } else {
                    ToolbarItem(placement: .topBarTrailing) { versionWord }
                }
            }
        }
        .task { await follow() }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { Task { await load() } }
        }
        // writing starts: the video waits at the moment being written about
        .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillShowNotification)) { _ in player?.pause() }
        .onDisappear { player?.pause() }
        .confirmationDialog("Delete this comment?", isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } }),
                            titleVisibility: .visible, presenting: deleting) { comment in
            Button("Delete", role: .destructive) { Task { await delete(comment) } }
        } message: { comment in
            if comments.contains(where: { $0.parentId == comment.id }) { Text("Its replies go with it.") }
        }
    }

    // MARK: The screen

    private func content(_ asset: ReviewAsset) -> some View {
        GeometryReader { space in
            VStack(spacing: 0) {
                video(width: space.size.width, height: space.size.height)
                ScrollViewReader { scroll in
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 0) {
                            VStack(spacing: 10) {
                                decision(asset)
                                if let extras = ReviewExtras.actions { extras(asset, comments) }
                            }
                            .padding(.horizontal, 16)
                            .padding(.vertical, 12)
                            ForEach(comments.threads(version: version)) { thread in
                                Divider().padding(.leading, 16)
                                threadView(thread)
                            }
                        }
                    }
                    .scrollDismissesKeyboard(.interactively)
                    .safeAreaInset(edge: .bottom) { box }
                    .onChange(of: scrollTarget) { _, id in
                        guard let id else { return }
                        withAnimation { scroll.scrollTo(id, anchor: .top) }
                        scrollTarget = nil
                    }
                }
            }
        }
    }

    /// "V2" at the right of the bar: a menu of the versions, newest first.
    private var versionMenu: some View {
        Menu {
            Picker("Version", selection: Binding(get: { version }, set: { show($0) })) {
                ForEach((asset?.versions ?? []).reversed()) { v in Text("V\(v.n)").tag(v.n) }
            }
        } label: {
            HStack(spacing: 3) {
                Text("V\(version)")
                Image(systemName: "chevron.down").font(.caption2.weight(.bold))
            }
            .font(.subheadline.weight(.semibold))
            .frame(minWidth: 44, minHeight: 44)
        }
        .accessibilityLabel("Version \(version)")
    }

    private var versionWord: some View {
        Text("V\(version)").font(.subheadline.weight(.semibold)).foregroundStyle(.secondary)
    }

    /// The player in the version's own shape, at most 45% of the height. A version with no video
    /// to play says why in its place.
    @ViewBuilder private func video(width: CGFloat, height: CGFloat) -> some View {
        if let player, let v = shown {
            let shape = v.width > 0 && v.height > 0 ? CGFloat(v.width) / CGFloat(v.height) : 9 / 16
            NativePlayer(player: player)
                .frame(width: width, height: max(120, min(width / shape, height * 0.45)))
        } else if let v = shown {
            HStack(spacing: 8) {
                if v.removed != true && v.status == "processing" { ProgressView().controlSize(.small) }
                Text(v.removed == true ? "This version's video was deleted"
                     : v.status == "error" ? (v.error ?? "This version could not be read") : "Getting the video ready")
            }
            .font(.subheadline)
            .foregroundStyle(.secondary)
            .frame(maxWidth: .infinity, minHeight: 120)
        }
    }

    /// Approve and Request changes, side by side. The one already said shows as chosen; the other stays to press.
    private func decision(_ asset: ReviewAsset) -> some View {
        let status = ReviewStatus(rawValue: asset.approval.status)
        return HStack(spacing: 10) {
            if status == .approved {
                ChosenMark(title: ReviewStatus.approved.label, color: .green)
            } else {
                WideButton(title: "Approve", systemImage: "checkmark", busy: deciding == .approved) { Task { await decide(.approved) } }
            }
            if status == .changes {
                ChosenMark(title: ReviewStatus.changes.label, color: .orange)
            } else {
                WideButton(title: "Request changes", kind: .plain, busy: deciding == .changes) { Task { await decide(.changes) } }
            }
        }
        .disabled(deciding != nil)
    }

    /// A comment, its replies indented under it, and Reply and Resolve. A resolved thread steps back and offers Reopen.
    private func threadView(_ thread: ReviewThread) -> some View {
        let top = thread.comment
        let done = top.resolved == true
        return VStack(alignment: .leading, spacing: 0) {
            VStack(alignment: .leading, spacing: 10) {
                commentView(top, done: done)
                ForEach(thread.replies) { reply in
                    commentView(reply, done: false).padding(.leading, 20).id(reply.id)
                }
            }
            .opacity(done ? 0.5 : 1)
            HStack(spacing: 18) {
                if done {
                    if manage || top.mine == true { control("Reopen", "arrow.uturn.backward") { Task { await resolve(top) } } }
                } else {
                    control("Reply", "arrowshape.turn.up.left") { reply(to: top) }
                    if manage || top.mine == true { control("Resolve", "checkmark") { Task { await resolve(top) } } }
                }
            }
        }
        .padding(.horizontal, 16)
        .padding(.top, 12)
        .id(top.id)
    }

    /// The time chip, who wrote it, and the text. A tap on a timed comment plays the video from its moment;
    /// a long press on your own offers Delete.
    private func commentView(_ comment: ReviewComment, done: Bool) -> some View {
        let words = VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 8) {
                if let time = comment.timeLabel { TimeChip(text: time, on: true) }
                Text(comment.author).font(.footnote.weight(.semibold)).foregroundStyle(.secondary).lineLimit(1)
                if done {
                    Image(systemName: "checkmark.circle.fill").font(.footnote).foregroundStyle(.green)
                        .accessibilityLabel("Resolved")
                }
            }
            Text(comment.text.isEmpty ? "Drawing or attachment" : comment.text)
                .foregroundStyle(comment.text.isEmpty ? .secondary : .primary)
                .multilineTextAlignment(.leading)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
        return Group {
            if let t = comment.t {
                Button { play(from: t) } label: { words }.buttonStyle(.plain)
            } else {
                words
            }
        }
        .contextMenu {
            if comment.mine == true {
                Button("Delete", systemImage: "trash", role: .destructive) { deleting = comment }
            }
        }
    }

    private func control(_ title: String, _ symbol: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Label(title, systemImage: symbol)
                .font(.footnote.weight(.semibold))
                .foregroundStyle(.secondary)
                .frame(minWidth: 44, minHeight: 44)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    /// The message box: the moment the comment is pinned to in front of the text (a tap unpins it),
    /// and who is being answered above it.
    private var box: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let writeError { QuietNotice(text: writeError).padding(.horizontal, 26) }
            if let replyTo {
                HStack(spacing: 6) {
                    Image(systemName: "arrowshape.turn.up.left.fill").font(.caption)
                    Text("Replying to \(replyTo.author)").font(.footnote).lineLimit(1)
                    Button {
                        self.replyTo = nil
                    } label: {
                        Image(systemName: "xmark").font(.caption.weight(.bold)).frame(width: 44, height: 44).contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Stop replying")
                }
                .foregroundStyle(.secondary)
                .padding(.leading, 14)
                .chatSurface(cornerRadius: 22)
                .padding(.horizontal, 12)
            }
            ChatComposer(text: $draft, placeholder: "Comment", sending: sending, autofocus: focus > 0,
                         onSend: { Task { await send() } }) {
                // a reply is about its comment, not a moment; a version with nothing to play has no moments
                if replyTo == nil, player != nil {
                    Button {
                        atTime.toggle()
                    } label: {
                        TimelineView(.periodic(from: .now, by: 0.5)) { _ in
                            TimeChip(text: atTime ? clock(now) : "No time", on: atTime)
                        }
                        .frame(minWidth: 44, minHeight: 44)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(atTime ? "Comment at \(clock(now))" : "Comment with no time")
                }
            }
            .id(focus)
        }
    }

    // MARK: Reading

    /// Reads the video now, then again whenever the server says something changed, for as long as the screen is open.
    private func follow() async {
        await load()
        var opened = false
        var due = Date.distantPast
        var soon: Task<Void, Never>?
        for await event in ServerEvents.stream("/api/sync/events") where event.name == "hello" || event.name == "change" {
            // the first hello only says the line is open; a later one follows a dropped line, when a change may have been missed
            defer { opened = true }
            if event.name == "hello" && !opened { continue }
            // Review's own changes are read at once. Any other change is read too, a little later: a reply written
            // here by another part of the server is announced under that part's name.
            let wait = event.name == "hello" || event.field("topic") == "review" ? 0.4 : 2
            let at = Date().addingTimeInterval(wait)
            if due > Date(), due <= at { continue }   // a read is already on its way, no later than this one would be
            soon?.cancel()
            due = at
            soon = Task {
                try? await Task.sleep(for: .seconds(wait))
                if !Task.isCancelled { await load() }
            }
        }
        soon?.cancel()
    }

    private func load() async {
        if debugArg("ReviewHold") != nil { return }   // a simulator picture of the loading state
        guard let api = ToolsetAPI.current else {
            loadError = "Not signed in"
            return
        }
        do {
            let detail: ReviewDetail = try await api.get("/api/review/assets/\(id)")
            let first = asset == nil
            asset = detail.asset
            comments = detail.comments
            manage = detail.manage ?? false
            if first {
                version = detail.asset.opening(wanted)
            } else if !detail.asset.versions.contains(where: { $0.n == version }) {
                version = detail.asset.opening(nil)
                replyTo = nil
                player = nil
            }
            if player == nil { open() }
            loadError = nil
            if first { debugStart() }
        } catch {
            // what is on screen stays when a later read fails
            guard asset == nil else { return }
            loadError = (error as? ToolsetAPI.Failure)?.status == 404 ? "Video not found" : error.localizedDescription
        }
    }

    /// Simulator pictures of what takes a tap: `-ReviewSeek <seconds>` plays from there (as a tap on a time chip),
    /// `-ReviewReply <comment id>` starts a reply, `-ReviewSend <text>` sends that text (as the reply, or as a
    /// comment at the player's moment). Nothing in a release build.
    private func debugStart() {
        let seek = debugArg("ReviewSeek").flatMap(Double.init)
        let answered = debugArg("ReviewReply").flatMap { id in comments.first { $0.id == id } }
        let text = debugArg("ReviewSend")
        guard seek != nil || answered != nil || text != nil else { return }
        Task {
            try? await Task.sleep(for: .milliseconds(600))   // the list is on screen: it scrolls as after a tap
            if let seek {
                play(from: seek)
                try? await Task.sleep(for: .seconds(2))
            }
            if let answered { reply(to: answered) }
            if let text {
                draft = text
                await send()
            }
        }
    }

    private func show(_ n: Int) {
        guard n != version else { return }
        version = n
        replyTo = nil
        open()
    }

    /// A player for the version on screen, when it has a video to play.
    private func open() {
        player?.pause()
        guard let api = ToolsetAPI.current, let asset, let v = shown, v.status == "ready", v.removed != true else {
            player = nil
            return
        }
        player = api.player(asset.media(v, "play"))
    }

    private func play(from seconds: Double) {
        guard let player else { return }
        player.seek(to: CMTime(seconds: seconds, preferredTimescale: 600), toleranceBefore: .zero, toleranceAfter: .zero)
        player.play()
    }

    // MARK: Writing

    private func reply(to comment: ReviewComment) {
        replyTo = comment
        focus += 1
        scrollTarget = comment.id
    }

    /// One write to this video; nil (and a line above the message box) when it failed.
    private func write(_ path: String, method: String = "POST", json: Any? = nil) async -> Data? {
        guard let api = ToolsetAPI.current else { return nil }
        do {
            let data = try await api.send("/api/review/assets/\(id)\(path)", method: method, json: json)
            writeError = nil
            return data
        } catch {
            writeError = error.localizedDescription
            return nil
        }
    }

    private func send() async {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, !sending else { return }
        sending = true
        defer { sending = false }
        let body = ReviewComment.body(version: version, text: text, t: atTime && player != nil ? now : nil, parentId: replyTo?.id)
        guard let data = await write("/comments", json: body) else { return }
        draft = ""
        replyTo = nil
        UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
        // the server answers with the comment: it is shown at once
        guard let made = try? JSONDecoder().decode(ReviewComment.self, from: data) else {
            await load()
            return
        }
        if !comments.contains(where: { $0.id == made.id }) { comments.append(made) }
        scrollTarget = made.id
    }

    private func resolve(_ comment: ReviewComment) async {
        guard let data = await write("/comments/\(comment.id)", method: "PATCH", json: ["resolved": comment.resolved != true]) else { return }
        if let fresh = try? JSONDecoder().decode(ReviewComment.self, from: data),
           let index = comments.firstIndex(where: { $0.id == comment.id }) {
            comments[index] = fresh
        } else {
            await load()
        }
    }

    private func delete(_ comment: ReviewComment) async {
        guard await write("/comments/\(comment.id)", method: "DELETE") != nil else { return }
        comments.removeAll { $0.id == comment.id || $0.parentId == comment.id }
        if replyTo?.id == comment.id { replyTo = nil }
    }

    private func decide(_ status: ReviewStatus) async {
        deciding = status
        defer { deciding = nil }
        guard let data = await write("/approval", json: ["status": status.rawValue]) else { return }
        if let fresh = try? JSONDecoder().decode(ReviewAsset.self, from: data) {
            asset = fresh
        } else {
            await load()
        }
    }
}

/// A moment of the video ("0:12") as a small pill; grey when the comment is not pinned to one.
private struct TimeChip: View {
    let text: String
    let on: Bool

    var body: some View {
        Text(text)
            .font(.footnote.monospacedDigit().weight(.semibold))
            .foregroundStyle(on ? Color("AccentColor") : Color.secondary)
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .background((on ? Color("AccentColor") : Color.secondary).opacity(0.16), in: Capsule())
            .fixedSize()
    }
}

/// The decision already made, where its button was: a check and the word, not to press.
private struct ChosenMark: View {
    let title: String
    let color: Color

    var body: some View {
        Label(title, systemImage: "checkmark.circle.fill")
            .font(.subheadline.weight(.semibold))
            .lineLimit(1)
            .minimumScaleFactor(0.8)
            .foregroundStyle(color)
            .frame(maxWidth: .infinity, minHeight: 44)
            .background(color.opacity(0.16), in: RoundedRectangle(cornerRadius: 12))
            .accessibilityAddTraits(.isSelected)
    }
}
