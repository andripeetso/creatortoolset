import Foundation
import Network
import UIKit
import WebKit

/// The timings of the connection supervisor.
enum ConnectionTiming {
    static let retryBase: TimeInterval = 1
    static let retryMax: TimeInterval = 300
    /// The first loss of a live line retries almost at once; the ladder still counts it.
    static let sessionLossRetry: TimeInterval = 0.25
    /// Opening a line and its first hello; a cold server with a big library can take this long.
    static let establish: TimeInterval = 15
    static let probeRemote: TimeInterval = 15
    static let probeNear: TimeInterval = 3
    /// After a long suspension pooled connections are often dead too: a replacement is cheaper than the wait.
    static let probeLongResume: TimeInterval = 1.5
    /// Back from the background after this long counts as a long resume.
    static let longResumeAfter: TimeInterval = 10
    /// Connected this long, a later failure starts the ladder again.
    static let backoffResetAfter: TimeInterval = 30
    static let betterRouteEvery: TimeInterval = 60
    /// A better route that answered its check but then failed to connect is not tried again for this long, so a
    /// flaky LAN cannot bounce the connection.
    static let betterRouteCooldown: TimeInterval = 300
    /// A route that keeps failing its check is checked half as often each time, up to this.
    static let silentRouteMax: TimeInterval = 1800
    /// Each route is first asked who it is, this long at most.
    static let routeCheck: TimeInterval = 2.5
    /// Near routes share this head start before the account's route is tried.
    static let routeHeadStart: TimeInterval = 0.5
    /// The server pings its line every 15 s: this long without a frame and the line is dead.
    static let lineSilence: TimeInterval = 35
    /// A DPoP session is renewed in its last minute.
    static let renewBefore: TimeInterval = 60
    /// The status in the header waits this long, so a short reconnect never flashes.
    static let headerDelay: TimeInterval = 0.8
}

/// Why a connection failed, where, and whether retrying can help.
struct ConnectionFailure: Error, Equatable, LocalizedError {
    enum Reason: String {
        // transient: retried on the ladder
        case network, timeout, transport, endpointUnavailable, relayUnavailable, remoteUnavailable
        // blocked: waits for the person (or a wakeup)
        case authentication, configuration, permission, unsupported
    }
    /// A part of the path: this phone, the account's connect service, the computer's tunnel, the server on it.
    enum Hop: String { case device, account, tunnel, server }
    enum Via: String { case account, direct }

    var reason: Reason
    var detail: String
    var hop: Hop?
    var via: Via?
    /// The connect service's failure class ("tunnel_down", "origin_unreachable", …) or one the phone names.
    var cause: String?
    var httpStatus: Int?
    var traceId: String?
    var updateRequired = false

    var blocked: Bool { [.authentication, .configuration, .permission, .unsupported].contains(reason) }
    var errorDescription: String? { detail }

    static func from(_ error: Error, route: Route?) -> ConnectionFailure {
        if let f = error as? ConnectionFailure { return f }
        let via: Via = route?.kind == .account ? .account : .direct
        let hop: Hop = via == .account ? .tunnel : .server
        guard let url = error as? URLError else { return ConnectionFailure(reason: .transport, detail: error.localizedDescription, via: via) }
        switch url.code {
        case .notConnectedToInternet, .networkConnectionLost, .dataNotAllowed, .internationalRoamingOff:
            return ConnectionFailure(reason: .network, detail: url.localizedDescription, hop: hop, via: via)
        case .timedOut:
            return ConnectionFailure(reason: .timeout, detail: url.localizedDescription, hop: hop, via: via, cause: "timeout")
        case .cannotFindHost, .dnsLookupFailed:
            return ConnectionFailure(reason: .network, detail: url.localizedDescription, hop: hop, via: via, cause: "dns")
        case .secureConnectionFailed, .serverCertificateUntrusted, .serverCertificateHasBadDate, .serverCertificateNotYetValid:
            return ConnectionFailure(reason: .transport, detail: url.localizedDescription, hop: hop, via: via, cause: "tls")
        case .cannotConnectToHost:
            return ConnectionFailure(reason: .network, detail: url.localizedDescription, hop: hop, via: via, cause: "refused")
        default:
            return ConnectionFailure(reason: .transport, detail: url.localizedDescription, hop: hop, via: via)
        }
    }

    /// A server's answer that wasn't the line.
    /// `code`: the 401's own (`api/connect/contract.md`): a proof the server couldn't check this time (`INVALID_DPOP`)
    /// is tried again with a fresh one, and an account session that ended is minted again; a revoked session waits
    /// for the person, as does a paired token the server no longer knows.
    static func status(_ status: Int, route: Route, code: String? = nil) -> ConnectionFailure {
        let via: Via = route.kind == .account ? .account : .direct
        switch status {
        case 401 where code == "INVALID_DPOP" || (route.authorization == .account && code != "SESSION_REVOKED"):
            return ConnectionFailure(reason: .transport, detail: "The computer asked this device to sign in again.", hop: .server, via: via,
                                     cause: code, httpStatus: status)
        case 401 where code == "SESSION_REVOKED":
            return ConnectionFailure(reason: .authentication, detail: "This device was signed out on the computer. Pair it again.", hop: .server,
                                     via: via, cause: code, httpStatus: status)
        case 401: return ConnectionFailure(reason: .authentication, detail: "The server credential is invalid.", hop: .server, via: via, httpStatus: status)
        case 403: return ConnectionFailure(reason: .permission, detail: "The server rejected the authentication request.", hop: .server, via: via, httpStatus: status)
        default: return ConnectionFailure(reason: .remoteUnavailable, detail: "The server answered \(status).", hop: .server, via: via,
                                          cause: status >= 500 ? "invalid_response" : nil, httpStatus: status)
        }
    }
}

