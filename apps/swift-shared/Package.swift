// swift-tools-version:5.10
import PackageDescription

// Code the Mac app (apps/mac) and the iPhone app (apps/ios) both use, so the two never drift apart: the Keychain item
// helper and what kind of network a host is on. `swift test` here runs its own tests.
let package = Package(
    name: "CreatorToolsetShared",
    platforms: [.macOS(.v14), .iOS(.v17)],
    products: [.library(name: "CreatorToolsetShared", targets: ["CreatorToolsetShared"])],
    targets: [
        .target(name: "CreatorToolsetShared"),
        .testTarget(name: "CreatorToolsetSharedTests", dependencies: ["CreatorToolsetShared"]),
    ]
)
