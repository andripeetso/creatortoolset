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
            try draw(SetupPageView(facts: facts) { _ in }.background(Color(nsColor: .windowBackgroundColor)), name, folder)
        }
        // the page offered by itself: a sheet on the main window, with Not now (drawn here, not AppKit's own sheet)
        var offered = fresh
        offered.progress = nil
        let sheet = SetupOfferView(facts: offered, act: { _ in }, notNow: {})
            .background(Color(nsColor: .windowBackgroundColor))
            .clipShape(RoundedRectangle(cornerRadius: 10))
            .shadow(color: .black.opacity(0.3), radius: 20, y: 8)
        let onWindow = ZStack(alignment: .top) {
            Color(nsColor: .underPageBackgroundColor)
            sheet.padding(.top, 28)
        }
        .frame(width: 900, height: 700)
        try draw(onWindow, "offer", folder)
    }

    private func draw(_ content: some View, _ name: String, _ folder: String) throws {
        for dark in [false, true] {
            let appearance = NSAppearance(named: dark ? .darkAqua : .aqua)!
            let view = content.environment(\.colorScheme, dark ? .dark : .light)
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
