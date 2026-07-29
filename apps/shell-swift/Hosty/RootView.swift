import Foundation
import HostyKit
import SwiftUI

struct RootView: View {
    @State private var model: HostyModel
    @State private var addingHost = false
    @State private var selectedAppID: String?
    @State private var hostPendingRemoval: HostConnection?
    @State private var confirmingHostRemoval = false
    @State private var columnVisibility: NavigationSplitViewVisibility = .all
    @State private var preferredCompactColumn: NavigationSplitViewColumn

    init(model: HostyModel = HostyModel()) {
        _model = State(initialValue: model)
        _preferredCompactColumn = State(initialValue: model.session == nil ? .sidebar : .content)
    }

    var body: some View {
        NavigationSplitView(
            columnVisibility: $columnVisibility,
            preferredCompactColumn: $preferredCompactColumn
        ) {
            hostSidebar
        } content: {
            hostContent
        } detail: {
            appDetail
        }
        .navigationSplitViewStyle(.balanced)
        .sheet(isPresented: $addingHost) {
            NavigationStack {
                AddHostView { connection in
                    model.add(connection)
                    selectedAppID = nil
                    preferredCompactColumn = .content
                }
            }
        }
        .confirmationDialog(
            "Forget this host?",
            isPresented: $confirmingHostRemoval,
            presenting: hostPendingRemoval
        ) { host in
            Button("Forget \(host.displayName)", role: .destructive) {
                model.remove(host)
                selectedAppID = nil
                preferredCompactColumn = model.session == nil ? .sidebar : .content
                hostPendingRemoval = nil
            }

            Button("Cancel", role: .cancel) {
                hostPendingRemoval = nil
            }
        } message: { host in
            Text("The saved sign-in for \(host.displayName) will also be removed from this device.")
        }
        .onChange(of: model.activeHost?.origin) {
            selectedAppID = nil
        }
    }

    private var hostSidebar: some View {
        List(selection: hostSelection) {
            ForEach(model.hosts) { host in
                NavigationLink(value: host.origin) {
                    HostRow(host: host, selected: host.origin == model.activeHost?.origin)
                }
                .contextMenu {
                    Button("Forget \(host.displayName)…", role: .destructive) {
                        requestRemoval(of: host)
                    }
                }
                .swipeActions {
                    Button("Forget", role: .destructive) {
                        requestRemoval(of: host)
                    }
                }
            }
        }
        .overlay {
            if model.hosts.isEmpty {
                ContentUnavailableView {
                    Label("No host yet", systemImage: "server.rack")
                } description: {
                    Text("Add the Hosty host you want to manage.")
                } actions: {
                    Button("Add a host") { addingHost = true }
                }
            }
        }
        .navigationTitle("Hosts")
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button("Add a host", systemImage: "plus") {
                    addingHost = true
                }
            }
        }
    }

    @ViewBuilder
    private var hostContent: some View {
        if let session = model.session {
            HostSessionView(
                session: session,
                appsModel: model.appsModel,
                selectedAppID: $selectedAppID
            )
            // Each host owns an independent authenticated client and event stream. Rebuilding this branch
            // prevents any transient state from the previous host appearing under the new host's name.
            .id(session.connection.origin)
        } else {
            ContentUnavailableView {
                Label("Select a host", systemImage: "server.rack")
            } description: {
                Text("Choose a saved host in the sidebar, or add a new one.")
            }
            .navigationTitle("Hosty")
        }
    }

    @ViewBuilder
    private var appDetail: some View {
        if let selectedAppID, let appsModel = model.appsModel {
            AppDetailView(appID: selectedAppID, model: appsModel)
                .id(selectedAppID)
        } else {
            ContentUnavailableView {
                Label("Select an app", systemImage: "shippingbox")
            } description: {
                Text("Choose an installed app to see its state, services, and available actions.")
            }
        }
    }

    private var hostSelection: Binding<HostOrigin?> {
        Binding(
            get: { model.activeHost?.origin },
            set: { origin in
                guard let host = model.hosts.first(where: { $0.origin == origin }) else { return }
                model.select(host)
                selectedAppID = nil
                preferredCompactColumn = .content
            })
    }

    private func requestRemoval(of host: HostConnection) {
        hostPendingRemoval = host
        confirmingHostRemoval = true
    }
}

