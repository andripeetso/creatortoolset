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
    @Published private(set) var problem: String?
    @Published private(set) var traceId: String?
    /// "Set up" after a sign-in: the linked computers with switches.
    @Published var setupShown = false

    private var relay: Credential?

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
        problem = nil
        traceId = nil
        defer { loading = false }
        hosted = (try? await Account.shared.hosted()) ?? hosted
        do {
            let listed = try JSONDecoder().decode(Listed.self, from: try await call("/v1/computers"))
            computers = listed.computers.compactMap { one in
                guard one.id.wholeMatch(of: #/[A-Za-z0-9_-]{8,128}/#) != nil else { return nil }
                let old = computers.first { $0.id == one.id }
                return AccountComputer(id: one.id, name: one.label ?? one.name ?? one.hostname ?? "Computer",
                                       endpoint: AccountComputer.endpoint(one.endpoint ?? one.hostname), status: old?.status ?? .checking)
            }
        } catch {
            problem = "Could not load your computers"
            traceId = (error as? APIError).map { "\($0.status)" }
            return
        }
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

    // MARK: connecting

    struct Minted: Decodable {
        let endpoint: String?
        let credential: String
    }

    /// A session on a linked computer: the connect service asks the computer for a one-time credential bound to this
    /// phone's key, the phone checks the computer's descriptor, then trades the credential for a DPoP session (1 h).
    func session(for computerId: String) async throws -> (URL, Credential) {
        let data: Data
        do {
            data = try await call("/v1/computers/\(computerId)/connect", method: "POST",
                                  json: ["clientProofKeyThumbprint": DPoPKey.shared.thumbprint])
        } catch APIError.server(404, _) {
            throw ConnectionFailure(reason: .configuration, detail: "This computer is not linked to your account.", hop: .account, via: .account, cause: "not_linked")
        } catch APIError.server(let status, let words) {
            throw ConnectionFailure(reason: status == 503 || status == 504 ? .remoteUnavailable : .relayUnavailable, detail: words,
                                    hop: status == 503 || status == 504 ? .tunnel : .account, via: .account,
                                    cause: status == 503 ? "tunnel_down" : status == 504 ? "timeout" : "relay_error", httpStatus: status)
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

    // MARK: on this phone

    func isAdded(_ computerId: String) -> Bool { Connections.shared.entry(computerId)?.enabled == true }

    /// The switch: on adds the computer (or switches a saved one back on) and connects it; off keeps it saved, not
    /// connected.
    func setAdded(_ computer: AccountComputer, _ on: Bool) {
        if Connections.shared.entry(computer.id) != nil { return Connections.shared.setEnabled(computer.id, on) }
        guard on, let endpoint = computer.endpoint else { return }
        Connections.shared.add(serverId: computer.id, label: computer.name, route: .account(endpoint), credential: nil, username: nil)
    }

    /// Right after a sign-in: one computer that answers is added at once; several open the setup sheet, unless the
    /// person said not to show it again. None: the first-run screen says to set it up on the computer.
    func afterSignIn() async {
        await refresh()
        let online = computers.filter { $0.status == .online }
        if computers.count == 1, let only = online.first, Connections.shared.entry(only.id) == nil {
            return setAdded(only, true)
        }
        if !computers.isEmpty, !optedOut { setupShown = true }
    }

    var optedOut: Bool {
        get { UserDefaults.standard.bool(forKey: optOutKey) }
        set { UserDefaults.standard.set(newValue, forKey: optOutKey) }
    }

    private var optOutKey: String { "connectSetupOptOut." + (Account.shared.profile?.email ?? "") }

    /// Signed out: the account's routes go; a computer still reachable another way stays saved.
    func signedOut() {
        relay = nil
        computers = []
        hosted = []
        Connections.shared.accountSignedOut()
    }
}
