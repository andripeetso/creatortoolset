// swift-tools-version:5.10
import PackageDescription

// Creator Toolset, the Mac app: a thin native shell around creatortoolset.com (see README.md).
// Built into a .app by scripts/build-app.sh; `swift test` runs the unit tests.
// Sparkle updates the installed app from an appcast you host (set FEED_URL and SPARKLE_PUBLIC_KEY at build time; see README.md).
let package = Package(
    name: "CreatorToolsetMac",
    platforms: [.macOS(.v14)],
    dependencies: [
        .package(url: "https://github.com/sparkle-project/Sparkle", from: "2.6.0"),
    ],
    targets: [
        .executableTarget(
            name: "CreatorToolsetMac",
            dependencies: [.product(name: "Sparkle", package: "Sparkle")],
            path: "Sources/CreatorToolsetMac"
        ),
        .testTarget(name: "CreatorToolsetMacTests", dependencies: ["CreatorToolsetMac"], path: "Tests/CreatorToolsetMacTests"),
    ]
)