private struct HostRow: View {
    let host: HostConnection
    let selected: Bool

    var body: some View {
        Label {
            VStack(alignment: .leading, spacing: 2) {
                Text(host.displayName)
                    .font(.body)

                if host.name != nil {
                    Text(host.origin.displayName)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
        } icon: {
            Image(systemName: "server.rack")
                .foregroundStyle(selected ? Color.accentColor : Color.secondary)
        }
        .accessibilityElement(children: .combine)
    }
}

/// One host, in whichever of its states it is currently in.
struct HostSessionView: View {
    @Bindable var session: HostSession
    let appsModel: AppsModel?
    @Binding var selectedAppID: String?
    @State private var signingIn = false

    var body: some View {
        Group {
            switch session.state {
            case .connecting:
                ProgressView("Connecting to \(session.connection.displayName)…")

            case .signedOut:
                ContentUnavailableView {
                    Label("Sign in", systemImage: "person.badge.key")
                } description: {
                    Text("Hosty opens \(session.connection.displayName)'s own sign-in page.")
                } actions: {
                    Button("Sign in") { signingIn = true }
                }

            case .unsupported(let hostVersion):
                ContentUnavailableView {
                    Label("Host is too old", systemImage: "arrow.up.circle")
                } description: {
                    Text("\(session.connection.displayName) runs Hosty \(hostVersion). This app signs in with a bearer session, which Hosty \(PlatformVersion.minimumSupported.description) added — update the host, then try again.")
                } actions: {
                    Button("Check again") { Task { await session.refresh() } }
                }

            case .unreachable(let message):
                ContentUnavailableView {
                    Label("Cannot reach this host", systemImage: "exclamationmark.triangle")
                } description: {
                    Text(message)
                } actions: {
                    Button("Try again") { Task { await session.refresh() } }
                }

            case .signedIn(let user):
                if session.canManageApps, let appsModel {
                    AppListView(model: appsModel, selection: $selectedAppID)
                        .toolbar {
                            ToolbarItem(placement: .primaryAction) {
                                Menu {
                                    Text(user.name)
                                    Button("Sign out") { Task { await session.signOut() } }
                                } label: {
                                    Label("Account", systemImage: "person.crop.circle")
                                }
                            }
                        }
                } else if session.canManageApps {
                    ProgressView("Loading apps…")
                } else {
                    // Installed Apps, every lifecycle verb, and every update endpoint are administrator-only.
                    // Saying so plainly beats an empty list or a permission error the operator has to
                    // interpret.
                    ContentUnavailableView {
                        Label("Not an administrator", systemImage: "lock")
                    } description: {
                        Text("\(user.name) is signed in to \(session.connection.displayName), but managing apps needs a Hosty administrator.")
                    } actions: {
                        Button("Sign out") { Task { await session.signOut() } }
                    }
                }
            }
        }
        .navigationTitle(session.connection.displayName)
        .task { await session.refresh() }
        .onChange(of: session.state) { _, state in
            guard case .signedIn = state else {
                appsModel?.resetAfterSignOut()
                selectedAppID = nil
                return
            }
        }
        .sheet(isPresented: $signingIn) {
            LoginSheet(origin: session.connection.origin) { sessionID in
                Task { await session.adopt(sessionID: sessionID) }
            }
        }
    }
}

private struct EmptyRootPreview: View {
    @State private var model: HostyModel

    init() {
        guard let defaults = UserDefaults(suiteName: "com.haas.hosty.preview.\(UUID().uuidString)") else {
            preconditionFailure("Could not create isolated preview defaults.")
        }

        _model = State(initialValue: HostyModel(store: HostStore(defaults: defaults)))
    }

    var body: some View {
        RootView(model: model)
    }
}

#Preview("No hosts") {
    EmptyRootPreview()
}
