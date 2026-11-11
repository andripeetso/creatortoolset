import Foundation
import WebKit
import XCTest
@testable import CreatorToolsetMac

/// A scheme task that only writes down what it is told, and on which thread.
private final class WrittenTask: NSObject, WKURLSchemeTask {
    let request: URLRequest
    let done: XCTestExpectation
    private(set) var calls: [String] = []
    private(set) var offMain = 0
    private(set) var bytes = 0

    init(_ url: URL, _ done: XCTestExpectation) {
        request = URLRequest(url: url)
        self.done = done
    }

    private func note(_ what: String) {
        calls.append(what)
        if !Thread.isMainThread { offMain += 1 }
    }
    func didReceive(_ response: URLResponse) { note("response") }
    func didReceive(_ data: Data) { note("data"); bytes += data.count }
    func didFinish() { note("finish"); done.fulfill() }
    func didFailWithError(_ error: Error) { note("fail"); done.fulfill() }
}

final class ProjectTests: XCTestCase {
    // Scratch in CT_SCRATCH_DIR (an external disk) or the temporary folder; each test removes its own folder.
    private var root: URL!

    override func setUpWithError() throws {
        let base = ProcessInfo.processInfo.environment["CT_SCRATCH_DIR"].map { URL(fileURLWithPath: $0) } ?? FileManager.default.temporaryDirectory
        root = base.appendingPathComponent("rec-project-tests/\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: root)
    }

    func testByteRange() {
        XCTAssertEqual(ProjectScheme.byteRange(header: "bytes=0-99", size: 1000), 0...99)
        XCTAssertEqual(ProjectScheme.byteRange(header: "bytes=900-", size: 1000), 900...999)
        XCTAssertEqual(ProjectScheme.byteRange(header: "bytes=0-", size: 20_000_000), 0...(8 << 20 - 1))
        XCTAssertEqual(ProjectScheme.byteRange(header: "bytes=-100", size: 1000), 900...999)
        XCTAssertEqual(ProjectScheme.byteRange(header: "bytes=-5000", size: 1000), 0...999)
        XCTAssertEqual(ProjectScheme.byteRange(header: "bytes=0-5000", size: 1000), 0...999)
        // malformed, unsatisfiable or multi-range headers are not answered
        XCTAssertNil(ProjectScheme.byteRange(header: nil, size: 1000))
        XCTAssertNil(ProjectScheme.byteRange(header: "bytes=1000-", size: 1000))
        XCTAssertNil(ProjectScheme.byteRange(header: "bytes=5-2", size: 1000))
        XCTAssertNil(ProjectScheme.byteRange(header: "bytes=0-1,5-6", size: 1000))
        XCTAssertNil(ProjectScheme.byteRange(header: "bytes=-0", size: 1000))
        XCTAssertNil(ProjectScheme.byteRange(header: "bytes=abc", size: 1000))
        XCTAssertNil(ProjectScheme.byteRange(header: "items=0-1", size: 1000))
        XCTAssertNil(ProjectScheme.byteRange(header: "bytes=0-1", size: 0))
    }

    func testIDValidationAndPathRejection() throws {
        XCTAssertTrue(ProjectStore.isValidID("0123456789ab"))
        XCTAssertFalse(ProjectStore.isValidID("0123456789AB"))
        XCTAssertFalse(ProjectStore.isValidID("0123456789abc"))
        XCTAssertFalse(ProjectStore.isValidID("../../../etc"))
        XCTAssertNil(ProjectStore.project(id: "../../../etc", root: root))
        XCTAssertNil(ProjectStore.project(id: "0123456789ab", root: root))
        // only the listed file names are served
        XCTAssertNil(ProjectScheme.types["../project.json"])
        XCTAssertNil(ProjectScheme.types["screen.mov"])
    }

    func testCreateMarkReadyOpenRoundTrip() throws {
        let date = Date(timeIntervalSince1970: 1_800_000_000)
        var project = try LocalProject.create(in: root, at: date)
        XCTAssertEqual(project.state, "recording")
        XCTAssertTrue(project.folder.lastPathComponent.range(of: #"^\d{4}-\d{2}-\d{2} \d{2}\.\d{2}\.\d{2}\.ctrec$"#,
                                                             options: .regularExpression) != nil)
        XCTAssertTrue(ProjectStore.isValidID(project.id))
        XCTAssertTrue(ProjectStore.list(root: root).isEmpty, "a recording still in progress is not listed")

        try project.markReady(durationMs: 12_000, width: 3024, height: 1964, tracks: ["mic", "system"], camera: false)
        let reopened = try LocalProject.open(folder: project.folder)
        XCTAssertEqual(reopened.id, project.id)
        XCTAssertEqual(reopened.state, "ready")
        XCTAssertEqual(reopened.durationMs, 12_000)
        XCTAssertEqual(reopened.tracks, ["mic", "system"])
        // the temp folder is /var/… while the store resolves it to /private/var/…: compare resolved paths
        XCTAssertEqual(ProjectStore.project(id: project.id, root: root)?.folder.resolvingSymlinksInPath(), project.folder.resolvingSymlinksInPath())
        XCTAssertEqual(ProjectStore.list(root: root).map(\.id), [project.id])
    }

    func testWriteLookRejectsInvalidJSONAndLargeFiles() throws {
        let project = try LocalProject.create(in: root, at: Date())
        XCTAssertThrowsError(try project.writeLook(Data("{nope".utf8)))
        XCTAssertThrowsError(try project.writeLook(Data(count: 256 * 1024 + 1)))
        try project.writeLook(Data(#"{"zoom":1.5}"#.utf8))
        XCTAssertTrue(FileManager.default.fileExists(atPath: project.lookURL.path))
    }

    func testListNewestFirst() throws {
        var older = try LocalProject.create(in: root, at: Date(timeIntervalSince1970: 1_800_000_000))
        var newer = try LocalProject.create(in: root, at: Date(timeIntervalSince1970: 1_800_000_060))
        try older.markReady(durationMs: 1, width: 2, height: 2, tracks: [], camera: false)
        try newer.markReady(durationMs: 1, width: 2, height: 2, tracks: [], camera: false)
        XCTAssertEqual(ProjectStore.list(root: root).map(\.id), [newer.id, older.id])
    }

    /// The freeze of 0.13.1 and before: answers were made from the reading thread under a lock that start and stop
    /// took too, and WebKit makes an answer from another thread wait for the main thread. Two requests at once (the
    /// editor plays the video and reads the pointer log) left each waiting for the other. Every answer is made on the
    /// main thread now, so two requests overlap, and a stopped one hears nothing more.
    @MainActor
    func testEveryAnswerIsMadeOnTheMainThreadAndRequestsOverlap() throws {
        let project = try LocalProject.create(in: root, at: Date())
        try Data(count: 3 << 20).write(to: project.screenURL)
        try project.writeEvents(Data(#"{"v":1,"width":2,"height":2,"moves":[],"clicks":[]}"#.utf8))
        let folder = root!
        let scheme = ProjectScheme(root: { folder })
        let web = WKWebView(frame: .zero)

        let video = WrittenTask(ProjectScheme.url(projectID: project.id, file: "screen.mp4"), expectation(description: "video"))
        let log = WrittenTask(ProjectScheme.url(projectID: project.id, file: "screen-events.json"), expectation(description: "log"))
        scheme.webView(web, start: video)
        scheme.webView(web, start: log)
        wait(for: [video.done, log.done], timeout: 10)
        XCTAssertEqual(video.calls, ["response", "data", "data", "data", "finish"])   // 3 MB in 1 MB pieces
        XCTAssertEqual(video.bytes, 3 << 20)
        XCTAssertEqual(log.calls, ["response", "data", "finish"])
        XCTAssertEqual(video.offMain + log.offMain, 0, "an answer made off the main thread waits for it inside WebKit")

        let unwanted = expectation(description: "stopped")
        unwanted.isInverted = true
        let stopped = WrittenTask(ProjectScheme.url(projectID: project.id, file: "screen.mp4"), unwanted)
        scheme.webView(web, start: stopped)
        scheme.webView(web, stop: stopped)
        wait(for: [unwanted], timeout: 0.5)
        XCTAssertEqual(stopped.calls, [])
    }
}
