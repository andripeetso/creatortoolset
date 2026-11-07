import Foundation
import XCTest
@testable import CreatorToolsetMac

final class ServersTests: XCTestCase {
    private let ids = { () -> () -> String in var n = 0; return { n += 1; return "s\(n)" } }

    func testTheOldSiteSettingMovesIntoTheListOnce() {
        // a saved site and the server switched off: the site is the one the window opens
        let off = migratedServers(site: "https://tools.example.com/", runsHere: false, hasLocal: true, newID: ids())
        XCTAssertEqual(off.servers, [ServerEntry(id: "s1", name: "tools.example.com", url: "https://tools.example.com")])
        XCTAssertEqual(off.current, "s1")
        // the server on (or never touched): This Mac stays picked, the site is kept in the list
        XCTAssertEqual(migratedServers(site: "https://tools.example.com", runsHere: nil, hasLocal: true, newID: ids()).current, thisMacID)
        // nothing saved and no server in this build: no server at all, no default site
        let none = migratedServers(site: nil, runsHere: nil, hasLocal: false)
        XCTAssertEqual(none.servers, [])
        XCTAssertNil(none.current)
        // the server off and no site: the window asks to pick or add one
        XCTAssertNil(migratedServers(site: nil, runsHere: false, hasLocal: true).current)
        // an unusable saved address is dropped
        XCTAssertEqual(migratedServers(site: "http://tools.example.com", runsHere: false, hasLocal: true).servers, [])
    }

    func testThisMacIsListedOnlyWithTheServerInTheBuild() {
        let added = [ServerEntry(id: "a", name: "Office", url: "https://office.example.com")]
        XCTAssertEqual(listedServers(added, hasLocal: true).map(\.id), [thisMacID, "a"])
        XCTAssertEqual(listedServers(added, hasLocal: false).map(\.id), ["a"])
        XCTAssertEqual(validCurrent(thisMacID, in: added, hasLocal: false), nil)
        XCTAssertEqual(validCurrent("gone", in: added, hasLocal: true), nil)
        XCTAssertEqual(validCurrent("a", in: added, hasLocal: false), "a")
    }

    func testAnAddressOrASignInLinkAddsAServer() {
        XCTAssertEqual(serverInput("tools.example.com"), ServerInput(url: URL(string: "https://tools.example.com")!, signInPath: nil))
        XCTAssertEqual(serverInput(" https://tools.example.com:8443/settings "), ServerInput(url: URL(string: "https://tools.example.com:8443")!, signInPath: nil))
        XCTAssertEqual(serverInput("https://tools.example.com/api/auth/link/abc_123")?.signInPath, "/api/auth/link/abc_123")
        XCTAssertNil(serverInput("https://tools.example.com/api/auth/link/")?.signInPath)
        XCTAssertEqual(serverInput("http://localhost:3000")?.url.absoluteString, "http://localhost:3000")
        XCTAssertNil(serverInput("http://tools.example.com"))   // never in clear to another host
        XCTAssertNil(serverInput(""))
        XCTAssertNil(serverInput("ftp://tools.example.com"))
    }

    func testAddRenameRemove() {
        let url = URL(string: "https://tools.example.com")!
        var (list, id) = addingServer(url, name: " ", to: [], newID: ids())
        XCTAssertEqual(list, [ServerEntry(id: "s1", name: "tools.example.com", url: "https://tools.example.com")])
        // the same server twice: one entry, its id
        let again = addingServer(url, name: "Other", to: list, newID: ids())
        XCTAssertEqual(again.servers.count, 1)
        XCTAssertEqual(again.id, id)
        list = renamingServer(id, to: " Office ", in: list)
        XCTAssertEqual(list[0].name, "Office")
        XCTAssertEqual(renamingServer(id, to: "  ", in: list)[0].name, "Office")
        // removing the open server leaves none picked; removing another keeps the pick
        XCTAssertNil(removingServer(id, from: list, current: id).current)
        let kept = removingServer(id, from: list, current: thisMacID)
        XCTAssertEqual(kept.servers, [])
        XCTAssertEqual(kept.current, thisMacID)
        (list, id) = addingServer(URL(string: "https://b.example.com")!, name: "B", to: list, newID: ids())
        XCTAssertEqual(list.map(\.name), ["Office", "B"])
    }

    func testTheGuideReadsTheHealthCheck() {
        let ok = healthChecks(status: 200, body: Data(#"{"ok":true,"environment":"x"}"#.utf8), error: nil)
        XCTAssertEqual(ok.https.state, .ok)
        XCTAssertEqual(ok.reachable.state, .ok)
        // Caddy up, the app still building
        let building = healthChecks(status: 502, body: nil, error: nil)
        XCTAssertEqual(building.https.state, .ok)
        XCTAssertEqual(building.reachable.state, .failed)
        XCTAssertTrue(building.reachable.text.contains("docker compose logs app"))
        // something else answers at the address
        XCTAssertEqual(healthChecks(status: 200, body: Data("<html>".utf8), error: nil).reachable.state, .failed)
        let cert = healthChecks(status: nil, body: nil, error: NSError(domain: NSURLErrorDomain, code: NSURLErrorServerCertificateUntrusted))
        XCTAssertEqual(cert.https.state, .failed)
        XCTAssertEqual(cert.reachable.state, .unknown)
        let dns = healthChecks(status: nil, body: nil, error: NSError(domain: NSURLErrorDomain, code: NSURLErrorCannotFindHost))
        XCTAssertEqual(dns.reachable.state, .failed)
        XCTAssertTrue(dns.reachable.text.contains("A record"))
        let closed = healthChecks(status: nil, body: nil, error: NSError(domain: NSURLErrorDomain, code: NSURLErrorCannotConnectToHost))
        XCTAssertTrue(closed.reachable.text.contains("443"))
    }

    func testMenuBarStatus() {
        XCTAssertEqual(menuStatus(serverFailed: false, serverUp: false, aiOn: false, aiRunning: 0, aiError: false, lowSpace: false), .idle)
        XCTAssertEqual(menuStatus(serverFailed: false, serverUp: true, aiOn: false, aiRunning: 0, aiError: false, lowSpace: false), .up)
        XCTAssertEqual(menuStatus(serverFailed: false, serverUp: false, aiOn: true, aiRunning: 2, aiError: false, lowSpace: false), .busy)
        XCTAssertEqual(menuStatus(serverFailed: true, serverUp: false, aiOn: true, aiRunning: 1, aiError: false, lowSpace: false), .problem)
        XCTAssertEqual(menuStatus(serverFailed: false, serverUp: true, aiOn: true, aiRunning: 0, aiError: false, lowSpace: true), .problem)
    }

    func testThePageLearnsThisMacsDeviceSafely() {
        XCTAssertTrue(macDeviceScript(#"d"1</script>"#).contains(#""d\"1<\/script>""#))
        XCTAssertTrue(macDeviceScript(nil).contains("const id = null"))
    }
}
