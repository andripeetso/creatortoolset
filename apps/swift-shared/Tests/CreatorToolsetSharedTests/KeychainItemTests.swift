import Foundation
import Security
import XCTest
import CreatorToolsetShared

/// The shared Keychain helper on its own service: a write replaces the value, a read finds it, a delete removes it.
final class KeychainItemTests: XCTestCase {
    func testAnItemIsWrittenReplacedReadAndDeleted() {
        let service = "creatortoolset.tests.\(UUID().uuidString)"
        defer { KeychainItem.delete(service: service, account: "a") }
        XCTAssertNil(KeychainItem.read(service: service, account: "a"))
        XCTAssertEqual(KeychainItem.write(Data("one".utf8), service: service, account: "a", accessible: kSecAttrAccessibleAfterFirstUnlock), errSecSuccess)
        XCTAssertEqual(KeychainItem.write(Data("two".utf8), service: service, account: "a", accessible: kSecAttrAccessibleAfterFirstUnlock), errSecSuccess)
        XCTAssertEqual(KeychainItem.read(service: service, account: "a"), Data("two".utf8))
        XCTAssertNil(KeychainItem.read(service: service, account: "b"))   // another account of the service is its own item
        KeychainItem.delete(service: service, account: "a")
        XCTAssertNil(KeychainItem.read(service: service, account: "a"))
    }
}
