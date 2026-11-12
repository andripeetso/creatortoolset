// An iPhone or iPad on a cable as a recording source. macOS hands such a device to an app as a capture device that
// carries its screen and its sound together, under the camera permission, and only to an app that asks for screen
// capture devices. Toolbar → Device lists them; picking one opens a panel with its picture and Start; the recording
// is the same writer as a screen recording's (Recorder.swift, Capture), fed from a capture session, with no pointer
// log: a phone has no pointer, and its taps are not something the Mac is told.
import AppKit
import AVFoundation
import CoreMediaIO
import SwiftUI

/// The iPhones and iPads on a cable.
enum PhoneDevices {
    private static var asked = false

    /// Asks macOS to list them, once. They show up a moment later (AVCaptureDevice.wasConnectedNotification says when).
    static func allow() {
        guard !asked else { return }
        asked = true
        var property = CMIOObjectPropertyAddress(
            mSelector: CMIOObjectPropertySelector(kCMIOHardwarePropertyAllowScreenCaptureDevices),
            mScope: CMIOObjectPropertyScope(kCMIOObjectPropertyScopeGlobal),
            mElement: CMIOObjectPropertyElement(kCMIOObjectPropertyElementMain))
        var on: UInt32 = 1
        let status = CMIOObjectSetPropertyData(CMIOObjectID(kCMIOObjectSystemObject), &property, 0, nil,
                                               UInt32(MemoryLayout<UInt32>.size), &on)
        if status != noErr { AppLog.write("devices on a cable cannot be listed: \(status)") }
    }

    /// Picture and sound in one device, from outside the Mac: a camera has only picture.
    static var connected: [AVCaptureDevice] {
        AVCaptureDevice.DiscoverySession(deviceTypes: [.external], mediaType: .muxed, position: .unspecified).devices
    }

    static func device(_ id: String) -> AVCaptureDevice? { connected.first { $0.uniqueID == id } }
}

/// The capture session of one device: the panel shown before a recording runs it for its picture, and the recording
/// takes it over, so the device is opened once and is already sending when the count-in ends.
final class PhoneSession: @unchecked Sendable {
    /// startRunning blocks, so never on the caller's thread.
    private static let queue = DispatchQueue(label: "com.creatortoolset.phone.session")

    let device: AVCaptureDevice
    let session = AVCaptureSession()
    let input: AVCaptureDeviceInput

    init(device: AVCaptureDevice) throws {
        self.device = device
        input = try AVCaptureDeviceInput(device: device)
        session.beginConfiguration()
        defer { session.commitConfiguration() }
        guard session.canAddInput(input) else { throw CameraError.noInput }
        session.addInput(input)
    }

    /// The picture's port: its format is the size the device sends.
    var picturePort: AVCaptureInput.Port? { input.ports.first { $0.mediaType == .video } }

    /// The picture's size in pixels as the device sends it now (it turns with the device), even numbers for the
    /// encoder; nil until its first frame has come (measured on an iPhone: 0×0 before it runs, its first frame 2.3 s
    /// after it is started).
    var pixels: (width: Int, height: Int)? {
        guard let live = picturePort?.formatDescription else { return nil }
        let size = CMVideoFormatDescriptionGetDimensions(live)
        guard size.width > 2, size.height > 2 else { return nil }
        return (Int(size.width) / 2 * 2, Int(size.height) / 2 * 2)
    }

    /// The size once the device sends, waiting up to `seconds` for it; nil when nothing came (a locked device).
    func pixelsOnceSending(within seconds: Double) async -> (width: Int, height: Int)? {
        let until = Date().addingTimeInterval(seconds)
        while Date() < until {
            if let pixels { return pixels }
            try? await Task.sleep(for: .milliseconds(100))
        }
        return pixels
    }

    func start() {
        Self.queue.async { if !self.session.isRunning { self.session.startRunning() } }
    }

    func stop() {
        Self.queue.async { if self.session.isRunning { self.session.stopRunning() } }
    }
}

/// The panel between picking a device and recording it: its picture, live, and Start. A locked device shows nothing
/// here, which is the moment to unlock it.
@MainActor
enum PhonePreview {
    private static var panel: NSPanel?
    private static var phone: PhoneSession?
    private static var watching: [NSObjectProtocol] = []

    static var window: NSWindow? { panel }

