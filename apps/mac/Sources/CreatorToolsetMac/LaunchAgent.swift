// Runs a LaunchAgent on this Mac for a pill row's button (Activity.swift): start, stop or restart. The server sends only
// the labels a plug-in declared (api/activity.ts cleanActions), and this file checks the verb and the label's shape again.
import Foundation

enum LaunchAgent {
    /// What a button may ask for; any other word is refused.
    static let verbs = ["start", "stop", "restart"]

    /// A reverse-DNS label: letters, digits, dots, dashes and underscores, not empty, not long.
    static func isValid(_ label: String) -> Bool {
        !label.isEmpty && label.count <= 200 && label.allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber || ".-_".contains($0)) }
    }

    /// The launchctl arguments for a verb on one agent of the user's session (`uid`), or nil for a bad verb or label.
    /// start loads the agent's plist from ~/Library/LaunchAgents; stop unloads it; restart kicks it (-k: a fresh copy).
    static func arguments(verb: String, label: String, uid: uid_t, home: String = NSHomeDirectory()) -> [String]? {
        guard verbs.contains(verb), isValid(label) else { return nil }
        let domain = "gui/\(uid)"
        switch verb {
        case "start": return ["bootstrap", domain, "\(home)/Library/LaunchAgents/\(label).plist"]
        case "stop": return ["bootout", "\(domain)/\(label)"]
        default: return ["kickstart", "-k", "\(domain)/\(label)"]
        }
    }

    /// Runs the verb through /bin/launchctl and returns nil on success, or a line for the panel when it failed.
    static func run(verb: String, label: String) -> String? {
        guard let args = arguments(verb: verb, label: label, uid: getuid()) else { return "This button can't run here." }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/launchctl")
        process.arguments = args
        process.standardOutput = FileHandle.nullDevice
        let errors = Pipe()
        process.standardError = errors
        do { try process.run() } catch { return "launchctl: \(error.localizedDescription)" }
        let text = String(decoding: errors.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
        process.waitUntilExit()
        if process.terminationStatus == 0 { return nil }
        let line = text.split(separator: "\n").last.map(String.init) ?? "exit \(process.terminationStatus)"
        return "\(verb) failed: \(line)"
    }
}
