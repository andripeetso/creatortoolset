import AppKit
import SwiftUI
import XCTest
@testable import CreatorToolsetMac

/// The dictation setup guide's steps drawn to PNGs, light and dark, for a look by eye:
/// `GUIDE_SHOTS=<folder> swift test --filter SetupGuideShotsTests`. Skipped without GUIDE_SHOTS.
@MainActor
final class SetupGuideShotsTests: XCTestCase {
    func testGuideShots() throws {
        guard let folder = ProcessInfo.processInfo.environment["GUIDE_SHOTS"] else { throw XCTSkip("GUIDE_SHOTS is not set") }
        let base = GuideFacts(talkKey: "Hold fn", talkHint: "Hold fn to talk", modelName: "Whisper Large v3 Turbo", modelSize: "1.6 GB")
        var halfway = base
        halfway.microphone = true
        var downloading = halfway
        downloading.progress = 0.42
        var offered = downloading
        offered.serverOffered = true
        var server = offered
        server.engine = .server
        var picking = base
        picking.picking = true
        let shots: [(String, Int, GuideFacts)] = [
            ("1-talk-key", 0, base), ("1-talk-key-picking", 0, picking),
            ("2-allow", 1, halfway), ("3-engine", 2, downloading), ("3-engine-choice", 2, offered),
            ("3-engine-server", 2, server), ("4-try", 3, halfway),
        ]
        for (name, step, facts) in shots {
            for dark in [false, true] {
                let appearance = NSAppearance(named: dark ? .darkAqua : .aqua)!
                let view = SetupGuideView(step: .constant(step), facts: facts) { _ in }
                    .background(Color(nsColor: .windowBackgroundColor))
                    .environment(\.colorScheme, dark ? .dark : .light)
                let host = NSHostingView(rootView: view)
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
