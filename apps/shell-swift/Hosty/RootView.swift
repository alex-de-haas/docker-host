import Foundation
import HostyKit
import SwiftUI

/// The whole interface: one host's three destinations, or the reason there is nothing to show yet.
///
/// The session gate lives *above* the `TabView` rather than inside a tab. Three tabs over a sign-in
/// prompt describe nothing — every one of them would be empty for the same reason — and the states
/// that are not `signedIn` are about the host, not about a section of it.
struct RootView: View {
    @State private var model: HostyModel
    @State private var router = ShellRouter()
    @State private var addingHost = false

    init(model: HostyModel = HostyModel()) {
        _model = State(initialValue: model)
    }

    var body: some View {
        Group {
            if model.hosts.isEmpty {
                NavigationStack { onboarding }
            } else if let session = model.session {
                HostScene(
                    session: session,
                    appsModel: model.appsModel,
                    router: router,
                    settings: settingsView,
                    switcher: switcher)
                    // Each host owns an independent authenticated client and event stream. Rebuilding
                    // this branch prevents any transient state from the previous host appearing under
                    // the new host's name.
                    .id(session.connection.origin)
            } else {
                // Hosts exist but none is active — only reachable between a removal and the next
                // selection, and never worth a screen of its own.
                ProgressView()
            }
        }
        .sheet(isPresented: $addingHost) {
            NavigationStack {
                AddHostView { connection in
                    model.add(connection)
                    router.resetForHostChange()
                }
            }
        }
        .onChange(of: model.activeHost?.origin) {
            router.resetForHostChange()
        }
    }

    private var onboarding: some View {
        ContentUnavailableView {
            Label("No host yet", systemImage: "server.rack")
        } description: {
            Text("Add the Hosty host you want to manage.")
        } actions: {
            Button("Add a host") { addingHost = true }
        }
        .navigationTitle("Hosty")
    }

    private var switcher: HostSwitcher {
        HostSwitcher(
            hosts: model.hosts,
            activeHost: model.activeHost,
            onSelect: { model.select($0) },
            onAddHost: { addingHost = true })
    }

    private var settingsView: SettingsView {
        SettingsView(
            hosts: model.hosts,
            activeHost: model.activeHost,
            session: model.session,
            onSelect: { model.select($0) },
            onAddHost: { addingHost = true },
            onForget: { model.remove($0) })
    }
}

/// One host: either its three destinations, or the single state that explains why there are none.
private struct HostScene: View {
    @Bindable var session: HostSession
    let appsModel: AppsModel?
    let router: ShellRouter
    let settings: SettingsView
    let switcher: HostSwitcher

    @State private var signingIn = false

    var body: some View {
        Group {
            if case .signedIn = session.state, let appsModel {
                ShellTabs(
                    session: session,
                    appsModel: appsModel,
                    router: router,
                    settings: settings,
                    switcher: switcher)
            } else {
                // Every pre-session state is one screen about the host, and each keeps the switcher:
                // a host that cannot be reached is exactly when the operator needs to leave it.
                NavigationStack {
                    gate
                        .navigationTitle(session.connection.displayName)
                        .toolbar { ToolbarItem(placement: .principal) { switcher } }
                }
            }
        }
        .task { await session.refresh() }
        .onChange(of: session.state) { _, state in
            guard case .signedIn = state else {
                appsModel?.resetAfterSignOut()
                router.resetForHostChange()
                return
            }
        }
        .sheet(isPresented: $signingIn) {
            LoginSheet(origin: session.connection.origin) { sessionID in
                Task { await session.adopt(sessionID: sessionID) }
            }
        }
    }

    @ViewBuilder
    private var gate: some View {
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

        case .signedIn:
            // Reached only in the moment between signing in and the app model existing.
            ProgressView("Loading apps…")
        }
    }
}

