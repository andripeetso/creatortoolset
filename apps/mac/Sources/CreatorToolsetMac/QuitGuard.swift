import AppKit
import SwiftUI

/// ⌘Q alone does not quit: the first press shows "Hold ⌘Q or press twice to quit", and the app quits when ⌘Q is held
/// or pressed again while that shows. Quit in a menu, the Dock or a logout still quits at once.
@MainActor
final class QuitGuard {
    static let shared = QuitGuard()

    /// How long the message stays up, and so how long a second press counts.
    nonisolated static let window: TimeInterval = 1.5
    /// How long ⌘Q must stay down to quit.
    nonisolated static let hold: TimeInterval = 0.8

    private var warnedAt: Date?
    private var held = false
    private var keyCode: UInt16 = 0
    private var panel: NSPanel?

    func install() {
        NSEvent.addLocalMonitorForEvents(matching: [.keyDown, .keyUp, .flagsChanged]) { [weak self] event in
            guard let self else { return event }
            switch event.type {
            case .keyDown:
                guard isQuitKey(flags: event.modifierFlags, characters: event.charactersIgnoringModifiers) else { return event }
                self.press(event)
                return nil
            case .keyUp where event.keyCode == self.keyCode:
                self.held = false
            case .flagsChanged where !event.modifierFlags.contains(.command):
                self.held = false
            default: break
            }
            return event
        }
    }

    private func press(_ event: NSEvent) {
        switch quitPress(warnedAt: warnedAt, now: Date(), isRepeat: event.isARepeat) {
        case .ignore: return
        case .quit: NSApp.terminate(nil)
        case .warn:
            let at = Date()
            warnedAt = at
            held = true
            keyCode = event.keyCode
            show()
            DispatchQueue.main.asyncAfter(deadline: .now() + Self.hold) { [weak self] in
                guard let self, self.warnedAt == at, self.held, NSApp.isActive else { return }
                NSApp.terminate(nil)
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + Self.window) { [weak self] in
                guard let self, self.warnedAt == at else { return }
                self.warnedAt = nil
                self.hide()
            }
        }
    }

    private func show() {
        let panel = self.panel ?? makePanel()
        self.panel = panel
        let area = NSApp.keyWindow?.frame ?? NSScreen.main?.visibleFrame ?? .zero
        let size = panel.contentView?.fittingSize ?? .zero
        panel.setFrame(NSRect(x: area.midX - size.width / 2, y: area.midY - size.height / 2,
                              width: size.width, height: size.height), display: true)
        panel.alphaValue = 1
        panel.orderFrontRegardless()
    }

    private func hide() {
        guard let panel else { return }
        NSAnimationContext.runAnimationGroup({ $0.duration = 0.2; panel.animator().alphaValue = 0 }) {
            MainActor.assumeIsolated { if self.warnedAt == nil { panel.orderOut(nil) } }
        }
    }

    private func makePanel() -> NSPanel {
        let panel = NSPanel(contentRect: .zero, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = false
        panel.ignoresMouseEvents = true
        panel.level = .floating
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        panel.contentView = NSHostingView(rootView:
            Text("Hold ⌘Q or press twice to quit")
                .font(.system(size: 26, weight: .semibold))
                .foregroundStyle(.white)
                .padding(.horizontal, 40)
                .padding(.vertical, 24)
                .background(Capsule().fill(Color(white: 0.17)))
                .shadow(color: .black.opacity(0.25), radius: 16, y: 6)
                .padding(24)   // room for the shadow
        )
        return panel
    }
}

/// The one key press the guard holds back: ⌘Q with no other modifier. Every other key goes on as before.
func isQuitKey(flags: NSEvent.ModifierFlags, characters: String?) -> Bool {
    flags.intersection([.command, .shift, .option, .control, .function]) == .command && characters?.lowercased() == "q"
}

enum QuitPress: Equatable { case warn, quit, ignore }

/// What one ⌘Q press does. A held key's repeats do nothing here (the hold timer quits); a fresh press while the
/// message from the last one still shows quits.
func quitPress(warnedAt: Date?, now: Date, isRepeat: Bool) -> QuitPress {
    if isRepeat { return .ignore }
    if let warnedAt, now.timeIntervalSince(warnedAt) < QuitGuard.window { return .quit }
    return .warn
}
