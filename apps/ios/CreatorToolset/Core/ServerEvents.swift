import Foundation

/// The server's own "something changed" line (server-sent events), read for as long as someone
/// listens. The server sends no data on it, only that a thing changed; the screen then reads
/// that thing again. A dropped line is opened again by itself, a little later each time.
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
                        var parser = Parser()
                        for try await line in bytes.lines {
                            if let event = parser.take(line) { continuation.yield(event) }
                        }
                    } catch {
                        // a dropped line, no network, a server restart: open it again
                    }
                    try? await Task.sleep(for: .seconds(wait))
                    wait = min(wait * 2, 30)
                }
                continuation.finish()
            }
            continuation.onTermination = { _ in task.cancel() }
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
