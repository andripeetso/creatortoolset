// The source picker for Record: after the toolbar's Display, Window or Area, one borderless overlay per screen lets the
// user choose what to capture. The screen under the pointer is the active one. Escape cancels; Return or the
// "Start recording" button starts. Window titles are never read or stored: only the app name and icon are shown.
import AppKit
import ScreenCaptureKit

/// Pure geometry and window choice for the picker. Tested in SourcePickerTests.
enum PickerGeometry {
    /// Smallest area side, in points, that can be recorded.
    static let minimumAreaSide: CGFloat = 16

    /// A screen frame in AppKit global coordinates (origin bottom left of the main display) as top-left global points.
    static func topLeftFrame(_ appKitFrame: CGRect, mainHeight: CGFloat) -> CGRect {
        CGRect(x: appKitFrame.minX, y: mainHeight - appKitFrame.maxY, width: appKitFrame.width, height: appKitFrame.height)
    }

    /// The rect spanned by two corners, whichever way the drag went.
    static func normalised(_ a: CGPoint, _ b: CGPoint) -> CGRect {
        CGRect(x: min(a.x, b.x), y: min(a.y, b.y), width: abs(a.x - b.x), height: abs(a.y - b.y))
    }

    /// Moves `rect` inside `bounds`, shrinks it if it is larger, and rounds its size down to whole pixels at `scale`
    /// that are even in both directions.
    static func clamped(_ rect: CGRect, to bounds: CGRect, scale: CGFloat) -> CGRect {
        let width = min(rect.width, bounds.width)
        let height = min(rect.height, bounds.height)
        let x = min(max(rect.minX, bounds.minX), bounds.maxX - width)
        let y = min(max(rect.minY, bounds.minY), bounds.maxY - height)
        let s = max(scale, 1)
        // ponytail: 1e-6 absorbs float noise before flooring; no other rounding rules needed
        func even(_ points: CGFloat) -> CGFloat {
            let pixels = ((points * s) + 1e-6).rounded(.down)
            return (pixels - pixels.truncatingRemainder(dividingBy: 2)) / s
        }
        return CGRect(x: x, y: y, width: even(width), height: even(height))
    }

    /// Flips a rect between top-left and bottom-left origin inside a view `height` tall. Applying it twice gives the input.
    static func flipped(_ rect: CGRect, height: CGFloat) -> CGRect {
        CGRect(x: rect.minX, y: height - rect.maxY, width: rect.width, height: rect.height)
    }

    /// A global top-left frame as a rect in a screen view's coordinates (bottom-left origin).
    static func viewRect(_ global: CGRect, screenTopLeft: CGRect) -> CGRect {
        let local = CGRect(x: global.minX - screenTopLeft.minX, y: global.minY - screenTopLeft.minY,
                           width: global.width, height: global.height)
        return flipped(local, height: screenTopLeft.height)
    }

    /// Which windows the picker offers: normal layer, another app's, not tiny. Unknown owners are left out.
    static func isPickable(layer: Int, ownerBundleID: String?, ownBundleID: String?, frame: CGRect) -> Bool {
        if layer != 0 || frame.width < 100 || frame.height < 100 { return false }
        guard let owner = ownerBundleID, owner != ownBundleID else { return false }
        return true
    }

    /// The frontmost window containing `point`. `windows` is ordered front to back.
    static func frontmost(at point: CGPoint, in windows: [PickableWindow]) -> PickableWindow? {
        windows.first { $0.frame.contains(point) }
    }

    /// "W x H" in pixels for a size in points.
    static func pixelText(_ size: CGSize, scale: CGFloat) -> String {
        "\(Int((size.width * scale).rounded())) x \(Int((size.height * scale).rounded()))"
    }

    static func isUsable(_ rect: CGRect) -> Bool {
        rect.width >= minimumAreaSide && rect.height >= minimumAreaSide
    }

    /// Resizes `rect` by dragging one handle to `p`. The edges opposite the handle stay put.
    static func resized(_ rect: CGRect, handle: ResizeHandle, to p: CGPoint) -> CGRect {
        var left = rect.minX, right = rect.maxX, bottom = rect.minY, top = rect.maxY
        if handle.west { left = p.x }
        if handle.east { right = p.x }
        if handle.north { top = p.y }
        if handle.south { bottom = p.y }
        return normalised(CGPoint(x: left, y: bottom), CGPoint(x: right, y: top))
    }

