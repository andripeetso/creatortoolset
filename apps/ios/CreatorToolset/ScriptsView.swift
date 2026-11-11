import SwiftUI
import UIKit

/// Scripts to film: the sessions that are ready or in production, newest first.
struct ScriptsView: View {
    @StateObject private var model = WorkshopModel()

    var body: some View {
        List {
            if let error = model.error { Problem(text: error) }
            ForEach(model.sessions.filter(\.toFilm)) { session in
                NavigationLink(value: session) { SessionRow(session: session) }
            }
        }
        .overlay {
            if model.loading {
                ProgressView()
            } else if !model.sessions.contains(where: \.toFilm) && model.error == nil {
                ContentUnavailableView("Nothing to film", systemImage: "doc.text")
            }
        }
        .navigationTitle("To film")
        .task { await model.load() }
        .refreshable { await model.load() }
        .navigationDestination(for: WorkshopSession.self) { ScriptReaderView(session: $0) }
    }
}

/// One session in a list: its kind letter, title, project and status.
struct SessionRow: View {
    let session: WorkshopSession

    var body: some View {
        HStack(spacing: 12) {
            Text(session.letter)
                .font(.headline.monospaced())
                .frame(width: 36, height: 36)
                .background(Color.accentColor.opacity(0.22), in: RoundedRectangle(cornerRadius: 8))
            VStack(alignment: .leading, spacing: 2) {
                Text(session.title).font(.body.weight(.medium)).lineLimit(2)
                Text([session.projectName, session.status.label].compactMap { $0 }.joined(separator: " · "))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
        }
    }
}

/// The script, read big: hooks first (numbered), then each block. It scrolls on its own when played, the screen
/// stays awake while it is open, and the big button films with the script on screen.
struct ScriptReaderView: View {
    let session: WorkshopSession
    @AppStorage("scriptTextSize") private var textSize = 26.0
    @AppStorage("scriptSpeed") private var speed = 25.0
    @State private var docs: [WorkshopDoc]?
    @State private var error: String?
    @State private var playing = false
    @State private var recorder = false

    var body: some View {
        VStack(spacing: 0) {
            if let caption {
                DisclosureGroup("Post description") {
                    Text(caption).font(.callout).textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .padding(.horizontal)
                .padding(.vertical, 6)
            }
            if let docs {
                if docs.allSatisfy({ $0.blocks.isEmpty && ($0.hooks ?? []).isEmpty }) {
                    ContentUnavailableView("No script yet", systemImage: "doc.text")
                } else {
                    ScriptText(docs: docs, size: CGFloat(textSize), playing: playing, speed: CGFloat(speed)) {
                        playing = false
                    }
                }
            } else if let error {
                Problem(text: error).padding()
                Spacer()
            } else {
                ProgressView().frame(maxHeight: .infinity)
            }
            controls
        }
        .navigationTitle(session.title)
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
        .fullScreenCover(isPresented: $recorder) {
            PrompterRecorder(docs: docs ?? [], size: $textSize, speed: $speed)
        }
        .onAppear { UIApplication.shared.isIdleTimerDisabled = true }
        .onDisappear {
            UIApplication.shared.isIdleTimerDisabled = false
            playing = false
        }
    }

    private var caption: String? {
        docs?.compactMap { $0.caption?.text }.first.map(scriptText).flatMap { $0.isEmpty ? nil : $0 }
    }

    private var controls: some View {
        VStack(spacing: 10) {
            HStack(spacing: 18) {
                Button { textSize = max(16, textSize - 2) } label: { Text("A−").font(.body.weight(.semibold)) }
                    .accessibilityLabel("Smaller text")
                Button { textSize = min(44, textSize + 2) } label: { Text("A+").font(.title3.weight(.semibold)) }
                    .accessibilityLabel("Bigger text")
                Button { playing.toggle() } label: {
                    Image(systemName: playing ? "pause.circle.fill" : "play.circle.fill").font(.title)
                }
                .accessibilityLabel(playing ? "Pause scrolling" : "Scroll the script")
                Slider(value: $speed, in: 5...80).accessibilityLabel("Scroll speed")
            }
            .buttonStyle(.borderless)
            Button {
                playing = false
                recorder = true
            } label: {
                Label("Film with the script", systemImage: "record.circle").frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .tint(.red)
            .controlSize(.large)
            .disabled(docs?.isEmpty ?? true)
        }
        .padding()
        .background(.bar)
    }

    private func load() async {
        guard let api = Servers.shared.api else { return }
        do {
            docs = try await api.sessionDocs(session.id)
        } catch {
            self.error = error.localizedDescription
        }
    }
}

/// The script's text view: a UITextView is already a scroll view, so the slow scroll is its own offset moved at 30 Hz.
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
