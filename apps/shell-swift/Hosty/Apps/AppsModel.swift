import Foundation
import HostyKit
import Observation
import SwiftUI

/// The installed-app list for one host, kept current from Core's event stream.
@Observable
final class AppsModel {
    private(set) var apps: [AppSummary] = []
    private(set) var updateCheck: AppUpdateCheckStatus?
    private(set) var loadError: String?
    private(set) var hasLoaded = false

    /// Apps with a lifecycle request in flight. This is not a guess at the app's state — Core reports
    /// `starting` and `stopping` as real runtime states and the UI follows the record. It only covers the
    /// gap between tapping and Core committing the change, so the button cannot be tapped twice.
    private(set) var inFlight: Set<String> = []

    /// The app icons for this host. It lives here because its lifetime is the session's: a store built per
    /// view would re-fetch every icon each time a column was rebuilt, and one shared across hosts would
    /// hand a host's icons to another host's session.
    private(set) var icons: AppIconStore

    private let session: HostSession

    // Held outside the main actor's isolation so `deinit`, which is nonisolated, can still cancel them.
    // A model dropped without `stopFollowing()` would otherwise leave its event stream open, holding a
    // connection to Core for as long as the process lives.
    private let streamTask = TaskBox()
    private let reloadTask = TaskBox()

    init(session: HostSession) {
        self.session = session
        self.icons = AppIconStore(client: session.client)
    }

    #if DEBUG
    /// A local-only model for SwiftUI previews. It never follows an event stream unless a preview calls
    /// `follow()` explicitly, and its data is independent of saved hosts and live Core instances.
    convenience init(previewApps: [AppSummary], previewIcons: [String: Image] = [:]) {
        guard let origin = try? HostOrigin(parsing: "https://preview.hosty.invalid") else {
            preconditionFailure("The static preview origin must be valid.")
        }

        self.init(session: HostSession(connection: HostConnection(origin: origin)))
        apps = previewApps
        hasLoaded = true
        icons = AppIconStore(previewImages: previewIcons)
    }
    #endif

    /// For screens that talk to Core directly, such as building an update plan for review.
    var client: CoreClient { session.client }

    /// The host this model belongs to. The workspace needs it to tell a loopback app URL apart from a
    /// reachable one, which is a question about how *this device* got to Core.
    var origin: HostOrigin { session.connection.origin }

    /// The host as a person names it — its own name if it has one, otherwise its address. Every
    /// destination shows exactly one host's data, so each says which in its navigation bar.
    var hostName: String { session.connection.displayName }

    /// The apps to offer as destinations: the ones Core resolved a UI for.
    ///
    /// Core has already filtered the list per user and refuses a launch code for a system app to a
    /// non-administrator, so there is no system/ordinary split here — a second visibility rule in the
    /// client would be a copy of an authorization decision.
    var uiApps: [AppSummary] { apps.filter(\.hasUI) }

    /// Core's own version verdict, read once per appearance of the screen that shows it. Held here so
    /// the Dashboard and the tab badge read one snapshot rather than each probing on their own.
    private(set) var coreUpdate: CoreUpdateStatus?
    private(set) var coreUpdateError: String?
    private(set) var isApplyingCoreUpdate = false

    /// `refresh` is the operator's explicit "check now" — it bypasses Core's TTL cache.
    func loadCoreUpdateStatus(refresh: Bool = false) async {
        guard session.canManageApps else { return }

        do {
            coreUpdate = try await session.client.coreUpdateStatus(refresh: refresh)
            coreUpdateError = nil
        } catch let error as CoreError {
            if error.requiresSignIn {
                await session.refresh()
                return
            }

            failCoreUpdateCheck(error.localizedDescription)
        } catch {
            failCoreUpdateCheck(error.localizedDescription)
        }
    }

