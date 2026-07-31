import HostyKit
import SwiftUI

/// The launcher: the apps this host offers, and nothing about managing them.
///
/// Only apps Core resolved a UI for appear — a headless app has nothing to open, and public endpoints
/// alone do not make one. There is no system/ordinary split: Core already filtered the list for this
/// user and refuses a launch code for a system app to anyone but an administrator, so a second rule
/// here would copy an authorization decision.
///
/// In compact width this is the Apps tab's own screen; in regular width the sidebar lists the same
/// apps directly and this grid is hidden, which is why selecting one sets the shared destination
/// rather than pushing.
///
/// A grid of icons rather than a list of rows, because this destination answers one question — which
/// app do I want to open — and an icon answers it faster than a line of text. Everything a row carried
/// besides the name (version, runtime, system ownership) is management detail and lives on Dashboard.
struct AppsView: View {
    let model: AppsModel
    let router: ShellRouter
    @State private var searchText = ""

    /// The narrowest a tile may be, at the standard text size. Scaled, so the grid answers Dynamic Type
    /// by reflowing to fewer, wider columns instead of squeezing names into a stack of hyphens.
    @ScaledMetric(relativeTo: .caption) private var minimumTileWidth: CGFloat = 84

    var body: some View {
        ScrollView {
            LazyVGrid(columns: [GridItem(.adaptive(minimum: minimumTileWidth), spacing: 8)], spacing: 22) {
                ForEach(filtered) { app in
                    Button {
                        router.open(appID: app.id)
                    } label: {
                        AppLauncherTile(app: app, icons: model.icons)
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.horizontal, 16)
            .padding(.top, 12)
            .padding(.bottom, 24)
        }
        .overlay {
            if !searchText.isEmpty && !model.uiApps.isEmpty && filtered.isEmpty {
                ContentUnavailableView.search(text: searchText)
            } else if model.uiApps.isEmpty {
                emptyState
            }
        }
        .searchable(text: $searchText, prompt: "Search apps")
        .navigationTitle("Apps")
        .navigationSubtitle(model.hostName)
        // The same trade as Dashboard, which this destination sits beside: a leading inline title, the
        // search collapsed into the bar, and no band of chrome above the content. Peer tabs that
        // disagreed about their own chrome would read as two different screens.
        .toolbarTitleDisplayMode(.inlineLarge)
        #if os(iOS)
        .searchToolbarBehavior(.minimize)
        .contentMargins(.top, 0, for: .scrollContent)
        #endif
        .refreshable { await model.reload() }
    }

    private var filtered: [AppSummary] {
        guard !searchText.isEmpty else { return model.uiApps }

        return model.uiApps.filter { app in
            app.displayName.localizedStandardContains(searchText)
                || app.id.localizedStandardContains(searchText)
        }
    }

    @ViewBuilder
    private var emptyState: some View {
        if !model.hasLoaded {
            ProgressView("Loading apps…")
        } else {
            ContentUnavailableView {
                Label("No apps to open", systemImage: "square.grid.2x2")
            } description: {
                Text("Apps appear here once one is installed with a user interface.")
            }
        }
    }
}

/// An app as something to use rather than something to administer: its icon, its name, and whether it
/// is ready. Version, runtime and system ownership belong to Dashboard — a launcher that repeated them
/// would be a management screen with bigger pictures.
private struct AppLauncherTile: View {
    let app: AppSummary
    let icons: AppIconStore

    var body: some View {
        VStack(spacing: 6) {
            AppIconView(app: app, icons: icons, edge: 60)
                // Being openable and being ready are different questions, and this is where the second
                // one is answered. A dimmed icon says it at a glance across a whole screen of them; the
                // dot says which kind of not-ready, and the accessibility label says it in words, since
                // neither dimming nor a colour survives being read aloud.
                .opacity(app.runtimeState.isUp ? 1 : 0.4)
                .overlay(alignment: .bottomTrailing) { stateDot }

            Text(app.displayName)
                .font(.caption)
                .multilineTextAlignment(.center)
                // Two lines with the space reserved, rather than the home screen's single truncated
                // one. A home screen can truncate because its names are short by convention; these are
                // "Hosty Marketplace" and "Project Manager", and one line cuts almost every one of them.
                // Reserving the second keeps every tile the same height whether or not a name uses it.
                .lineLimit(2, reservesSpace: true)
                .foregroundStyle(.primary)
        }
        .frame(maxWidth: .infinity)
        .contentShape(Rectangle())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(app.displayName), \(readiness)")
        .accessibilityAddTraits(.isButton)
    }

    @ViewBuilder
    private var stateDot: some View {
        if !app.runtimeState.isUp {
            Circle()
                .fill(app.runtimeState.isBusy ? Color.orange : Color.secondary)
                .frame(width: 10, height: 10)
                .overlay(Circle().strokeBorder(.background, lineWidth: 2))
                .offset(x: 3, y: 3)
        }
    }

    private var readiness: String {
        if app.runtimeState.isUp {
            return "ready"
        }

        return app.runtimeState.isBusy ? "starting" : "not running"
    }
}

#if DEBUG
/// The readiness treatment, which a healthy host cannot show: every app on one is running.
#Preview("Launcher tiles") {
    let icons = AppIconStore(previewImages: PreviewFixtures.icons)

    LazyVGrid(columns: [GridItem(.adaptive(minimum: 84), spacing: 8)], spacing: 22) {
        AppLauncherTile(app: PreviewFixtures.runningApp, icons: icons)
        AppLauncherTile(app: PreviewFixtures.app(PreviewFixtures.runningApp, runtimeState: .starting), icons: icons)
        AppLauncherTile(app: PreviewFixtures.app(PreviewFixtures.runningApp, runtimeState: .stopped), icons: icons)
        AppLauncherTile(app: PreviewFixtures.systemApp, icons: icons)
    }
    .padding()
}

#Preview("Launcher tiles — accessibility size") {
    let icons = AppIconStore(previewImages: PreviewFixtures.icons)

    LazyVGrid(columns: [GridItem(.adaptive(minimum: 84), spacing: 8)], spacing: 22) {
        AppLauncherTile(app: PreviewFixtures.runningApp, icons: icons)
        AppLauncherTile(app: PreviewFixtures.app(PreviewFixtures.runningApp, runtimeState: .stopped), icons: icons)
    }
    .padding()
    .environment(\.dynamicTypeSize, .accessibility3)
}
#endif