    /// The handle under `p`, if any, within `reach` points.
    static func handle(at p: CGPoint, in rect: CGRect, reach: CGFloat = 10) -> ResizeHandle? {
        ResizeHandle.allCases.first { h in
            let c = h.point(in: rect)
            return hypot(c.x - p.x, c.y - p.y) <= reach
        }
    }
}

/// The eight handles of an area selection. North is the top edge in bottom-left coordinates (maxY), as drawn.
enum ResizeHandle: CaseIterable {
    case nw, n, ne, e, se, s, sw, w

    var west: Bool { self == .nw || self == .w || self == .sw }
    var east: Bool { self == .ne || self == .e || self == .se }
    var north: Bool { self == .nw || self == .n || self == .ne }
    var south: Bool { self == .sw || self == .s || self == .se }

    func point(in r: CGRect) -> CGPoint {
        CGPoint(x: west ? r.minX : (east ? r.maxX : r.midX), y: south ? r.minY : (north ? r.maxY : r.midY))
    }
}

/// A window the picker can offer. Only the app name and icon are kept; titles are never read.
struct PickableWindow {
    let id: CGWindowID
    let frame: CGRect          // global, top-left origin, points
    let appName: String
    var icon: NSImage? = nil
}

/// Chooses a display, window or area to record. Dismissal with `close()` is silent: no callback fires.
@MainActor
enum SourcePicker {
    fileprivate static var session: PickerSession?

    /// The overlay windows, so the capture can leave them out of the picture.
    static var windows: [NSWindow] { session?.overlays ?? [] }

    static func pick(_ kind: SourceKind, onStart: @escaping (RecordSource) -> Void, onCancel: @escaping () -> Void) {
        close()
        let s = PickerSession(kind: kind, onStart: onStart, onCancel: onCancel)
        session = s
        s.open()
    }

    static func close() {
        session?.dismiss()
        session = nil
    }
}

@MainActor
private final class PickerSession {
    let kind: SourceKind
    private let onStart: (RecordSource) -> Void
    private let onCancel: () -> Void
    private(set) var overlays: [NSWindow] = []
    fileprivate var views: [PickerView] = []
    fileprivate var candidates: [PickableWindow] = []
    fileprivate var hovered: PickableWindow?
    fileprivate var activeDisplayID: CGDirectDisplayID?
    /// Area only: the selection on the active screen, in its view coordinates (bottom-left origin).
    fileprivate var selection: CGRect?
    private var drag: AreaDrag?
    private var mainHeight: CGFloat = 0
    private var done = false

    init(kind: SourceKind, onStart: @escaping (RecordSource) -> Void, onCancel: @escaping () -> Void) {
        self.kind = kind
        self.onStart = onStart
        self.onCancel = onCancel
    }

    private enum AreaDrag {
        case new(from: CGPoint)
        case move(from: CGPoint, original: CGRect)
        case resize(ResizeHandle, original: CGRect)
    }

    static func areaKey(_ displayID: CGDirectDisplayID) -> String { "recordArea.\(displayID)" }

    func open() {
        mainHeight = CGDisplayBounds(CGMainDisplayID()).height
        for screen in NSScreen.screens {
            guard let id = screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? CGDirectDisplayID else { continue }
            let view = PickerView(session: self, screen: screen, displayID: id,
                                  topLeft: PickerGeometry.topLeftFrame(screen.frame, mainHeight: mainHeight))
            let window = PickerOverlay(contentRect: screen.frame, styleMask: .borderless, backing: .buffered,
                                       defer: false, screen: screen)
            window.contentView = view
            window.isOpaque = false
            window.backgroundColor = .clear
            window.hasShadow = false
            // Just below the toolbar's .floating level, so the toolbar stays clickable on top.
            window.level = NSWindow.Level(rawValue: NSWindow.Level.floating.rawValue - 1)
            window.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
            window.isReleasedWhenClosed = false
            window.acceptsMouseMovedEvents = true
            views.append(view)
            overlays.append(window)
        }
        refresh()
        NSApp.activate(ignoringOtherApps: true)
        overlays.forEach { $0.orderFrontRegardless() }
        if let v = activeView {
            v.window?.makeKeyAndOrderFront(nil)
            v.window?.makeFirstResponder(v)
        }
        if kind == .window { loadWindows() }
    }

    func dismiss() {
        done = true
        overlays.forEach { $0.orderOut(nil) }
        overlays = []
        views = []
    }

