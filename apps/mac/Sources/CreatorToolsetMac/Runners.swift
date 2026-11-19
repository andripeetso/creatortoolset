// One runner per server this Mac is signed in to and switched on for, whatever the window shows (Shell.swift). Each
// server has its own device runner (Relay.swift) and its own worker (Worker.swift); the workers' jobs take one Mac-wide
// turn, so this Mac still runs one worker job at a time.
import Combine
import Foundation

/// What a server's runner does for the app; the device runner (RelayRunner) in the app, a fake in the tests.
protocol HostRelay: AnyObject {
    var isStopped: Bool { get }
    func start()
    func stop()
    func reportNow()
    func modelsChanged()
}

extension RelayRunner: HostRelay {}

/// The servers whose runner runs: switched on, paired (a token), and This Mac's own server only while it runs.
func runnerHosts(listed: [URL], on: (String) -> Bool, hasToken: (String) -> Bool, localHost: String?, localRunning: Bool) -> Set<String> {
    Set(listed.compactMap(\.host).filter { on($0) && hasToken($0) && ($0 != localHost || localRunning) })
}

/// "Take work from this server", per server. The old one switch for all servers is the default of a server first
/// paired after this version; the servers paired before it keep its value.
struct HostSwitches {
    static let key = "aiOnHosts"
    static let oldKey = "aiOnThisMac"
    static let migratedKey = "aiHostsMigrated"
    private let defaults: UserDefaults
    private(set) var on: [String: Bool]
    /// The old switch's value, frozen: nothing writes it again.
    let aiDefault: Bool
    /// Servers whose pairing failed this run: no runner until the window shows them again (memory only).
    var pairFailed: Set<String> = []

    /// `paired`: the servers this Mac has a token for now, migrated once.
    init(defaults: UserDefaults = .standard, paired: [String]) {
        self.defaults = defaults
        aiDefault = defaults.bool(forKey: Self.oldKey)
        var on = defaults.dictionary(forKey: Self.key) as? [String: Bool] ?? [:]
        if !defaults.bool(forKey: Self.migratedKey) {
            for host in paired where on[host] == nil { on[host] = aiDefault }
            defaults.set(on, forKey: Self.key)
            defaults.set(true, forKey: Self.migratedKey)
        }
        self.on = on
    }

    func aiOn(_ host: String) -> Bool { on[host] ?? aiDefault }
    /// Whether the server gets a runner now.
    func runs(_ host: String) -> Bool { aiOn(host) && !pairFailed.contains(host) }

    mutating func set(_ host: String, _ value: Bool) {
        on[host] = value
        defaults.set(on, forKey: Self.key)
    }
}

/// The notice when a server refused this Mac's token.
func removedNotice(_ server: String) -> String {
    "This Mac was removed from \(server). Turn on “Take work from this server” there to add it again."
}

/// Whether running AI jobs still hold back a downloaded update: never past `cap` (a busy server elsewhere would hold it
/// for good; what the relaunch cuts off goes back to its server by its lease, as on any quit).
func aiHoldsUpdate(running: Int, drawing: Bool, waited: TimeInterval, cap: TimeInterval = 30 * 60) -> Bool {
    waited < cap && (running > 0 || drawing)
}

@MainActor
final class Runners {
    final class Handle {
        let id: UUID
        let url: URL
        let token: String
        let relay: HostRelay
        let worker: Worker
        var statusWatch: AnyCancellable?
        init(id: UUID, url: URL, token: String, relay: HostRelay, worker: Worker) {
            self.id = id
            self.url = url
            self.token = token
            self.relay = relay
            self.worker = worker
        }
    }

    /// A server's runner and worker, not started yet; the id is the handle's, for the runner's callbacks.
    var make: (_ host: String, _ url: URL, _ token: String, _ id: UUID) -> (HostRelay, Worker) = { _, _, _, _ in
        fatalError("Runners.make is set by the Shell")
    }
    /// Something the menu shows changed: a status, a worker's row, a runner started or stopped.
    var onChange: () -> Void = {}
    private(set) var handles: [String: Handle] = [:]
    private var statuses: [String: AIStatus] = [:]
    /// The server the window shows; its runner's error is the menu's dot.
    var windowHost: String?

