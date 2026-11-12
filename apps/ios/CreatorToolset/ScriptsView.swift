import SwiftUI
import UIKit

/// Scripts to film: the sessions that are ready or in production, newest first.
struct ScriptsView: View {
    @ObservedObject private var model = WorkshopModel.shared

    var body: some View {
        List {
            if model.needsSignIn {
                SignInAgainButton { await model.load(force: true) }.listRowSeparator(.hidden)
            } else if let error = model.error {
                Problem(text: error)
            }
            ForEach(model.sessions.filter(\.toFilm)) { session in
                NavigationLink(value: session) { SessionRow(session: session) }
            }
        }
        .overlay {
            if model.loading && model.sessions.isEmpty {
                ProgressView()
            } else if !model.sessions.contains(where: \.toFilm) && model.error == nil && !model.needsSignIn {
                ContentUnavailableView("Nothing to film", systemImage: "doc.text")
            }
        }
        .navigationTitle("Scripts")
        .task { await model.load() }
        .refreshable { await model.load(force: true) }
        .navigationDestination(for: WorkshopSession.self) { ScriptReaderView(session: $0) }
    }
}

/// One session in a list: its kind letter, title, project and status.
struct SessionRow: View {
    let session: WorkshopSession
    var dimmed = false

    var body: some View {
        HStack(spacing: 12) {
            Text(session.letter)
                .font(.headline.monospaced())
                .frame(width: 36, height: 36)
                .background(Color("AccentColor").opacity(0.22), in: RoundedRectangle(cornerRadius: 8))
            VStack(alignment: .leading, spacing: 2) {
                Text(session.title).font(.body.weight(.medium)).lineLimit(2)
                Text([session.projectName, session.status.label].compactMap { $0 }.joined(separator: " · "))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
        }
        .opacity(dimmed ? 0.5 : 1)
    }
}

/// The script, read big: hooks first (numbered), then each block as a
/// paragraph (carousel slides numbered). Under it three controls, like a camera:
/// the slow scroll, the big record button (the camera with the script by the lens),
/// and the scroll's speed. The screen stays awake while it is open.
struct ScriptReaderView: View {
    let session: WorkshopSession
    @AppStorage("scriptTextSize") private var textSize = 26.0
    @AppStorage("scriptSpeed") private var speed = ScrollSpeed.base
    @State private var docs: [WorkshopDoc]?
    @State private var error: String?
    @State private var needsSignIn = false
    @State private var playing = false
    @State private var recorder = false
    @State private var sizing = false

    var body: some View {
        VStack(spacing: 0) {
            if let description {
                DisclosureGroup {
                    Text(description).font(.callout).textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.top, 4)
                } label: {
                    Text("Post description").font(.footnote).foregroundStyle(.secondary)
                }
                .tint(Color.secondary)
                .padding(.horizontal, 20)
                .padding(.vertical, 6)
            }
            script
            controls
        }
        .navigationTitle(session.title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar(.hidden, for: .tabBar)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button("Aa") { sizing = true }
                    .accessibilityLabel("Text size")
                    .popover(isPresented: $sizing) {
                        TextSizeControl(size: $textSize).presentationCompactAdaptation(.popover)
                    }
            }
        }
        .task {
            await load()
            // a debug build opens the text size without taps: -TextSize YES
            if debugArg("TextSize") != nil { sizing = true }
        }
        .fullScreenCover(isPresented: $recorder) {
            PrompterRecorder(docs: docs ?? [], size: $textSize, speed: $speed)
        }
        .onAppear { UIApplication.shared.isIdleTimerDisabled = true }
        .onDisappear {
            UIApplication.shared.isIdleTimerDisabled = false
            playing = false
        }
    }

    private var description: String? {
        docs?.compactMap { $0.caption?.text }.first.map(scriptText).flatMap { $0.isEmpty ? nil : $0 }
    }

    private var hasScript: Bool {
        docs?.contains { !$0.blocks.isEmpty || !($0.hooks ?? []).isEmpty } == true
    }

    @ViewBuilder private var script: some View {
        if let docs {
            if hasScript {
                ScriptText(docs: docs, size: CGFloat(textSize), playing: playing, speed: CGFloat(speed)) {
                    playing = false
                }
            } else {
                ContentUnavailableView("No script yet", systemImage: "doc.text")
            }
        } else if needsSignIn {
            SignInAgainButton { await load() }.padding().frame(maxHeight: .infinity)
        } else if let error {
            Problem(text: error).padding()
            Spacer()
        } else {
            ProgressView().frame(maxHeight: .infinity)
        }
    }

    private var controls: some View {
        HStack {
            RoundControl(label: playing ? "Pause scrolling" : "Scroll the script") { playing.toggle() } content: {
                Image(systemName: playing ? "pause.fill" : "play.fill")
            }
            Spacer()
            Button {
                playing = false
                recorder = true
            } label: {
                RecordMark(ring: .primary)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Film with the script on screen")
            .disabled(!hasScript)
            .opacity(hasScript ? 1 : 0.4)
            Spacer()
            SpeedControl(speed: $speed)
        }
        .padding(.horizontal, 40)
        .padding(.top, 12)
        .padding(.bottom, 8)
        .background(.bar)
    }

    private func load() async {
        guard let api = API.current else {
            needsSignIn = true
            return
        }
        do {
            docs = try await api.sessionDocs(session.id)
            error = nil
            needsSignIn = false
        } catch {
            needsSignIn = error.needsToolsetSignIn
            self.error = needsSignIn ? nil : error.localizedDescription
        }
    }
}

