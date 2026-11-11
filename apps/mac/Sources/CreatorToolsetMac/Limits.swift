// The plan limits of the Claude and Codex CLIs on this Mac (POST /api/devices/relay/limits): each config folder's
// login is read in memory, its usage page is asked, and the percent used and the reset of each window are posted to
// the site every 5 minutes. Tokens stay in memory: never in a log line, an error, a file or the request body.
import CryptoKit
import Foundation

/// The usage pages the CLIs read themselves (undocumented). Each takes that login's own access token; it is never refreshed here.
let claudeUsageURL = "https://api.anthropic.com/api/oauth/usage"
let codexUsageURL = "https://chatgpt.com/backend-api/wham/usage"

/// The limits at start and then this often (seconds).
let limitsInterval = 300

/// The opt-in per Mac (UserDefaults): off by default. Reading the limits uses the Claude login in the keychain and the
/// undocumented usage pages, so nothing is read or called until the owner of this Mac turns it on (Settings → This Mac).
let limitsReadingKey = "limitsReading"
func limitsReadingOn(_ defaults: UserDefaults = .standard) -> Bool { defaults.bool(forKey: limitsReadingKey) }

/// Codex window names by seconds.
let codexLabels: [Double: String] = [18000: "Session", 604800: "Weekly", 2592000: "Monthly"]

/// A JSON number (not true or false), or nil.
func jsonNumber(_ value: Any?) -> Double? {
    guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() else { return nil }
    return number.doubleValue
}

/// An ISO time (Claude's resets_at) as epoch ms, or nil.
func isoEpochMs(_ value: Any?) -> Int? {
    guard let text = value as? String else { return nil }
    let fractional = ISO8601DateFormatter()
    fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    let plain = ISO8601DateFormatter()
    plain.formatOptions = [.withInternetDateTime]
    guard let date = fractional.date(from: text) ?? plain.date(from: text) else { return nil }
    return Int(date.timeIntervalSince1970 * 1000)
}

/// "opus" -> "Opus", "claude_x" -> "Claude X": underscores become spaces, each word capitalised.
func titleWords(_ suffix: String) -> String {
    suffix.replacingOccurrences(of: "_", with: " ")
        .split(separator: " ")
        .map { $0.prefix(1).uppercased() + $0.dropFirst() }
        .joined(separator: " ")
}

/// Claude's windows: five_hour, seven_day, then each other seven_day_<model> object with a utilization (sorted by key).
func claudeWindows(_ body: [String: Any]) -> [[String: Any]] {
    let day = 7 * 86400 * 1000
    var specs: [(key: String, label: String, kind: String, windowMs: Int)] = [
        ("five_hour", "Session", "session", 5 * 3600 * 1000),
        ("seven_day", "Weekly", "weekly", day),
    ]
    for key in body.keys.sorted() where key.hasPrefix("seven_day_") && key != "seven_day_overage_included" {
        let suffix = String(key.dropFirst("seven_day_".count))
        specs.append((key, "Weekly · " + titleWords(suffix), "weekly", day))
    }
    var out: [[String: Any]] = []
    for spec in specs {
        guard let window = body[spec.key] as? [String: Any], let used = jsonNumber(window["utilization"]) else { continue }
        var row: [String: Any] = [
            "id": spec.key, "label": spec.label, "kind": spec.kind,
            "usedPercent": min(100, max(0, used)), "windowMs": spec.windowMs,
        ]
        if let reset = isoEpochMs(window["resets_at"]) { row["resetsAt"] = reset }
        out.append(row)
    }
    return out
}

/// Codex's label for a window of `seconds`: Session, Weekly, Monthly, else "<hours>-hour", else "Limit".
func codexLabel(seconds: Double?) -> String {
    if let s = seconds, let known = codexLabels[s] { return known }
    if let s = seconds, s != 0 { return "\(Int((s / 3600).rounded(.toNearestOrEven)))-hour" }
    return "Limit"
}

/// Codex's kind for a window of `seconds`: monthly from 30 days, weekly from 7 days, else session.
func codexKind(seconds: Double?) -> String {
    guard let s = seconds else { return "session" }
    if s >= 2592000 { return "monthly" }
    if s >= 604800 { return "weekly" }
    return "session"
}