    var isEmpty: Bool { handles.isEmpty }
    func relay(for host: String?) -> HostRelay? { host.flatMap { handles[$0]?.relay } }
    func worker(for host: String?) -> Worker? { host.flatMap { handles[$0]?.worker } }
    func isCurrent(_ host: String, _ id: UUID) -> Bool { handles[host]?.id == id }
    func forEach(_ body: (HostRelay) -> Void) { handles.values.forEach { body($0.relay) } }

    /// The window's server's status (nothing running there: empty).
    var windowStatus: AIStatus { windowHost.flatMap { statuses[$0] } ?? AIStatus() }
    var running: Int { statuses.values.reduce(0) { $0 + $1.running } }
    var drawing: Bool { statuses.values.contains { $0.drawing } }
    /// The workers' rows, one per server, in a steady order.
    var workRows: [ActivityRow] {
        handles.keys.sorted().compactMap { host in handles[host]?.worker.status.map { workRow($0, host: host) } }
    }

    /// Starts the servers in `wanted` that have no runner and stops the rest. A server whose token or address changed,
    /// or whose runner stopped itself (a refusal), starts again with what is there now.
    func sync(_ wanted: [String: URL], token: (String) -> String?) {
        for (host, h) in handles where wanted[host] != h.url || h.relay.isStopped || token(host) != h.token {
            stop(host: host)
        }
        for (host, url) in wanted where handles[host] == nil {
            guard let t = token(host) else { continue }
            let id = UUID()
            let (relay, worker) = make(host, url, t, id)
            let h = Handle(id: id, url: url, token: t, relay: relay, worker: worker)
            h.statusWatch = worker.objectWillChange.sink { [weak self] in self?.onChange() }
            handles[host] = h
            relay.start()
        }
        onChange()
    }

    /// A Download location change: each idle worker is let go, so its next step starts one with the new folder
    /// (CT_PROXY_DIR). A worker in a step keeps the folder it started with until that step ends.
    func restartIdleWorkers() {
        for h in handles.values where h.worker.status == nil {
            if let pid = h.worker.release() { DispatchQueue.global().async { Worker.stopGroups([pid]) } }
        }
    }

    /// Stops one server's runner and its worker (the worker's group off the main thread).
    func stop(host: String) {
        guard let h = handles.removeValue(forKey: host) else { return }
        // what the stopped runner still finishes is no longer told here, so its count and its row would stay for good
        statuses[host] = nil
        h.relay.stop()
        if let pid = h.worker.release() { DispatchQueue.global().async { Worker.stopGroups([pid]) } }
        onChange()
    }

    /// Whether a refusal of `token` is this server's: its runner still has that token and the vault still holds it. A
    /// late refusal from a runner already replaced (the server was paired again) is not.
    func refused(host: String, token: String, vault: String?) -> Bool {
        handles[host]?.token == token && vault == token
    }

    /// On quit: every runner stops, and every worker's group gets one shared grace, then whatever is left is killed.
    func stopAll(grace: TimeInterval = 10) {
        let pids = handles.values.compactMap { h -> pid_t? in
            h.relay.stop()
            return h.worker.release()
        }
        handles = [:]
        statuses = [:]
        Worker.stopGroups(pids, grace: grace)
    }

    /// A runner's status. Returns the AppLog line when its error appears, changes or clears, and nil otherwise, so
    /// a server that keeps failing the same way writes one line, not one every poll.
    func note(_ status: AIStatus, host: String) -> String? {
        let old = statuses[host]?.lastError
        statuses[host] = status
        onChange()
        guard old != status.lastError else { return nil }
        return "relay \(host): \(status.lastError ?? "ok")"
    }
}
