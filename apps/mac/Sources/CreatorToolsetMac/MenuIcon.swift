// The menu bar item: a dark pill as tall as the menu bar's icons with the Creator Toolset mark (the logo's one-stroke C and T, ToolsetLogo in
// apps/captions) and a status dot. Drawn in code and in colour, not as a template, so the dark pill with its light
// rim reads on light and dark menu bars alike and stands apart from the monochrome icons around it. A count between the
// mark and the dot: the things waiting for you (the panel's For you).
import AppKit

func menuBarImage(_ status: MenuStatus, waiting: Int = 0) -> NSImage {
    let count = waiting > 0 ? NSAttributedString(string: "\(waiting)", attributes: [
        .font: NSFont.monospacedDigitSystemFont(ofSize: 12, weight: .semibold), .foregroundColor: NSColor.white,
    ]) : nil
    let extra = count.map { ceil($0.size().width) + 4 } ?? 0
    let image = NSImage(size: NSSize(width: 43 + extra, height: 22), flipped: true) { rect in
        let pill = NSBezierPath(roundedRect: rect.insetBy(dx: 0.5, dy: 0.5), xRadius: 10.5, yRadius: 10.5)
        NSColor(srgbRed: 0.09, green: 0.08, blue: 0.14, alpha: 1).setFill()
        pill.fill()
        NSColor(white: 1, alpha: 0.3).setStroke()
        pill.lineWidth = 1
        pill.stroke()

        // The mark in the logo's 1024 box (translated -28 like the logo): the C is an arc around (412, 520), radius
        // 235, 130 wide, from the top round the left to the lower right; the T is a 500×130 bar and a 128×600 stem.
        // Its box (112…910 × 220…820) is scaled to 14 pt high and set at the pill's left.
        let s: CGFloat = 14 / 600
        func p(_ x: CGFloat, _ y: CGFloat) -> NSPoint { NSPoint(x: 8 + (x - 112) * s, y: 4 + (y - 220) * s) }
        NSColor.white.set()
        let c = NSBezierPath()
        for i in 0...48 {
            let a = (-90 - 226.4 * Double(i) / 48) * .pi / 180
            let point = p(412 + 235 * cos(a), 520 + 235 * sin(a))
            if i == 0 { c.move(to: point) } else { c.line(to: point) }
        }
        c.lineWidth = 130 * s
        c.stroke()
        NSBezierPath(rect: NSRect(origin: p(410, 220), size: NSSize(width: 500 * s, height: 130 * s))).fill()
        NSBezierPath(rect: NSRect(origin: p(662, 220), size: NSSize(width: 128 * s, height: 600 * s))).fill()

        if let count { count.draw(at: NSPoint(x: 30, y: (rect.height - count.size().height) / 2)) }

        // The status: a filled dot (green up, violet running a job, amber a problem), a hollow ring when idle.
        let dot = NSBezierPath(ovalIn: NSRect(x: rect.maxX - 13, y: rect.midY - 3.5, width: 7, height: 7))
        switch status {
        case .idle:
            NSColor(white: 1, alpha: 0.5).setStroke()
            dot.lineWidth = 1.2
            dot.stroke()
        case .up: NSColor(srgbRed: 0.20, green: 0.83, blue: 0.60, alpha: 1).setFill(); dot.fill()
        case .busy: NSColor(srgbRed: 0.65, green: 0.55, blue: 0.98, alpha: 1).setFill(); dot.fill()
        case .problem: NSColor(srgbRed: 0.96, green: 0.62, blue: 0.04, alpha: 1).setFill(); dot.fill()
        }
        return true
    }
    image.isTemplate = false
    return image
}

/// The words VoiceOver reads for the item.
func menuStatusLabel(_ status: MenuStatus, waiting: Int = 0) -> String {
    let base: String
    switch status {
    case .idle: base = "Creator Toolset"
    case .up: base = "Creator Toolset, running"
    case .busy: base = "Creator Toolset, running an AI job"
    case .problem: base = "Creator Toolset, needs a look"
    }
    return waiting > 0 ? "\(base), \(waiting) waiting for you" : base
}
