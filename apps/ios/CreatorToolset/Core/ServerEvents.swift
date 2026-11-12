import Foundation
import UIKit

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
    /// While the app is in the background the line is closed, and opened again on return (a "hello" then says
    /// read again): the server counts an open line as someone watching, and pushes only to no one watching.
    static func stream(_ path: String) -> AsyncStream<Event> {
        AsyncStream { continuation in
            let task = Task {
                var wait = 1.0
                while !Task.isCancelled {
                    await untilInFront()
                    guard let api = ToolsetAPI.current else {
                        try? await Task.sleep(for: .seconds(5))
                        continue
                    }
                    var request = api.request(path)
                    request.timeoutInterval = 3600
                    request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
                    let opened = Date()
                    do {
                        try await withThrowingTaskGroup(of: Void.self) { group in
                            group.addTask {
                                let (bytes, response) = try await ToolsetAPI.slow.bytes(for: request)
                                guard (response as? HTTPURLResponse)?.statusCode == 200 else { throw URLError(.badServerResponse) }
                                var parser = Parser()
                                for try await line in bytes.lines {
                                    if let event = parser.take(line) { continuation.yield(event) }
                                }
                            }
                            group.addTask {
                                // the app went to the background: close the line
                                for await _ in NotificationCenter.default.notifications(named: UIApplication.didEnterBackgroundNotification) { return }
                            }
                            try await group.next()
                            group.cancelAll()
                        }
                        wait = 1
                    } catch {
                        // a dropped line, no network, a server restart: open it again
                    }
                    if Date().timeIntervalSince(opened) > 30 { wait = 1 }   // it was open a while: not a line that keeps failing
                    try? await Task.sleep(for: .seconds(wait))
                    wait = min(wait * 2, 30)
                }
                continuation.finish()
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    /// Returns at once in front; in the background, when the app comes back.
    // ponytail: a return in the moment between the look and the wait is missed until the next one
    private static func untilInFront() async {
        guard await UIApplication.shared.applicationState == .background else { return }
        for await _ in NotificationCenter.default.notifications(named: UIApplication.willEnterForegroundNotification) { return }
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
