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
        Consent.show("studio.example.com")   // the window's server, unless a test says otherwise
    }

    override func tearDown() {
        defaults.removePersistentDomain(forName: suite)
        Consent.show(nil)
    }

    private func request(_ json: String) -> RelayRequest { RelayRequest(json: Data(json.utf8))! }
    private func needs(_ json: String, root: URL = URL(fileURLWithPath: NSTemporaryDirectory())) throws -> [ConsentItem] {
        let req = request(json)
        return launchNeeds(req, try requestOptions(req, root: root), resolve: { "/usr/local/bin/\($0)" })
    }

    func testTheAppsOwnProgramsNeedNothing() throws {
        for driver in ["claude", "codex", "gemini", "grok", "cursor", "opencode", "pi", "musecode"] {
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

    // 35: a server not in the window never opens anything; its kept answers still hold
    func testAServerNotInTheWindowIsNeverAskedAndNothingIsKeptOrSilenced() throws {
        Consent.show("other.example.com")
        let consent = Consent(host: "studio.example.com", store: ConsentStore(defaults: defaults)) { _, _, _, _ in
            XCTFail("no prompt for a server not in the window"); return true
        }
        let agent = ConsentItem(kind: .program, text: "/usr/local/bin/my-agent acp")
        XCTAssertThrowsError(try consent.check([agent])) { error in
            XCTAssertEqual((error as? RelayError)?.message,
                           "This Mac did not allow studio.example.com to start that program. Allow it on the Mac when studio.example.com is open in Creator Toolset, or pick another AI in Settings → Providers.")
        }
        XCTAssertEqual(ConsentStore(defaults: defaults).allowed("studio.example.com"), [])
        XCTAssertFalse(consent.chatAnswers())
        XCTAssertNil(ConsentStore(defaults: defaults).chatAnswers("studio.example.com"), "a background no is not kept")
        XCTAssertEqual(consent.askHere("Run ls", "ls -la"), "denied")

        // kept answers hold in the background
        ConsentStore(defaults: defaults).allow("studio.example.com", agent)
        ConsentStore(defaults: defaults).setChatAnswers("studio.example.com", true)
        try consent.check([agent])
        XCTAssertTrue(consent.chatAnswers())
    }

    // 35: shown again, the same server asks as today (nothing was silenced in the background)
    func testOnceInTheWindowTheServerAsksAsBefore() throws {
        var shown: [String] = []
        let consent = Consent(host: "studio.example.com", store: ConsentStore(defaults: defaults)) { title, _, _, _ in
            shown.append(title); return true
        }
        let agent = ConsentItem(kind: .program, text: "/usr/local/bin/my-agent acp")
        Consent.show("other.example.com")
        XCTAssertThrowsError(try consent.check([agent]))
        XCTAssertEqual(shown, [])
        Consent.show("studio.example.com")
        try consent.check([agent])
        XCTAssertEqual(shown, ["Let studio.example.com start a program on this Mac?"])
    }

    // 35b: the key is the host as the runner names it, and a job's thread reads it without waiting for the main thread
    func testTheKeyIsTheRunnersHostAndIsReadOffTheMainThread() {
        XCTAssertEqual(Consent.key(for: URL(string: "http://localhost:4317")!), "localhost:4317")
        XCTAssertEqual(Consent.key(for: URL(string: "https://studio.example.com")!), "studio.example.com")
        Consent.show("other.example.com")
        let consent = Consent(host: "studio.example.com", store: ConsentStore(defaults: defaults)) { _, _, _, _ in true }
        let done = DispatchSemaphore(value: 0)
        DispatchQueue.global().async {
            do { try consent.check([ConsentItem(kind: .folder, text: "/tmp/home")]); XCTFail("refused in the background") } catch {}
            done.signal()
        }
        XCTAssertEqual(done.wait(timeout: .now() + 2), .success)
    }

    func testAnEndpointAndTheKeychainSettingsItPassNeedThisMacsYes() throws {
        let json = #"{"id":"j","system":"","user":"","driver":"claude","instance":"gw","envNames":["ANTHROPIC_KEY","NOT A NAME"],"baseUrl":"https://gw.example.com:8443/v1/messages"}"#
        let req = request(json)
        let root = URL(fileURLWithPath: NSTemporaryDirectory())
        let opts = try requestOptions(req, root: root, read: { $0 == "gw/ANTHROPIC_KEY" ? "secret" : nil })
        XCTAssertEqual(launchNeeds(req, opts), [ConsentItem(kind: .endpoint, text: "https://gw.example.com:8443"),
                                                ConsentItem(kind: .environment, text: "ANTHROPIC_KEY")])
        // no value kept here for the name: only the endpoint is asked
        let bare = try requestOptions(req, root: root, read: { _ in nil })
        XCTAssertEqual(launchNeeds(req, bare), [ConsentItem(kind: .endpoint, text: "https://gw.example.com:8443")])
        // the default Claude setup asks nothing
        XCTAssertEqual(try needs(#"{"id":"j","system":"","user":"","driver":"claude"}"#), [])
    }

    func testAnEndpointIsAskedByItsOriginOnly() {
        XCTAssertEqual(endpointOrigin("https://gw.example.com/v1/messages?x=1"), "https://gw.example.com")
        XCTAssertEqual(endpointOrigin("http://localhost:4000/anthropic"), "http://localhost:4000")
        XCTAssertNil(endpointOrigin("not an address"))
    }
}
