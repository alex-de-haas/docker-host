import HostyKit
import SwiftUI

struct RootView: View {
    @State private var model = HostyModel()
    @State private var addingHost = false

    var body: some View {
        NavigationStack {
            content
                .navigationTitle(model.activeHost?.displayName ?? "Hosty")
                .toolbar { toolbar }
        }
        .sheet(isPresented: $addingHost) {
            NavigationStack {
                AddHostView { model.add($0) }
            }
        }
    }

    @ViewBuilder
    private var content: some View {
        if let session = model.session {
            HostSessionView(session: session)
                // A fresh session object per host: `id` forces the subview (and its state) to be rebuilt
                // when the operator switches hosts, rather than showing one host's state under another's
                // name for a moment.
                .id(session.connection.origin)
        } else {
            ContentUnavailableView {
                Label("No host yet", systemImage: "server.rack")
            } description: {
                Text("Add the Hosty host you want to manage.")
            } actions: {
                Button("Add a host") { addingHost = true }
            }
        }
    }

    @ToolbarContentBuilder
    private var toolbar: some ToolbarContent {
        ToolbarItem {
            Menu {
                if !model.hosts.isEmpty {
                    Picker("Host", selection: hostSelection) {
                        ForEach(model.hosts) { host in
                            Text(host.displayName).tag(host.origin as HostOrigin?)
                        }
                    }
                }

                Button("Add a host…") { addingHost = true }

                if let active = model.activeHost {
                    Divider()
                    Button("Forget \(active.displayName)", role: .destructive) {
                        model.remove(active)
                    }
                }
            } label: {
                Label("Hosts", systemImage: "server.rack")
            }
        }
    }

    private var hostSelection: Binding<HostOrigin?> {
        Binding(
            get: { model.activeHost?.origin },
            set: { origin in
                guard let host = model.hosts.first(where: { $0.origin == origin }) else { return }
                model.select(host)
            })
    }
}

/// One host, in whichever of its states it is currently in.
struct HostSessionView: View {
    @Bindable var session: HostSession
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
                    Text("\(session.connection.displayName) runs Hosty \(hostVersion). This app signs in with a bearer session, which Hosty \(PlatformVersion.minimumSupported) added — update the host, then try again.")
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
                if session.canManageApps {
                    AppListView(session: session)
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
        .task { await session.refresh() }
        .sheet(isPresented: $signingIn) {
            LoginSheet(origin: session.connection.origin) { sessionID in
                Task { await session.adopt(sessionID: sessionID) }
            }
        }
    }
}

#Preview {
    RootView()
}
