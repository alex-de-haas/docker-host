import HostyKit
import SwiftUI

struct AppListView: View {
    @State private var model: AppsModel

    init(session: HostSession) {
        _model = State(initialValue: AppsModel(session: session))
    }

    var body: some View {
        List {
            if let loadError = model.loadError {
                Section {
                    Label(loadError, systemImage: "exclamationmark.triangle")
                        .foregroundStyle(.red)
                }
            }

            section("Apps", apps: model.userApps)
            section("System", apps: model.systemApps)
        }
        .overlay {
            if model.apps.isEmpty {
                emptyState
            }
        }
        .navigationDestination(for: String.self) { appID in
            AppDetailView(appID: appID, model: model)
        }
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
        .onDisappear { model.stopFollowing() }
    }

    @ViewBuilder
    private func section(_ title: String, apps: [AppSummary]) -> some View {
        if !apps.isEmpty {
            Section(title) {
                ForEach(apps) { app in
                    NavigationLink(value: app.id) {
                        AppRow(app: app, model: model)
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
    let model: AppsModel

    var body: some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    Text(app.displayName)
                        .font(.body)

                    if app.live {
                        // A live source app runs from the operator's own folder: its contract is adopted
                        // on restart and it has no reviewed-update path at all.
                        BadgeChip(text: "Live", tint: .purple)
                    }
                }

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

                if let problem = app.problems.first {
                    Label(problem, systemImage: "exclamationmark.triangle.fill")
                        .font(.caption)
                        .foregroundStyle(.orange)
                        .lineLimit(2)
                }
            }

            Spacer(minLength: 0)

            if app.updateCheck?.updateAvailable == true {
                Image(systemName: "arrow.up.circle.fill")
                    .foregroundStyle(.blue)
                    .accessibilityLabel("Update available")
            }
        }
        .padding(.vertical, 2)
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
    }
}
