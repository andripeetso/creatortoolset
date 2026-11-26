import Foundation
import SwiftUI

/// How far a file to blur is on its way into the Media Library, as the server says it (`GET /api/library/:id/intake`,
/// `contracts/library.ts` Intake): held on the server until the main computer has it, there waiting for its blur, being
/// blurred, done, or failed. Read each time it is shown; nothing of it is kept on the phone.
struct Intake: Decodable, Equatable {
    var assetId: String
    /// The version on its way: Face Blur's retry names it.
    var versionId: String
    /// "held", "computer", "blurring", "done" or "failed".
    var step: String
    /// held: no computer is copying it now. computer: its blur can't start now.
    var waiting: Bool?
    /// failed: "copy" (to the main computer) or "blur".
    var failed: String?
    var error: String?

    struct List: Decodable {
        var items: [Intake]
    }

    /// The upload's answer for a file the server holds for its blur (`{ assetId, versionId, held: true, libraryId }`):
    /// what the intake is asked by. nil for any other answer.
    struct Held: Codable, Hashable {
        var library: String
        var asset: String

        init?(finish body: Data) {
            guard let json = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any], json["held"] as? Bool == true,
                  let library = json["libraryId"] as? String, let asset = json["assetId"] as? String else { return nil }
            self.library = library
            self.asset = asset
        }
    }

    var isDone: Bool { step == "done" }
    var isFailed: Bool { step == "failed" }

    /// What is being done with the file; nil once it is ready (a state that is fine shows nothing).
    var line: String? {
        switch step {
        case "held": waiting == true ? "Waiting for the main computer" : "Copying to the main computer"
        case "computer": "Waiting to blur"
        case "blurring": "Blurring"
        case "failed": failed == "copy" ? "Could not copy to the main computer" : "Could not blur"
        default: nil
        }
    }

    /// Asks for a failed file again: its copy to the main computer by the library, its blur by Face Blur. A failed file
    /// is not read by itself (`IntakeWatch`): from here it is again, whatever the server said to this.
    @MainActor
    static func retry(part: String?, library: String, asset: String, version: String, api: API) async throws {
        defer { IntakeWatch.shared.watch([asset], library: library, api: api) }
        if part == "copy" {
            _ = try await api.send("/api/library/\(library)/assets/\(asset)/intake/retry")
        } else {
            _ = try await api.send("/api/x/blur-faces/auto/retry", json: ["versionId": version])
        }
    }
}

/// The intake of the clips on screen (a chat's files, the Upload tab's own): read when a screen shows them, and again
/// while one of them is on its way: 5 seconds after a read that changed something, twice as long after each that
/// changed nothing, up to a minute. It stops when none is on its way: a failed one waits for its Retry.
@MainActor
final class IntakeWatch: ObservableObject {
    static let shared = IntakeWatch()
    /// Seconds between two reads: the shortest, and the longest.
    static let quick = 5.0, slow = 60.0

    /// By clip (asset id): how far it is, as last read.
    @Published private(set) var steps: [String: Intake] = [:]
    /// The clips still on their way, with the library and the client they are asked by.
    private var wanted: [String: (library: String, api: API)] = [:]
    private var reading: Task<Void, Never>?
    /// How one library's clips are read; a test gives its own.
    var ask: (API, String, [String]) async throws -> [Intake] = { api, library, assets in
        (try await api.get("/api/library/\(library)/intake?assets=\(assets.joined(separator: ","))") as Intake.List).items
    }
    /// The wait between two reads, in seconds; a test gives its own.
    var pause: (Double) async -> Void = { try? await Task.sleep(for: .seconds($0)) }

    /// A screen shows these clips of one library, or one's Retry was pressed. One not asked about until now is read
    /// now, and the reads go on at the shortest wait while any is on its way.
    func watch(_ assets: [String], library: String, api: API?) {
        guard let api else { return }
        var fresh = false
        for asset in assets where steps[asset]?.isDone != true {
            if wanted[asset] == nil { fresh = true }
            wanted[asset] = (library, api)
        }
        guard fresh else { return }
        reading?.cancel()
        reading = Task { [weak self] in
            var wait = Self.quick
            while let self, !Task.isCancelled {
                let changed = await self.read()
                if Task.isCancelled { return }   // a newer run reads from here on
                guard !self.wanted.isEmpty else { break }
                wait = changed ? Self.quick : min(wait * 2, Self.slow)
                await self.pause(wait)
            }
            if !Task.isCancelled { self?.reading = nil }
        }
    }

    /// Waits until nothing is read any more (for a test).
    func settled() async { await reading?.value }

    /// One read of every library that has a clip on its way; true when a clip's step changed. Not asked about again:
    /// a clip that is ready, one that failed (until its Retry), one its library no longer lists (deleted), and every
    /// clip of a library the server refuses to read (deleted, or signed out). With no answer they are asked again.
    @discardableResult
    func read() async -> Bool {
        var changed = false
        for (library, clips) in Dictionary(grouping: wanted, by: { $0.value.library }) {
            let assets = clips.map(\.key).sorted().prefix(200)
            guard let api = clips.first?.value.api else { continue }
            let items: [Intake]
            do {
                items = try await ask(api, library, Array(assets))
            } catch {
                // (a read cut short by a newer one says nothing of its clips)
                if !Task.isCancelled, !AssistantUpload.waits(error) { for asset in assets { wanted[asset] = nil } }
                continue
            }
            for asset in assets {
                let item = items.first { $0.assetId == asset }
                if steps[asset] != item {
                    steps[asset] = item
                    changed = true
                }
                if item?.isDone != false || item?.isFailed == true { wanted[asset] = nil }
            }
        }
        return changed
    }
}
