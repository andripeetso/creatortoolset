import AppKit
import AVFoundation
import SwiftUI

/// The toolbar's choices. Values live in UserDefaults, so they survive a relaunch.
@MainActor final class RecordSetup: ObservableObject {
    @AppStorage("recordSourceKind") private var kindRaw: String = SourceKind.display.rawValue
    /// "" = system default microphone, "none" = no microphone, otherwise a device's uniqueID.
    @AppStorage("recordMicID") var micID: String = ""
    /// "none" = no camera, otherwise a device's uniqueID.
    @AppStorage("recordCameraID") var cameraID: String = "none"
    /// Record Mac sound: on unless switched off (the owner, 11-13: "have it on by default"); a choice made stays.
    @AppStorage("recordSystemAudio") var systemAudio: Bool = true
    /// Mic level 0...1, fed by the meter while the toolbar is open: its own object, never this one's change. It
    /// changes 20 times a second, and what follows the choices here (the camera bubble) reopened the camera on every
    /// one of those, asking macOS for the camera each time: the camera never showed and the app hung.
    let level = MicLevelValue()

    /// Called when the microphone choice changes, so the meter can follow it.
    var onMicChange: (() -> Void)?

    private var lastMicID = ""
    private var lastSnapshot = ""
    private var observer: NSObjectProtocol?

    var kind: SourceKind {
        get { SourceKind(rawValue: kindRaw) ?? .display }
        set { kindRaw = newValue.rawValue }
    }

    init() {
        lastMicID = micID
        lastSnapshot = snapshot()
        // @AppStorage does not publish changes outside a View, so watch UserDefaults and re-send here.
        observer = NotificationCenter.default.addObserver(forName: UserDefaults.didChangeNotification, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in self?.defaultsChanged() }
        }
    }

    var micDevices: [AVCaptureDevice] {
        AVCaptureDevice.DiscoverySession(deviceTypes: [.microphone], mediaType: .audio, position: .unspecified).devices
    }

    var cameraDevices: [AVCaptureDevice] {
        AVCaptureDevice.DiscoverySession(
            deviceTypes: [.builtInWideAngleCamera, .external, .continuityCamera], mediaType: .video, position: .unspecified
        ).devices
    }

    /// nil for "none", the default input for "", and nil when a saved device is no longer connected.
    var micDevice: AVCaptureDevice? {
        switch micID {
        case "none": return nil
        case "": return AVCaptureDevice.default(for: .audio)
        default: return micDevices.first { $0.uniqueID == micID }
        }
    }

    var cameraDevice: AVCaptureDevice? {
        guard cameraID != "none" else { return nil }
        return cameraDevices.first { $0.uniqueID == cameraID }
    }

    /// The iPhones and iPads on a cable (Phone.swift), read when the Device menu opens.
    var phones: [AVCaptureDevice] { PhoneDevices.connected }

    private func snapshot() -> String { "\(kindRaw)|\(micID)|\(cameraID)|\(systemAudio)" }

    private func defaultsChanged() {
        if micID != lastMicID {
            lastMicID = micID
            onMicChange?()
        }
        let now = snapshot()
        if now != lastSnapshot {
            lastSnapshot = now
            objectWillChange.send()
        }
    }
}

/// The recorder's floating panels hold their controls in this: a press on one works the first time. A panel that does
/// not have the keyboard (the picker, the camera bubble or another app had it last) otherwise takes the first press for
/// itself and does nothing with it, so every button seemed to need two presses (the owner, 11-11: "clicking these
/// control buttons is almost completely non-responsive").
final class FirstClickHostingView<Content: View>: NSHostingView<Content> {
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
}

/// The microphone's level, 0...1, for the bar under the microphone's name.
@MainActor final class MicLevelValue: ObservableObject {
    @Published var value: Float = 0
}

/// The floating toolbar shown before a recording starts. Nothing is captured here except the mic level.
@MainActor enum RecordToolbar {
    private static var panel: ToolbarPanel?
    private static let meter = MicMeter()

    /// The toolbar's window, so the lead can leave it out of the capture.
    static var window: NSWindow? { panel }

