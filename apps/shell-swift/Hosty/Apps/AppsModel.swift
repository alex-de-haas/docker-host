import Foundation
import HostyKit
import Observation

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

    private let session: HostSession

    // Held outside the main actor's isolation so `deinit`, which is nonisolated, can still cancel them.
    // A model dropped without `stopFollowing()` would otherwise leave its event stream open, holding a
    // connection to Core for as long as the process lives.
    private let streamTask = TaskBox()
    private let reloadTask = TaskBox()

    init(session: HostSession) {
        self.session = session
    }

    #if DEBUG
    /// A local-only model for SwiftUI previews. It never follows an event stream unless a preview calls
    /// `follow()` explicitly, and its data is independent of saved hosts and live Core instances.
    convenience init(previewApps: [AppSummary]) {
        guard let origin = try? HostOrigin(parsing: "https://preview.hosty.invalid") else {
            preconditionFailure("The static preview origin must be valid.")
        }

        self.init(session: HostSession(connection: HostConnection(origin: origin)))
        apps = previewApps
        hasLoaded = true
    }
    #endif

    var userApps: [AppSummary] { apps.filter { !$0.system } }
    var systemApps: [AppSummary] { apps.filter(\.system) }

    /// For screens that talk to Core directly, such as building an update plan for review.
    var client: CoreClient { session.client }

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
