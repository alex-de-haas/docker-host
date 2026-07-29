import HostyKit
import SwiftUI

struct AppDetailView: View {
    let appID: String
    let model: AppsModel

    @State private var reviewingUpdate = false
    @State private var updateStatus: AppUpdateStatus?
    @State private var refreshingUpdate = false
    @State private var updateError: String?
    @State private var confirmingStop = false

    private var app: AppSummary? {
        model.apps.first { $0.id == appID }
    }

    var body: some View {
        Group {
            if let app {
                Form {
                    lifecycle(app)
                    updates(app)
                    overview(app)
                    problems(app)
                    services(app)
                    capabilities(app)
                }
                .formStyle(.grouped)
                .navigationTitle(app.displayName)
                .sheet(isPresented: $reviewingUpdate) {
                    UpdateReviewSheet(app: app, model: model)
                }
                .confirmationDialog(
                    "Stop \(app.displayName)?",
                    isPresented: $confirmingStop
                ) {
                    Button("Stop \(app.displayName)", role: .destructive) {
                        Task { await model.stop(app) }
                    }

                    Button("Cancel", role: .cancel) {}
                } message: {
                    Text("Services and endpoints provided by this app will become unavailable until it is started again.")
                }
            } else {
                // The list is the single source of truth, so an app that leaves it (removed on the host,
                // or gone after a resync) leaves this screen too rather than showing a stale record.
                ContentUnavailableView {
                    Label("App is gone", systemImage: "shippingbox")
                } description: {
                    Text("It is no longer installed on this host.")
                }
            }
        }
        #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
        #endif
    }

    @ViewBuilder
    private func lifecycle(_ app: AppSummary) -> some View {
        Section {
            LabeledContent("State") {
                RuntimeStateBadge(state: app.runtimeState, operating: app.isOperating)
            }

            ViewThatFits(in: .horizontal) {
                HStack {
                    startButton(app)
                    Spacer()
                    restartButton(app)
                    Spacer()
                    stopButton(app)
                }

                VStack(spacing: 12) {
                    startButton(app)
                        .frame(maxWidth: .infinity)
                    restartButton(app)
                        .frame(maxWidth: .infinity)
                    stopButton(app)
                        .frame(maxWidth: .infinity)
                }
            }
            .buttonStyle(.bordered)
        } footer: {
            if model.isBusy(app) {
                Text("Waiting for the host to finish the current operation.")
            }
        }
    }

    @ViewBuilder
    private func updates(_ app: AppSummary) -> some View {
        Section("Updates") {
            if app.live {
                // A live source app re-reads the operator's own folder on every start: its contract is
                // adopted on restart and there is no reviewed-update path to offer at all. Showing a
                // disabled button would imply one exists.
                Label(
                    "This app runs from a live source folder. It picks up changes when it restarts, so there is no update to review.",
                    systemImage: "info.circle")
                    .foregroundStyle(.secondary)
                    .font(.footnote)
            } else {
                availability(app)

                Button {
                    Task { await refreshUpdateStatus(app) }
                } label: {
                    if refreshingUpdate {
                        HStack {
                            ProgressView().controlSize(.small)
                            Text("Checking…")
                        }
                    } else {
                        Text("Check for an update")
                    }
                }
                .disabled(refreshingUpdate)

                if let updateError {
                    Label(updateError, systemImage: "exclamationmark.triangle")
                        .foregroundStyle(.red)
                        .font(.footnote)
                }

                if app.updateCheck?.updateAvailable == true {
                    Button("Review update…") { reviewingUpdate = true }
                        .disabled(model.isBusy(app))
                }

                if let updateStatus, !updateStatus.services.isEmpty {
                    ForEach(updateStatus.services, id: \.service) { service in
                        LabeledContent(service.service) {
                            Text(serviceVerdict(service))
                                .font(.caption)
                                .foregroundStyle(service.updateAvailable ? .blue : .secondary)
                        }
                    }
                }
            }
        }
    }

    @ViewBuilder
    private func availability(_ app: AppSummary) -> some View {
        if let check = app.updateCheck {
            if let error = check.error {
                Label(error, systemImage: "exclamationmark.triangle")
                    .foregroundStyle(.orange)
                    .font(.footnote)
            } else if check.updateAvailable {
                Label("An update is available", systemImage: "arrow.up.circle.fill")
                    .foregroundStyle(.blue)
            } else {
                Label("Up to date", systemImage: "checkmark.circle")
                    .foregroundStyle(.secondary)
            }
        } else {
            // Null until a check has run for this app — which is not the same as "up to date".
            Text("Not checked yet.")
                .foregroundStyle(.secondary)
                .font(.footnote)
        }
    }

    private func serviceVerdict(_ service: AppServiceUpdateStatus) -> String {
        // `unknown` means the registry could not be reached, or there is no lock to compare against —
        // deliberately not reported as "up to date".
        if service.unknown { return "Unknown" }
        return service.updateAvailable ? "New build available" : "Current"
    }

