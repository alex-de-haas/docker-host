import HostyKit
import SwiftUI

struct AppListView: View {
    let model: AppsModel
    @Binding var selection: String?
    @State private var searchText = ""
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        List(selection: $selection) {
            if let loadError = model.loadError {
                Section {
                    Label(loadError, systemImage: "exclamationmark.triangle")
                        .foregroundStyle(.red)
                }
            }

            section("Apps", apps: filtered(model.userApps))
            section("System", apps: filtered(model.systemApps))
        }
        .overlay {
            if !searchText.isEmpty && !model.apps.isEmpty && filtered(model.apps).isEmpty {
                ContentUnavailableView.search(text: searchText)
            } else if model.apps.isEmpty {
                emptyState
            }
        }
        .searchable(text: $searchText, prompt: "Search apps")
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
        .task {
            // `follow` yields a resync on connect, and that resync is the first load — asking for the list
            // here as well would just fetch it twice on every appearance.
            model.follow()
        }
        // The stream's lifetime is the *app's* foreground, not this view's appearance.
        //
        // Stopping it in `onDisappear` looked right and was badly wrong: pushing the detail screen fires
        // it, so the one screen an operator actually watches — a restart, an update applying — was the one
        // screen with no live updates at all. It sat on "Updating…" until the list was reopened.
        //
        // Coming back to the foreground still forces a re-read: a suspended app's connection dies quietly,
        // and the reconnect that follows can be several backoff steps in, so the stream alone can leave
        // half a minute of state from before the phone was pocketed.
        .onChange(of: scenePhase) { _, phase in
            switch phase {
            case .active:
                model.follow()
                Task { await model.reload() }
            case .background:
                model.stopFollowing()
            default:
                break
            }
        }
    }

    private func filtered(_ apps: [AppSummary]) -> [AppSummary] {
        guard !searchText.isEmpty else { return apps }

        return apps.filter { app in
            app.displayName.localizedStandardContains(searchText)
                || app.id.localizedStandardContains(searchText)
                || app.selectedRuntime?.localizedStandardContains(searchText) == true
        }
    }

    @ViewBuilder
    private func section(_ title: String, apps: [AppSummary]) -> some View {
        if !apps.isEmpty {
            Section(title) {
                ForEach(apps) { app in
                    NavigationLink(value: app.id) {
                        AppRow(app: app)
                    }
                }
            }
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

struct AppRow: View {
    let app: AppSummary
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        Group {
            if dynamicTypeSize.isAccessibilitySize {
                accessibleLayout
            } else {
                standardLayout
            }
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
    }

    private var standardLayout: some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 3) {
                title
                metadata
                firstProblem
            }

            Spacer(minLength: 0)

            updateIcon
        }
    }

    private var accessibleLayout: some View {
        VStack(alignment: .leading, spacing: 8) {
            title
            RuntimeStateBadge(state: app.runtimeState, operating: app.isOperating)

            Text(accessibleMetadata)
                .font(.caption)
                .foregroundStyle(.secondary)

            firstProblem

            if app.updateCheck?.updateAvailable == true {
                Label("Update available", systemImage: "arrow.up.circle.fill")
                    .font(.caption)
                    .foregroundStyle(.blue)
            }
        }
    }

    private var title: some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 6) {
                Text(app.displayName)
                    .font(.body)

                liveBadge
            }

            VStack(alignment: .leading, spacing: 4) {
                Text(app.displayName)
                    .font(.body)

                liveBadge
            }
        }
    }

    @ViewBuilder
    private var liveBadge: some View {
        if app.live {
            // A live source app runs from the operator's own folder: its contract is adopted on restart
            // and it has no reviewed-update path at all.
            BadgeChip(text: "Live", tint: .purple)
        }
    }

    private var metadata: some View {
        HStack(spacing: 8) {
            RuntimeStateBadge(state: app.runtimeState, operating: app.isOperating)

            Text(app.version)
                .font(.caption)
                .foregroundStyle(.secondary)

            if let runtime = app.selectedRuntime {
                Text(runtime)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
    }

    private var accessibleMetadata: String {
        if let runtime = app.selectedRuntime {
            return "Version \(app.version), runtime \(runtime)"
        }

        return "Version \(app.version)"
    }

    @ViewBuilder
    private var firstProblem: some View {
        if let problem = app.problems.first {
            Label(problem, systemImage: "exclamationmark.triangle.fill")
                .font(.caption)
                .foregroundStyle(.orange)
                .lineLimit(2)
        }
    }

    @ViewBuilder
    private var updateIcon: some View {
        if app.updateCheck?.updateAvailable == true {
            Image(systemName: "arrow.up.circle.fill")
                .foregroundStyle(.blue)
                .accessibilityLabel("Update available")
        }
    }
}

struct BadgeChip: View {
    let text: String
    let tint: Color

    var body: some View {
        Text(text)
            .font(.caption2.weight(.medium))
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(tint.opacity(0.15), in: Capsule())
            .foregroundStyle(tint)
            .fixedSize(horizontal: true, vertical: false)
    }
}

#if DEBUG
#Preview("App row") {
    List {
        AppRow(app: PreviewFixtures.runningApp)
    }
}

#Preview("App row — accessibility size") {
    List {
        AppRow(app: PreviewFixtures.runningApp)
    }
    .environment(\.dynamicTypeSize, .accessibility3)
}
#endif