/// Dashboard, Apps, Settings — a tab bar on a phone and a sidebar on iPad and macOS, from one
/// declaration.
///
/// The apps live in their own `TabSection` so the sidebar lists them beside the destinations, the way
/// the browser Shell's does. That section is hidden from the compact tab bar, where a dozen apps would
/// crowd out the destinations; the flat Apps list is hidden from the sidebar, where it would only
/// duplicate the section.
private struct ShellTabs: View {
    let session: HostSession
    let appsModel: AppsModel
    let router: ShellRouter
    let settings: SettingsView
    let switcher: HostSwitcher
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        TabView(selection: selection) {
            // Managing a host is administrator-only, and the tab is absent rather than disabled for
            // anyone else: Core does not return the data it would show.
            if session.canManageApps {
                Tab("Dashboard", systemImage: "gauge", value: ShellRouter.Destination.dashboard) {
                    DashboardView(session: session, model: appsModel, router: router, switcher: switcher)
                }
                .badge(pendingUpdateCount)
            }

            Tab("Apps", systemImage: "square.grid.2x2", value: ShellRouter.Destination.apps) {
                NavigationStack {
                    AppsView(model: appsModel, router: router)
                        .toolbar { ToolbarItem(placement: .principal) { switcher } }
                }
            }
            .hiddenFromSidebar()

            TabSection("Apps") {
                ForEach(appsModel.uiApps) { app in
                    Tab(app.displayName, systemImage: "square.grid.2x2", value: ShellRouter.Destination.app(app.id)) {
                        NavigationStack {
                            AppWorkspaceView(app: app, session: session, router: router)
                        }
                    }
                }
            }
            .hiddenFromTabBar()

            Tab("Settings", systemImage: "gearshape", value: ShellRouter.Destination.settings) {
                NavigationStack {
                    settings
                        .toolbar { ToolbarItem(placement: .principal) { switcher } }
                }
            }
        }
        .tabViewStyle(.sidebarAdaptable)
        .onChange(of: appsModel.apps.map(\.id)) { _, ids in
            router.reconcile(availableAppIDs: Set(ids))
        }
        // `follow` yields a resync on connect, and that resync is the first load, so asking for the
        // list here as well would fetch it twice.
        .task { appsModel.follow() }
        // Coming back to the foreground forces a re-read: a suspended app's connection dies quietly,
        // and the reconnect that follows can be several backoff steps in, so the stream alone can
        // leave half a minute of state from before the phone was pocketed.
        .onChange(of: scenePhase) { _, phase in
            switch phase {
            case .active:
                appsModel.follow()
                Task { await appsModel.reload() }
            case .background:
                appsModel.stopFollowing()
            default:
                break
            }
        }
    }

    /// Everything the badge counts is actionable on Dashboard: the apps with an update waiting, plus
    /// Core itself as one more. A badge pointing at a screen with nothing to act on would be the wrong
    /// kind of consistency.
    private var pendingUpdateCount: Int {
        let apps = appsModel.apps.filter { $0.updateCheck?.updateAvailable == true }.count
        return apps + (appsModel.coreUpdate?.canApply == true ? 1 : 0)
    }

    /// A non-administrator has no Dashboard, so a selection pointing at it would render nothing. Core
    /// decides the role; this only keeps the selection on a destination that exists.
    private var selection: Binding<ShellRouter.Destination> {
        Binding(
            get: {
                if router.destination == .dashboard, !session.canManageApps {
                    return .apps
                }

                return router.destination
            },
            set: { router.destination = $0 })
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

/// `AdaptableTabBarPlacement` is an iOS type: on macOS the adaptive style is always a sidebar, so
/// there is no second placement to hide anything from. These keep the tab declarations readable
/// instead of splitting the whole `TabView` in two with `#if`.
extension TabContent {
    /// Hides a tab where the sidebar already lists the same thing.
    func hiddenFromSidebar() -> some TabContent<TabValue> {
        #if os(iOS)
        defaultVisibility(.hidden, for: .sidebar)
        #else
        self
        #endif
    }

    /// Keeps per-app tabs out of the compact tab bar, where a dozen apps would crowd out the
    /// destinations.
    func hiddenFromTabBar() -> some TabContent<TabValue> {
        #if os(iOS)
        defaultVisibility(.hidden, for: .tabBar)
        #else
        self
        #endif
    }
}
