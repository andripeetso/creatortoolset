import XCTest
@testable import CreatorToolsetMac

// The Download location (UNIFIED-PRD M15): read from a throwaway defaults suite, never the person's own; passed to the
// worker as CT_PROXY_DIR only when set.
final class DownloadLocationTests: XCTestCase {
    private func suite() -> UserDefaults {
        let name = "ct-download-location-test-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: name)!
        addTeardownBlock { defaults.removePersistentDomain(forName: name) }
        return defaults
    }

    func testNoLocationIsTheDefault() {
        XCTAssertNil(DownloadLocation.path(suite()))
    }

    func testAnEmptyLocationIsNoLocation() {
        let d = suite()
        d.set("", forKey: DownloadLocation.key)
        XCTAssertNil(DownloadLocation.path(d))
    }

    func testTheChosenFolderIsRead() {
        let d = suite()
        d.set("/Volumes/WinningFriends/Downloads", forKey: DownloadLocation.key)
        XCTAssertEqual(DownloadLocation.path(d), "/Volumes/WinningFriends/Downloads")
    }

    func testTheWorkerGetsTheFolderOnlyWhenChosen() {
        let server = URL(string: "https://studio.example.com")!
        let data = URL(fileURLWithPath: "/x/relay/studio.example.com/work")
        let app = URL(fileURLWithPath: "/Applications/Creator Toolset.app/Contents/Resources/server")
        func env(_ proxyDir: String?) -> [String: String] {
            workerEnvironment(server: server, token: "ctd_abc", data: data, folder: app, inherited: [:], plugins: [:], proxyDir: proxyDir)
        }
        XCTAssertNil(env(nil)["CT_PROXY_DIR"])
        XCTAssertNil(env("")["CT_PROXY_DIR"])
        XCTAssertEqual(env("/Volumes/WinningFriends/Downloads")["CT_PROXY_DIR"], "/Volumes/WinningFriends/Downloads")
    }
}