enum ConnectionPhase: String { case available, offline, connecting, backoff, connected, blocked }

struct ConnectionState: Equatable {
    var phase: ConnectionPhase = .available
    var attempt = 0
    var lastFailure: ConnectionFailure?
    var retryAt: Date?
    /// The route the line is open on (connected) or was last tried.
    var routeId: String?
    var networkOffline = false
    /// When the phase last changed: the header waits a moment before it says so.
    var since = Date()
}

/// The retry ladder, without timers: what to do after a failure. Every time is given, so tests drive it.
struct SupervisorCore: Equatable {
    var failureCount = 0

    enum Next: Equatable {
        case retry(after: TimeInterval)
        /// Offline or blocked: no retry until a wakeup, a network change or Retry now.
        case wait
    }

    /// Exponential with jitter: 1–2 s, 2–4 s, … up to 2.5–5 min.
    static func retryDelay(failureCount: Int, random: Double) -> TimeInterval {
        let ceiling = min(ConnectionTiming.retryMax, ConnectionTiming.retryBase * pow(2, Double(failureCount + 1)))
        return ceiling / 2 + ceiling / 2 * random
    }

    mutating func resetLadder() { failureCount = 0 }

    /// `connectedFor`: how long the line was up (nil: it never opened).
    mutating func failed(_ failure: ConnectionFailure, connectedFor: TimeInterval?, offline: Bool, random: Double) -> Next {
        if let up = connectedFor, up >= ConnectionTiming.backoffResetAfter { resetLadder() }
        if failure.blocked || offline { return .wait }
        let firstLoss = connectedFor != nil && failureCount == 0
        failureCount += 1
        if firstLoss { return .retry(after: ConnectionTiming.sessionLossRetry * (0.5 + random / 2)) }
        return .retry(after: Self.retryDelay(failureCount: failureCount - 1, random: random))
    }

    static func probeTimeout(_ kind: RouteKind, longResume: Bool) -> TimeInterval {
        if longResume { return ConnectionTiming.probeLongResume }
        return kind.isNear ? ConnectionTiming.probeNear : ConnectionTiming.probeRemote
    }
}

/// Which better routes may be tried now: not one that failed to connect in the last 5 min, and a route whose check
/// keeps failing only every 2, 4, 8 … up to 30 min, until the network changes.
struct RouteHealth: Equatable {
    struct Silent: Equatable {
        var failures: Int
        var until: Date
    }

    var cooldowns: [String: Date] = [:]
    var silent: [String: Silent] = [:]

    enum Preflight: Equatable { case ready, unprepared, silent }

    func candidates(_ routes: [Route], before index: Int, now: Date) -> [Route] {
        guard index > 0 else { return [] }
        return routes.prefix(index).filter { (cooldowns[$0.id] ?? .distantPast) <= now && (silent[$0.id]?.until ?? .distantPast) <= now }
    }

    mutating func record(_ id: String, _ result: Preflight, now: Date) {
        guard result == .silent else { return silent[id] = nil }
        let failures = (silent[id]?.failures ?? 0) + 1
        let delay = min(ConnectionTiming.silentRouteMax, ConnectionTiming.betterRouteEvery * pow(2, Double(failures)))
        silent[id] = Silent(failures: failures, until: now.addingTimeInterval(delay))
    }

    mutating func coolDown(_ id: String, now: Date) { cooldowns[id] = now.addingTimeInterval(ConnectionTiming.betterRouteCooldown) }

    /// The network changed: a dead route may answer now.
    mutating func forgetSilent() { silent = [:] }
}

/// What reaches a supervisor: the line's frames, wakeups, the person's taps.
enum SupervisorSignal: Equatable {
    case frame(generation: Int, name: String)
    case lineEnded(generation: Int, ConnectionFailure)
    case retry
    case wakeup(longResume: Bool)
    case network(online: Bool)
    case suspend
    case changed
    case checkRoutes
}

/// One waiting reader, a queue of what came while nobody waited.
@MainActor
final class Mailbox<T> {
    private var queue: [T] = []
    private var waiter: CheckedContinuation<T?, Never>?
    private var timer: Task<Void, Never>?

    func post(_ value: T) {
        if let waiter {
            self.waiter = nil
            timer?.cancel()
            waiter.resume(returning: value)
        } else {
            queue.append(value)
        }
    }

    /// The next one, or nil at `deadline` (never, without one) or when the task is cancelled.
    func next(until deadline: Date? = nil) async -> T? {
        if !queue.isEmpty { return queue.removeFirst() }
        if let deadline, deadline <= Date() { return nil }
        return await withTaskCancellationHandler {
            await withCheckedContinuation { continuation in
                waiter = continuation
                if let deadline {
                    timer = Task { [weak self] in
                        try? await Task.sleep(for: .seconds(max(0, deadline.timeIntervalSinceNow)))
                        guard !Task.isCancelled else { return }
                        self?.expire()
                    }
                }
            }
        } onCancel: {
            Task { @MainActor [weak self] in self?.expire() }
        }
    }

    private func expire() {
        guard let waiter else { return }
        self.waiter = nil
        waiter.resume(returning: nil)
    }
}

/// Keeps one server connected: picks the route, opens the change line, watches it, retries on the ladder, moves to a
/// better route when one answers. "Connected" means the line's hello arrived.
@MainActor
final class ServerSupervisor {
    let serverId: String
    private(set) var state = ConnectionState() {
        didSet {
            if state.phase != oldValue.phase { state.since = Date() }
            if state != oldValue { owner?.stateChanged(serverId, state) }
        }
    }

    private weak var owner: Connections?
    private let mailbox = Mailbox<SupervisorSignal>()
    private var core = SupervisorCore()
    private var health = RouteHealth()
    private var task: Task<Void, Never>?
    private var generation = 0
    private var line: Task<Void, Never>?
    private var preferredRouteId: String?
    private var suspended = false

