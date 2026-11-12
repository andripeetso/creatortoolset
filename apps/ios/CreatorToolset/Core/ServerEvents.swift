import Foundation
import UIKit

/// The server's own "something changed" line (server-sent events), read for as long as someone
/// listens. The server sends no data on it, only that a thing changed; the screen then reads
/// that thing again. A dropped line is opened again by itself, a little later each time.
/// No line stays open while the app is in the background: the server takes an open one to mean
/// someone is watching, and holds a notification back. It opens again when the app is back, and
/// its first "hello" tells every reader to read again.
///
///     for await event in ServerEvents.stream("/api/sync/events") where event.name == "change" { … }
enum ServerEvents {
    struct Event: Equatable {
        /// "change", "hello", "ping", "changed"…
        let name: String
        /// The event's data as it came (JSON on the sync line, an id on the AI Editor's).
        let data: String

        /// A field of JSON data, e.g. the topic of a change.
        func field(_ key: String) -> String? {
            guard let object = (try? JSONSerialization.jsonObject(with: Data(data.utf8))) as? [String: Any] else { return nil }
            return object[key] as? String
        }
    }

    /// Ends when the task that reads it is cancelled (a SwiftUI `.task` does that when its screen goes).
    static func stream(_ path: String) -> AsyncStream<Event> {
        AsyncStream { continuation in
            let task = Task {
                var wait = 1.0
                while !Task.isCancelled {
                    await Presence.shared.arrive()
                    if Task.isCancelled { break }
                    guard let api = ToolsetAPI.current else {
                        try? await Task.sleep(for: .seconds(5))
                        continue
                    }
                    var request = api.request(path)
                    request.timeoutInterval = 3600
                    request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
                    do {
                        let (bytes, response) = try await ToolsetAPI.slow.bytes(for: request)
                        guard (response as? HTTPURLResponse)?.statusCode == 200 else { throw URLError(.badServerResponse) }
                        wait = 1
                        // ended the moment the app leaves the front (at once when it already has)
                        await Presence.shared.opened(bytes.task)
                        defer { Task { @MainActor in Presence.shared.closed(bytes.task) } }
                        var parser = Parser()
                        for try await line in bytes.lines {
                            if let event = parser.take(line) { continuation.yield(event) }
                        }
                    } catch {
                        // a dropped line, no network, a server restart: open it again
                    }
                    // closed because the app left: it opens the moment the app is back, with no pause
                    if await Presence.shared.away { continue }
                    try? await Task.sleep(for: .seconds(wait))
                    wait = min(wait * 2, 30)
                }
                continuation.finish()
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    /// Whether the app is in front, for every open line at once.
    @MainActor
    final class Presence {
        static let shared: Presence = {
            let presence = Presence(away: UIApplication.shared.applicationState == .background)
            let center = NotificationCenter.default
            center.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { _ in
                MainActor.assumeIsolated { presence.left() }
            }
            for name in [UIApplication.willEnterForegroundNotification, UIApplication.didBecomeActiveNotification] {
                center.addObserver(forName: name, object: nil, queue: .main) { _ in
                    MainActor.assumeIsolated { presence.came() }
                }
            }
            return presence
        }()

        /// In the background (an app iOS started there has never been in front): no line may be open.
        private(set) var away: Bool
        private var open: [URLSessionTask] = []
        private var waiting: [CheckedContinuation<Void, Never>] = []

        init(away: Bool) { self.away = away }

        /// The app left the front: every open line ends.
        func left() {
            away = true
            open.forEach { $0.cancel() }
            open = []
        }

        /// The app is in front (again): the lines that waited open.
        func came() {
            away = false
            waiting.forEach { $0.resume() }
            waiting = []
        }

        /// Returns once a line may be opened: at once in front, else when the app comes back.
        func arrive() async {
            while away { await withCheckedContinuation { waiting.append($0) } }
        }

        /// A line that opened; one that opened just as the app left ends at once.
        func opened(_ line: URLSessionTask) {
            if away { line.cancel() } else { open.append(line) }
        }

        func closed(_ line: URLSessionTask) {
            open.removeAll { $0 === line }
        }
    }

    /// Lines into events. `URLSession.bytes.lines` drops the empty line that ends an event, so an
    /// event is complete at its `data:` line (the server writes `event:` first, one `data:` line each).
    struct Parser {
        private var name = "message"

        mutating func take(_ line: String) -> Event? {
            if line.hasPrefix("event:") {
                name = line.dropFirst(6).trimmingCharacters(in: .whitespaces)
                return nil
            }
            guard line.hasPrefix("data:") else { return nil }
            defer { name = "message" }
            return Event(name: name, data: line.dropFirst(5).trimmingCharacters(in: .whitespaces))
        }
    }
}