    private var activeView: PickerView? { views.first { $0.displayID == activeDisplayID } }

    /// Follows the pointer between screens and recomputes the hovered window.
    func refresh() {
        let mouse = NSEvent.mouseLocation
        if let under = views.first(where: { $0.screen.frame.contains(mouse) }), under.displayID != activeDisplayID {
            setActive(under)
        }
        if kind == .window {
            // the window under the pointer; over empty desktop the last one stays picked, and before any hover the
            // frontmost window (the one you were working in), so Start and Return always have a window
            hovered = PickerGeometry.frontmost(at: CGPoint(x: mouse.x, y: mainHeight - mouse.y), in: candidates)
                ?? hovered ?? candidates.first
        }
        views.forEach { $0.update() }
    }

    private func setActive(_ view: PickerView) {
        activeDisplayID = view.displayID
        drag = nil
        selection = savedSelection(view)
    }

    private func savedSelection(_ view: PickerView) -> CGRect? {
        guard let a = UserDefaults.standard.array(forKey: Self.areaKey(view.displayID)) as? [Double], a.count == 4 else { return nil }
        let r = PickerGeometry.flipped(CGRect(x: a[0], y: a[1], width: a[2], height: a[3]), height: view.bounds.height)
        return PickerGeometry.clamped(r, to: view.bounds, scale: view.scale)
    }

    func mouseDown(in view: PickerView, at p: CGPoint) {
        switch kind {
        case .display:
            break
        case .window:
            // a click on a window records it; a click on empty desktop does nothing (the picked one waits for Start)
            let mouse = NSEvent.mouseLocation
            if PickerGeometry.frontmost(at: CGPoint(x: mouse.x, y: mainHeight - mouse.y), in: candidates) != nil { startCurrent() }
        case .area:
            if view.displayID != activeDisplayID { setActive(view) }
            if let sel = selection {
                if let h = PickerGeometry.handle(at: p, in: sel) {
                    drag = .resize(h, original: sel)
                } else if sel.contains(p) {
                    drag = .move(from: p, original: sel)
                } else {
                    drag = .new(from: p)
                    selection = nil
                }
            } else {
                drag = .new(from: p)
            }
            views.forEach { $0.update() }
        }
    }

    func mouseDragged(to p: CGPoint) {
        guard let d = drag, let v = activeView else { return }
        let raw: CGRect
        switch d {
        case .new(let from):
            raw = PickerGeometry.normalised(from, p)
        case .move(let from, let original):
            raw = original.offsetBy(dx: p.x - from.x, dy: p.y - from.y)
        case .resize(let h, let original):
            raw = PickerGeometry.resized(original, handle: h, to: p)
        }
        selection = PickerGeometry.clamped(raw, to: v.bounds, scale: v.scale)
        views.forEach { $0.update() }
    }

    func mouseUp() {
        guard drag != nil else { return }
        drag = nil
        if let v = activeView, let sel = selection, PickerGeometry.isUsable(sel) {
            // Stored in display points, top-left origin, so it stays right whatever the screen layout is later.
            let r = PickerGeometry.flipped(sel, height: v.bounds.height)
            UserDefaults.standard.set([Double(r.minX), Double(r.minY), Double(r.width), Double(r.height)],
                                      forKey: Self.areaKey(v.displayID))
        }
        views.forEach { $0.update() }
    }

    /// Starts with what is picked now: the active screen, the hovered window or the area.
    func startCurrent() {
        switch kind {
        case .display:
            if let id = activeDisplayID { start(.display(id)) }
        case .window:
            refresh()
            if let w = hovered { start(.window(w.id)) }
        case .area:
            guard let v = activeView, let sel = selection, PickerGeometry.isUsable(sel) else { return }
            start(.area(v.displayID, PickerGeometry.flipped(sel, height: v.bounds.height)))
        }
    }

    func cancel() {
        guard end() else { return }
        onCancel()
    }

    private func start(_ source: RecordSource) {
        guard end() else { return }
        onStart(source)
    }

    private func end() -> Bool {
        guard !done else { return false }
        SourcePicker.close()
        return true
    }

