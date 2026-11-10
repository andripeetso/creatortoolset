// A copy of the app beside the released one. A bundle id that extends the released id (com.creatortoolset.mac.fresh,
// scripts/fresh-user.sh's first-run copy) gets its own Keychain services, data folder, logs, recordings folder and
// server port, so it never reads or overwrites the released app's data. Every other id, the released one and a build
// with its own BUNDLE_ID alike, keeps the names the app has always used.
import Foundation

enum AppIdentity {
    static let released = "com.creatortoolset.mac"
    static let bundleID = Bundle.main.bundleIdentifier ?? released

    /// The copy's name: "fresh" for com.creatortoolset.mac.fresh, nil for any id that is not a copy.
    static func copy(_ id: String = bundleID) -> String? {
        id.hasPrefix(released + ".") && id.count > released.count + 1 ? String(id.dropFirst(released.count + 1)) : nil
    }

    /// "" for the app itself; " (fresh)" for the copy. Appended to "Creator Toolset" in folder and log names.
    static func tag(_ id: String = bundleID) -> String { copy(id).map { " (\($0))" } ?? "" }

    /// The Keychain service for one kind of secret: "server", "account", "device" or "env".
    static func keychain(_ kind: String, _ id: String = bundleID) -> String { "\(copy(id) == nil ? released : id).\(kind)" }

    /// The server's default port: 43128, or the next one for a copy.
    static func port(_ id: String = bundleID) -> Int { copy(id) == nil ? 43128 : 43129 }
}