/// The slow scroll's speed as he reads it: 0.5×, 1×, 1.5×, 2×. It is kept in points per second
/// (1× is 25, as it always was), so the reader and the camera share one setting.
enum ScrollSpeed {
    static let base = 25.0
    static let steps = [0.5, 1, 1.5, 2]

    /// "1×", "1.5×".
    static func label(_ points: Double) -> String {
        let times = (points / base * 10).rounded() / 10
        return (times == times.rounded() ? String(Int(times)) : String(times)) + "×"
    }

    /// The next step up from this speed; after the fastest, the slowest again.
    static func next(after points: Double) -> Double {
        (steps.first { $0 * base > points + 0.01 } ?? steps[0]) * base
    }
}

/// A round control beside the record button, in the reader and in the camera.
struct RoundControl<Content: View>: View {
    let label: String
    let action: () -> Void
    @ViewBuilder var content: () -> Content

    var body: some View {
        Button(action: action) {
            content()
                .font(.headline)
                .frame(width: 56, height: 56)
                .background(.thinMaterial, in: Circle())
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
    }
}

/// Shows the scroll's speed; a tap moves it one step on.
struct SpeedControl: View {
    @Binding var speed: Double

    var body: some View {
        RoundControl(label: "Scroll speed, \(ScrollSpeed.label(speed))") { speed = ScrollSpeed.next(after: speed) } content: {
            Text(ScrollSpeed.label(speed)).font(.subheadline.weight(.semibold)).monospacedDigit()
        }
    }
}

/// The record button: a ring around a red disc, a red square while it records. The ring is white
/// over the camera, and the colour of the text on the script's own page (dark on a light page).
struct RecordMark: View {
    var recording = false
    var ring: Color = .white

    var body: some View {
        ZStack {
            Circle().stroke(ring, lineWidth: 4).frame(width: 78, height: 78)
            RoundedRectangle(cornerRadius: recording ? 8 : 30)
                .fill(.red)
                .frame(width: recording ? 32 : 60, height: recording ? 32 : 60)
        }
        .animation(.easeInOut(duration: 0.2), value: recording)
    }
}

/// Smaller and bigger text for the script.
struct TextSizeControl: View {
    @Binding var size: Double

    var body: some View {
        HStack(spacing: 0) {
            Button { size = max(16, size - 2) } label: {
                Text("A").font(.system(size: 15, weight: .semibold)).frame(width: 64, height: 48).contentShape(Rectangle())
            }
            .accessibilityLabel("Smaller text")
            Divider().frame(height: 24)
            Button { size = min(44, size + 2) } label: {
                Text("A").font(.system(size: 24, weight: .semibold)).frame(width: 64, height: 48).contentShape(Rectangle())
            }
            .accessibilityLabel("Bigger text")
        }
        .buttonStyle(.plain)
        .padding(.horizontal, 4)
    }
}

/// The script's text view: a UITextView is already a scroll view, so the
/// slow scroll is its own offset moved at 30 Hz.
struct ScriptText: UIViewRepresentable {
    let docs: [WorkshopDoc]
    let size: CGFloat
    let playing: Bool
    let speed: CGFloat
    /// over the camera (PrompterRecorder): white text with a shadow
    var onCamera = false
    let onEnd: () -> Void

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> UITextView {
        let view = UITextView()
        view.isEditable = false
        view.backgroundColor = .clear
        view.textContainerInset = UIEdgeInsets(top: 12, left: 20, bottom: 40, right: 20)
        view.alwaysBounceVertical = true
        return view
    }

