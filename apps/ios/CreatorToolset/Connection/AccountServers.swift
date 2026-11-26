import Foundation

/// A computer linked to the person's account, as the connect service lists it, with its live status.
struct AccountComputer: Identifiable, Equatable {
    enum Status: Equatable { case checking, online, offline }

    /// The computer's id: the same id its server gives itself.
    let id: String
    var name: String
    var endpoint: URL?
    var status: Status = .checking
    /// "tunnel_released" (asleep), or the connect service's failure class for the tunnel.
    var offlineReason: String?
    var endpointFailure: String?
    var traceId: String?
    /// When it was linked to the account (the connect service's `created_at`), for "the account's most recent".
    var linkedAt: Double?

    /// `https://<host>` from a host name or a URL: an address that a session is sent to, so https and a plain name only.
    static func endpoint(_ raw: String?) -> URL? {
        guard let raw, !raw.isEmpty else { return nil }
        let host = raw.contains("://") ? URL(string: raw)?.host(percentEncoded: false) ?? "" : raw
        return Computer.origin(host)
    }
}

/// The account's side of connecting: a DPoP-bound token for the connect service (30 min), the linked computers and
/// whether each really answers, and a session on one with no code and no password. The connect service only asks the
/// computer to mint a one-time credential bound to this phone's key; the session itself comes from the computer.
@MainActor
final class AccountServers: ObservableObject {
    static let shared = AccountServers()

    @Published private(set) var computers: [AccountComputer] = []
    /// Hosted servers the account signed in to (signed in with the same Apple, Google or GitHub).
    @Published private(set) var hosted: [Computer] = []
    @Published private(set) var loading = false
    /// Set only when nothing at all can be listed; a failed list with servers known keeps them and retries quietly.
    @Published private(set) var problem: String?
    @Published private(set) var traceId: String?

    private var relay: Credential?
    /// Lists that failed in a row, and the quiet retry after the last one.
    private var failures = 0
    private var retry: Task<Void, Never>?

    init() {
        #if DEBUG
        if ConnectionDemo.on { computers = ConnectionDemo.accountComputers }
        #endif
    }

    // MARK: the connect service

    /// The account's relay token traded for a DPoP-bound one (`connect status mobile`), kept until its last minute.
    func relayAccess() async throws -> String {
        if let relay, !relay.expired(Date().addingTimeInterval(60)) { return relay.token }
        guard let account = try await Account.shared.relayToken(orNone: true) else {
            throw AccountError.refused("Your account has no connect service yet")
        }
        var request = URLRequest(url: API(server: Account.connectService, cookie: nil).url("/v1/client/dpop-token"))
        request.httpMethod = "POST"
        request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        request.setValue(try DPoP.proof(method: "POST", url: request.url!), forHTTPHeaderField: "DPoP")
        request.httpBody = Data(Pairing.form([
            "grant_type": Pairing.grantType, "subject_token": account, "subject_token_type": Pairing.accessType,
            "client_id": "creatortoolset-mobile", "scope": "connect status mobile",
        ]).utf8)
        let data = try await Self.send(request)
        let credential = try JSONDecoder().decode(TokenResponse.self, from: data).credential()
        relay = credential
        return credential.token
    }

    /// One call to the connect service, signed for this phone.
    private func call(_ path: String, method: String = "GET", json: [String: Any]? = nil) async throws -> Data {
        let token = try await relayAccess()
        var request = URLRequest(url: API(server: Account.connectService, cookie: nil).url(path))
        request.httpMethod = method
        request.timeoutInterval = 20
        for (k, v) in Credential(kind: .dpop, token: token).headers(method: method, url: request.url!) { request.setValue(v, forHTTPHeaderField: k) }
        if let json {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONSerialization.data(withJSONObject: json)
        }
        do {
            return try await Self.send(request)
        } catch APIError.server(401, _) {
            relay = nil
            throw AccountError.refused("The connect service didn't accept this phone's sign-in. Sign out and sign in again.")
        }
    }

    private static func send(_ request: URLRequest) async throws -> Data {
        let (data, response): (Data, URLResponse)
        do {
            (data, response) = try await API.session.data(for: request)
        } catch is URLError {
            throw AccountError.unreachable(request.url?.host() ?? "the connect service")
        }
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else { throw APIError.server(status, API.message(data, status: status)) }
        return data
    }

    // MARK: the list

    struct Listed: Decodable {
        struct One: Decodable {
            let id: String
            let name: String?
            let label: String?
            let hostname: String?
            let endpoint: String?
            let created_at: Double?
        }
        let computers: [One]
    }

    struct Health: Decodable {
        let status: String
        let offlineReason: String?
        let endpointFailure: String?
        let traceId: String?
    }