    /// A check that could not run leaves no verdict behind.
    ///
    /// Keeping the previous one would offer an update action — and count toward the Dashboard badge —
    /// on the strength of an answer that has just been contradicted by a failure.
    private func failCoreUpdateCheck(_ message: String) {
        coreUpdate = nil
        coreUpdateError = message
    }

    /// Starts Core's self-update.
    ///
    /// Core answers 202 and then restarts itself, so what follows is a connection loss that means the
    /// update is running — not a failure. The flag stays set through it; the session's own refresh is
    /// what eventually reports the host being back, with a new version.
    func applyCoreUpdate() async {
        guard !isApplyingCoreUpdate else { return }

        isApplyingCoreUpdate = true
        coreUpdateError = nil

        do {
            _ = try await session.client.applyCoreUpdate()
            await waitForCoreToReturn()
        } catch let error as CoreError {
            // Core refused before starting any work — the CLI could not be found, or the spawn failed.
            // Nothing is running, so the operator has to hear it rather than watch a spinner.
            isApplyingCoreUpdate = false
            coreUpdateError = error.localizedDescription
        } catch {
            isApplyingCoreUpdate = false
            coreUpdateError = error.localizedDescription
        }
    }

    /// Waits out the restart the update causes, then re-reads the host.
    ///
    /// Core answered 202 and is replacing its own binary, so every request until it is back fails —
    /// that is the update working. Polling ends the "Updating Core" state on the first answer, and
    /// gives up after a bounded wait rather than leaving it on forever, which is what the operator
    /// would otherwise be left looking at.
    private func waitForCoreToReturn() async {
        // Long enough for a binary swap and a cold start, short enough to stop claiming progress that
        // is not happening.
        let deadline = Date().addingTimeInterval(120)

        while Date() < deadline {
            try? await Task.sleep(for: .seconds(3))

            // Clears the once-per-session version answer: a Core update is the one thing that changes
            // it while the app is running.
            await session.refreshAfterCoreRestart()
            guard case .signedIn = session.state else { continue }

            isApplyingCoreUpdate = false
            await loadCoreUpdateStatus(refresh: true)
            await reload()
            return
        }

        isApplyingCoreUpdate = false
        coreUpdateError = "Core did not come back after the update. Check the host, then try again."
    }

    /// Refreshes one app's update verdict while preserving the session-level 401 behavior used by the
    /// list and lifecycle calls. The caller owns the local presentation of other errors.
    func refreshUpdateStatus(for app: AppSummary) async throws -> AppUpdateStatus {
        do {
            return try await session.client.updateStatus(appID: app.id, refresh: true)
        } catch let error as CoreError {
            if error.requiresSignIn {
                await session.refresh()
            }

            throw error
        }
    }

    /// Whether a fleet update sweep is running right now. Read from the server's own state rather than a
    /// local flag, so the spinner is right even when another client started the sweep.
    var isCheckingUpdates: Bool { updateCheck?.running == true }

    /// Whether a batch apply is in flight. Unlike the fleet check this is a local flag: the applies are
    /// separate per-app requests, and Core reports no batch of its own to read the state back from.
    private(set) var isUpdatingAll = false

    /// The apps a batch apply would touch right now. `hasRoutineUpdate` owns the rule; see it for why
    /// each clause is there.
    var routineUpdates: [AppSummary] { apps.filter(\.hasRoutineUpdate) }

    /// How many available updates this action leaves alone because they must be reviewed.
    var reviewOnlyUpdateCount: Int { apps.filter(\.needsUpdateReview).count }