    init(serverId: String, owner: Connections) {
        self.serverId = serverId
        self.owner = owner
    }

    func start() { if task == nil { task = Task { await run() } } }

    func stop() {
        task?.cancel()
        task = nil
        closeLine()
    }

    func post(_ signal: SupervisorSignal) {
        // at once, so a supervisor made in the background never opens a line before it reads its mail
        if signal == .suspend { suspended = true }
        mailbox.post(signal)
    }

    private var entry: ServerEntry? { owner?.entry(serverId) }

    private func closeLine() {
        line?.cancel()
        line = nil
        generation += 1
    }

    // MARK: the loop

    private func run() async {
        while !Task.isCancelled {
            guard let entry, let owner else { return }
            if suspended || entry.signedOut == true || owner.offline {
                if entry.signedOut == true { state = ConnectionState(phase: .blocked, lastFailure: state.lastFailure) }
                else if owner.offline, !suspended { state = ConnectionState(phase: .offline, attempt: state.attempt, lastFailure: state.lastFailure, networkOffline: true) }
                guard await waitForSignal(until: nil) else { return }
                continue
            }
            state.phase = .connecting
            state.retryAt = nil
            state.attempt += 1
            let outcome = await attempt(entry)
            if Task.isCancelled { return }
            switch outcome {
            case .interrupted:
                continue
            case .replace:
                core.resetLadder()
                state.attempt = 0
                continue
            case .failed(let failure, let connectedFor):
                state.lastFailure = failure
                switch core.failed(failure, connectedFor: connectedFor, offline: owner.offline, random: .random(in: 0..<1)) {
                case .wait:
                    state.phase = failure.blocked ? .blocked : .offline
                    state.retryAt = nil
                    guard await waitForSignal(until: nil) else { return }
                case .retry(let delay):
                    state.phase = .backoff
                    state.retryAt = Date().addingTimeInterval(delay)
                    guard await waitForSignal(until: state.retryAt) else { return }
                }
            }
        }
    }

    private enum Outcome {
        case interrupted
        /// A better route answered, or a probe found the line dead: connect again at once.
        case replace
        case failed(ConnectionFailure, connectedFor: TimeInterval?)
    }

    /// Waits for something that may change the outcome of a retry. False when the task ended.
    private func waitForSignal(until deadline: Date?) async -> Bool {
        while !Task.isCancelled {
            guard let signal = await mailbox.next(until: deadline) else { return !Task.isCancelled }
            switch signal {
            case .frame, .lineEnded, .checkRoutes:
                continue   // a closed line's leftovers
            case .suspend:
                suspended = true
                closeLine()
                continue
            case .wakeup:
                suspended = false
                core.resetLadder()
                health.forgetSilent()
                return true
            case .network(let online):
                health.forgetSilent()
                if online { core.resetLadder() }
                return true
            case .retry, .changed:
                core.resetLadder()
                return true
            }
        }
        return false
    }

    private func attempt(_ entry: ServerEntry) async -> Outcome {
        let preferred = preferredRouteId
        preferredRouteId = nil
        let route: Route
        let credential: Credential
        do {
            (route, credential) = try await connectOverRoutes(entry, preferred: preferred)
        } catch is CancellationError {
            return .interrupted
        } catch Interrupted.interrupted {
            return .interrupted
        } catch {
            return .failed(ConnectionFailure.from(error, route: nil), connectedFor: nil)
        }
        if let preferred, preferred != route.id { health.coolDown(preferred, now: Date()) }
        let connectedAt = Date()
        state = ConnectionState(phase: .connected, attempt: state.attempt, routeId: route.id)
        owner?.connected(serverId, route: route)
        if credential.kind == .dpop { owner?.renewBefore(serverId, credential) }
        let learning = Task { await learnRoutes(over: route, credential: credential) }
        defer { learning.cancel() }
        let end = await monitor(route: route, credential: credential)
        closeLine()
        switch end {
        case .interrupted, .replace: return end
        case .failed(let failure, _): return .failed(failure, connectedFor: Date().timeIntervalSince(connectedAt))
        }
    }

    private enum Interrupted: Error { case interrupted }

    // MARK: choosing a route

    /// The first route that connects wins; a server this app can't talk to stops the walk (it is the same server on
    /// every route).
    private func connectOverRoutes(_ entry: ServerEntry, preferred: String?) async throws -> (Route, Credential) {
        var routes = Routes.usable(entry.routes)
        if let preferred, let i = routes.firstIndex(where: { $0.id == preferred }) { routes.insert(routes.remove(at: i), at: 0) }
        guard !routes.isEmpty else {
            throw ConnectionFailure(reason: .configuration, detail: "\(entry.label) has no route this phone may use.", hop: .device)
        }
        var transient: ConnectionFailure?
        var blocked: ConnectionFailure?
        func tryRoute(_ route: Route) async throws -> (Route, Credential)? {
            do {
                return try await open(entry, route)
            } catch let failure as ConnectionFailure {
                if failure.reason == .unsupported { throw failure }
                if failure.blocked { blocked = blocked ?? failure } else { transient = transient ?? failure }
                return nil
            }
        }
        let (serverId, provisional) = (entry.serverId, entry.provisional)
        let check: (Route) async -> RouteCheck = {
            await Self.check($0, serverId: serverId, provisional: provisional, timeout: ConnectionTiming.routeCheck)
        }
        if let won = try await Self.walk(routes, headStart: ConnectionTiming.routeHeadStart, check: check, open: tryRoute) { return won }
        throw transient ?? blocked ?? ConnectionFailure(reason: .endpointUnavailable,
                                                        detail: "\(entry.label) did not answer on any saved route.")
    }

