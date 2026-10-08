import HostyKit
import SwiftUI

/// Reviewing and applying one app's update.
///
/// Updates are plan-first by design: `POST /update/plan` builds a plan and returns a `planDigest`, and the
/// routine apply must echo that digest back. The change list is always shown. Plans requiring review
/// direct the operator to Hosty Shell for Core-owned confirmation rather than submitting them to the
/// routine-only queued endpoint.
struct UpdateReviewSheet: View {
    let app: AppSummary
    let model: AppsModel

    @State private var plan: AppUpdatePlan?
    @State private var error: String?
    @State private var applying = false
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Group {
                if let plan {
                    planForm(plan)
                } else if let error {
                    ContentUnavailableView {
                        Label("Could not build a plan", systemImage: "exclamationmark.triangle")
                    } description: {
                        Text(error)
                    } actions: {
                        Button("Try again") { Task { await build() } }
                    }
                } else {
                    ProgressView("Working out what would change…")
                }
            }
            .navigationTitle("Update \(app.displayName)")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
            }
        }
        .task { await build() }
    }

    @ViewBuilder
    private func planForm(_ plan: AppUpdatePlan) -> some View {
        Form {
            Section {
                LabeledContent("Version") {
                    Text("\(plan.currentVersion) → \(plan.targetVersion)")
                        .monospaced()
                }

                if let current = plan.currentRuntime, current != plan.targetRuntime {
                    LabeledContent("Runtime") {
                        Text("\(current) → \(plan.targetRuntime)").monospaced()
                    }
                }

                if plan.willCreatePreUpdateBackup {
                    Label("A backup is taken before the update", systemImage: "clock.arrow.circlepath")
                        .foregroundStyle(.secondary)
                        .font(.footnote)
                }
            }

            changesSection(plan)

            if plan.mustBeReviewed {
                Section {
                    Label("Core confirmation required", systemImage: "checkmark.shield")
                        .font(.headline)
                    Text("Open Hosty Shell for this host, find \(app.displayName), choose Update, and confirm the changes on Core's review page.")
                }
            } else {
                Section {
                    Button {
                        Task { await apply(plan) }
                    } label: {
                        if applying {
                            HStack {
                                ProgressView().controlSize(.small)
                                Text("Applying…")
                            }
                        } else {
                            Text("Apply update")
                        }
                    }
                    .disabled(applying)
                } footer: {
                    // Routine apply runs detached; Core returns as soon as it accepts the operation.
                    Text("The host applies this in the background. The app list will show its progress.")
                }
            }

            if let error {
                Section {
                    Label(error, systemImage: "exclamationmark.triangle")
                        .foregroundStyle(.red)
                }
            }
        }
        .formStyle(.grouped)
    }

    @ViewBuilder
    private func changesSection(_ plan: AppUpdatePlan) -> some View {
        Section {
            if plan.changes.isEmpty {
                if plan.sourceConfigured == false {
                    // The distinction that matters: with no external source configured, Core could only
                    // compare against its own internal copy, so "no changes" is "nothing to compare
                    // against" — not "up to date".
                    Label(
                        "No source is configured for this app, so Core could not tell what would change. An empty list here does not mean it is up to date.",
                        systemImage: "questionmark.circle")
                        .foregroundStyle(.orange)
                } else {
                    Text("No contract changes — only the version and resolved artifacts move.")
                        .foregroundStyle(.secondary)
                }
            } else {
                ForEach(plan.readableChanges) { change in
                    ChangeRow(change: change)
                }
            }
        } header: {
            HStack {
                Text("Changes")
                if plan.mustBeReviewed {
                    BadgeChip(text: "Needs review", tint: .orange)
                }
            }
        } footer: {
            if plan.mustBeReviewed {
                Text("Core must confirm these changes before the update can be applied.")
            }
        }
    }

    private func build() async {
        error = nil
        do {
            plan = try await model.client.buildUpdatePlan(appID: app.id)
        } catch let error as CoreError {
            self.error = error.localizedDescription
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func apply(_ plan: AppUpdatePlan) async {
        guard !plan.mustBeReviewed else { return }
        applying = true
        defer { applying = false }

        do {
            // The digest of the plan shown above, so Core can refuse an apply whose plan has moved on.
            try await model.client.applyUpdate(appID: app.id, planDigest: plan.planDigest)
            await model.reload()
            dismiss()
        } catch let error as CoreError {
            self.error = error.localizedDescription
        } catch {
            self.error = error.localizedDescription
        }
    }
}

/// One change: what moved, and what it moved between.
///
/// The two are separated because they read differently. The subject is prose and belongs in the body
/// font; the values are identifiers — digests, image refs, port signatures — and belong on their own
/// monospaced line, where a 64-character digest cannot wrap through the middle of the sentence naming
/// it. Run together, as Core writes them, a change list is a wall of tokens that no one reviews.
private struct ChangeRow: View {
    let change: AppUpdateChange

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(change.title)
                .font(.callout)

            if let detail = change.detail {
                Text(detail)
                    .font(.caption)
                    .monospaced()
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
            }
        }
        .padding(.vertical, 1)
        .accessibilityElement(children: .combine)
    }
}

#if DEBUG
#Preview("Change list") {
    List {
        ForEach(
            [
                "version:0.4.9->0.4.10",
                "artifact:backend:sha256:f05e326e71aa7814ea34f68ed6282ac6932ee84cc23d058db05b1c00dcf59273->sha256:1df50287b502fdabd7ec616b46ada2c9cd44698f699963e4d96d1c0c77afe8c0",
                "manifest",
                "service:worker:added:docker",
                "port:backend.http:8080/tcp->9090/tcp",
                "setting:apiKey:type:string->secret",
                "endpoint:api:removed:http/8080",
                "data:compatible",
                "somethingNewCoreInvented:tomorrow",
            ].map(AppUpdateChange.init(parsing:))
        ) { change in
            ChangeRow(change: change)
        }
    }
}
#endif