    /// Shows the toolbar at the bottom centre of `screen`. Closing it runs `onClose` once.
    static func show(on screen: NSScreen, setup: RecordSetup, onPick: @escaping (SourceKind) -> Void,
                     onDevice: @escaping (String) -> Void,
                     onClose: @escaping () -> Void, onFolder: @escaping () -> Void, onShowFolder: @escaping () -> Void) {
        close()
        PhoneDevices.allow()   // a device on a cable is listed a moment after this
        let dismiss = { close(); onClose() }
        let view = ToolbarView(
            setup: setup,
            pick: { kind in setup.kind = kind; onPick(kind) },
            device: { id in setup.kind = .device; onDevice(id) },
            close: dismiss,
            folder: onFolder,
            showFolder: onShowFolder
        )
        let hosting = FirstClickHostingView(rootView: view)
        let size = hosting.fittingSize

        let panel = ToolbarPanel(contentRect: NSRect(origin: .zero, size: size), styleMask: [.borderless, .nonactivatingPanel],
                                 backing: .buffered, defer: false)
        panel.onEscape = dismiss
        panel.isFloatingPanel = true
        panel.level = .floating
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        panel.isMovableByWindowBackground = true
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = true
        panel.hidesOnDeactivate = false
        panel.isReleasedWhenClosed = false
        panel.contentView = hosting
        let area = screen.visibleFrame
        panel.setFrameOrigin(NSPoint(x: area.midX - size.width / 2, y: area.minY + 24))
        self.panel = panel

        setup.onMicChange = { [weak setup] in
            guard let setup else { return }
            startMeter(setup)
        }
        panel.orderFrontRegardless()
        panel.makeKey()
        startMeter(setup)
    }

    /// Hides the toolbar and stops the mic meter. Returns after the meter's capture session has stopped.
    static func close() {
        meter.stop()
        panel?.orderOut(nil)
        panel = nil
    }

    /// Starts the meter for the chosen mic, asking for permission first when it has not been decided.
    private static func startMeter(_ setup: RecordSetup) {
        meter.stop()
        setup.level.value = 0
        guard panel != nil, let device = setup.micDevice else { return }
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .authorized:
            beginMeter(device, setup)
        case .notDetermined:
            Task { @MainActor in
                guard await AVCaptureDevice.requestAccess(for: .audio), panel != nil, let device = setup.micDevice else { return }
                beginMeter(device, setup)
            }
        default:
            return
        }
    }

    private static func beginMeter(_ device: AVCaptureDevice, _ setup: RecordSetup) {
        do {
            try meter.start(device: device) { [weak setup] value in
                Task { @MainActor in setup?.level.value = value }
            }
        } catch {
            AppLog.write("mic meter did not start: \(error)")
        }
    }
}

/// Borderless panel that can take keyboard focus without activating the app, so Escape reaches it.
private final class ToolbarPanel: NSPanel {
    var onEscape: (() -> Void)?

    override var canBecomeKey: Bool { true }

    override func keyDown(with event: NSEvent) {
        if event.keyCode == 53 { onEscape?() } else { super.keyDown(with: event) }
    }
}

private struct ToolbarView: View {
    @ObservedObject var setup: RecordSetup
    let pick: (SourceKind) -> Void
    let device: (String) -> Void
    let close: () -> Void
    let folder: () -> Void
    let showFolder: () -> Void

