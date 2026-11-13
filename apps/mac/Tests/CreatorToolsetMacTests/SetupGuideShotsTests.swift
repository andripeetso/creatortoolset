import AppKit
import SwiftUI
import XCTest
@testable import CreatorToolsetMac

/// The dictation setup page drawn to PNGs, light and dark, for a look by eye:
/// `GUIDE_SHOTS=<folder> swift test --filter SetupGuideShotsTests`. Skipped without GUIDE_SHOTS.
@MainActor
final class SetupGuideShotsTests: XCTestCase {
    func testSetupPageShots() throws {
        guard let folder = ProcessInfo.processInfo.environment["GUIDE_SHOTS"] else { throw XCTSkip("GUIDE_SHOTS is not set") }
        let fresh = SetupFacts(talkKey: "F13", line: SetupFacts.line(for: .key(.function(105, "F13"))), languages: ["en"],
                               speech: "This Mac · Whisper Large v3 Turbo", modelSize: "1.6 GB", progress: 0.42)
        var halfway = fresh
        halfway.microphone = true
        halfway.languages = ["en", "et"]
        var done = halfway
        done.accessibility = true
        done.progress = nil
        done.modelHere = true
        var server = done
        server.speech = "Your server"
        server.leavesMac = true
        var hold = fresh
        hold.talkKey = "Hold fn"
        hold.line = SetupFacts.line(for: .hold(.fn))
        hold.microphoneDenied = true
        hold.progress = nil
        let shots: [(String, SetupFacts)] = [("fresh", fresh), ("halfway", halfway), ("ready", done), ("server", server), ("hold", hold)]
        for (name, facts) in shots {
            for dark in [false, true] {
                let appearance = NSAppearance(named: dark ? .darkAqua : .aqua)!
                let view = SetupPageView(facts: facts) { _ in }
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
