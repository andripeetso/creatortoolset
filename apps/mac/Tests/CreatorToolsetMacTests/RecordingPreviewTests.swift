import AppKit
import SwiftUI
import XCTest
@testable import CreatorToolsetMac

final class RecordingPreviewTests: XCTestCase {
    /// A picture of the panel after Stop with two workspaces, for a person to look at: CT_PROOF_DIR=<folder> swift test --filter RecordingPreview
    @MainActor
    func testWorkspacePicture() throws {
        guard let dir = ProcessInfo.processInfo.environment["CT_PROOF_DIR"].map({ URL(fileURLWithPath: $0, isDirectory: true) }) else {
            throw XCTSkip("set CT_PROOF_DIR to a folder for the picture")
        }
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        var project = try LocalProject.create(in: root, at: Date())
        project.durationMs = 83_000; project.width = 2560; project.height = 1440
        let busy = RecordingPreviewBusy()
        busy.workspaces = [RecordWorkspace(id: "a", name: "Tiny Acrobatics"), RecordWorkspace(id: "b", name: "Client work")]
        busy.chosen = "a"
        let actions = RecordingPreview.Actions(edit: {}, save: {}, copy: {}, share: { _, _ in }, reveal: {}, discard: {})
        let view = NSHostingView(rootView: PreviewView(project: project, thumb: nil, busy: busy, actions: actions, close: {}).frame(width: 340, height: 210))
        view.frame = NSRect(x: 0, y: 0, width: 340, height: 210)
        view.layoutSubtreeIfNeeded()
        let rep = try XCTUnwrap(view.bitmapImageRepForCachingDisplay(in: view.bounds))
        view.cacheDisplay(in: view.bounds, to: rep)
        try XCTUnwrap(rep.representation(using: .png, properties: [:])).write(to: dir.appendingPathComponent("preview-workspace.png"))
    }

    /// The toolbar with the workspace menu (two workspaces): CT_PROOF_DIR=<folder> swift test --filter RecordingPreview
    @MainActor
    func testToolbarWorkspacePicture() throws {
        guard let dir = ProcessInfo.processInfo.environment["CT_PROOF_DIR"].map({ URL(fileURLWithPath: $0, isDirectory: true) }) else {
            throw XCTSkip("set CT_PROOF_DIR to a folder for the picture")
        }
        let setup = RecordSetup()
        setup.workspaces = [RecordWorkspace(id: "a", name: "Tiny Acrobatics"), RecordWorkspace(id: "b", name: "Client work")]
        setup.workspace = "a"
        let view = NSHostingView(rootView: ToolbarView(setup: setup, pick: { _ in }, device: { _ in }, close: {}, folder: {}, showFolder: {}))
        view.frame = NSRect(origin: .zero, size: view.fittingSize)
        view.layoutSubtreeIfNeeded()
        let rep = try XCTUnwrap(view.bitmapImageRepForCachingDisplay(in: view.bounds))
        view.cacheDisplay(in: view.bounds, to: rep)
        try XCTUnwrap(rep.representation(using: .png, properties: [:])).write(to: dir.appendingPathComponent("toolbar-workspace.png"))
    }
}