    /// The order routes are opened in (`open` nil: that one failed, try the next). Every route but the account's (the
    /// connect service checks its tunnel) is first asked who it is; near routes share a head start before the
    /// account's route is tried; routes that didn't answer are tried last. One that answered as another server is
    /// never opened, nor is a plain-HTTP address outside the tailnet that didn't answer: whatever answers there on the
    /// network the phone is on now would get the credential.
    static func walk<T>(_ routes: [Route], headStart: TimeInterval, check: @escaping (Route) async -> RouteCheck,
                        open: (Route) async throws -> T?) async throws -> T? {
        let checks: [Task<RouteCheck, Never>?] = routes.map { route in route.kind == .account ? nil : Task { await check(route) } }
        defer { checks.forEach { $0?.cancel() } }
        let deadline = Date().addingTimeInterval(headStart)
        var silent: [Int] = []
        for (index, route) in routes.enumerated() {
            if let task = checks[index] {
                switch await value(task, by: deadline) ?? .silent {
                case .other: continue
                case .silent:
                    silent.append(index)
                    continue
                case .answered, .unchecked: break
                }
            }
            if let won = try await open(route) { return won }
        }
        // a slow route that answered after the head start goes before one that is still dead
        var late: [(Int, RouteCheck)] = []
        for index in silent { if let task = checks[index] { late.append((index, await task.value)) } }
        let answered = late.filter { $0.1 == .answered }
        let unverified = late.filter { $0.1 == .silent && !routes[$0.0].needsVerifiedServer }
        for (index, _) in answered + unverified {
            if let won = try await open(routes[index]) { return won }
        }
        return nil
    }

    enum RouteCheck: Equatable {
        case answered, silent, unchecked
        /// Another server answered at that address.
        case other
    }

    /// The public descriptor, so this sends no credential to whatever answers at a saved LAN address on another
    /// network. A server saved by address before ids existed takes any answer (and is given its id on connect).
    static func check(_ route: Route, serverId: String, provisional: Bool, timeout: TimeInterval) async -> RouteCheck {
        guard let descriptor = try? await ServerDescriptor.fetch(route.url, timeout: timeout) else { return .silent }
        return provisional || descriptor.serverId == serverId ? .answered : .other
    }

    private static func value(_ task: Task<RouteCheck, Never>, by deadline: Date) async -> RouteCheck? {
        await withTaskGroup(of: RouteCheck?.self) { group in
            group.addTask { await task.value }
            group.addTask {
                try? await Task.sleep(for: .seconds(max(0, deadline.timeIntervalSinceNow)))
                return nil
            }
            let first = await group.next() ?? nil
            group.cancelAll()
            return first
        }
    }

    // MARK: the line

    /// Opens the change line on a route with its credential; returns once its hello arrived.
    private func open(_ entry: ServerEntry, _ route: Route) async throws -> (Route, Credential) {
        guard let owner else { throw Interrupted.interrupted }
        state.routeId = route.id
        let credential = try await owner.credential(for: entry, route: route)
        closeLine()
        let generation = generation
        var request = URLRequest(url: API(server: route.url, cookie: nil).url("/api/sync/events"))
        request.timeoutInterval = 3600
        request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        for (k, v) in credential.headers(method: "GET", url: request.url!) { request.setValue(v, forHTTPHeaderField: k) }
        let mailbox = mailbox
        let serverId = serverId
        line = Task.detached { [weak owner] in
            func post(_ signal: SupervisorSignal) { Task { @MainActor in mailbox.post(signal) } }
            do {
                let (bytes, response) = try await API.slow.bytes(for: request)
                let status = (response as? HTTPURLResponse)?.statusCode ?? 0
                guard status == 200 else {
                    var body = Data()
                    for try await byte in bytes { body.append(byte); if body.count >= 2048 { break } }
                    let code = ((try? JSONSerialization.jsonObject(with: body)) as? [String: Any])?["code"] as? String
                    Task { @MainActor in owner?.lineRefused(serverId, route: route, status: status, code: code) }
                    return post(.lineEnded(generation: generation, .status(status, route: route, code: code)))
                }
                var parser = ServerEvents.Parser()
                for try await text in bytes.lines {
                    guard let event = parser.take(text) else { continue }
                    post(.frame(generation: generation, name: event.name))
                    // the screens read this same line (`ServerEvents`): one line per server
                    Task { @MainActor in owner?.deliver(serverId, event) }
                }
                post(.lineEnded(generation: generation, ConnectionFailure.from(URLError(.networkConnectionLost), route: route)))
            } catch is CancellationError {
            } catch let error as URLError where error.code == .cancelled {
            } catch {
                post(.lineEnded(generation: generation, ConnectionFailure.from(error, route: route)))
            }
        }
        let deadline = Date().addingTimeInterval(ConnectionTiming.establish)
        var later: [SupervisorSignal] = []
        defer { later.forEach(mailbox.post) }
        while true {
            guard let signal = await mailbox.next(until: deadline) else {
                if Task.isCancelled { throw Interrupted.interrupted }
                closeLine()
                throw ConnectionFailure(reason: .timeout, detail: "\(entry.label) did not answer in time.", hop: route.kind == .account ? .tunnel : .server,
                                        via: route.kind == .account ? .account : .direct, cause: "timeout")
            }
            switch signal {
            case .frame(generation, "hello"):
                return (route, credential)
            case .frame:
                continue
            case .lineEnded(generation, let failure):
                throw failure
            case .lineEnded:
                continue
            case .suspend:
                suspended = true
                closeLine()
                throw Interrupted.interrupted
            case .changed:
                if self.entry?.signedOut == true || self.entry?.routes.contains(where: { $0.id == route.id }) != true {
                    closeLine()
                    throw Interrupted.interrupted
                }
            case .network(false):
                closeLine()
                throw Interrupted.interrupted
            default:
                later.append(signal)
            }
        }
    }

