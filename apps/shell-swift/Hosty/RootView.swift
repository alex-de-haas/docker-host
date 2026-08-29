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

    /// Only the pre-session states show this: once signed in, Settings owns host switching.
    let switcher: HostSwitcher

    @State private var signingIn = false

    var body: some View {
        Group {
            if case .signedIn = session.state, let appsModel {
                ShellTabs(
                    session: session,
                    appsModel: appsModel,
                    router: router,
                    settings: settings)
            } else {
                // Every pre-session state is one screen about the host, and each keeps the switcher:
                // a host that cannot be reached is exactly when the operator needs to leave it, and
                // Settings — where switching otherwise lives — is behind the very session that is
                // missing here.
                NavigationStack {
                    gate
                        .navigationTitle("")
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
            LoginSheet(
                origin: session.connection.origin,
                supportsDeviceLogin: session.supportsDeviceLogin
            ) { sessionID in
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
                Text(session.supportsDeviceLogin
                    ? "Approve a code in your own browser, where your saved password is."
                    : "Hosty opens \(session.connection.displayName)'s own sign-in page.")
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
    @Environment(\.scenePhase) private var scenePhase
    #if os(iOS)
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    private var isCompact: Bool { horizontalSizeClass == .compact }
    #else
    private var isCompact: Bool { false }
    #endif

    /// The app whose workspace is pushed in compact width. Nil in regular, where the same selection is
    /// a sidebar tab instead — one router state, two presentations.
    private var openedApp: Binding<AppSummary?> {
        Binding(
            get: {
                guard isCompact, let id = router.destination.appID else { return nil }
                return appsModel.uiApps.first { $0.id == id }
            },
            set: { app in
                router.destination = app.map { .app($0.id) } ?? .apps
            })
    }

    var body: some View {
        TabView(selection: selection) {
            // Managing a host is administrator-only, and the tab is absent rather than disabled for
            // anyone else: Core does not return the data it would show.
            if session.canManageApps {
                Tab("Dashboard", systemImage: "gauge", value: ShellRouter.Destination.dashboard) {
                    DashboardView(session: session, model: appsModel, router: router)
                }
                .badge(pendingUpdateCount)
            }

            // The flat list is the compact presentation of the apps, and only that. In regular width
            // the sidebar already lists every app by name a few rows below, so a destination whose
            // entire content is a grid of those same rows is a tap that leads back to what the
            // operator can already see.
            if isCompact {
                Tab("Apps", systemImage: "square.grid.2x2", value: ShellRouter.Destination.apps) {
                    NavigationStack {
                        AppsView(model: appsModel, router: router)
                            // Compact only, and the reason the section below is compact-excluded
                            // rather than merely hidden: pushing keeps the destinations in the tab
                            // bar.
                            .navigationDestination(item: openedApp) { app in
                                AppWorkspaceView(app: app, session: session, router: router)
                            }
                    }
                }
            } else {
                // Apps as sidebar entries, beside the destinations, the way the browser Shell lists
                // them.
                //
                // Declared only in regular width. `defaultVisibility(.hidden, for: .tabBar)` does not
                // keep them out of the compact tab bar — verified in the simulator, where the
                // destinations themselves ended up behind a "More" item — so in compact they are not
                // tabs at all and the Apps list pushes instead.
                TabSection("Apps") {
                    ForEach(appsModel.uiApps) { app in
                        // One repeated grid glyph rather than each app's own artwork. A tab draws
                        // an icon only from its `systemImage`/`image` initializers: handed a plain
                        // `Color` with an explicit frame a custom label drew nothing at all, and
                        // handed the app's `Image` it drew it stretched into a tall pill — an
                        // explicit square frame and a 1:1 aspect ratio were both ignored. Per-app
                        // artwork here needs a `List`-backed sidebar instead of a `TabSection`.
                        Tab(app.displayName, systemImage: "square.grid.2x2", value: ShellRouter.Destination.app(app.id)) {
                            NavigationStack {
                                AppWorkspaceView(app: app, session: session, router: router)
                            }
                        }
                    }
                }
            }

            Tab("Settings", systemImage: "gearshape", value: ShellRouter.Destination.settings) {
                NavigationStack {
                    settings
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

    /// The tab actually on screen for the router's destination.
    ///
    /// Two destinations can name something that is not there: Dashboard, which Core answers to nobody
    /// but an administrator, and — in regular width — the flat Apps list, which the sidebar replaces.
    /// This only keeps the selection on a destination that exists; the router keeps saying where the
    /// operator meant to be.
    private var selection: Binding<ShellRouter.Destination> {
        Binding(
            get: {
                switch router.destination {
                case .dashboard where !session.canManageApps:
                    return firstAvailable

                case .apps where !isCompact:
                    return firstAvailable

                // Compact has no per-app tab; the workspace is pushed inside Apps, which stays the
                // selected destination while it is open.
                case .app where isCompact:
                    return .apps

                default:
                    return router.destination
                }
            },
            set: { router.destination = $0 })
    }

    /// Where a destination with no tab of its own lands. Settings is the floor: it is the one
    /// destination every role gets on every host, including one with no apps installed at all.
    private var firstAvailable: ShellRouter.Destination {
        if session.canManageApps { return .dashboard }
        if isCompact { return .apps }
        return appsModel.uiApps.first.map { .app($0.id) } ?? .settings
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
