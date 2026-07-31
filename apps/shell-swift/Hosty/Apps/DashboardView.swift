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

    var body: some View {
        NavigationSplitView {
            DashboardListView(session: session, model: model, router: router)
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
    @State private var confirmingUpdateAll = false
    @State private var reviewingApp: AppSummary?

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
                        AppRow(
                            app: app,
                            icons: model.icons,
                            onUpdate: { act(onUpdateFor: app) },
                            isBusy: model.isBusy(app))
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
        // The host this screen is about. Naming it here is what makes removing the switcher a move
        // rather than a loss: every destination shows exactly one host's data, and an operator with
        // more than one saved host has to be able to see which — they just do not need a control
        // spending a row on it.
        .navigationSubtitle(session.connection.displayName)
        // Two bands of chrome above the host: a large title repeating the word the selected tab already
        // says, and a search field for a list most operators can see all of. Both collapse into the bar
        // the actions are already in — inline title, search as a button — which is worth about an app
        // row of the screen. Swapping only the title would gain nothing: the search field takes the
        // band the large title vacates.
        //
        // `inlineLarge` rather than `inline` because it pins the title to the leading edge. A plain
        // inline title is centered until the toolbar runs out of room and then jumps left — which here
        // means the title moves depending on whether an update happens to be waiting.
        .toolbarTitleDisplayMode(.inlineLarge)
        #if os(iOS)
        .searchToolbarBehavior(.minimize)
        .contentMargins(.top, 0, for: .scrollContent)
        #endif
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

            // Absent rather than disabled when there is nothing routine to apply: a permanently greyed
            // button on a host that is up to date is one more thing to read and dismiss.
            if !model.routineUpdates.isEmpty || model.isUpdatingAll {
                ToolbarItem {
                    Button {
                        confirmingUpdateAll = true
                    } label: {
                        if model.isUpdatingAll {
                            ProgressView().controlSize(.small)
                        } else {
                            Label("Update all apps", systemImage: "arrow.up.circle")
                        }
                    }
                    .disabled(model.isUpdatingAll)
                }
            }
        }
        // A toolbar button renders icon-only, so the count that the browser Shell puts in the button's
        // own label has nowhere to go there. It goes here instead: the one action that applies updates
        // to several apps at once must say how many before it runs, not after.
        .confirmationDialog(
            updateAllTitle,
            isPresented: $confirmingUpdateAll,
            titleVisibility: .visible
        ) {
            Button("Update all") { Task { await model.updateAllApps() } }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text(updateAllMessage)
        }
        // The other half of the row marker: a plan that has to be read is opened here rather than
        // applied, so one control means "act on this update" whichever kind it turns out to be.
        .sheet(item: $reviewingApp) { app in
            UpdateReviewSheet(app: app, model: model)
        }
        .refreshable { await model.reload() }
        .task { await model.loadCoreUpdateStatus() }
    }

    /// One tap on a row's update marker. A routine verdict is applied on the spot — its plan is already
    /// built and its digest is what Core asks for — while a review-class one opens that plan instead.
    /// Applying it silently is the one thing this must never do.
    private func act(onUpdateFor app: AppSummary) {
        if app.hasRoutineUpdate {
            Task { await model.applyUpdate(app) }
        } else {
            reviewingApp = app
        }
    }

    private var updateAllTitle: String {
        let count = model.routineUpdates.count
        return count == 1 ? "Apply 1 update?" : "Apply \(count) updates?"
    }

    private var updateAllMessage: String {
        var lines = ["The host applies these in the background, and the list shows each app's progress."]

        // Named rather than silently skipped: the count above is smaller than the number of update
        // badges on screen, and an operator who is not told why would read it as apps being missed.
        let review = model.reviewOnlyUpdateCount
        if review > 0 {
            lines.append(
                review == 1
                    ? "1 more update changes more than the version and has to be reviewed on the app's own screen."
                    : "\(review) more updates change more than the version and have to be reviewed on each app's own screen.")
        }

        return lines.joined(separator: "\n\n")
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
                // Just "Update": the row it sits in already says what is being updated, and the release
                // tag it used to carry is a build identifier — on a dev channel it reads as a branch
                // name, which says nothing about the version the operator would end up on.
                Button {
                    Task { await model.applyCoreUpdate() }
                } label: {
                    Label("Update", systemImage: "arrow.up.circle")
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
        // Header-sized, not row-sized. These numbers describe the rows below rather than competing with
        // them, and at this size all three fit one line at standard Dynamic Type — so the caption costs
        // two fewer lines than it did while saying the same thing.
        .font(.footnote)
    }

    // Standing figures first, then the three that only appear when they have something to report — so
    // the line grows rightwards from a shape the operator already knows, and the one thing that might be
    // wrong sits at the end where a colour is doing the work.
    @ViewBuilder
    private var counts: some View {
        count(running, "running", systemImage: "bolt.horizontal")
        count(apps.count, "total", systemImage: "shippingbox")

        if transitioning > 0 {
            count(transitioning, "in progress", systemImage: "arrow.triangle.2.circlepath")
        }

        // In the same blue as the markers on the rows it counts, so the header and the list are visibly
        // talking about the same thing.
        if updatable > 0 {
            count(updatable, "with an update available", systemImage: "arrow.up.circle")
                .foregroundStyle(Color.blue)
        }

        // A zero here is the normal state of a healthy host, and a warning icon standing beside one
        // every day is how a warning stops being read at all. Red only when something actually failed:
        // an unmet dependency is a shortfall, and spending the alarm colour on it would leave nothing
        // louder for the app that is genuinely broken.
        if attention > 0 {
            count(attention, "need attention", systemImage: "exclamationmark.circle")
                .foregroundStyle(failed > 0 ? Color.red : Color.orange)
        }
    }

    /// Icon and number, no word.
    ///
    /// The words fit on one line only while there were three counters. The fourth appears exactly when
    /// apps are mid-verb — the moment the header is worth reading — and spelling them out turned the
    /// line into a column right then. The word survives where it costs no width: the accessibility
    /// label, which is the one place it was load-bearing.
    private func count(_ value: Int, _ meaning: String, systemImage: String) -> some View {
        Label("\(value)", systemImage: systemImage)
            .accessibilityLabel("\(value) \(meaning)")
    }

    private var running: Int { apps.filter { $0.runtimeState.isUp }.count }

    // Apps mid-verb are counted in neither bucket: calling them "not running" reads as a shortfall
    // during a boot that is going fine, and calling them a problem is worse.
    private var transitioning: Int { apps.filter { $0.runtimeState.isBusy }.count }

    private var attention: Int { apps.filter(\.needsAttention).count }

    /// How many of those are failures rather than shortfalls — the difference between red and orange.
    private var failed: Int { apps.filter(\.hasFailed).count }

    // Every update the rows mark, review-class ones included — the header counts what is on screen, not
    // what one particular button would apply.
    private var updatable: Int {
        apps.filter { $0.updateCheck?.updateAvailable == true }.count
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