    /// Watches a live line: its pings, the better-route check every minute, wakeups and network changes (a probe
    /// that finds the server gone replaces the line). An account session renews itself (`Connections.renewBefore`).
    private func monitor(route: Route, credential: Credential) async -> Outcome {
        var lastFrame = Date()
        var nextCheck = Date().addingTimeInterval(ConnectionTiming.betterRouteEvery)
        while !Task.isCancelled {
            let deadline = [nextCheck, lastFrame.addingTimeInterval(ConnectionTiming.lineSilence)].min()
            guard let signal = await mailbox.next(until: deadline) else {
                if Task.isCancelled { return .interrupted }
                let now = Date()
                if now >= lastFrame.addingTimeInterval(ConnectionTiming.lineSilence) {
                    return .failed(ConnectionFailure(reason: .timeout, detail: "The connection went quiet.", hop: route.kind == .account ? .tunnel : .server,
                                                     via: route.kind == .account ? .account : .direct, cause: "timeout"), connectedFor: nil)
                }
                if now >= nextCheck {
                    nextCheck = now.addingTimeInterval(ConnectionTiming.betterRouteEvery)
                    if let better = await betterRoute(than: route) { return replace(with: better) }
                }
                continue
            }
            switch signal {
            case .frame(generation, _):
                lastFrame = Date()
            case .frame, .lineEnded:
                if case .lineEnded(generation, let failure) = signal { return .failed(failure, connectedFor: nil) }
            case .suspend:
                suspended = true
                return .interrupted
            case .changed:
                guard let entry, entry.signedOut != true, entry.routes.contains(where: { $0.id == route.id }) else { return .interrupted }
                if let better = await betterRoute(than: route) { return replace(with: better) }
            case .checkRoutes:
                if let better = await betterRoute(than: route) { return replace(with: better) }
            case .network(let online):
                guard online else { return .interrupted }
                health.forgetSilent()
                if !(await probe(route, longResume: false)) { return .replace }
                owner?.connected(serverId, route: route)   // checked again on the new network
                if let better = await betterRoute(than: route) { return replace(with: better) }
            case .wakeup(let long):
                if !(await probe(route, longResume: long)) { return .replace }
                owner?.connected(serverId, route: route)
                if let better = await betterRoute(than: route) { return replace(with: better) }
            case .retry:
                if !(await probe(route, longResume: false)) { return .replace }
            }
        }
        return .interrupted
    }

    private func replace(with routeId: String) -> Outcome {
        preferredRouteId = routeId
        return .replace
    }

    private func probe(_ route: Route, longResume: Bool) async -> Bool {
        guard let entry else { return false }
        let timeout = SupervisorCore.probeTimeout(route.kind, longResume: longResume)
        return await Self.check(route, serverId: entry.serverId, provisional: entry.provisional, timeout: timeout) == .answered
    }

    /// A route ahead of the one in use that answers and can be signed in on now.
    private func betterRoute(than active: Route) async -> String? {
        guard let entry, let owner, let index = entry.routes.firstIndex(where: { $0.id == active.id }) else { return nil }
        let now = Date()
        let candidates = health.candidates(entry.routes, before: index, now: now)
        guard !candidates.isEmpty else { return nil }
        let results = await withTaskGroup(of: (String, RouteHealth.Preflight).self) { group in
            for route in candidates {
                let ready = owner.canSign(entry, route)
                group.addTask {
                    if Routes.sendsTokenInClear(entry.routes, route) { return (route.id, .silent) }
                    let check = await Self.check(route, serverId: entry.serverId, provisional: entry.provisional, timeout: ConnectionTiming.routeCheck)
                    return (route.id, check != .answered ? .silent : ready ? .ready : .unprepared)
                }
            }
            var out: [String: RouteHealth.Preflight] = [:]
            for await (id, result) in group { out[id] = result }
            return out
        }
        for (id, result) in results { health.record(id, result, now: now) }
        return candidates.first { results[$0.id] == .ready }?.id
    }

    /// The addresses the server reports for itself, merged into the routes (learned over this one).
    private func learnRoutes(over route: Route, credential: Credential) async {
        var request = URLRequest(url: API(server: route.url, cookie: nil).url("/api/server/endpoints"))
        request.timeoutInterval = 15
        for (k, v) in credential.headers(method: "GET", url: request.url!) { request.setValue(v, forHTTPHeaderField: k) }
        guard let (data, response) = try? await API.session.data(for: request),
              (response as? HTTPURLResponse)?.statusCode == 200,
              let reported = try? JSONDecoder().decode([ReportedEndpoint].self, from: data),
              let owner, !Task.isCancelled else { return }
        if owner.learn(serverId, over: route, reported: reported) { post(.checkRoutes) }
    }
}

/// Every server saved on this phone and its connection. Every saved server connects at once; the app picks the
/// route by itself. The tabs read `servers`, `state(_:)` and `current`, and call `remove`, `retry`, `signInAgain`.
@MainActor
final class Connections: ObservableObject {
    static let shared = Connections()

    @Published private(set) var saved: ServerRegistry.Saved
    @Published private(set) var states: [String: ConnectionState] = [:]
    /// This phone has no network.
    @Published private(set) var offline = false

    private var supervisors: [String: ServerSupervisor] = [:]
    private let path = NWPathMonitor()
    private var backgroundAt: Date?
    private var renewing: [String: Task<(URL, Credential), Error>] = [:]
    /// The next renewal of each account session, armed from the credential it renews.
    private var renewals: [String: Task<Void, Never>] = [:]
    /// Mints an account session (the connect service); a test's own.
    var mint: (String) async throws -> (URL, Credential) = { try await AccountServers.shared.session(for: $0) }
    let live: Bool