    /// Shows the panel in the middle of `screen`, replacing any earlier one, and starts the device.
    static func show(_ phone: PhoneSession, on screen: NSScreen, onStart: @escaping () -> Void) {
        close()
        let area = screen.visibleFrame
        let view = NSHostingView(rootView: content(phone, area: area, start: onStart))
        let fitted = view.fittingSize
        let panel = EscapePanel(contentRect: NSRect(x: area.midX - fitted.width / 2, y: area.midY - fitted.height / 2,
                                                    width: fitted.width, height: fitted.height),
                                styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        panel.onEscape = { close() }
        panel.level = .floating
        panel.isFloatingPanel = true
        panel.isMovableByWindowBackground = true
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = true
        panel.hidesOnDeactivate = false
        panel.isReleasedWhenClosed = false
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        panel.contentView = view
        panel.orderFrontRegardless()
        panel.makeKey()
        self.panel = panel
        self.phone = phone
        watching = [
            // unplugged while the panel is open: nothing left to start
            NotificationCenter.default.addObserver(forName: AVCaptureDevice.wasDisconnectedNotification, object: phone.device,
                                                   queue: .main) { _ in Task { @MainActor in close() } },
            // the first frame, or the device turned: the panel takes the picture's shape, around the same middle
            NotificationCenter.default.addObserver(forName: AVCaptureInput.Port.formatDescriptionDidChangeNotification,
                                                   object: phone.picturePort, queue: .main) { _ in
                Task { @MainActor in
                    guard let panel = self.panel, let view = panel.contentView as? NSHostingView<PhonePreviewView> else { return }
                    view.rootView = content(phone, area: area, start: onStart)
                    let fitted = view.fittingSize
                    let middle = CGPoint(x: panel.frame.midX, y: panel.frame.midY)
                    panel.setFrame(NSRect(x: middle.x - fitted.width / 2, y: middle.y - fitted.height / 2,
                                          width: fitted.width, height: fitted.height), display: true)
                }
            },
        ]
        phone.start()
    }

    /// The panel's content for the device's picture as it is now: as tall as 60% of the screen allows, in the
    /// picture's shape; a phone held upright until the first frame says otherwise.
    private static func content(_ phone: PhoneSession, area: CGRect, start: @escaping () -> Void) -> PhonePreviewView {
        let size = phone.pixels ?? (1206, 2622)
        let ratio = CGFloat(size.width) / CGFloat(size.height)
        var high = min(560, area.height * 0.6)
        var wide = high * ratio
        if wide > area.width * 0.6 {
            wide = area.width * 0.6
            high = wide / ratio
        }
        return PhonePreviewView(session: phone.session, name: phone.device.localizedName,
                                picture: CGSize(width: wide, height: high), start: start)
    }

    /// Start was pressed: the panel goes and the recording gets the running session. nil when another device's
    /// panel, or none, is open.
    static func handOver(_ id: String) -> PhoneSession? {
        guard let phone, phone.device.uniqueID == id else { return nil }
        self.phone = nil
        close()
        return phone
    }

    /// Hides the panel and stops the device, unless a recording took it over.
    static func close() {
        watching.forEach(NotificationCenter.default.removeObserver)
        watching = []
        panel?.orderOut(nil)
        panel = nil
        phone?.stop()
        phone = nil
    }
}

/// A borderless panel that takes the keyboard without bringing the app forward, so Escape reaches it.
final class EscapePanel: NSPanel {
    var onEscape: (() -> Void)?

    override var canBecomeKey: Bool { true }

    override func keyDown(with event: NSEvent) {
        if event.keyCode == 53 { onEscape?() } else { super.keyDown(with: event) }
    }
}

struct PhonePreviewView: View {
    let session: AVCaptureSession
    let name: String
    let picture: CGSize
    let start: () -> Void

    var body: some View {
        VStack(spacing: 10) {
            SessionPicture(session: session)
                .frame(width: picture.width, height: picture.height)
                .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
            HStack(spacing: 12) {
                Text(name).font(.system(size: 12, weight: .medium)).lineLimit(1)
                Spacer(minLength: 0)
                Button("Start Recording", action: start)
                    .keyboardShortcut(.defaultAction)
                    .controlSize(.large)
            }
            .frame(width: max(picture.width, 300))
        }
        .padding(12)
        .background(RoundedRectangle(cornerRadius: 16, style: .continuous).fill(.ultraThinMaterial))
        .environment(\.colorScheme, .dark)
        .fixedSize()
    }
}

/// A capture session's picture, whole, on black.
private struct SessionPicture: NSViewRepresentable {
    let session: AVCaptureSession

    func makeNSView(context: Context) -> NSView {
        let view = NSView()
        let layer = AVCaptureVideoPreviewLayer(session: session)
        layer.videoGravity = .resizeAspect
        layer.backgroundColor = NSColor.black.cgColor
        view.layer = layer
        view.wantsLayer = true
        return view
    }

    func updateNSView(_ view: NSView, context: Context) {}
}
