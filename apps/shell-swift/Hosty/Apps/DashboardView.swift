import HostyKit
import SwiftUI

/// The management surface: what the host is, and every app on it.
///
/// Same order and the same division as the browser Shell's Dashboard — facts about the host sit beside
/// the table they describe, while anything editable belongs to Settings. Administrator-only, because
/// Core answers none of this to anyone else.
struct DashboardView: View {
    let session: HostSession
    let model: AppsModel
    let router: ShellRouter
    let switcher: HostSwitcher

    var body: some View {
        NavigationSplitView {
            DashboardListView(session: session, model: model, router: router)
                .toolbar { ToolbarItem(placement: .principal) { switcher } }
        } detail: {
            if let id = router.managedAppID {
                NavigationStack {
                    AppDetailView(appID: id, model: model)
                }
                .id(id)
            } else {
                ContentUnavailableView {
                    Label("Select an app", systemImage: "shippingbox")
                } description: {
                    Text("Choose an installed app to see its state, services, and available actions.")
                }
            }
        }
    }
}

private struct DashboardListView: View {
    let session: HostSession
    let model: AppsModel
    let router: ShellRouter
    @State private var searchText = ""

    var body: some View {
        List(selection: managedSelection) {
            Section {
                CoreRow(model: model, version: session.hostVersion)
            }

            if let loadError = model.loadError {
                Section {
                    Label(loadError, systemImage: "exclamationmark.triangle")
                        .foregroundStyle(.red)
                }
            }

            // One list, not a user/system split. A system app is told apart by its badge, not by which
            // table it sits in — the same shape the browser Shell settled on.
            Section {
                ForEach(filtered) { app in
                    NavigationLink(value: app.id) {
                        AppRow(app: app, icons: model.icons)
                    }
                }
            } header: {
                AppCounts(apps: model.apps)
            }
        }
        .overlay {
            if !searchText.isEmpty && !model.apps.isEmpty && filtered.isEmpty {
                ContentUnavailableView.search(text: searchText)
            } else if model.apps.isEmpty {
                emptyState
            }
        }
        .searchable(text: $searchText, prompt: "Search apps")
        .navigationTitle("Dashboard")
        .toolbar {
            ToolbarItem {
                Button {
                    Task { await model.checkForUpdates() }
                } label: {
                    if model.isCheckingUpdates {
                        ProgressView().controlSize(.small)
                    } else {
                        Label("Check for updates", systemImage: "arrow.triangle.2.circlepath")
                    }
                }
                .disabled(model.isCheckingUpdates)
            }
        }
        .refreshable { await model.reload() }
        .task { await model.loadCoreUpdateStatus() }
    }

    private var managedSelection: Binding<String?> {
        Binding(get: { router.managedAppID }, set: { router.managedAppID = $0 })
    }

    private var filtered: [AppSummary] {
        guard !searchText.isEmpty else { return model.apps }

        return model.apps.filter { app in
            app.displayName.localizedStandardContains(searchText)
                || app.id.localizedStandardContains(searchText)
                || app.selectedRuntime?.localizedStandardContains(searchText) == true
        }
    }

    @ViewBuilder
    private var emptyState: some View {
        if !model.hasLoaded {
            ProgressView("Loading apps…")
        } else if model.loadError == nil {
            ContentUnavailableView {
                Label("No apps installed", systemImage: "shippingbox")
            } description: {
                Text("Install an app from the browser Shell, and it will show up here.")
            }
        }
    }
}

/// Core itself, beside the apps it manages but deliberately not among them: it cannot be installed or
/// removed, and it answers almost none of the verbs an app row does.
private struct CoreRow: View {
    let model: AppsModel
    let version: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 12) {
                Image(systemName: "server.rack")
                    .font(.title3)
                    .foregroundStyle(.secondary)
                    .frame(width: 28)

                VStack(alignment: .leading, spacing: 2) {
                    Text("Hosty Core")
                        .font(.body)

                    Text(version.map { "v\($0)" } ?? "version unknown")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }

                Spacer(minLength: 0)
            }

            if let error = model.coreUpdateError {
                Label(error, systemImage: "exclamationmark.triangle")
                    .font(.caption)
                    .foregroundStyle(.orange)
            }

            if model.isApplyingCoreUpdate {
                // Core restarts itself as part of this, so the connection drops on purpose. Saying so
                // keeps the operator from reading the reconnect that follows as a failure.
                Label("Updating Core — it will restart and this app will reconnect.", systemImage: "arrow.down.circle")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } else if model.coreUpdate?.canApply == true {
                Button {
                    Task { await model.applyCoreUpdate() }
                } label: {
                    Label(
                        "Update Core to \(model.coreUpdate?.releaseTag ?? "the latest release")",
                        systemImage: "arrow.up.circle")
                }
                .font(.callout)
            }
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
    }
}

/// One line describing the rows below it — every row, system apps included. A header that disagreed
/// with the list under it would be worse than either number alone.
private struct AppCounts: View {
    let apps: [AppSummary]
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        // At accessibility sizes three icon-and-number pairs cannot share a line, so they stack rather
        // than truncate.
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 12) { counts }
            VStack(alignment: .leading, spacing: 4) { counts }
        }
        .textCase(nil)
    }

    @ViewBuilder
    private var counts: some View {
        Label("\(running) running", systemImage: "bolt.horizontal")
        if transitioning > 0 {
            Label("\(transitioning) in progress", systemImage: "arrow.triangle.2.circlepath")
        }
        Label("\(attention) need attention", systemImage: "exclamationmark.circle")
            .foregroundStyle(attention > 0 ? Color.orange : Color.secondary)
        Label("\(apps.count) total", systemImage: "shippingbox")
    }

    private var running: Int { apps.filter { $0.runtimeState.isUp }.count }

    // Apps mid-verb are counted in neither bucket: calling them "not running" reads as a shortfall
    // during a boot that is going fine, and calling them a problem is worse.
    private var transitioning: Int { apps.filter { $0.runtimeState.isBusy }.count }

    private var attention: Int {
        apps.filter { !$0.problems.isEmpty || $0.operationStatus == AppOperationStatus.failed }.count
    }
}

#if DEBUG
#Preview("Dashboard counts") {
    List {
        Section {
            Text("Rows go here")
        } header: {
            AppCounts(apps: [PreviewFixtures.runningApp, PreviewFixtures.systemApp])
        }
    }
}
#endif