    /// Applies one app's waiting update straight from its row.
    ///
    /// This is the same reviewed apply the plan sheet performs, minus the reading: the fleet check has
    /// already built the plan behind the verdict, and its digest is exactly what Core requires. Offered
    /// only for a routine verdict — a `requiresReview` plan changes more than the version and never gets
    /// a one-tap path, so this refuses rather than trusting the caller to have checked.
    func applyUpdate(_ app: AppSummary) async {
        guard app.hasRoutineUpdate, let planDigest = app.updateCheck?.planDigest else { return }
        guard !inFlight.contains(app.id) else { return }

        inFlight.insert(app.id)
        defer { inFlight.remove(app.id) }

        var failure: String?

        do {
            try await session.client.applyUpdate(appID: app.id, planDigest: planDigest)
        } catch let error as CoreError {
            if error.requiresSignIn {
                await session.refresh()
                return
            }

            failure = error.localizedDescription
        } catch {
            failure = error.localizedDescription
        }

        // Core commits `operationStatus: "updating"` before answering, so the row shows the work as soon
        // as this returns. The reload has to come first either way: it clears `loadError` on success and
        // would wipe the message below.
        await reload()

        if let failure {
            loadError = failure
        }
    }

    /// Applies every routine update in one action.
    ///
    /// Each apply is enqueued and runs detached on the host, so this ends once Core has accepted them
    /// all; the rows themselves then carry the progress, since an accepted apply shows as `updating`.
    /// One refusal is counted rather than ending the sweep — an app Core will not take should not hold
    /// back the rest of the fleet.
    ///
    /// Unlike the browser Shell there is no "Shell last" ordering here: this client is not served by any
    /// app on the host, so nothing it is running from can be restarted out from under it.
    func updateAllApps() async {
        guard !isUpdatingAll else { return }

        let routine = routineUpdates
        guard !routine.isEmpty else { return }

        isUpdatingAll = true
        defer { isUpdatingAll = false }

        var failed = 0

        for app in routine {
            guard let planDigest = app.updateCheck?.planDigest else { continue }

            do {
                try await session.client.applyUpdate(appID: app.id, planDigest: planDigest)
            } catch let error as CoreError {
                if error.requiresSignIn {
                    await session.refresh()
                    return
                }

                failed += 1
            } catch {
                failed += 1
            }
        }

        // Re-read first: a reload clears `loadError` on success, so a message set before it would be
        // wiped by the very refresh that is meant to show what the applies did.
        await reload()

        if failed == routine.count {
            loadError = "No updates could be started."
        } else if failed > 0 {
            loadError = "\(failed) of \(routine.count) updates could not be started."
        }
    }

    /// Starts a fleet update check, or joins one already in flight.
    ///
    /// It returns immediately: the sweep runs detached on the host and reports progress through the
    /// `updateCheck` block and the `apps.update-check.changed` event, which the stream already turns into
    /// reloads. So there is nothing to await here beyond the acknowledgement.
    func checkForUpdates() async {
        do {
            updateCheck = try await session.client.triggerFleetUpdateCheck().status
        } catch let error as CoreError {
            if error.requiresSignIn {
                await session.refresh()
                return
            }

            loadError = error.localizedDescription
        } catch {
            loadError = error.localizedDescription
        }
    }

    /// Begins following the host: one resync per connection, then events.
    ///
    /// The bus is hint-only, so every element that arrives is either "re-read everything" or "re-read
    /// because of this". Both end in the same reload — the difference is only how soon.
    func follow() {
        guard !streamTask.isRunning else { return }

        // The stream is built here, outside the task, and `self` stays weak *inside* the loop.
        //
        // Promoting it once with `guard let self` would hold a strong reference for the loop's whole
        // life, and the loop is effectively endless — closing the ring model → TaskBox → task → model.
        // The model could then never deallocate, so `deinit` would never cancel anything, and switching
        // or forgetting a host would leave the previous model reloading over its own live connection
        // forever. Re-acquiring per element keeps the ring open.
        let stream = CoreEventStream(client: session.client)

        streamTask.set(Task { [weak self] in
            for await element in stream.elements() {
                guard let self else { return }

                switch element {
                case .resync:
                    // A connection, or a reconnection after a gap during which anything could have
                    // happened. Reload immediately and without debouncing.
                    await reload()
                case .event(let event):
                    switch event.known {
                    case .appChanged, .appRemoved, .appUpdateCheckChanged, .fleetUpdateCheckChanged:
                        scheduleReload()
                    case .notification, nil:
                        break
                    }
                case .unauthorized:
                    // The stream has already stopped. Hand it to the session, which owns the signed-out
                    // screen — otherwise this view would sit on stale apps looking signed in.
                    await session.refresh()
                }
            }
        })
    }

