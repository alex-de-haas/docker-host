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
/// apps directly and this list is hidden, which is why selecting a row sets the shared destination
/// rather than pushing.
struct AppsView: View {
    let model: AppsModel
    let router: ShellRouter
    @State private var searchText = ""

    var body: some View {
        List {
            ForEach(filtered) { app in
                Button {
                    router.open(appID: app.id)
                } label: {
                    AppLauncherRow(app: app, icons: model.icons)
                }
                .buttonStyle(.plain)
            }
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

/// An app as something to use rather than something to administer: its name, and whether it is ready.
/// Version, runtime and lifecycle state belong to Dashboard.
private struct AppLauncherRow: View {
    let app: AppSummary
    let icons: AppIconStore

    var body: some View {
        HStack(spacing: 12) {
            AppIconView(app: app, icons: icons)

            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    Text(app.displayName)
                        .font(.body)
                        .foregroundStyle(.primary)

                    if app.system {
                        BadgeChip(text: "System", tint: .secondary)
                    }
                }

                if !app.runtimeState.isUp {
                    // Being openable and being ready are different questions. Saying which one is
                    // unmet beats a row that simply fails when tapped.
                    Text(app.runtimeState.isBusy ? "Starting…" : "Not running")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }

            Spacer(minLength: 0)

            Image(systemName: "chevron.right")
                .font(.caption)
                .foregroundStyle(.tertiary)
        }
        .padding(.vertical, 2)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }
}