/// Codex's primary and secondary windows from rate_limit (reset_at in seconds, limit_window_seconds in seconds).
func codexWindows(_ body: [String: Any]) -> [[String: Any]] {
    let limit = (body["rate_limit"] as? [String: Any]) ?? [:]
    var out: [[String: Any]] = []
    for (id, key) in [("primary", "primary_window"), ("secondary", "secondary_window")] {
        guard let window = limit[key] as? [String: Any], let used = jsonNumber(window["used_percent"]) else { continue }
        let seconds = jsonNumber(window["limit_window_seconds"])
        var row: [String: Any] = [
            "id": id, "label": codexLabel(seconds: seconds), "kind": codexKind(seconds: seconds),
            "usedPercent": min(100, max(0, used)),
        ]
        if let reset = jsonNumber(window["reset_at"]) { row["resetsAt"] = Int(reset * 1000) }
        if let s = seconds { row["windowMs"] = Int(s * 1000) }
        out.append(row)
    }
    return out
}

/// The keychain item for a config folder: "Claude Code-credentials-" + the first 8 hex digits of SHA-256 of the path.
func claudeKeychainService(home: String) -> String {
    let hex = SHA256.hash(data: Data(home.utf8)).map { String(format: "%02x", $0) }.joined()
    return "Claude Code-credentials-" + String(hex.prefix(8))
}

/// A generic password's JSON value from the login keychain, read through `security ... -w` into memory only. nil on any failure.
private func keychainJSON(service: String) -> [String: Any]? {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/security")
    process.arguments = ["find-generic-password", "-s", service, "-w"]
    let out = Pipe()
    process.standardOutput = out
    process.standardError = FileHandle.nullDevice
    process.standardInput = FileHandle.nullDevice
    do { try process.run() } catch { return nil }
    let deadline = Date().addingTimeInterval(5)
    while process.isRunning && Date() < deadline { Thread.sleep(forTimeInterval: 0.02) }
    if process.isRunning {
        process.terminate()
        return nil
    }
    guard process.terminationStatus == 0 else { return nil }
    let data = out.fileHandleForReading.readDataToEndOfFile()
    return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
}

/// Claude Code's access token for one config folder: the keychain item named for the folder's path, and for the
/// default folder the unsuffixed item when that one has no login. nil when there is no login or no token.
func claudeLogin(home: String) -> String? {
    func oauth(_ item: [String: Any]?) -> [String: Any]? { item?["claudeAiOauth"] as? [String: Any] }
    var login = oauth(keychainJSON(service: claudeKeychainService(home: home)))
    if login == nil, home == FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".claude").path {
        login = oauth(keychainJSON(service: "Claude Code-credentials"))
    }
    guard let token = login?["accessToken"] as? String, !token.isEmpty else { return nil }
    return token
}

/// Codex's ChatGPT login in one folder (auth.json's tokens): the access token and the account id when there is one.
func codexLogin(home: String) -> (token: String, accountId: String?)? {
    let url = URL(fileURLWithPath: home).appendingPathComponent("auth.json")
    guard let data = try? Data(contentsOf: url),
          let root = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
          let tokens = root["tokens"] as? [String: Any],
          let token = tokens["access_token"] as? String, !token.isEmpty else { return nil }
    let account = (tokens["account_id"] as? String).flatMap { $0.isEmpty ? nil : $0 }
    return (token, account)
}

/// A usage page's answer: 401 or 403 = signed out (the CLI signs in again; never refreshed here), 200 with a JSON object = ok,
/// anything else = an error: "HTTP <code>", or "no answer" when no reply came.
func readingState(status: Int, body: [String: Any]?) -> (state: String, error: String?) {
    if status == 401 || status == 403 { return ("signed_out", nil) }
    if status == 200, body != nil { return ("ok", nil) }
    return ("error", status == 0 ? "no answer" : "HTTP \(status)")
}

