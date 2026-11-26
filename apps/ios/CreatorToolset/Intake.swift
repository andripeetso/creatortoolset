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

    /// Asks for a failed file again: its copy to the main computer by the library, its blur by Face Blur.
    static func retry(part: String?, library: String, asset: String, version: String, api: API) async throws {
        if part == "copy" {
            _ = try await api.send("/api/library/\(library)/assets/\(asset)/intake/retry")
        } else {
            _ = try await api.send("/api/x/blur-faces/auto/retry", json: ["versionId": version])
        }
    }
}

/// The intake of the clips on screen (a chat's files, the Upload tab's own): read when a screen shows them, and again
/// every few seconds while one of them is on its way and the app is open.
@MainActor
final class IntakeWatch: ObservableObject {
    static let shared = IntakeWatch()

    /// By clip (asset id): how far it is, as last read.
    @Published private(set) var steps: [String: Intake] = [:]
    /// The clips still on their way, with the library and the client they are asked by.
    private var wanted: [String: (library: String, api: API)] = [:]
    private var reading: Task<Void, Never>?
    /// How one library's clips are read; a test gives its own.
    var ask: (API, String, [String]) async -> [Intake]? = { api, library, assets in
        (try? await api.get("/api/library/\(library)/intake?assets=\(assets.joined(separator: ","))") as Intake.List)?.items
    }

    /// A screen shows these clips of one library: they are read now, and again while any is on its way.
    func watch(_ assets: [String], library: String, api: API?) {
        guard let api else { return }
        for asset in assets where steps[asset]?.isDone != true { wanted[asset] = (library, api) }
        guard reading == nil, !wanted.isEmpty else { return }
        reading = Task { [weak self] in
            while let self, !Task.isCancelled, !self.wanted.isEmpty {
                await self.read()
                try? await Task.sleep(for: .seconds(5))
            }
            self?.reading = nil
        }
    }

    /// One read of every library that has a clip on its way. A clip that is ready, or that its library no longer
    /// lists (deleted), is not asked about again.
    func read() async {
        for (library, clips) in Dictionary(grouping: wanted, by: { $0.value.library }) {
            let assets = clips.map(\.key).sorted().prefix(200)
            guard let api = clips.first?.value.api, let items = await ask(api, library, Array(assets)) else { continue }
            for asset in assets {
                let item = items.first { $0.assetId == asset }
                if steps[asset] != item { steps[asset] = item }
                if item?.isDone != false { wanted[asset] = nil }
            }
        }
    }
}
