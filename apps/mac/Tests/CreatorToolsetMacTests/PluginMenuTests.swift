import XCTest
@testable import CreatorToolsetMac

final class PluginMenuTests: XCTestCase {
    func testItemsDecodeFromTheServersList() throws {
        let json = Data(#"[{"id":"tiny:finals","title":"Tiny Finals","href":"/finals"}]"#.utf8)
        let items = try JSONDecoder().decode([PluginMenuItem].self, from: json)
        XCTAssertEqual(items, [PluginMenuItem(id: "tiny:finals", title: "Tiny Finals", href: "/finals")])
    }

    func testOnlyTitledAppPathsAreShown() {
        let items = [
            PluginMenuItem(id: "a", title: "Editor", href: "/editor"),
            PluginMenuItem(id: "b", title: "Elsewhere", href: "https://example.com"),
            PluginMenuItem(id: "c", title: "Protocol relative", href: "//example.com"),
            PluginMenuItem(id: "d", title: "Backslash", href: "/\\example.com"),
            PluginMenuItem(id: "e", title: "   ", href: "/library"),
        ]
        XCTAssertEqual(pluginMenuItems(items).map(\.id), ["a"])
    }

    func testAppToolsKeepTheirListOrderAndTheFirstBuildsShortcuts() {
        let items = [
            AppToolItem(id: "home", title: "Home", href: "/"),
            AppToolItem(id: "editor", title: "AI Editor", href: "/editor"),
            AppToolItem(id: "bad", title: "Elsewhere", href: "https://example.com"),
        ]
        XCTAssertEqual(appToolItems(items).map(\.id), ["home", "editor"])
        XCTAssertEqual(appToolShortcuts["editor"], "3")
        XCTAssertEqual(appToolShortcuts["finals"], "4")
    }
}