    private func refreshUpdateStatus(_ app: AppSummary) async {
        refreshingUpdate = true
        updateError = nil
        defer { refreshingUpdate = false }

        do {
            updateStatus = try await model.refreshUpdateStatus(for: app)
        } catch {
            updateError = error.localizedDescription
        }

        // The per-app check also refreshes the cached verdict on the record, so re-read the list.
        await model.reload()
    }

    private func startButton(_ app: AppSummary) -> some View {
        Button("Start") { Task { await model.start(app) } }
            .disabled(model.isBusy(app) || app.runtimeState.isUp)
            .fixedSize(horizontal: true, vertical: false)
    }

    private func restartButton(_ app: AppSummary) -> some View {
        Button("Restart") { Task { await model.restart(app) } }
            .disabled(model.isBusy(app))
            .fixedSize(horizontal: true, vertical: false)
    }

    private func stopButton(_ app: AppSummary) -> some View {
        Button("Stop", role: .destructive) { confirmingStop = true }
            .disabled(model.isBusy(app) || app.runtimeState.isIdle)
            .fixedSize(horizontal: true, vertical: false)
    }

    @ViewBuilder
    private func overview(_ app: AppSummary) -> some View {
        Section("Overview") {
            LabeledContent("Version", value: app.version)
            LabeledContent("Identifier", value: app.id)
            LabeledContent("Source", value: app.source)

            if let runtime = app.selectedRuntime {
                LabeledContent("Runtime", value: runtime)
            }

            LabeledContent("Autostart", value: app.autostart ? "On" : "Off")

            if app.live {
                LabeledContent("Artifact") {
                    BadgeChip(text: "Live source", tint: .purple)
                }
            } else {
                LabeledContent("Update policy", value: app.updatePolicy)
            }

            if let description = app.description, !description.isEmpty {
                Text(description)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        }
    }

    @ViewBuilder
    private func problems(_ app: AppSummary) -> some View {
        if !app.problems.isEmpty {
            Section("Problems") {
                ForEach(app.problems, id: \.self) { problem in
                    Label(problem, systemImage: "exclamationmark.triangle.fill")
                        .foregroundStyle(.orange)
                }
            }
        }
    }

    @ViewBuilder
    private func services(_ app: AppSummary) -> some View {
        // Core reports endpoints, each naming the service that owns it; there is no separate services
        // list to fetch. Grouping here is what turns one into the other.
        let grouped = Dictionary(grouping: app.endpoints) { $0.service ?? "—" }

        ForEach(grouped.keys.sorted(), id: \.self) { service in
            Section {
                ForEach(grouped[service] ?? [], id: \.key) { endpoint in
                    EndpointRow(endpoint: endpoint)
                }

                if let lock = app.artifactLocks?[service] {
                    LabeledContent("Locked artifact") {
                        VStack(alignment: .trailing, spacing: 2) {
                            if let digest = lock.shortDigest {
                                Text(digest).font(.caption.monospaced())
                            }

                            if let ref = lock.resolvedFromRef {
                                Text(ref).font(.caption2).foregroundStyle(.secondary)
                            }
                        }
                    }
                }
            } header: {
                Text(service == "—" ? "Endpoints" : service)
            }
        }
    }

    @ViewBuilder
    private func capabilities(_ app: AppSummary) -> some View {
        if !app.capabilities.isEmpty {
            Section("Capabilities") {
                Text(app.capabilities.sorted().joined(separator: ", "))
                    .font(.callout)
            }
        }
    }
}

struct EndpointRow: View {
    let endpoint: AppEndpoint

    var body: some View {
        LabeledContent {
            VStack(alignment: .trailing, spacing: 2) {
                if let url = endpoint.url {
                    Text(url).font(.caption.monospaced())
                }

                if let availability = endpoint.availability {
                    Text(description(for: availability))
                        .font(.caption2)
                        .foregroundStyle(tint(for: availability))
                }
            }
        } label: {
            HStack(spacing: 6) {
                Text(endpoint.key)
                if endpoint.public {
                    BadgeChip(text: "Public", tint: .blue)
                }
            }
        }
    }

    private func description(for availability: AppEndpointAvailability) -> String {
        switch availability {
        // "Assigned" is the state worth spelling out: the address is durable and reserved, the service
        // behind it simply is not up.
        case .assigned: "Reserved — service stopped"
        case .running: "Serving"
        case .unavailable: "Unavailable"
        }
    }

    private func tint(for availability: AppEndpointAvailability) -> Color {
        switch availability {
        case .assigned: .secondary
        case .running: .green
        case .unavailable: .orange
        }
    }
}

#if DEBUG
#Preview("App detail") {
    let app = PreviewFixtures.runningApp
    let model = AppsModel(previewApps: [app])

    NavigationStack {
        AppDetailView(appID: app.id, model: model)
    }
}

#Preview("App detail — accessibility size") {
    let app = PreviewFixtures.runningApp
    let model = AppsModel(previewApps: [app])

    NavigationStack {
        AppDetailView(appID: app.id, model: model)
    }
    .environment(\.dynamicTypeSize, .accessibility3)
}
#endif
