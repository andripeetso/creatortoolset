import AppKit
import SwiftUI

// The small panel that pops up at the bottom right of the screen when a recording stops. It shows the thumbnail and
// the file's size and length; hovering it shows Save, Copy, Share and Edit. It stays until the user acts or closes it,
// and does nothing with the recording itself: the caller (Recorder) runs each action and calls close() when done.

@MainActor
final class RecordingPreviewBusy: ObservableObject {
    @Published var text: String?
}

@MainActor enum RecordingPreview {
    /// What each button does. The caller decides; the panel only reports the click.
    struct Actions {
        var edit: () -> Void
        var save: () -> Void
        var copy: () -> Void
        var share: (ShareDestination) -> Void
        var reveal: () -> Void
        var discard: () -> Void
    }

    private static var current: Controller?

    /// The panel on screen, nil when none is open.
    static var window: NSWindow? { current?.panel }

    static func show(_ project: LocalProject, on screen: NSScreen, actions: Actions) {
        close()
        let controller = Controller(project: project, actions: actions)
        let margin: CGFloat = 16
        let area = screen.visibleFrame
        let origin = NSPoint(x: area.maxX - Controller.size.width - margin, y: area.minY + margin)
        controller.panel.setFrameOrigin(origin)
        controller.panel.alphaValue = 0
        controller.panel.orderFrontRegardless()
        NSAnimationContext.runAnimationGroup { context in
            context.duration = 0.2
            controller.panel.animator().alphaValue = 1
        }
        current = controller
    }

    static func close() {
        current?.panel.orderOut(nil)
        current = nil
    }

    /// Shows `text` over the thumbnail and disables the buttons while a share or save runs; nil clears it.
    static func setBusy(_ text: String?) {
        current?.busy.text = text
    }

    @MainActor
    private final class Controller {
        static let size = NSSize(width: 340, height: 210)
        let panel: NSPanel
        let busy = RecordingPreviewBusy()

        init(project: LocalProject, actions: Actions) {
            panel = NSPanel(contentRect: NSRect(origin: .zero, size: Controller.size),
                            styleMask: [.borderless, .nonactivatingPanel, .fullSizeContentView],
                            backing: .buffered, defer: false)
            panel.isFloatingPanel = true
            panel.becomesKeyOnlyIfNeeded = true
            panel.level = .floating
            panel.backgroundColor = .clear
            panel.isOpaque = false
            panel.hasShadow = true
            panel.hidesOnDeactivate = false
            panel.isMovableByWindowBackground = true
            panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
            let view = PreviewView(project: project,
                                   thumb: NSImage(contentsOf: project.thumbURL),
                                   busy: busy,
                                   actions: actions,
                                   close: { RecordingPreview.close() })
            panel.contentView = NSHostingView(rootView: view.frame(width: Controller.size.width, height: Controller.size.height))
        }
    }
}

private struct PreviewView: View {
    let project: LocalProject
    let thumb: NSImage?
    @ObservedObject var busy: RecordingPreviewBusy
    let actions: RecordingPreview.Actions
    let close: () -> Void
    @State private var hovering = false

    var body: some View {
        ZStack {
            Group {
                if let thumb {
                    Image(nsImage: thumb).resizable().scaledToFill()
                } else {
                    Color(white: 0.12)
                }
            }
            .frame(width: 340, height: 210)
            .clipped()

            if hovering && busy.text == nil {
                Color.black.opacity(0.55)
                VStack(spacing: 10) {
                    HStack(spacing: 10) {
                        tile("Save...", "square.and.arrow.down", actions.save)
                        tile("Copy", "doc.on.doc", copy)
                    }
                    HStack(spacing: 10) {
                        Menu {
                            Button("Review") { actions.share(.review) }
                            Button("Video Notes") { actions.share(.notes) }
                            Button("Guide Builder") { actions.share(.guide) }
                        } label: {
                            tileLabel("Share", "link")
                        }
                        .menuStyle(.borderlessButton)
                        .fixedSize()
                        tile("Edit", "pencil", actions.edit)
                    }
                }
            }

            if let text = busy.text {
                Color.black.opacity(0.6)
                VStack(spacing: 10) {
                    ProgressView().controlSize(.small).tint(.white)
                    Text(text).font(.system(size: 13, weight: .medium)).foregroundStyle(.white)
                }
            }

            VStack {
                HStack {
                    Button(action: close) {
                        Image(systemName: "xmark")
                            .font(.system(size: 10, weight: .bold))
                            .foregroundStyle(.white)
                            .frame(width: 22, height: 22)
                            .background(Circle().fill(Color.black.opacity(0.5)))
                    }
                    .buttonStyle(.plain)
                    .help("Close (the recording stays)")
                    Spacer()
                }
                Spacer()
                HStack {
                    Text(infoLine)
                        .font(.system(size: 11, weight: .medium).monospacedDigit())
                        .foregroundStyle(.white.opacity(0.9))
                    Spacer()
                    Menu {
                        Button("Show in Finder", action: actions.reveal)
                        Divider()
                        Button("Throw Away", role: .destructive, action: actions.discard)
                    } label: {
                        Image(systemName: "ellipsis")
                            .foregroundStyle(.white)
                            .frame(width: 26, height: 22)
                    }
                    .menuStyle(.borderlessButton)
                    .fixedSize()
                }
                .padding(.horizontal, 10)
                .padding(.vertical, 6)
                .background(LinearGradient(colors: [.clear, .black.opacity(0.7)], startPoint: .top, endPoint: .bottom))
            }
            .padding(8)
        }
        .frame(width: 340, height: 210)
        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).stroke(Color.white.opacity(0.12)))
        .disabled(busy.text != nil)
        .onHover { hovering = $0 }
    }

    private var infoLine: String {
        let seconds = project.durationMs / 1000
        let rest = seconds % 60
        return "MP4 · \(project.width) x \(project.height) · \(seconds / 60):\(rest < 10 ? "0" : "")\(rest)"
    }

    private func copy() {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.writeObjects([project.screenURL as NSURL])
        actions.copy()
    }

    private func tile(_ title: String, _ symbol: String, _ action: @escaping () -> Void) -> some View {
        Button(action: action) { tileLabel(title, symbol) }.buttonStyle(.plain)
    }

    private func tileLabel(_ title: String, _ symbol: String) -> some View {
        VStack(spacing: 4) {
            Image(systemName: symbol).font(.system(size: 16, weight: .medium))
            Text(title).font(.system(size: 11, weight: .medium))
        }
        .foregroundStyle(.white)
        .frame(width: 96, height: 56)
        .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(Color.white.opacity(0.14)))
    }
}