    private func loadWindows() {
        Task { @MainActor [weak self] in
            guard let content = try? await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true),
                  let self else { return }
            let own = Bundle.main.bundleIdentifier
            var icons: [String: NSImage] = [:]
            // ScreenCaptureKit lists windows front to back.
            self.candidates = content.windows.compactMap { w -> PickableWindow? in
                let app = w.owningApplication
                guard PickerGeometry.isPickable(layer: w.windowLayer, ownerBundleID: app?.bundleIdentifier,
                                                ownBundleID: own, frame: w.frame) else { return nil }
                let bundle = app?.bundleIdentifier ?? ""
                if icons[bundle] == nil {
                    icons[bundle] = NSRunningApplication.runningApplications(withBundleIdentifier: bundle).first?.icon
                }
                return PickableWindow(id: w.windowID, frame: w.frame, appName: app?.applicationName ?? "", icon: icons[bundle])
            }
            self.refresh()
        }
    }
}

/// The overlay window must be able to become key so it receives Escape and Return.
@MainActor
private final class PickerOverlay: NSWindow {
    override var canBecomeKey: Bool { true }
}

/// One screen's overlay: draws the highlight and holds the centred card (name or app, size chip, Start button).
@MainActor
private final class PickerView: NSView {
    weak var session: PickerSession?
    let screen: NSScreen
    let displayID: CGDirectDisplayID
    /// The screen frame as global top-left points (see PickerGeometry.topLeftFrame).
    let topLeft: CGRect
    var scale: CGFloat { screen.backingScaleFactor }

    private let card = NSStackView()
    private let iconView = NSImageView()
    private let appLabel = NSTextField(labelWithString: "")
    private let nameLabel = NSTextField(labelWithString: "")
    private let chip = NSTextField(labelWithString: "")
    private let chipBox = NSStackView()
    private let button = NSButton(title: "Start recording", target: nil, action: nil)

    init(session: PickerSession, screen: NSScreen, displayID: CGDirectDisplayID, topLeft: CGRect) {
        self.session = session
        self.screen = screen
        self.displayID = displayID
        self.topLeft = topLeft
        super.init(frame: NSRect(origin: .zero, size: screen.frame.size))
        autoresizingMask = [.width, .height]
        addTrackingArea(NSTrackingArea(rect: .zero, options: [.activeAlways, .mouseMoved, .inVisibleRect],
                                       owner: self, userInfo: nil))

        card.orientation = .vertical
        card.alignment = .centerX
        card.spacing = 10
        card.autoresizingMask = []
        // a dark card under the labels: white text stays readable on any tint or wallpaper
        card.edgeInsets = NSEdgeInsets(top: 18, left: 26, bottom: 18, right: 26)
        card.wantsLayer = true
        card.layer?.cornerRadius = 14
        card.layer?.backgroundColor = NSColor.black.withAlphaComponent(0.55).cgColor

        iconView.imageScaling = .scaleProportionallyUpOrDown
        iconView.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([iconView.widthAnchor.constraint(equalToConstant: 56),
                                     iconView.heightAnchor.constraint(equalToConstant: 56)])

        nameLabel.font = .systemFont(ofSize: 24, weight: .semibold)
        nameLabel.textColor = .white
        appLabel.font = .systemFont(ofSize: 18, weight: .semibold)
        appLabel.textColor = .white

        chip.font = .monospacedDigitSystemFont(ofSize: 13, weight: .medium)
        chip.textColor = .white
        chipBox.setViews([chip], in: .center)
        chipBox.edgeInsets = NSEdgeInsets(top: 4, left: 10, bottom: 4, right: 10)
        chipBox.wantsLayer = true
        chipBox.layer?.cornerRadius = 6
        chipBox.layer?.backgroundColor = NSColor.black.withAlphaComponent(0.6).cgColor

        button.bezelStyle = .rounded
        button.bezelColor = .controlAccentColor
        button.controlSize = .large
        button.image = NSImage(systemSymbolName: "record.circle", accessibilityDescription: nil)
        button.imagePosition = .imageLeading
        button.contentTintColor = .white
        button.target = self
        button.action = #selector(startTapped)

        card.setViews([iconView, appLabel, nameLabel, chipBox, button], in: .center)
        addSubview(card)
    }

    required init?(coder: NSCoder) {
        fatalError("PickerView is built in code")
    }

    override var acceptsFirstResponder: Bool { true }

    /// Everything goes to this view except the Start button, so labels never swallow clicks.
    override func hitTest(_ point: NSPoint) -> NSView? {
        let p = convert(point, from: superview)
        if !card.isHidden, !button.isHidden, button.convert(button.bounds, to: self).contains(p) { return button }
        return self
    }

