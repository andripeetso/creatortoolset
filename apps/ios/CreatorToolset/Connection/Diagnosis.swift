import Foundation
import SwiftUI

/// A connection's state in words: the dot, the row's line, the notice over a screen.
enum ConnectionWords {
    enum Tone { case connected, connecting, reconnecting, offline, failed, available, unsupported }

    static func tone(_ state: ConnectionState) -> Tone {
        switch state.phase {
        case .available: return .available
        case .offline: return .offline
        case .connected: return .connected
        case .connecting: return state.attempt <= 1 && state.lastFailure == nil ? .connecting : .reconnecting
        case .backoff: return .reconnecting
        case .blocked: return state.lastFailure?.reason == .unsupported ? .unsupported : .failed
        }
    }

    static func color(_ tone: Tone) -> Color {
        switch tone {
        case .connected: .green
        case .connecting: .blue
        case .reconnecting: .orange
        case .offline, .failed: .red
        case .available, .unsupported: .gray
        }
    }

    static func label(_ tone: Tone) -> String {
        switch tone {
        case .connected: "Connected"
        case .connecting: "Connecting…"
        case .reconnecting: "Reconnecting…"
        case .offline: "Offline"
        case .failed: "Connection failed"
        case .available: "Available"
        case .unsupported: "Client not supported"
        }
    }

    /// The row's line: the reason rides with a failure.
    static func text(_ state: ConnectionState) -> String {
        let tone = tone(state)
        let reason = state.lastFailure?.detail
        switch tone {
        case .reconnecting: return reason.map { "Failed to connect. Reconnecting… Reason: \($0)" } ?? "Reconnecting…"
        case .failed: return reason.map { "Connection failed. Reason: \($0)" } ?? "Connection failed"
        default: return label(tone)
        }
    }

    /// The header's line, shown only once a state has lasted `ConnectionTiming.headerDelay` (nil: nothing to say).
    static func header(_ entries: [ServerEntry], states: [String: ConnectionState], offline: Bool, now: Date = Date()) -> String? {
        let enabled = entries.filter(\.enabled)
        guard !enabled.isEmpty else { return nil }
        if offline { return "You are offline" }
        let settled = { (s: ConnectionState) in now.timeIntervalSince(s.since) >= ConnectionTiming.headerDelay }
        let down = enabled.filter { e in
            let s = states[e.serverId] ?? ConnectionState()
            return s.phase != .connected && settled(s)
        }
        if down.isEmpty { return nil }
        let reconnecting = down.filter { [.connecting, .backoff].contains((states[$0.serverId] ?? ConnectionState()).phase) }
        if reconnecting.count == 1 { return "Reconnecting to \(reconnecting[0].label)" }
        if reconnecting.count > 1 { return "Reconnecting \(reconnecting.count) computers" }
        return "Not connected"
    }

    /// The full-screen notice when a screen can't load from a server.
    static func notice(_ label: String, _ state: ConnectionState, offline: Bool, thing: String) -> (title: String, detail: String)? {
        if offline { return ("You are offline", "Saved data stays available. The \(thing) will load when your connection returns.") }
        switch tone(state) {
        case .connected: return nil
        case .connecting: return ("Connecting to \(label)…", "The \(thing) will load as soon as the computer is ready.")
        case .reconnecting: return ("Reconnecting to \(label)…", "The app will keep retrying automatically." + (state.lastFailure.map { " \($0.detail)" } ?? ""))
        case .unsupported: return ("Client not supported", "Use compatible versions of the app and server to connect.")
        case .failed: return ("\(label) is unavailable", state.lastFailure?.detail ?? "Reconnect the computer to load the \(thing).")
        case .available, .offline: return ("\(label) is disconnected", "Reconnect the computer to load the \(thing).")
        }
    }
}

/// What failed on the way to a computer, in order, and what to try.
struct ConnectionDiagnosis: Equatable {
    enum Result: Equatable { case ok, failed, unchecked }

    struct Hop: Equatable {
        let hop: ConnectionFailure.Hop
        let label: String
        let result: Result
    }

    let headline: String
    let hops: [Hop]
    let steps: [String]
    let facts: [(String, String)]

    static func == (a: Self, b: Self) -> Bool {
        a.headline == b.headline && a.hops == b.hops && a.steps == b.steps && a.facts.map { "\($0.0)=\($0.1)" } == b.facts.map { "\($0.0)=\($0.1)" }
    }

    struct Input {
        var host: String
        var state: ConnectionState
        /// The computer's usual way in, when the failure doesn't name one.
        var via: ConnectionFailure.Via
        /// The connect service's last health check, which can name a cause before any connect attempt.
        var accountStatus: AccountComputer?
        var appVersion: String?
        var serverVersion: String?
    }