    func updateUIView(_ view: UITextView, context: Context) {
        let coordinator = context.coordinator
        coordinator.speed = speed
        coordinator.onEnd = onEnd
        if coordinator.size != size || coordinator.docCount != docs.count {
            coordinator.size = size
            coordinator.docCount = docs.count
            view.attributedText = Self.render(docs, size: size, onCamera: onCamera)
        }
        if playing, coordinator.timer == nil {
            coordinator.timer = Timer.scheduledTimer(withTimeInterval: 1.0 / 30, repeats: true) { [weak coordinator, weak view] _ in
                guard let coordinator, let view else { return }
                coordinator.step(view)
            }
        } else if !playing {
            coordinator.timer?.invalidate()
            coordinator.timer = nil
        }
    }

    static func dismantleUIView(_ view: UITextView, coordinator: Coordinator) {
        coordinator.timer?.invalidate()
        coordinator.timer = nil
    }

    /// Hooks first (numbered), then each block; a carousel's blocks are numbered slides.
    static func render(_ docs: [WorkshopDoc], size: CGFloat, onCamera: Bool = false) -> NSAttributedString {
        let text = NSMutableAttributedString()
        let paragraph = NSMutableParagraphStyle()
        paragraph.lineSpacing = size * 0.15
        paragraph.paragraphSpacing = size * 0.9
        let shadow = NSShadow()
        shadow.shadowColor = UIColor.black.withAlphaComponent(0.8)
        shadow.shadowBlurRadius = 4
        func add(_ line: String, _ font: UIFont, _ color: UIColor = .label) {
            var attributes: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: color, .paragraphStyle: paragraph]
            if onCamera {
                attributes[.foregroundColor] = color == .label ? UIColor.white : UIColor.white.withAlphaComponent(0.7)
                attributes[.shadow] = shadow
            }
            text.append(NSAttributedString(string: line + "\n", attributes: attributes))
        }
        let body = UIFont.systemFont(ofSize: size)
        let heading = UIFont.systemFont(ofSize: size * 0.7, weight: .semibold)
        for doc in docs {
            if docs.count > 1 { add(doc.title, heading, .secondaryLabel) }
            let hooks = (doc.hooks ?? []).map { scriptText($0.text) }.filter { !$0.isEmpty }
            if !hooks.isEmpty {
                add("Hooks", heading, .secondaryLabel)
                for (i, hook) in hooks.enumerated() { add("\(i + 1). \(hook)", body) }
            }
            let blocks = doc.blocks.map { scriptText($0.text) }.filter { !$0.isEmpty }
            for (i, block) in blocks.enumerated() {
                add(doc.kind == "carousel" ? "\(i + 1). \(block)" : block, body)
            }
        }
        return text
    }

    final class Coordinator {
        var size: CGFloat = 0
        var docCount = -1
        var speed: CGFloat = 25
        var onEnd: () -> Void = {}
        var timer: Timer?

        /// One tick: the offset moves by the speed (points per second) over the frame.
        func step(_ view: UITextView) {
            let bottom = max(0, view.contentSize.height - view.bounds.height + view.adjustedContentInset.bottom)
            let y = view.contentOffset.y + speed / 30
            if y >= bottom {
                view.setContentOffset(CGPoint(x: 0, y: bottom), animated: false)
                timer?.invalidate()
                timer = nil
                onEnd()
            } else {
                view.setContentOffset(CGPoint(x: 0, y: y), animated: false)
            }
        }
    }
}

/// A session opened by its id (a card in a chat, a link): its script.
struct SessionRouteView: View {
    let id: String
    @ObservedObject private var model = WorkshopModel.shared

    var body: some View {
        if let session = model.sessions.first(where: { $0.id == id }) {
            ScriptReaderView(session: session)
        } else if model.needsSignIn {
            SignInAgainButton { await model.load(force: true) }.padding()
        } else if let error = model.error {
            Problem(text: error).padding()
        } else {
            ProgressView().task { await model.load(force: true) }
        }
    }
}