    var body: some View {
        HStack(spacing: 8) {
            Button(action: close) {
                Image(systemName: "xmark.circle.fill").font(.system(size: 18)).foregroundStyle(.secondary)
                    .frame(width: 28, height: 40).contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .help("Close")

            divider
            ForEach(SourceKind.allCases, id: \.self) { sourceButton($0) }   // Device opens a menu, the others the picker
            divider
            cameraMenu
            micMenu
            soundButton
            gearMenu
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(RoundedRectangle(cornerRadius: 14, style: .continuous).fill(.ultraThinMaterial))
        .environment(\.colorScheme, .dark)
        .fixedSize()
    }

    private var divider: some View {
        Rectangle().fill(Color.white.opacity(0.2)).frame(width: 1, height: 36)
    }

    private func sourceButton(_ kind: SourceKind) -> some View {
        let selected = setup.kind == kind
        return Button { if kind == .device { showDevices() } else { pick(kind) } } label: {
            VStack(spacing: 3) {
                Image(systemName: symbol(kind)).font(.system(size: 16))
                Text(title(kind)).font(.system(size: 10, weight: .medium))
            }
            .frame(width: 60, height: 40)
            .background(RoundedRectangle(cornerRadius: 8, style: .continuous).fill(selected ? Color.white.opacity(0.22) : .clear))
            // the whole tile takes the press: a plain button only hits its drawn pixels, and a miss on this panel
            // (movable by its background) drags it instead
            .contentShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
        }
        .buttonStyle(.plain)
        .help(title(kind))
    }

    private var cameraMenu: some View {
        Menu {
            Button("No camera") { setup.cameraID = "none" }
            ForEach(setup.cameraDevices, id: \.uniqueID) { device in
                Button(device.localizedName) { setup.cameraID = device.uniqueID }
            }
        } label: {
            HStack(spacing: 5) {
                Image(systemName: setup.cameraDevice == nil ? "video.slash" : "video")
                Text(setup.cameraDevice?.localizedName ?? "No camera").lineLimit(1)
            }
            .frame(maxWidth: 150, alignment: .leading)
        }
        .menuStyle(.borderlessButton)
        .menuIndicator(.hidden)
        .fixedSize()
    }

    private var micMenu: some View {
        Menu {
            Button("Default (\(AVCaptureDevice.default(for: .audio)?.localizedName ?? "none"))") { setup.micID = "" }
            ForEach(setup.micDevices, id: \.uniqueID) { device in
                Button(device.localizedName) { setup.micID = device.uniqueID }
            }
            Divider()
            Button("No microphone") { setup.micID = "none" }
        } label: {
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 5) {
                    Image(systemName: setup.micDevice == nil ? "mic.slash" : "mic")
                    Text(setup.micDevice?.localizedName ?? "No microphone").lineLimit(1)
                }
                if setup.micDevice != nil {
                    LevelBar(level: setup.level).frame(width: 140)
                }
            }
            .frame(maxWidth: 160, alignment: .leading)
        }
        .menuStyle(.borderlessButton)
        .menuIndicator(.hidden)
        .fixedSize()
    }

    private var soundButton: some View {
        Button { setup.systemAudio.toggle() } label: {
            HStack(spacing: 5) {
                Image(systemName: setup.systemAudio ? "speaker.wave.2.fill" : "speaker.slash")
                Text(setup.kind == .device ? "Record device sound" : "Record Mac sound").font(.system(size: 11))
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 6)
            .background(RoundedRectangle(cornerRadius: 7, style: .continuous).fill(setup.systemAudio ? Color.accentColor : .clear))
            .contentShape(RoundedRectangle(cornerRadius: 7, style: .continuous))
        }
        .buttonStyle(.plain)
    }

    private var gearMenu: some View {
        Menu {
            Button("Recordings folder...") { folder() }
            Button("Show recordings") { showFolder() }
        } label: {
            Image(systemName: "gearshape").font(.system(size: 14))
        }
        .menuStyle(.borderlessButton)
        .menuIndicator(.hidden)
        .fixedSize()
    }

    /// Device: the iPhones and iPads on a cable, in a menu at the pointer. Picking one opens its picture with Start.
    private func showDevices() {
        let menu = NSMenu()
        menu.autoenablesItems = false
        let phones = setup.phones
        if phones.isEmpty {
            let none = NSMenuItem(title: "Connect an iPhone or iPad with a cable and unlock it", action: nil, keyEquivalent: "")
            none.isEnabled = false
            menu.addItem(none)
        }
        for phone in phones {
            let id = phone.uniqueID
            let choice = MenuChoice { device(id) }
            let item = NSMenuItem(title: phone.localizedName, action: #selector(MenuChoice.run), keyEquivalent: "")
            item.target = choice
            item.representedObject = choice   // an item does not keep its target alive
            menu.addItem(item)
        }
        menu.popUp(positioning: nil, at: NSEvent.mouseLocation, in: nil)
    }

    private func symbol(_ kind: SourceKind) -> String {
        switch kind {
        case .display: return "display"
        case .window: return "macwindow"
        case .area: return "rectangle.dashed"
        case .device: return "iphone"
        }
    }

    private func title(_ kind: SourceKind) -> String {
        switch kind {
        case .display: return "Display"
        case .window: return "Window"
        case .area: return "Area"
        case .device: return "Device"
        }
    }
}

/// What a menu item does when it is chosen.
private final class MenuChoice: NSObject {
    private let action: () -> Void
    init(_ action: @escaping () -> Void) { self.action = action }
    @objc func run() { action() }
}

private struct LevelBar: View {
    @ObservedObject var level: MicLevelValue

    var body: some View {
        GeometryReader { geo in
            ZStack(alignment: .leading) {
                Capsule().fill(Color.white.opacity(0.15))
                Capsule().fill(Color.green).frame(width: geo.size.width * CGFloat(min(1, max(0, level.value))))
            }
        }
        .frame(height: 3)
    }
}
