import Foundation
import Testing

@testable import HostyKit

/// Which cached verdicts a batch apply may act on without a person reading the plan.
///
/// This is the rule behind Dashboard's "Update all", and every clause of it is a refusal. It is pinned
/// here rather than left in the view because the count shown to the operator and the set actually sent
/// to Core must be the same set — a filter that drifted between them would either promise applies that
/// cannot happen or run ones nobody was shown.
@Suite("Routine updates")
struct RoutineUpdateTests {
    private func app(
        updateAvailable: Bool,
        requiresReview: Bool = false,
        planDigest: String? = "d1e2f3",
        error: String? = nil,
        operationStatus: String = "started"
    ) -> AppSummary {
        app(
            check: AppUpdateAvailability(
                updateAvailable: updateAvailable,
                requiresReview: requiresReview,
                planDigest: planDigest,
                checkedAt: Date(timeIntervalSince1970: 0),
                error: error),
            operationStatus: operationStatus)
    }

    private func app(check: AppUpdateAvailability?, operationStatus: String = "started") -> AppSummary {
        AppSummary(
            id: "com.haas.demo-app",
            displayName: "Demo App",
            description: nil,
            version: "1.0.0",
            kind: "runtime",
            system: false,
            source: "manifest",
            selectedRuntime: "docker",
            autostart: true,
            operationStatus: operationStatus,
            runtimeState: .running,
            lastOperation: nil,
            lastError: nil,
            capabilities: [],
            endpoints: [],
            runtimeProfiles: [],
            updatePolicy: "reviewed",
            artifactLocks: nil,
            manifestError: nil,
            live: false,
            iconUrl: nil,
            updateCheck: check,
            dependencies: nil,
            embeddedUrl: nil,
            navigation: nil)
    }

    @Test("An ordinary available update is routine")
    func routineUpdate() {
        let app = app(updateAvailable: true)

        #expect(app.hasRoutineUpdate)
        #expect(!app.needsUpdateReview)
    }

    // The whole point of the review flag: such a plan changes more than the version and the resolved
    // artifacts, so it belongs to a person. A batch that silently swept it up would apply changes
    // nobody read.
    @Test("A review-class update is never batched, and is counted as needing review instead")
    func reviewClassUpdate() {
        let app = app(updateAvailable: true, requiresReview: true)

        #expect(!app.hasRoutineUpdate)
        #expect(app.needsUpdateReview)
    }

    // Core's apply requires the digest of the plan that was shown. No digest, no apply — so counting
    // one would promise an action that is refused the moment it is attempted.
    @Test("An update with no plan digest to echo back is not batchable")
    func missingPlanDigest() {
        #expect(!app(updateAvailable: true, planDigest: nil).hasRoutineUpdate)
    }

    @Test("An app already updating is not given a second apply")
    func alreadyUpdating() {
        #expect(!app(updateAvailable: true, operationStatus: "updating").hasRoutineUpdate)
    }

    // Three ways to have nothing to apply, all of which have to read the same: no update, no verdict at
    // all, and a check that failed. The last is the one worth pinning — an error leaves `updateAvailable`
    // false, and treating a failed check as "nothing to do" is right only because it is not "up to date"
    // anywhere it is displayed.
    @Test("No update, no verdict, and a failed check are all unbatchable")
    func nothingToApply() {
        #expect(!app(updateAvailable: false).hasRoutineUpdate)
        #expect(!app(check: nil).hasRoutineUpdate)
        #expect(!app(updateAvailable: false, error: "registry unreachable").hasRoutineUpdate)

        #expect(!app(updateAvailable: false).needsUpdateReview)
        #expect(!app(check: nil).needsUpdateReview)
    }

    // The two counts on Dashboard partition the available updates: what the button applies, and what it
    // says it is leaving behind. An app in both, or in neither, would make the confirmation lie.
    @Test("Routine and needs-review are exclusive for every available update")
    func countsPartitionAvailableUpdates() {
        let apps = [
            app(updateAvailable: true),
            app(updateAvailable: true, requiresReview: true),
            app(updateAvailable: false),
            app(check: nil),
        ]

        for app in apps {
            #expect(!(app.hasRoutineUpdate && app.needsUpdateReview))
        }

        #expect(apps.filter(\.hasRoutineUpdate).count == 1)
        #expect(apps.filter(\.needsUpdateReview).count == 1)
    }
}