    /// The linked computers, each then asked whether it really answers (a signed check through its tunnel), and the
    /// hosted servers the account signed in to.
    func refresh() async {
        guard Account.shared.profile != nil else {
            computers = []
            hosted = []
            return
        }
        #if DEBUG
        if ConnectionDemo.on { return }
        #endif
        loading = true
        defer { loading = false }
        if let listed = try? await Account.shared.hosted() {
            await adoptHosted(listed)
            hosted = listed
        }
        var step = "/v1/client/dpop-token" // which call failed, for the trace
        do {
            _ = try await relayAccess()
            step = "/v1/computers"
            let listed = try JSONDecoder().decode(Listed.self, from: try await call(step))
            computers = listed.computers.compactMap { one in
                guard one.id.wholeMatch(of: #/[A-Za-z0-9_-]{8,128}/#) != nil else { return nil }
                let old = computers.first { $0.id == one.id }
                return AccountComputer(id: one.id, name: one.label ?? one.name ?? one.hostname ?? "Computer",
                                       endpoint: AccountComputer.endpoint(one.endpoint ?? one.hostname), status: old?.status ?? .checking,
                                       linkedAt: one.created_at)
            }
        } catch {
            failures += 1
            traceId = "\(step) \(Self.trace(error))"
            if computers.isEmpty { computers = known() }
            // the servers already known stay shown; the warning is for a list with nothing at all in it
            problem = computers.isEmpty && hosted.isEmpty ? "Could not load your computers" : nil
            retryLater()
            return
        }
        failures = 0
        retry?.cancel()
        problem = nil
        traceId = nil
        adopt()
        await withTaskGroup(of: (String, Health?).self) { group in
            for computer in computers {
                group.addTask { [weak self] in
                    let data = try? await self?.call("/v1/computers/\(computer.id)/status", method: "POST", json: [:])
                    return (computer.id, data.flatMap { try? JSONDecoder().decode(Health.self, from: $0) })
                }
            }
            for await (id, health) in group {
                guard let i = computers.firstIndex(where: { $0.id == id }) else { continue }
                computers[i].status = health?.status == "online" ? .online : .offline
                computers[i].offlineReason = health?.offlineReason
                computers[i].endpointFailure = health?.endpointFailure
                computers[i].traceId = health?.traceId
            }
        }
    }

    /// After a failed list: again by itself, later each time (5 s, 15 s, 45 s, 2 min, then every 5 min) while signed in.
    nonisolated static func backoff(_ failures: Int) -> TimeInterval {
        [5, 15, 45, 120, 300][min(max(failures, 1), 5) - 1]
    }

    private func retryLater() {
        retry?.cancel()
        let wait = Self.backoff(failures)
        retry = Task { [weak self] in
            try? await Task.sleep(for: .seconds(wait))
            guard !Task.isCancelled, Account.shared.profile != nil else { return }
            await self?.refresh()
        }
    }

    /// What a failed list said, for the trace under Details: the status and the service's code ("404 not_found").
    nonisolated static func trace(_ error: Error) -> String {
        switch error {
        case APIError.server(let status, let message): return "\(status) \(message)"
        default: return error.localizedDescription
        }
    }

    /// The account's computers this phone already has, while the connect service can't list them.
    private func known() -> [AccountComputer] {
        Connections.shared.servers.compactMap { entry in
            guard entry.platform != "hosted", let route = entry.routes.first(where: { $0.id == Route.accountId }) else { return nil }
            return AccountComputer(id: entry.serverId, name: entry.label, endpoint: route.url)
        }
    }

    // MARK: connecting

    struct Minted: Decodable {
        let endpoint: String?
        let credential: String
    }

    /// A session on a linked computer: the connect service asks the computer for a one-time credential bound to this
    /// phone's key, the phone checks the computer's descriptor, then trades the credential for a DPoP session (1 h).
    func session(for computerId: String) async throws -> (URL, Credential) {
        if let entry = Connections.shared.entry(computerId), entry.platform == "hosted",
           let url = entry.routes.first(where: { $0.id == Route.accountId })?.url {
            return (url, try await hostedSession(url))
        }
        let data: Data
        do {
            data = try await call("/v1/computers/\(computerId)/connect", method: "POST",
                                  json: ["clientProofKeyThumbprint": DPoPKey.shared.thumbprint])
        } catch APIError.server(404, _) {
            throw ConnectionFailure(reason: .configuration, detail: "This computer is not linked to your account.", hop: .account, via: .account, cause: "not_linked")
        } catch APIError.server(let status, let code) {
            throw Self.connectFailure(status: status, code: code)
        } catch let error as AccountError {
            throw ConnectionFailure(reason: .relayUnavailable, detail: error.localizedDescription, hop: .account, via: .account)
        }
        let minted = try JSONDecoder().decode(Minted.self, from: data)
        guard let endpoint = AccountComputer.endpoint(minted.endpoint) ?? computers.first(where: { $0.id == computerId })?.endpoint
            ?? Connections.shared.entry(computerId)?.routes.first(where: { $0.id == Route.accountId })?.url else {
            throw ConnectionFailure(reason: .configuration, detail: "The connect service gave no address for this computer.", hop: .account, via: .account)
        }
        let descriptor: ServerDescriptor
        do {
            descriptor = try await ServerDescriptor.fetch(endpoint, timeout: ConnectionTiming.probeRemote)
        } catch {
            throw ConnectionFailure.from(error, route: .account(endpoint))
        }
        guard descriptor.serverId == computerId else {
            throw ConnectionFailure(reason: .configuration, detail: PairingError.differentServer(descriptor.label).localizedDescription,
                                    hop: .tunnel, via: .account)
        }
        do {
            let credential = try await Pairing.exchange(endpoint, credential: minted.credential, dpop: true, metadata: Pairing.clientMetadata())
            return (endpoint, credential)
        } catch let error as PairingError {
            throw ConnectionFailure(reason: .authentication, detail: error.localizedDescription, hop: .server, via: .account)
        }
    }

    /// A hosted server the account signed in to: the account's sign-in service gives a one-time ticket for it, bound to
    /// this phone's key and a fresh verifier, and the server trades it for a DPoP session (1 h). No sheet, no password.
    func hostedSession(_ url: URL) async throws -> Credential {
        let pkce = Pkce.make()
        do {
            let ticket = try await Account.shared.serverTicket(host: Self.host(url), challenge: pkce.challenge)
            var fields = Pairing.clientMetadata()
            fields["code_verifier"] = pkce.verifier
            return try await Pairing.exchange(url, credential: ticket, dpop: true, metadata: fields, tokenType: Pairing.accountTicketType)
        } catch let error as PairingError {
            throw ConnectionFailure(reason: .authentication, detail: error.localizedDescription, hop: .server, via: .account)
        } catch APIError.server(let status, let words) {
            // the account's site refused the ticket (403: this account never signed in there, or took it off the list)
            throw ConnectionFailure(reason: status == 403 ? .authentication : .relayUnavailable, detail: words, hop: .account, via: .account,
                                    httpStatus: status)
        } catch let error as AccountError {
            throw ConnectionFailure(reason: error == .signedOut ? .authentication : .relayUnavailable, detail: error.localizedDescription,
                                    hop: .account, via: .account)
        } catch let error as URLError {
            throw ConnectionFailure.from(error, route: .account(url))
        }
    }

    /// The host a ticket is for: the name, and the port when there is one.
    nonisolated static func host(_ url: URL) -> String {
        (url.host(percentEncoded: false) ?? "").lowercased() + (url.port.map { ":\($0)" } ?? "")
    }

    /// The account's hosted servers that take its ticket are on this phone with no sign-in, like its computers; one
    /// already here (signed in by address before) stays as it is, and one that can't is left for Sign in.
    private func adoptHosted(_ list: [Computer]) async {
        // a token from before binding gets no tickets: those servers keep Sign in until the next account sign-in
        guard Account.shared.bound else { return }
        let here = Set(Connections.shared.servers.flatMap { $0.routes.map(\.origin) })
        let new = list.filter { !here.contains(Routes.origin($0.url)) }
        let found = await withTaskGroup(of: (Computer, ServerDescriptor?).self) { group in
            for server in new {
                group.addTask { (server, try? await ServerDescriptor.fetch(server.url, timeout: ConnectionTiming.probeRemote)) }
            }
            var out: [(Computer, ServerDescriptor)] = []
            for await (server, d) in group { if let d, d.takesAccount { out.append((server, d)) } }
            return out
        }
        for (server, d) in found {
            Connections.shared.add(serverId: d.serverId, label: d.label, route: .account(server.url), credential: nil, username: nil,
                                   descriptor: d, shown: false)
        }
    }

    /// The connect service's answer to a connect that failed (`apps/relay/src/connect.ts`: `{error: <code>}`), in words:
    /// the computer didn't answer through its tunnel (502/503/504), or it never told the account its key (409).
    nonisolated static func connectFailure(status: Int, code: String) -> ConnectionFailure {
        switch (status, code) {
        case (409, _):
            return ConnectionFailure(reason: .configuration, detail: "Open Creator Toolset on the computer once, then try again.",
                                     hop: .tunnel, via: .account, cause: code, httpStatus: status)
        case (504, _), (_, "computer_timeout"):
            return ConnectionFailure(reason: .remoteUnavailable, detail: "The computer didn't answer in time.", hop: .tunnel,
                                     via: .account, cause: "timeout", httpStatus: status)
        case (502, "invalid_response"):
            return ConnectionFailure(reason: .remoteUnavailable, detail: "The computer's answer didn't check out.", hop: .server,
                                     via: .account, cause: code, httpStatus: status)
        case (502, _), (503, _):
            return ConnectionFailure(reason: .remoteUnavailable, detail: "The computer can't be reached through its tunnel.", hop: .tunnel,
                                     via: .account, cause: status == 503 ? "tunnel_down" : code, httpStatus: status)
        default:
            return ConnectionFailure(reason: .relayUnavailable, detail: "The connect service answered \(status).", hop: .account,
                                     via: .account, cause: code, httpStatus: status)
        }
    }

    // MARK: on this phone

    /// Every computer on the account is on this phone: whether it is on the account is decided on the computer
    /// (Reach from anywhere), never here. A new one is saved and connected without taking the place of the one shown.
    func adopt() {
        for computer in computers where Connections.shared.entry(computer.id) == nil {
            guard let endpoint = computer.endpoint else { continue }
            Connections.shared.add(serverId: computer.id, label: computer.name, route: .account(endpoint), credential: nil,
                                   username: nil, shown: false)
        }
    }

    /// Right after a sign-in every computer on the account is added (`refresh`) and the app picks the one it shows
    /// (`pick`); when it can't tell, the one shown stays. None linked: the first-run screen says to set it up on the
    /// computer.
    func afterSignIn() async {
        let lastUsed = Connections.shared.current?.serverId   // before the account's computers are added
        await AccountPush.register()
        await refresh()
        let online = computers.filter { $0.status == .online }
        let here = await answeringHere(online.map(\.id))
        if let id = Self.pick(computers, answersHere: here, lastUsed: lastUsed),
           let key = Connections.shared.entry(id)?.key {
            Connections.shared.use(key: key)
        }
    }

    /// Which computer the phone uses after an account sign-in, in the owner's order: the offline ones drop out; the
    /// only one left; else the one that answers on this network (its LAN route); else the one this phone used last;
    /// else the one linked to the account most recently. Nil when it truly can't tell.
    nonisolated static func pick(_ computers: [AccountComputer], answersHere: Set<String>, lastUsed: String?) -> String? {
        let online = computers.filter { $0.status == .online }
        if online.count == 1 { return online[0].id }
        guard !online.isEmpty else { return nil }
        let local = online.filter { answersHere.contains($0.id) }
        if local.count == 1 { return local[0].id }
        if let lastUsed, online.contains(where: { $0.id == lastUsed }) { return lastUsed }
        let dated = online.compactMap { c in c.linkedAt.map { (c.id, $0) } }.sorted { $0.1 > $1.1 }
        guard let newest = dated.first, dated.count == online.count, dated.dropFirst().first?.1 != newest.1 else { return nil }
        return newest.0
    }

    /// The computers (by id) whose LAN route, learned on an earlier connection, answers as that same computer on this
    /// network now (its descriptor, 2.5 s each, all at once). A computer never connected before has no LAN route yet.
    private func answeringHere(_ ids: [String]) async -> Set<String> {
        let lan = ids.compactMap { id in Connections.shared.entry(id).map { e in (id, e.routes.filter { $0.kind == .lan }.map(\.url)) } }
        return await withTaskGroup(of: String?.self) { group in
            for (id, urls) in lan {
                for url in urls {
                    group.addTask { (try? await ServerDescriptor.fetch(url, timeout: ConnectionTiming.routeCheck))?.serverId == id ? id : nil }
                }
            }
            var out = Set<String>()
            for await id in group { if let id { out.insert(id) } }
            return out
        }
    }

    /// Signed out: the account's routes go; a computer still reachable another way stays saved.
    func signedOut() {
        retry?.cancel()
        failures = 0
        problem = nil
        relay = nil
        computers = []
        hosted = []
        Connections.shared.accountSignedOut()
    }
}

/// Push through the account (`AccountPush`) signs its calls to the connect service the way the list does.
extension AccountServers: AccountRelay {
    var signedIn: Bool { Account.shared.profile != nil }

    func send(_ path: String, method: String, json: [String: Any]?) async throws -> Int {
        let token = try await relayAccess()
        var request = URLRequest(url: API(server: Account.connectService, cookie: nil).url(path))
        request.httpMethod = method
        request.timeoutInterval = 20
        for (k, v) in Credential(kind: .dpop, token: token).headers(method: method, url: request.url!) { request.setValue(v, forHTTPHeaderField: k) }
        if let json {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONSerialization.data(withJSONObject: json)
        }
        let (_, response) = try await API.session.data(for: request)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        if status == 401 { relay = nil }
        return status
    }

    func computerIds() async throws -> Set<String> {
        Set(try JSONDecoder().decode(Listed.self, from: try await call("/v1/computers")).computers.map(\.id))
    }

    var currentServerId: String? { Connections.shared.current?.serverId }
}
