import XCTest
@testable import CreatorToolsetMac

final class DisksTests: XCTestCase {
    private let gb: Int64 = 1_073_741_824

    private func volume(_ path: String, free: Int64 = 50, total: Int64 = 460, fstype: String = "apfs",
                        source: String = "/dev/disk3s1", readOnly: Bool = false, browsable: Bool = true) -> VolumeFacts {
        VolumeFacts(path: path, freeBytes: free * gb, totalBytes: total * gb, fstype: fstype, source: source,
                    readOnly: readOnly, browsable: browsable)
    }

    func testTheSystemDiskAndAnExternalDriveAreKept() {
        let system = diskReport(volume("/"))
        XCTAssertEqual(system?["name"] as? String, "System disk")
        XCTAssertEqual(system?["freeGb"] as? Double, 50)
        XCTAssertEqual(system?["totalGb"] as? Double, 460)
        XCTAssertNil(system?["network"])
        XCTAssertEqual(diskReport(volume("/Volumes/Backup"))?["name"] as? String, "Backup")
    }

    func testInstallerImagesHiddenVolumesAndTinyHelpersAreLeftOut() {
        XCTAssertNil(diskReport(volume("/Volumes/Installer", readOnly: true)))
        XCTAssertNil(diskReport(volume("/Volumes/Hidden", browsable: false)))
        XCTAssertNil(diskReport(volume("/Volumes/Tiny", total: 0)))
        XCTAssertNil(diskReport(volume("/private/var/folders/x")))
    }

    func testANetworkShareKeepsItsServer() {
        let share = diskReport(volume("/Volumes/footage", fstype: "smbfs", source: "//user@NAS-1._smb._tcp.local/footage"))
        XCTAssertEqual(share?["network"] as? Bool, true)
        XCTAssertEqual(share?["server"] as? String, "nas-1")
    }

    func testAnSshfsMountIsANetworkShareToo() {
        XCTAssertEqual(diskReport(volume("/Volumes/home", fstype: "fuse.sshfs", source: "user@box:/home"))?["network"] as? Bool, true)
    }

    func testATotalSmallerThanFreeIsLeftOut() {
        let quota = diskReport(volume("/Volumes/quota", free: 900, total: 500))
        XCTAssertNil(quota?["totalGb"])
        XCTAssertEqual(quota?["freeGb"] as? Double, 900)
    }

    func testShareServerNames() {
        XCTAssertEqual(shareServer("//user@Studio-Box._smb._tcp.local/TEAM"), "studio-box")
        XCTAssertEqual(shareServer("//nas-1.local/data"), "nas-1")
        XCTAssertNil(shareServer("/dev/disk3s1"))
        XCTAssertNil(shareServer("//nas-1"))
        XCTAssertNil(shareServer("//"))
    }
}
