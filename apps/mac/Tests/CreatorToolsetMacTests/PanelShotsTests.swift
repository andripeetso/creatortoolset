import AppKit
import SwiftUI
import XCTest
@testable import CreatorToolsetMac

/// The menu bar panel drawn with fixture rows, light and dark, to PNGs for a look by eye:
/// `PANEL_SHOTS=<folder> swift test --filter PanelShotsTests`. Skipped without PANEL_SHOTS.
@MainActor
final class PanelShotsTests: XCTestCase {
    func testPanelShots() throws {
        guard let folder = ProcessInfo.processInfo.environment["PANEL_SHOTS"] else { throw XCTSkip("PANEL_SHOTS is not set") }
        let edit = ActivityRow(id: "p:edit", title: "Morning stretch", detail: "1 job running or queued", state: .working, href: "/editor/a")
        let start = PluginAction(id: "start", title: "Start", run: "start", label: "com.example.worker")
        let stopped = ActivityRow(id: "p:worker", title: "AI Editor", detail: "Edits can't go on until it starts", state: .ready,
                                  href: "/editor", actions: [start])
        let reply = ActivityRow(id: "r:s1", title: "Hook ideas", detail: "Workshop · new reply", state: .ready, href: "/workshop/sessions/s1")

        func panel(_ active: [ActivityRow], _ forYou: [ActivityRow], recording: Bool = false, lit: Bool = false) -> some View {
            PanelBody(active: active, forYou: forYou) {
                PanelMenuRow(title: "Open Creator Toolset") {}
                PanelMenuRow(title: recording ? "Stop Recording" : "Record Screen", shortcut: "⌥⇧R", highlighted: lit) {}
                PanelMoreRow { Button("Quit") {} }
            }
        }
        let shots: [(String, AnyView)] = [
            ("empty", AnyView(panel([], []))),
            ("running", AnyView(panel([edit], [reply]))),
            ("stopped", AnyView(panel([], [stopped]))),
            ("recording", AnyView(panel([edit], [], recording: true, lit: true))),
        ]
        for (name, view) in shots {
            for dark in [false, true] {
                let appearance = NSAppearance(named: dark ? .darkAqua : .aqua)!
                let host = NSHostingView(rootView: view.background(Color(nsColor: .windowBackgroundColor))
                    .environment(\.colorScheme, dark ? .dark : .light))
                host.appearance = appearance
                let window = NSWindow(contentRect: .zero, styleMask: .borderless, backing: .buffered, defer: false)
                window.appearance = appearance
                window.contentView = host
                window.setContentSize(host.fittingSize)
                host.layoutSubtreeIfNeeded()
                let rep = try XCTUnwrap(host.bitmapImageRepForCachingDisplay(in: host.bounds))
                host.cacheDisplay(in: host.bounds, to: rep)
                let png = try XCTUnwrap(rep.representation(using: .png, properties: [:]))
                try png.write(to: URL(fileURLWithPath: folder).appendingPathComponent("\(name)-\(dark ? "dark" : "light").png"))
            }
        }
    }
}
