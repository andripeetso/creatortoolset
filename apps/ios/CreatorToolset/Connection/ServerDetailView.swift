import SwiftUI

/// One computer: its connection (and, when it fails, what failed and what to try), its routes, what this phone may
/// do there, and its version.
struct ServerDetailView: View {
    let serverId: String
    @ObservedObject private var connections = Connections.shared
    @ObservedObject private var accountServers = AccountServers.shared
    @State private var addingRoute = false
    @State private var removing: ServerEntry?
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        if let entry = connections.entry(serverId) {
            form(entry)
        } else {
            ContentUnavailableView("Removed", systemImage: "desktopcomputer")
        }
    }

    private func form(_ entry: ServerEntry) -> some View {
        let state = connections.state(serverId)
        let diagnosis = ConnectionDiagnosis.make(.init(
            host: entry.label, state: state,
            via: entry.routes.first(where: { $0.id == state.routeId })?.kind == .account || entry.routes.allSatisfy({ $0.authorization == .account }) ? .account : .direct,
            accountStatus: accountServers.computers.first { $0.id == serverId },
            appVersion: SettingsView.version, serverVersion: entry.version))
        return Form {
            Section("Connection") {
                HStack(spacing: 12) {
                    ConnectionDot(state: state)
                    Text(entry.enabled ? ConnectionWords.text(state) : "Switched off")
                    Spacer()
                }
                Toggle("Connect this computer", isOn: Binding(get: { entry.enabled }, set: { connections.setEnabled(serverId, $0) }))
                if entry.enabled, state.phase != .connected {
                    Button("Retry now") { connections.retry(serverId) }
                }
            }
            if entry.enabled, let diagnosis { DiagnosisView(host: entry.label, diagnosis: diagnosis) }
            Section {
                ForEach(Array(entry.routes.enumerated()), id: \.element.id) { index, route in
                    routeRow(route, index: index, of: entry.routes.count, inUse: state.phase == .connected && state.routeId == route.id)
                        .swipeActions {
                            if !route.learned, entry.routes.filter({ !$0.learned }).count > 1 {
                                Button("Remove", role: .destructive) { removeRoute(entry, route) }
                            }
                        }
                        .accessibilityAction(named: "Remove \(route.label) route") { removeRoute(entry, route) }
                }
                .onMove { from, to in move(entry, from, to) }
                Button("Add route", systemImage: "plus") { addingRoute = true }
            } header: {
                HStack {
                    Text("Routes")
                    Spacer()
                    EditButton().font(.caption).textCase(nil)
                }
            } footer: {
                Text("The phone picks the route by itself: the nearest that answers, checked again every minute and when the network changes.")
            }
            Section("Your permissions") {
                let scopes = ServerRegistry.credential(serverId, route: entry.activeRoute ?? entry.routes[0])?.scopes
                permission("See everything", "read", scopes)
                permission("Make changes", "write", scopes)
                permission("Manage access", "access", scopes)
            }
            Section("Creator Toolset") {
                LabeledContent("Version", value: entry.version ?? "Not known yet")
                if entry.updateRequired == true {
                    Text("This app needs a newer version of Creator Toolset on this computer.").foregroundStyle(.orange)
                }
                if let reason = entry.unsupportedReason { Text(reason).foregroundStyle(.secondary) }
            }
            Section {
                Button("Remove from this device", role: .destructive) { removing = entry }
            } footer: {
                Text("Removing only forgets it on this phone. To sign this phone out of the computer, revoke it there: Settings → Computers.")
            }
        }
        .navigationTitle(entry.label)
        .navigationBarTitleDisplayMode(.inline)
        .sheet(isPresented: $addingRoute) { NavigationStack { AddServerView(routeFor: entry) } }
        .alert("Remove from this device?", isPresented: Binding(get: { removing != nil }, set: { if !$0 { removing = nil } }), presenting: removing) { entry in
            Button("Cancel", role: .cancel) {}
            Button("Remove", role: .destructive) {
                connections.remove(entry.serverId)
                dismiss()
            }
        } message: { entry in
            Text("Forget \(entry.label) and what this phone keeps of it. Switch it off instead to keep it saved.")
        }
    }

    private func routeRow(_ route: Route, index: Int, of count: Int, inUse: Bool) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack {
                Text(route.label)
                if inUse { Text("In use").font(.caption.weight(.semibold)).foregroundStyle(.green) }
                Spacer()
                Text("Route \(index + 1) of \(count)").font(.caption2).foregroundStyle(.secondary)
            }
            Text(route.kind == .account ? "Through your account" : Routes.origin(route.url))
                .font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
            if route.learned { Text("Found automatically").font(.caption2).foregroundStyle(.secondary) }
        }
        .accessibilityElement(children: .combine)
    }

    private func permission(_ title: String, _ scope: String, _ scopes: [String]?) -> some View {
        LabeledContent(title, value: scopes == nil ? "Not known" : scopes!.contains(scope) ? "Allowed" : "Not granted")
    }

    private func removeRoute(_ entry: ServerEntry, _ route: Route) {
        guard !route.learned, entry.routes.filter({ !$0.learned }).count > 1 else { return }
        ServerRegistry.setCredential(serverId, routeId: route.id, nil)
        connections.setRoutes(serverId, Routes.removing(entry.routes, route.id))
    }

    private func move(_ entry: ServerEntry, _ from: IndexSet, _ to: Int) {
        var routes = entry.routes
        routes.move(fromOffsets: from, toOffset: to)
        connections.setRoutes(serverId, routes)
    }
}
