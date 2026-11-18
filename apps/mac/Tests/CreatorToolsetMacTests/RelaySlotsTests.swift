import Foundation
import XCTest
@testable import CreatorToolsetMac

/// Two servers' runners on one Mac: they share one pool of relay slots, and only the window's server asks anything.
final class RelaySlotsTests: XCTestCase {
    private final class Count: @unchecked Sendable {
        private let lock = NSLock()
        private var now = 0, top = 0, all = 0, handed: [Int: Int] = [:]
        var max: Int { lock.lock(); defer { lock.unlock() }; return top }
        var total: Int { lock.lock(); defer { lock.unlock() }; return all }
        func enter() { lock.lock(); now += 1; all += 1; top = Swift.max(top, now); lock.unlock() }
        func leave() { lock.lock(); now -= 1; lock.unlock() }
        /// The next request number for a site, or nil once `limit` were handed.
        func hand(_ site: Int, limit: Int) -> Int? {
            lock.lock(); defer { lock.unlock() }
            let n = handed[site, default: 0]
            guard n < limit else { return nil }
            handed[site] = n + 1
            return n
        }
    }

    private func runner(_ site: FakeSite, prompt: @escaping ConsentPrompt = { _, _, _, _ in false }) -> RelayRunner {
        let dir = testFolder("relay-slots")
        return RelayRunner(base: site.url, token: "ctd_test", work: dir.appendingPathComponent("relay"), home: dir, prompt: prompt,
                           onStatus: { _ in }, onRevoked: {})
    }

    /// Each runner's own long-poll loop on a thread of its own until `until`, then stopped; true when every loop ended.
    private func serving(_ runners: [RelayRunner], upTo seconds: Double, until: @escaping () -> Bool) async -> Bool {
        let ended = Count()
        for r in runners { DispatchQueue.global().async { r.serve(); ended.enter() } }
        let deadline = Date().addingTimeInterval(seconds)
        while Date() < deadline, !until() { try? await Task.sleep(nanoseconds: 20_000_000) }
        runners.forEach { $0.stop() }
        let limit = Date().addingTimeInterval(5)
        while Date() < limit, ended.total < runners.count { try? await Task.sleep(nanoseconds: 20_000_000) }
        return ended.total == runners.count
    }

    /// Sets the shared pool's free slots to `n`; returns how many it had.
    @discardableResult private static func setPool(to n: Int) -> Int {
        var had = 0
        while RelayRunner.sharedSlots.wait(timeout: .now()) == .success { had += 1 }
        for _ in 0..<n { RelayRunner.sharedSlots.signal() }
        return had
    }

    // 34b
    func testTwoServersRunAtMostFourRelayJobsAtOnceBetweenThem() async {
        // earlier tests run steps without a poll's slot, which leaves the shared pool above four: set it to four here
        let before = Self.setPool(to: RelayRunner.slotCount)
        defer { Self.setPool(to: before) }

        let count = Count()
        let sites = [FakeSite(), FakeSite()]
        let sha = String(repeating: "a", count: 64)
        for (i, site) in sites.enumerated() {
            site.answer = { request in
                if request.path == "/api/devices/relay/wait" {
                    guard let n = count.hand(i, limit: 4) else { Thread.sleep(forTimeInterval: 0.05); return (204, "") }
                    return (200, #"{"id":"j\#(i)-\#(n)","system":"","user":"","files":{"a.txt":"sha256:\#(sha)"}}"#)
                }
                if request.path.hasPrefix("/api/devices/relay/blob/") {
                    // a job holding its slot: the file it needs takes a while to come
                    count.enter()
                    Thread.sleep(forTimeInterval: 0.4)
                    count.leave()
                    return (404, "{}")
                }
                return (200, "{}")
            }
        }
        let fails = { sites.map { $0.requests.filter { $0.path.hasSuffix("/fail") }.count }.reduce(0, +) }
        let ended = await serving(sites.map { runner($0) }, upTo: 15, until: { fails() >= 8 })
        XCTAssertTrue(ended)
        XCTAssertEqual(fails(), 8, "all eight jobs ran")
        XCTAssertLessThanOrEqual(count.max, RelayRunner.slotCount)
        XCTAssertGreaterThan(count.max, 1)
        for site in sites { XCTAssertTrue(site.requests.contains { $0.path.hasPrefix("/api/devices/relay/blob/") }, "both servers' jobs ran") }
    }

    // 35b: the key the Shell shows is the one the runner gives its Consent, read from the job's own thread
    func testOnlyTheServerTheWindowShowsAsksAndItsKeyIsTheRunners() async throws {
        defer { Consent.show(nil) }
        let site = FakeSite()
        let asked = Count()
        let prompt: ConsentPrompt = { _, _, _, _ in asked.enter(); return false }
        let jobs = Count()
        site.answer = { request in
            guard request.path == "/api/devices/relay/wait" else { return (200, "{}") }
            guard let n = jobs.hand(0, limit: 1) else { Thread.sleep(forTimeInterval: 0.05); return (204, "") }
            return (200, #"{"id":"c\#(n)","system":"","user":"","driver":"acp","acp":{"command":"my-agent","args":["acp"]}}"#)
        }
        let failed = { site.requests.filter { $0.path.hasSuffix("/fail") } }
        let error = { (r: FakeSite.Request) in ((try? JSONSerialization.jsonObject(with: r.body)) as? [String: Any])?["error"] as? String ?? "" }

        Consent.show("other.example.com")
        var ended = await serving([runner(site, prompt: prompt)], upTo: 10, until: { !failed().isEmpty })
        XCTAssertTrue(ended)
        XCTAssertEqual(asked.total, 0, "a server not in the window opens nothing")
        XCTAssertTrue(error(try XCTUnwrap(failed().first)).contains("is open in Creator Toolset"))

        site.forget()
        Consent.show(Consent.key(for: site.url))
        let jobs2 = Count()
        site.answer = { request in
            guard request.path == "/api/devices/relay/wait" else { return (200, "{}") }
            guard jobs2.hand(0, limit: 1) != nil else { Thread.sleep(forTimeInterval: 0.05); return (204, "") }
            return (200, #"{"id":"d0","system":"","user":"","driver":"acp","acp":{"command":"my-agent","args":["acp"]}}"#)
        }
        ended = await serving([runner(site, prompt: prompt)], upTo: 10, until: { !failed().isEmpty })
        XCTAssertTrue(ended)
        XCTAssertEqual(asked.total, 1, "the window's server asks as today")
        XCTAssertTrue(error(try XCTUnwrap(failed().first)).contains("when it asks"))
    }
}