/// A GET to a usage page: the HTTP status (0 = no answer) and its JSON object. Errors never carry the headers.
private func usageGET(_ urlString: String, headers: [String: String]) -> (status: Int, body: [String: Any]?) {
    guard let url = URL(string: urlString) else { return (0, nil) }
    var request = URLRequest(url: url, timeoutInterval: 15)
    for (name, value) in headers { request.setValue(value, forHTTPHeaderField: name) }
    final class Slot {
        var status = 0
        var body: [String: Any]?
    }
    let slot = Slot()
    let done = DispatchSemaphore(value: 0)
    URLSession.shared.dataTask(with: request) { data, response, error in
        if error == nil, let http = response as? HTTPURLResponse {
            slot.status = http.statusCode
            slot.body = data.flatMap { (try? JSONSerialization.jsonObject(with: $0)) as? [String: Any] }
        }
        done.signal()
    }.resume()
    _ = done.wait(timeout: .now() + 20)
    return (slot.status, slot.body)
}

/// One folder's reading: its state, an error when there is one, and its windows (only when ok).
typealias LimitReading = (state: String, error: String?, windows: [[String: Any]])

private func finish(_ reply: (status: Int, body: [String: Any]?), windows: ([String: Any]) -> [[String: Any]]) -> LimitReading {
    let reading = readingState(status: reply.status, body: reply.body)
    guard reading.state == "ok", let body = reply.body else { return (reading.state, reading.error, []) }
    return (reading.state, nil, windows(body))
}

private func claudeReading(home: String) -> LimitReading {
    guard let token = claudeLogin(home: home) else { return ("no_login", nil, []) }
    let reply = usageGET(claudeUsageURL, headers: [
        "Authorization": "Bearer " + token, "anthropic-beta": "oauth-2025-04-20", "User-Agent": "creator-toolset",
    ])
    return finish(reply, windows: claudeWindows)
}

private func codexReading(home: String) -> LimitReading {
    guard let login = codexLogin(home: home) else { return ("no_login", nil, []) }
    var headers = ["Authorization": "Bearer " + login.token, "User-Agent": "creator-toolset"]
    if let account = login.accountId { headers["ChatGPT-Account-Id"] = account }
    return finish(usageGET(codexUsageURL, headers: headers), windows: codexWindows)
}

/// The identities for the limits post: each Claude and Codex folder from homeReport, with its label and reading.
/// With the opt-in off this returns none, and no keychain item or usage page is touched.
func limitsReport(home: URL, now: Date = Date(), enabled: Bool = limitsReadingOn()) -> [[String: Any]] {
    _ = now   // the pass's time is stamped by limitsForever (`at`)
    guard enabled else { return [] }
    var out: [[String: Any]] = []
    for row in homeReport(home: home) {
        guard let driver = row["driver"] as? String, let path = row["home"] as? String else { continue }
        let name = URL(fileURLWithPath: path).lastPathComponent
        let isDefault = path == home.appendingPathComponent("." + driver).path
        let prefix = ".claude-"
        let label = isDefault ? "default" : (name.hasPrefix(prefix) ? String(name.dropFirst(prefix.count)) : name)
        let reading = driver == "claude" ? claudeReading(home: path) : codexReading(home: path)
        var identity: [String: Any] = [
            "driver": driver, "home": path, "isDefault": isDefault, "label": label,
            "state": reading.state, "windows": reading.windows,
        ]
        if let error = reading.error { identity["error"] = error }
        out.append(identity)
    }
    return out
}

/// The limits now and then every 5 minutes, until `stopped` says so. A failed pass is logged
/// (no tokens) and the loop goes on. A site without the route answers 404, which is ignored.
/// With the opt-in off each pass posts an empty list, so readings sent before the switch-off leave the site too.
func limitsForever(api: DeviceAPI, home: URL, stopped: () -> Bool, enabled: () -> Bool = { limitsReadingOn() }) {
    while !stopped() {
        do {
            let now = Date()
            let reply = try api.call("POST", "/api/devices/relay/limits",
                                     ["at": Int(now.timeIntervalSince1970 * 1000), "identities": limitsReport(home: home, now: now, enabled: enabled())], tries: 2)
            if !(200..<300).contains(reply.status) && reply.status != 404 {
                AppLog.write("relay limits: HTTP \(reply.status)")
            }
        } catch {
            AppLog.write("relay limits: \(error.localizedDescription)")
        }
        // switched on or off meanwhile: the next pass goes now, so a Turn on shows a reading at once
        let was = enabled()
        for _ in 0..<limitsInterval where !stopped() && enabled() == was {
            Thread.sleep(forTimeInterval: 1)
        }
    }
}
