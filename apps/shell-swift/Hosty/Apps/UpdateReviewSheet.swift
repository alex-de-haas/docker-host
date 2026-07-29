import HostyKit
import SwiftUI

/// Reviewing and applying one app's update.
///
/// Updates are plan-first by design: `POST /update/plan` builds a plan and returns a `planDigest`, and the
/// apply must echo that digest back. So an apply can never act on a plan that changed after a person
/// looked at it — and this screen is what makes the looking real. The change list is always shown, never
/// only when `requiresReview` says so; the flag raises the emphasis, it does not decide whether the
/// operator is told.
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
                // The apply is enqueued and runs detached — the request returns as soon as Core accepts
                // it, and progress shows up as the app's operation status.
                Text("The host applies this in the background. The app list will show its progress.")
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
                ForEach(plan.changes, id: \.self) { change in
                    Text(change).font(.callout)
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
                Text("This plan changes more than the version and artifacts. Read it before applying.")
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
