import Foundation
import XCTest
@testable import CreatorToolsetMac

/// Antigravity on this Mac: the downloaded copy is found only whole, a chat starts it with its own profile and no
/// browser, and a run with no copy or no sign-in stops with a plain message.
final class AntigravityTests: XCTestCase {
    private func temp() -> URL {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("agy-test-\(UUID().uuidString)")
        try! FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }

    private func request(_ json: String) -> RelayRequest { RelayRequest(json: Data(json.utf8))! }

    /// A copy as the server's install leaves it: two programs and release.json naming their sizes.
    private func install(_ root: URL, harnessBytes: Int = 3) {
        let dir = root.appendingPathComponent("runtime")
        try! FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        for (name, text) in [("agy_acp_server.par", "#!/bin/sh\n"), ("localharness_external", "ab\n")] {
            let file = dir.appendingPathComponent(name)
            try! Data(text.utf8).write(to: file)
            try! FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: file.path)
        }
        let record = #"{"version":"1.4.5","files":[{"name":"agy_acp_server.par","bytes":10},{"name":"localharness_external","bytes":\#(harnessBytes)}]}"#
        try! Data(record.utf8).write(to: dir.appendingPathComponent("release.json"))
    }

    private func signIn(_ root: URL) {
        let dir = root.appendingPathComponent("profile/antigravity-acp")
        try! FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        try! Data("{}".utf8).write(to: dir.appendingPathComponent("acp_token.json"))
    }

    func testTheDownloadedCopyCountsOnlyWhole() {
        let root = temp()
        XCTAssertNil(antigravityRuntime(root: root))
        install(root, harnessBytes: 99)   // a file at another size than its record: a half-finished copy
        XCTAssertNil(antigravityRuntime(root: root))
        install(root)
        XCTAssertEqual(antigravityRuntime(root: root),
                       AntigravityRuntime(program: root.appendingPathComponent("runtime/agy_acp_server.par").path,
                                          harness: root.appendingPathComponent("runtime/localharness_external").path, version: "1.4.5"))
    }

    func testAPersonsOwnCopyNeedsItsHarnessBesideIt() {
        let root = temp()
        install(root)
        let own = root.appendingPathComponent("runtime/agy_acp_server.par").path
        XCTAssertEqual(antigravityRuntime(custom: own, root: temp())?.harness, root.appendingPathComponent("runtime/localharness_external").path)
        try! FileManager.default.removeItem(at: root.appendingPathComponent("runtime/localharness_external"))
        XCTAssertNil(antigravityRuntime(custom: own, root: temp()))
    }

    func testAChatStartsTheCopyWithItsProfileAndNoBrowser() throws {
        let root = temp()
        let json = #"{"id":"j","system":"","user":"","driver":"antigravity"}"#
        XCTAssertThrowsError(try requestOptions(request(json), root: temp(), antigravity: root)) { error in
            XCTAssertEqual((error as? RelayError)?.message, antigravityMissing)
        }
        install(root)
        XCTAssertThrowsError(try requestOptions(request(json), root: temp(), antigravity: root)) { error in
            XCTAssertEqual((error as? RelayError)?.message, antigravitySignedOut)
        }
        signIn(root)
        let opts = try requestOptions(request(json), root: temp(), antigravity: root)
        XCTAssertEqual(opts.acp, AcpLaunch(command: root.appendingPathComponent("runtime/agy_acp_server.par").path, args: []))
        XCTAssertEqual(opts.env["GEMINI_HOME"], root.appendingPathComponent("profile").path)
        XCTAssertEqual(opts.env["ANTIGRAVITY_HARNESS_PATH"], root.appendingPathComponent("runtime/localharness_external").path)
        XCTAssertEqual(opts.env["BROWSER"], "/usr/bin/true")
        // the app's own program needs no yes from this Mac
        XCTAssertEqual(launchNeeds(request(json), opts), [])
    }

    func testQuotaIsALimit() {
        XCTAssertTrue(limitFlag("antigravity", "Error 429, Message: Quota exhausted for test model., Status: RESOURCE_EXHAUSTED"))
        XCTAssertFalse(limitFlag("antigravity", "Authentication required"))
    }
}

/// One real chat turn through the downloaded program, as the relay runs it (requestOptions, then acpAnswer). Runs only
/// with CT_AGY_LIVE_ROOT set to an app folder's antigravity/ that is installed and signed in; skipped otherwise.
final class AntigravityLiveTests: XCTestCase {
    func testARealChatTurn() throws {
        guard let path = ProcessInfo.processInfo.environment["CT_AGY_LIVE_ROOT"] else { throw XCTSkip("CT_AGY_LIVE_ROOT is not set") }
        let root = URL(fileURLWithPath: path)
        let req = RelayRequest(json: Data(#"{"id":"live","system":"Answer in one word.","user":"What colour is a clear daytime sky?","driver":"antigravity"}"#.utf8))!
        let opts = try requestOptions(req, antigravity: root)
        let work = FileManager.default.temporaryDirectory.appendingPathComponent("agy-live-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: work, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: work) }
        let answer = try acpAnswer(req, opts, work: work, send: { _ in true })
        print("antigravity answered: \(answer.text)")
        XCTAssertTrue(answer.text.lowercased().contains("blue"), answer.text)
    }
}