    private struct Located {
        let hop: ConnectionFailure.Hop
        let cause: String?
        var guessed = false
    }

    private static func locate(_ input: Input) -> Located? {
        let failure = input.state.lastFailure
        if input.state.networkOffline || input.state.phase == .offline { return Located(hop: .device, cause: "offline") }
        if failure?.updateRequired == true { return Located(hop: .server, cause: "outdated") }
        if let failure, let hop = failure.hop { return Located(hop: hop, cause: failure.cause) }
        if let failure {
            let unreachable = [.network, .timeout, .transport].contains(failure.reason)
            return Located(hop: unreachable && (failure.via ?? input.via) == .account ? .tunnel : .server, cause: nil, guessed: true)
        }
        guard let status = input.accountStatus, status.status == .offline else { return nil }
        if status.offlineReason == "tunnel_released" { return Located(hop: .tunnel, cause: "released") }
        let cause = status.endpointFailure
        return Located(hop: ["origin_unreachable", "invalid_response"].contains(cause ?? "") ? .server : .tunnel, cause: cause)
    }

    private static func headline(_ host: String, _ located: Located, _ failure: ConnectionFailure?) -> String {
        switch located.cause {
        case "offline": return "This phone is offline"
        case "outdated": return "\(host) runs an older Creator Toolset"
        case "clock_skew": return "This phone's clock is off"
        case "not_linked": return "\(host) is not linked to your account"
        case "relay_error": return "The connect service returned an error"
        case "tunnel_pending": return "\(host)'s tunnel is still being set up"
        case "released", "tunnel_down": return "\(host)'s tunnel is offline"
        case "origin_unreachable": return "Tunnel works, but Creator Toolset on \(host) did not answer"
        case "invalid_response": return "Creator Toolset on \(host) sent an unexpected answer"
        case "dns": return "\(host)'s address did not resolve"
        case "tls": return "Secure connection to \(host) failed"
        case "refused": return "\(host) refused the connection"
        case "timeout": return "\(host) did not answer in time"
        default: break
        }
        let onThisPhone = [.network, .transport, .timeout].contains(failure?.reason)
        switch located.hop {
        case .device: return "This phone could not prepare the connection"
        case .account: return failure?.reason == .authentication ? "Your account did not accept this phone's sign-in" : "This phone can't reach your account"
        case .tunnel: return onThisPhone ? "This phone can't reach \(host)'s tunnel" : "Your account could not reach \(host)'s tunnel"
        case .server:
            return [.authentication, .permission].contains(failure?.reason) ? "Creator Toolset on \(host) did not accept this phone"
                : "Creator Toolset on \(host) did not answer"
        }
    }

    private static func steps(_ host: String, _ located: Located, _ failure: ConnectionFailure?) -> [String] {
        let checkHost = "On \(host), open Creator Toolset → Settings → Computers and check Reach from anywhere."
        switch located.cause {
        case "offline": return ["Connect this phone to the internet. Creator Toolset reconnects on its own."]
        case "outdated": return ["Update Creator Toolset on \(host)."]
        case "clock_skew": return ["Turn on automatic date and time on this phone and on \(host), then retry."]
        case "not_linked": return ["Check that this phone is signed in to the same account as \(host).", checkHost]
        case "tunnel_pending": return ["Wait a minute. Creator Toolset retries on its own.", checkHost]
        case "relay_error": return ["Wait a few minutes. Creator Toolset retries on its own.", "If it keeps failing, copy the details and report it."]
        case "released", "tunnel_down":
            return ["Make sure \(host) is awake and Creator Toolset is running on it.", checkHost,
                    "A VPN exit node on \(host) can block the tunnel (port 7844). Turn it off or allow the tunnel."]
        case "origin_unreachable", "invalid_response": return ["Open or restart Creator Toolset on \(host).", checkHost]
        case "dns", "tls", "refused", "timeout": return ["Make sure \(host) is awake and online.", checkHost]
        default: break
        }
        let onThisPhone = [.network, .transport, .timeout].contains(failure?.reason)
        switch located.hop {
        case .device: return ["Close and open Creator Toolset on this phone.", "If it keeps failing, remove \(host) from this phone and add it again."]
        case .account:
            return failure?.reason == .authentication ? ["Sign out of your account on this phone and sign in again."]
                : ["Check this phone's internet connection.", "A VPN, firewall, or ad blocker on this phone can block the connect service."]
        case .tunnel:
            return onThisPhone ? ["A VPN, firewall, or DNS filter on this phone can block the tunnel.",
                                  "Try another network, or add a direct route such as a tailnet address."]
                : ["Make sure \(host) is awake and online.", checkHost]
        case .server:
            if [.authentication, .permission].contains(failure?.reason) {
                return ["Pair this phone again: on \(host), Settings → Computers → Create link.", "Retry. If it keeps failing, copy the details."]
            }
            return ["Make sure Creator Toolset is running on \(host).", "Retry. If it keeps failing, copy the details."]
        }
    }

