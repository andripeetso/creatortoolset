import Foundation
import XCTest
@testable import CreatorToolsetMac

/// What a server may make this Mac do: the app's own programs need nothing, anything a server names is this Mac's yes.
final class ConsentTests: XCTestCase {
    private var defaults: UserDefaults!
    private let suite = "com.creatortoolset.mac.consent.tests"

    override func setUp() {
        defaults = UserDefaults(suiteName: suite)
        defaults.removePersistentDomain(forName: suite)
    }

    override func tearDown() { defaults.removePersistentDomain(forName: suite) }

    private func request(_ json: String) -> RelayRequest { RelayRequest(json: Data(json.utf8))! }
    private func needs(_ json: String, root: URL = URL(fileURLWithPath: NSTemporaryDirectory())) throws -> [ConsentItem] {
        let req = request(json)
        return launchNeeds(req, try requestOptions(req, root: root), resolve: { "/usr/local/bin/\($0)" })
    }

    func testTheAppsOwnProgramsNeedNothing() throws {
        for driver in ["claude", "codex", "gemini", "grok", "cursor", "opencode", "antigravity", "pi", "musecode"] {
            XCTAssertEqual(try needs(#"{"id":"j","system":"","user":"","driver":"\#(driver)"}"#), [], driver)
        }
    }

    func testAProgramOrArgumentsTheServerNamesNeedThisMacsYes() throws {
        XCTAssertEqual(try needs(#"{"id":"j","system":"","user":"","driver":"acp","acp":{"command":"my-agent","args":["acp"]}}"#),
                       [ConsentItem(kind: .program, text: "/usr/local/bin/my-agent acp")])
        XCTAssertEqual(try needs(#"{"id":"j","system":"","user":"","driver":"pi","launchArgs":["-y","other-package"]}"#),
                       [ConsentItem(kind: .program, text: "/usr/local/bin/npx -y pi-acp@0.0.34 -y other-package")])
        XCTAssertEqual(try needs(#"{"id":"j","system":"","user":"","driver":"cursor","binaryPath":"/opt/x/agent"}"#).map(\.kind), [.program])
    }

    func testASettingsFolderNeedsThisMacsYesAndNeverOneInTheAppsOwnFolders() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("consent-\(UUID().uuidString)")
        let hub = root.appendingPathComponent(".claude-hub"), library = root.appendingPathComponent("Library/Application Support/x")
        for dir in [hub, library] { try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true) }
        defer { try? FileManager.default.removeItem(at: root) }
        XCTAssertEqual(try needs(#"{"id":"j","system":"","user":"","home":"\#(hub.path)"}"#, root: root).map(\.kind), [.folder])
        XCTAssertThrowsError(try checkedHome(library.path, root: root))
    }

    func testAYesIsKeptAndANoSilencesTheServer() throws {
        var shown: [String] = []
        var answer = true
        let consent = Consent(host: "studio.example.com", store: ConsentStore(defaults: defaults)) { title, _, _, _ in
            shown.append(title)
            return answer
        }
        let agent = ConsentItem(kind: .program, text: "/usr/local/bin/my-agent acp")
        try consent.check([agent])
        try consent.check([agent])   // kept: asked once
        XCTAssertEqual(shown, ["Let studio.example.com start a program on this Mac?"])
        answer = false
        XCTAssertThrowsError(try consent.check([ConsentItem(kind: .program, text: "/usr/local/bin/other")]))
        XCTAssertThrowsError(try consent.check([ConsentItem(kind: .program, text: "/usr/local/bin/third")]))
        XCTAssertEqual(shown.count, 2)   // the no silenced the rest of the run
        try consent.check([agent])        // what was allowed still runs
    }

    func testAServerCantShowAnAlteredOrEndlessCommand() {
        XCTAssertEqual(alertLine("run\nthis\u{7}"), "run this")
        XCTAssertNil(alertLine(String(repeating: "a", count: 401)))
        let consent = Consent(host: "h", store: ConsentStore(defaults: defaults)) { _, _, _, _ in XCTFail("never shown"); return true }
        XCTAssertThrowsError(try consent.check([ConsentItem(kind: .program, text: String(repeating: "a", count: 500))]))
    }

    func testTheAssistantsQuestionsAreAnsweredHereUntilThisMacLetsTheServerAnswer() {
        var answers = [false, true, true]
        var titles: [String] = []
        let consent = Consent(host: "studio.example.com", store: ConsentStore(defaults: defaults)) { title, _, _, _ in
            titles.append(title)
            return answers.removeFirst()
        }
        XCTAssertFalse(consent.chatAnswers())            // asked once: "Ask on This Mac"
        XCTAssertFalse(consent.chatAnswers())            // kept, not asked again
        XCTAssertEqual(consent.askHere("Run ls", "ls -la"), "allowed")
        XCTAssertEqual(titles, ["Let studio.example.com answer the assistant's questions?", "The assistant wants to: Run ls"])
        XCTAssertEqual(ConsentStore(defaults: defaults).chatAnswers("studio.example.com"), false)
    }
}