    @objc private func startTapped() {
        session?.startCurrent()
    }

    override func mouseMoved(with event: NSEvent) {
        if session?.kind == .area { NSCursor.crosshair.set() } else { NSCursor.arrow.set() }
        session?.refresh()
    }

    override func mouseDown(with event: NSEvent) {
        session?.mouseDown(in: self, at: convert(event.locationInWindow, from: nil))
    }

    override func mouseDragged(with event: NSEvent) {
        session?.mouseDragged(to: convert(event.locationInWindow, from: nil))
    }

    override func mouseUp(with event: NSEvent) {
        session?.mouseUp()
    }

    override func keyDown(with event: NSEvent) {
        switch event.keyCode {
        case 53: session?.cancel()                 // Escape
        case 36, 76: session?.startCurrent()       // Return, keypad Enter
        default: super.keyDown(with: event)
        }
    }

    /// Redraws and places the card for the current picker state.
    func update() {
        guard let s = session else { return }
        let active = s.activeDisplayID == displayID
        nameLabel.isHidden = true
        iconView.isHidden = true
        appLabel.isHidden = true
        chipBox.isHidden = true
        button.isHidden = true
        var center: CGPoint?
        switch s.kind {
        case .display where active:
            nameLabel.stringValue = screen.localizedName
            nameLabel.isHidden = false
            setChip(PickerGeometry.pixelText(bounds.size, scale: scale))
            button.isHidden = false
            center = CGPoint(x: bounds.midX, y: bounds.midY)
        case .display:
            break
        case .window:
            if let w = s.hovered, topLeft.contains(CGPoint(x: w.frame.midX, y: w.frame.midY)) {
                iconView.image = w.icon
                iconView.isHidden = false
                appLabel.stringValue = w.appName
                appLabel.isHidden = false
                button.isHidden = false
                let r = PickerGeometry.viewRect(w.frame, screenTopLeft: topLeft)
                center = CGPoint(x: r.midX, y: r.midY)
            }
        case .area:
            if active, let sel = s.selection {
                setChip(PickerGeometry.pixelText(sel.size, scale: scale))
                button.isHidden = !PickerGeometry.isUsable(sel)
                center = CGPoint(x: sel.midX, y: sel.midY)
            }
        }
        card.isHidden = center == nil
        if let c = center {
            card.layoutSubtreeIfNeeded()
            let size = card.fittingSize
            card.frame = NSRect(x: c.x - size.width / 2, y: c.y - size.height / 2, width: size.width, height: size.height)
        }
        needsDisplay = true
    }

    private func setChip(_ text: String) {
        chip.stringValue = text
        chipBox.isHidden = false
    }

    override func draw(_ dirtyRect: NSRect) {
        guard let s = session else { return }
        let accent = NSColor.controlAccentColor
        let dim = NSColor.black.withAlphaComponent(0.45)
        switch s.kind {
        case .display:
            if s.activeDisplayID == displayID {
                accent.withAlphaComponent(0.18).setFill()
                bounds.fill()
                stroke(bounds, accent)
            } else {
                dim.setFill()
                bounds.fill()
            }
        case .window:
            let hole = s.hovered.map { PickerGeometry.viewRect($0.frame, screenTopLeft: topLeft) }
            dimmed(except: hole, dim)
            if let h = hole { stroke(h, accent) }
        case .area:
            guard s.activeDisplayID == displayID, let sel = s.selection else {
                dim.setFill()
                bounds.fill()
                return
            }
            dimmed(except: sel, dim)
            stroke(sel, accent)
            for h in ResizeHandle.allCases {
                let c = h.point(in: sel)
                let box = NSBezierPath(rect: NSRect(x: c.x - 4, y: c.y - 4, width: 8, height: 8))
                NSColor.white.setFill()
                box.fill()
                accent.setStroke()
                box.lineWidth = 1
                box.stroke()
            }
        }
    }

    private func dimmed(except hole: CGRect?, _ color: NSColor) {
        let path = NSBezierPath(rect: bounds)
        if let h = hole { path.appendRect(h) }
        path.windingRule = .evenOdd
        color.setFill()
        path.fill()
    }

    private func stroke(_ r: CGRect, _ color: NSColor) {
        let p = NSBezierPath(rect: r.insetBy(dx: 1, dy: 1))
        p.lineWidth = 2
        color.setStroke()
        p.stroke()
    }
}