    private static func label(_ hop: ConnectionFailure.Hop, _ host: String) -> String {
        switch hop {
        case .device: "This device"
        case .account: "Account"
        case .tunnel: "\(host) tunnel"
        case .server: "Creator Toolset on \(host)"
        }
    }

    /// Nil when nothing has failed.
    static func make(_ input: Input) -> ConnectionDiagnosis? {
        guard let located = locate(input) else { return nil }
        let failure = input.state.lastFailure
        let accountPath = located.hop == .account || located.hop == .tunnel
            || (failure == nil && input.accountStatus?.status == .offline) || (failure?.via ?? input.via) == .account
        let order: [ConnectionFailure.Hop] = accountPath ? [.device, .account, .tunnel, .server] : [.device, .server]
        let failedIndex = order.firstIndex(of: located.hop) ?? 0
        let hops = order.enumerated().map { index, hop in
            Hop(hop: hop, label: label(hop, input.host),
                result: index == failedIndex ? .failed : index < failedIndex && !located.guessed ? .ok : .unchecked)
        }
        var facts: [(String, String)] = []
        func add(_ label: String, _ value: String?) { if let value, !value.isEmpty { facts.append((label, value)) } }
        add("Cause", located.cause ?? failure?.reason.rawValue)
        add("HTTP status", failure?.httpStatus.map(String.init))
        add("Attempts", input.state.attempt > 0 ? String(input.state.attempt) : nil)
        add("Next retry", input.state.retryAt.map { $0.formatted(date: .omitted, time: .standard) })
        add("Route", accountPath ? "Account" : "Direct")
        add("App version", input.appVersion)
        add("Computer version", input.serverVersion)
        add("Error", failure?.detail)
        add("Trace ID", failure?.traceId ?? input.accountStatus?.traceId)
        return ConnectionDiagnosis(headline: headline(input.host, located, failure), hops: hops,
                                   steps: steps(input.host, located, failure), facts: facts)
    }

    /// One plain-text block to copy into a report.
    func text(_ host: String) -> String {
        let marks: [Result: String] = [.ok: "ok", .failed: "FAILED", .unchecked: "not checked"]
        return (["Creator Toolset connection to \(host): \(headline)", ""] + hops.map { "\($0.label): \(marks[$0.result]!)" }
                + [""] + facts.map { "\($0.0): \($0.1)" }).joined(separator: "\n")
    }
}

/// The checklist: ✓ This device · ✓ Account · ✕ {Mac} tunnel · – Creator Toolset on {Mac}, then what to try and the
/// details to copy.
struct DiagnosisView: View {
    let host: String
    let diagnosis: ConnectionDiagnosis

    var body: some View {
        Section {
            Text(diagnosis.headline).font(.headline)
            ForEach(diagnosis.hops, id: \.label) { hop in
                HStack {
                    Image(systemName: hop.result == .ok ? "checkmark.circle.fill" : hop.result == .failed ? "xmark.circle.fill" : "minus.circle")
                        .foregroundStyle(hop.result == .ok ? .green : hop.result == .failed ? .red : .secondary)
                    Text(hop.label)
                    Spacer()
                    Text(hop.result == .ok ? "OK" : hop.result == .failed ? "Failed" : "Not checked")
                        .font(.caption).foregroundStyle(.secondary)
                }
                .accessibilityElement(children: .combine)
            }
        }
        Section("What to try") {
            ForEach(Array(diagnosis.steps.enumerated()), id: \.offset) { index, step in
                HStack(alignment: .firstTextBaseline) {
                    Text("\(index + 1).").foregroundStyle(.secondary).monospacedDigit()
                    Text(step)
                }
            }
        }
        Section("Details") {
            ForEach(diagnosis.facts, id: \.0) { fact in
                LabeledContent(fact.0) { Text(fact.1).textSelection(.enabled).multilineTextAlignment(.trailing) }
            }
            Button("Copy details", systemImage: "doc.on.doc") { UIPasteboard.general.string = diagnosis.text(host) }
            if let trace = diagnosis.facts.first(where: { $0.0 == "Trace ID" })?.1 {
                Button("Copy trace ID", systemImage: "number") { UIPasteboard.general.string = trace }
            }
        }
    }
}