    /// `background`: launched straight into the background (an upload finished, a refresh): no line opens until the
    /// app comes forward.
    init(saved: ServerRegistry.Saved = ServerRegistry.read(), live: Bool = true,
         background: Bool = UIApplication.shared.applicationState == .background) {
        self.saved = saved
        #if DEBUG
        let demo = ConnectionDemo.on || PhoneDemo.on
        if ConnectionDemo.on { self.saved = ConnectionDemo.saved; states = ConnectionDemo.states }
        if PhoneDemo.on { self.saved = PhoneDemo.saved; states = PhoneDemo.states }
        self.live = live && !demo
        #else
        self.live = live
        #endif
        guard self.live else { return }
        if background { backgroundAt = Date() }
        path.pathUpdateHandler = { [weak self] path in
            let shape = "\(path.status) \(path.availableInterfaces.map(\.name).sorted()) \(path.gateways.map(\.debugDescription).sorted())"
            Task { @MainActor in self?.pathChanged(online: path.status == .satisfied, shape: shape) }
        }
        path.start(queue: DispatchQueue(label: "connections.path"))
        let center = NotificationCenter.default
        center.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.left() }
        }
        center.addObserver(forName: UIApplication.willEnterForegroundNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.came() }
        }
        sync()
    }

    // MARK: what the screens read

    private var listeners: [UUID: AsyncStream<ServerEvents.Event>.Continuation] = [:]

    /// The change line of the server in use, as the screens read it (`ServerEvents.stream`): the events of that
    /// server's own supervised line, so no screen opens a second one. Another server taking its place says "hello",
    /// so every reader reads again.
    func events() -> AsyncStream<ServerEvents.Event> {
        AsyncStream { continuation in
            let id = UUID()
            listeners[id] = continuation
            continuation.onTermination = { _ in Task { @MainActor [weak self] in self?.listeners[id] = nil } }
        }
    }

    /// An event on a server's line: to the readers when it is the server in use.
    func deliver(_ serverId: String, _ event: ServerEvents.Event) {
        guard serverId == current?.serverId else { return }
        for listener in listeners.values { listener.yield(event) }
    }

    /// How many readers listen (a test's look).
    var listenerCount: Int { listeners.count }

    var servers: [ServerEntry] { saved.servers }
    var current: ServerEntry? { saved.current }

    func entry(_ serverId: String) -> ServerEntry? { saved.servers.first { $0.serverId == serverId } }
    func entry(key: String) -> ServerEntry? { saved.servers.first { $0.key == key } }
    func state(_ serverId: String) -> ConnectionState { states[serverId] ?? ConnectionState() }

    /// The client for a server, on the route in use.
    func api(_ entry: ServerEntry) -> API { API.connected(entry) }

    // MARK: what the screens do

    /// Sign in again on a computer on the account that signed this phone out: the next try mints a new session
    /// through the account. A paired one signs in again by pairing (`add` clears it).
    func signInAgain(_ serverId: String) {
        update(serverId) { $0.signedOut = nil }
    }

    /// The person reordered or removed a route.
    func setRoutes(_ serverId: String, _ routes: [Route]) {
        guard !routes.isEmpty else { return }
        update(serverId) { $0.routes = routes }
    }

    /// Retry now: the ladder starts again.
    func retry(_ serverId: String) { supervisors[serverId]?.post(.retry) }

    func retryAll() { supervisors.values.forEach { $0.post(.retry) } }

    /// The server the screens show.
    func use(key: String) {
        guard saved.currentKey != key else { return }
        saved.currentKey = key
        persist()
        for listener in listeners.values { listener.yield(ServerEvents.Event(name: "hello", data: "")) }
    }

    /// Remove from this phone (only one added by code or address): forgets it, its credentials and what the app kept for it. It never revokes: that
    /// happens on the computer.
    func remove(_ serverId: String) {
        guard let entry = entry(serverId) else { return }
        let api = API.connected(entry)
        Task { await StudioHooks.removing(api) }
        supervisors.removeValue(forKey: serverId)?.stop()
        renewals.removeValue(forKey: serverId)?.cancel()
        ServerRegistry.forgetCredentials(entry)
        saved.servers.removeAll { $0.serverId == serverId }
        states[serverId] = nil
        if saved.currentKey == entry.key { saved.currentKey = saved.servers.first?.key }
        persist()
        if saved.servers.isEmpty {
            WKWebsiteDataStore.default().removeData(ofTypes: WKWebsiteDataStore.allWebsiteDataTypes(), modifiedSince: .distantPast) {}
        }
    }

    // MARK: adding

    /// A server paired or reached through the account. One already saved under the same id takes the new route
    /// (first among its kind) and credential, signed in again; a new one is saved and connected. It becomes the one
    /// shown, unless `shown` is false and another one already is.
    func add(serverId: String, label: String, route: Route, credential: Credential?, username: String?,
             descriptor: ServerDescriptor? = nil, updateRequired: Bool = false, shown: Bool = true) {
        if let i = saved.servers.firstIndex(where: { $0.serverId == serverId }) {
            saved.servers[i].routes = Routes.upsert(saved.servers[i].routes, route)
            saved.servers[i].signedOut = nil
            if let username { saved.servers[i].username = username }
            saved.servers[i].updateRequired = updateRequired ? true : nil
            saved.servers[i].unsupportedReason = nil
        } else {
            saved.servers.append(ServerEntry(serverId: serverId, label: label, routes: [route], updateRequired: updateRequired ? true : nil,
                                             username: username, version: descriptor?.version, platform: descriptor?.platform,
                                             kind: descriptor?.kind, home: route.url))
        }
        if let credential { ServerRegistry.setCredential(serverId, routeId: route.authorization == .account ? Route.accountId : route.id, credential) }
        if shown || !saved.servers.contains(where: { $0.key == saved.currentKey }) { saved.currentKey = entry(serverId)?.key }
        persist()
        supervisors[serverId]?.post(.changed)
    }

    /// A sign-in by address from before pairing (username and password, a hosted server through the account): saved
    /// by its address until it says who it is.
    func addByAddress(_ url: URL, label: String?, username: String?, cookie: String?) {
        let route = Route.paired(url)
        let existing = saved.servers.first { $0.routes.contains { $0.id == route.id } }
        add(serverId: existing?.serverId ?? "url:" + Routes.origin(url), label: label ?? existing?.label ?? (url.host(percentEncoded: false) ?? url.absoluteString),
            route: route, credential: cookie.map { Credential(kind: .cookie, token: $0) }, username: username)
    }

    /// The account was signed out: its routes go (and the routes learned through them); a server still reachable
    /// another way stays saved.
    func accountSignedOut() {
        for entry in saved.servers where entry.routes.contains(where: { $0.authorization == .account }) {
            let left = Routes.removing(entry.routes, Route.accountId).filter { $0.authorization != .account }
            if left.isEmpty { remove(entry.serverId) } else { update(entry.serverId) { $0.routes = left } }
            ServerRegistry.setCredential(entry.serverId, routeId: Route.accountId, nil)
        }
    }

    /// The server turned the credential of a request away: the next request asks the supervisor again, and an account
    /// session is minted again.
    func refused(_ entry: ServerEntry) {
        if entry.activeRoute?.authorization == .account { Task { _ = try? await renew(entry) } }
        supervisors[entry.serverId]?.post(.retry)
    }

    /// A 401 on a server's line or a request, by its code. Revoked: that credential is dropped and the computer says
    /// Signed out until the person signs in again, never retried by itself (a paired route revoked on a computer still
    /// on the account just leaves the account's route). An account session that ended otherwise is dropped so the
    /// next try mints one.
    func lineRefused(_ serverId: String, route: Route, status: Int, code: String?) {
        guard status == 401, code != "INVALID_DPOP", let entry = entry(serverId) else { return }
        if code == "SESSION_REVOKED" {
            ServerRegistry.setCredential(serverId, routeId: route.authorization == .account ? Route.accountId : route.id, nil)
            if route.authorization == .account || !entry.onAccount { update(serverId) { $0.signedOut = true } }
            return
        }
        if route.authorization == .account { ServerRegistry.setCredential(entry.serverId, routeId: Route.accountId, nil) }
    }

    // MARK: for the supervisors

    func stateChanged(_ serverId: String, _ state: ConnectionState) { states[serverId] = state }

    func connected(_ serverId: String, route: Route) {
        guard entry(serverId)?.activeRouteId != route.id else { return }
        update(serverId, signal: false) { $0.activeRouteId = route.id }
        Task { await describe(serverId, route: route) }
    }

    /// The descriptor of a server just connected: its label, version, and its id once a server saved by address
    /// tells it.
    private func describe(_ serverId: String, route: Route) async {
        guard let d = try? await ServerDescriptor.fetch(route.url, timeout: ConnectionTiming.probeRemote), let entry = entry(serverId) else { return }
        if entry.provisional, d.serverId != serverId {
            if let other = self.entry(d.serverId) {
                // already saved by its id: one entry, with both routes
                update(other.serverId) { e in for r in entry.routes where !e.routes.contains(where: { $0.id == r.id }) { e.routes = Routes.insert(e.routes, r) } }
                for r in entry.routes { if let c = ServerRegistry.credential(serverId, route: r) { ServerRegistry.setCredential(d.serverId, routeId: r.id, c) } }
                remove(serverId)
                return
            }
            supervisors.removeValue(forKey: serverId)?.stop()
            let moved = ServerRegistry.rekey(entry, to: d.serverId)
            if let i = saved.servers.firstIndex(where: { $0.serverId == serverId }) { saved.servers[i] = moved }
            states[d.serverId] = states.removeValue(forKey: serverId)
            persist()
            sync()
            return
        }
        update(serverId, signal: false) {
            $0.version = d.version
            $0.platform = d.platform
            $0.kind = d.kind
            $0.updateRequired = d.protocolVersion < ServerDescriptor.supportedProtocol ? true : nil
        }
    }

    /// True when the routes changed.
    func learn(_ serverId: String, over route: Route, reported: [ReportedEndpoint]) -> Bool {
        guard let entry = entry(serverId), let merged = Routes.mergeLearned(entry.routes, active: route, reported: reported) else { return false }
        update(serverId, signal: false) { $0.routes = merged }
        return true
    }

    /// Whether a route can be signed in on without asking anyone.
    func canSign(_ entry: ServerEntry, _ route: Route) -> Bool {
        route.authorization == .account ? Account.shared.profile != nil : ServerRegistry.credential(entry.serverId, route: route) != nil
    }

    /// The credential to open a route with. An account route's session is minted through the account when there is
    /// none or it ends within a minute.
    func credential(for entry: ServerEntry, route: Route) async throws -> Credential {
        if route.authorization == .account {
            if let c = ServerRegistry.credential(entry.serverId, route: route),
               !c.expired(Date().addingTimeInterval(ConnectionTiming.renewBefore)) { return c }
            return try await renew(entry)
        }
        guard let c = ServerRegistry.credential(entry.serverId, route: route) else {
            throw ConnectionFailure(reason: .authentication, detail: "The server credential is invalid.", hop: .device)
        }
        return c
    }

    /// A new account session for a server (one at a time per server).
    @discardableResult
    func renew(_ entry: ServerEntry) async throws -> Credential {
        if let running = renewing[entry.serverId] { return try await running.value.1 }
        let task = Task { try await mint(entry.serverId) }
        renewing[entry.serverId] = task
        defer { renewing[entry.serverId] = nil }
        let (endpoint, credential) = try await task.value
        ServerRegistry.setCredential(entry.serverId, routeId: Route.accountId, credential)
        renewBefore(entry.serverId, credential)
        if let i = saved.servers.firstIndex(where: { $0.serverId == entry.serverId }),
           let r = saved.servers[i].routes.firstIndex(where: { $0.id == Route.accountId }), saved.servers[i].routes[r].url != endpoint {
            saved.servers[i].routes[r].url = endpoint
            persist()
        }
        return credential
    }

    /// When an account session is renewed: its last minute, or halfway through a shorter one.
    nonisolated static func renewAt(_ credential: Credential, now: Date = Date()) -> Date? {
        guard credential.kind == .dpop, let end = credential.expiresAt else { return nil }
        return end.addingTimeInterval(-min(ConnectionTiming.renewBefore, max(0, end.timeIntervalSince(now)) / 2))
    }

    /// Arms the renewal of the account session just used or minted, while its server stays connected over the
    /// account; a renewal that fails is tried again in 30 s.
    func renewBefore(_ serverId: String, _ credential: Credential) {
        guard let at = Self.renewAt(credential) else { return }
        armRenewal(serverId, at: at)
    }

    private func armRenewal(_ serverId: String, at: Date) {
        renewals[serverId]?.cancel()
        renewals[serverId] = Task { [weak self] in
            try? await Task.sleep(for: .seconds(max(0, at.timeIntervalSinceNow)))
            guard !Task.isCancelled, let self, let entry = self.entry(serverId), self.state(serverId).phase == .connected,
                  entry.activeRoute?.authorization == .account else { return }
            if (try? await self.renew(entry)) == nil { self.armRenewal(serverId, at: Date().addingTimeInterval(30)) }
        }
    }

    /// The client for a server whose account session ends within a minute, signed with a new one (an upload step asks
    /// for its ticket in the background, where no line renews it). Others come back as they are.
    func renewedIfEnding(_ api: API) async -> API {
        guard let credential = api.credential, credential.kind == .dpop,
              credential.expired(Date().addingTimeInterval(ConnectionTiming.renewBefore)),
              let key = api.key, let entry = entry(key: key), let fresh = try? await renew(entry) else { return api }
        var out = api
        out.credential = fresh
        return out
    }

    // MARK: inside

    private func update(_ serverId: String, signal: Bool = true, _ change: (inout ServerEntry) -> Void) {
        guard let i = saved.servers.firstIndex(where: { $0.serverId == serverId }) else { return }
        var next = saved.servers[i]
        change(&next)
        guard next != saved.servers[i] else { return }
        saved.servers[i] = next
        persist()
        if signal { supervisors[serverId]?.post(.changed) }
    }

    private func persist() {
        // the screenshots' made-up computers and a test's own list never replace what is saved
        if live { ServerRegistry.write(saved) }
        sync()
    }

    /// One supervisor per saved server.
    private func sync() {
        guard live else { return }
        let ids = Set(saved.servers.map(\.serverId))
        for (id, supervisor) in supervisors where !ids.contains(id) {
            supervisor.stop()
            supervisors[id] = nil
        }
        for id in ids where supervisors[id] == nil {
            let supervisor = ServerSupervisor(serverId: id, owner: self)
            supervisors[id] = supervisor
            if backgroundAt != nil { supervisor.post(.suspend) }
            supervisor.start()
        }
    }

    /// Any change of the network path (online, offline, another interface or gateway, also while the app was away):
    /// the route last connected over is forgotten until the supervisor checks it on this network.
    func pathChanged(online: Bool, shape: String, defaults: UserDefaults = .standard) {
        let key = "connections.path"
        let changed = defaults.string(forKey: key).map { $0 != shape } ?? false
        defaults.set(shape, forKey: key)
        if changed {
            for entry in saved.servers where entry.activeRouteId != nil { update(entry.serverId, signal: false) { $0.activeRouteId = nil } }
        }
        guard offline == online else {
            if changed, online { supervisors.values.forEach { $0.post(.network(online: true)) } }
            return
        }
        offline = !online
        supervisors.values.forEach { $0.post(.network(online: online)) }
    }

    /// No line stays open in the background: the server takes an open one to mean someone is watching.
    private func left() {
        backgroundAt = Date()
        supervisors.values.forEach { $0.post(.suspend) }
    }

    private func came() {
        let long = backgroundAt.map { Date().timeIntervalSince($0) >= ConnectionTiming.longResumeAfter } ?? false
        backgroundAt = nil
        supervisors.values.forEach { $0.post(.wakeup(longResume: long)) }
    }
}

extension API {
    /// The client for a saved server on the route the app last connected over, signed with that route's credential
    /// (`Authorization`; a server saved before pairing keeps its cookie until it is turned away).
    static func connected(_ entry: ServerEntry) -> API {
        let route = entry.activeRoute
        let credential = route.flatMap { ServerRegistry.credential(entry.serverId, route: $0) }
        var api = API(server: route?.url ?? entry.home, cookie: credential?.kind == .cookie ? credential?.token : nil, username: entry.username)
        if credential?.kind != .cookie { api.credential = credential }
        api.unrouted = route == nil
        api.key = entry.key
        // the phone's own pick of workspace on this server (`WorkspacePick`), on every request
        api.workspace = WorkspacePick.get(server: entry.key, username: entry.username)
        return api
    }

    /// The client for a server by the id other parts of the app know it by (`Server.id`).
    static func connected(_ server: Server) -> API? {
        ServerRegistry.read().servers.first { $0.key == server.id }.map(connected)
    }
}