    func stopFollowing() {
        streamTask.cancel()
        reloadTask.cancel()
    }

    /// A signed-out session must not retain app names or operational state from the previous credential.
    /// Keep this separate from `stopFollowing()`: backgrounding pauses the stream but should preserve the
    /// last rendered snapshot until the foreground resync arrives.
    func resetAfterSignOut() {
        stopFollowing()
        apps = []
        updateCheck = nil
        loadError = nil
        hasLoaded = false
        inFlight = []
    }

    deinit {
        streamTask.cancel()
        reloadTask.cancel()
    }

    func reload() async {
        do {
            let response = try await session.client.apps()
            apps = response.apps.sorted { $0.displayName.localizedCaseInsensitiveCompare($1.displayName) == .orderedAscending }
            updateCheck = response.updateCheck
            loadError = nil
        } catch let error as CoreError {
            // A dead session is the session's business, not the list's: hand it back so the whole screen
            // becomes "sign in" rather than an app list wearing an error.
            if error.requiresSignIn {
                await session.refresh()
                return
            }

            loadError = error.localizedDescription
        } catch {
            loadError = error.localizedDescription
        }

        hasLoaded = true
    }

    // MARK: - Lifecycle

    func start(_ app: AppSummary) async { await perform(app) { try await $0.start(appID: $1) } }

    func stop(_ app: AppSummary) async { await perform(app) { try await $0.stop(appID: $1) } }

    func restart(_ app: AppSummary) async { await perform(app) { try await $0.restart(appID: $1) } }

    /// True while the app must not be given another lifecycle command: a request of ours is in flight, a
    /// verb is already running on the host, or some other operation owns the record.
    func isBusy(_ app: AppSummary) -> Bool {
        inFlight.contains(app.id) || app.runtimeState.isBusy || app.isOperating
    }

    private func perform(
        _ app: AppSummary,
        _ action: @Sendable (CoreClient, String) async throws -> Void
    ) async {
        inFlight.insert(app.id)
        defer { inFlight.remove(app.id) }

        do {
            try await action(session.client, app.id)
        } catch let error as CoreError {
            if error.requiresSignIn {
                await session.refresh()
                return
            }

            loadError = error.localizedDescription
        } catch {
            loadError = error.localizedDescription
        }

        // Core commits the transition to `starting`/`stopping` before the call returns, so reading back
        // now shows the real state rather than waiting on the event to arrive.
        await reload()
    }

    /// Coalesces bursts of events into one reload. A single operation commits several times in a row —
    /// one reload per commit would be pure waste on a list that re-reads everything anyway.
    private func scheduleReload() {
        reloadTask.set(Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(300))
            guard !Task.isCancelled else { return }
            await self?.reload()
        })
    }
}

/// A cancellable task handle usable from a nonisolated context.
///
/// Exists solely so `AppsModel.deinit` can stop its event stream: `deinit` is nonisolated and cannot touch
/// main-actor state, but an abandoned SSE connection is not something to leave running.
/// `nonisolated` explicitly: the target defaults every type to the main actor, which is precisely the
/// isolation this box has to escape to be usable from `deinit`.
private nonisolated final class TaskBox: @unchecked Sendable {
    private let lock = NSLock()
    private var task: Task<Void, Never>?

    var isRunning: Bool {
        lock.withLock { task != nil }
    }

    /// Replaces the current task, cancelling whatever it displaces.
    func set(_ task: Task<Void, Never>?) {
        lock.withLock {
            self.task?.cancel()
            self.task = task
        }
    }

    func cancel() {
        set(nil)
    }
}
