import Foundation
import HostyKit
import Observation

/// The signed-in state of one host, and the client every screen talks through.
@Observable
final class HostSession {
    enum State: Equatable {
        /// Working out where we stand — no credential has been tried yet, or a probe is in flight.
        case connecting
        /// Reached the host, but there is no usable session. Sign in.
        case signedOut
        /// Signed in. The user may or may not be an administrator; `RootView` decides what that allows.
        case signedIn(HostUser)
        /// Could not reach the host, or it answered in a way that is not recoverable by signing in.
        case unreachable(String)
        /// Reached a Hosty host too old to accept a bearer-presented session. Signing in cannot help.
        case unsupported(hostVersion: String)
    }

    let connection: HostConnection
    private(set) var state: State = .connecting

    /// Exposed so later phases can call Core through the same authenticated client.
    let client: CoreClient

    /// The web views this host's apps run in. Owned by the session because that is their lifetime: the
    /// credential that authorized their identity grants is this session's, and when it ends they must
    /// go with it.
    @MainActor let workspaces = WorkspaceStore()

    private let keychain: KeychainStore

    /// The host's platform version is checked once per session rather than on every refresh: it cannot
    /// change while Core is running, and Phase 4 refreshes this often from the event stream.
    private var versionChecked = false

    /// What the host reported for itself, kept from that one check so the Dashboard can show it without
    /// a probe of its own. Nil until the check has run, or when it could not.
    private(set) var hostVersion: String?

    init(connection: HostConnection, keychain: KeychainStore = .shared) {
        self.connection = connection
        self.keychain = keychain
        self.client = CoreClient(
            origin: connection.origin,
            sessionID: keychain.sessionID(for: connection.origin))
    }

    var user: HostUser? {
        if case .signedIn(let user) = state { return user }
        return nil
    }

    /// True when this host user may actually manage apps. Installed Apps, every lifecycle verb, and every
    /// update endpoint are administrator-only, so a signed-in ordinary user gets an explicit explanation
    /// rather than an empty list.
    var canManageApps: Bool { user?.isAdmin == true }

    /// Whether this host can sign the operator in through their own browser.
    ///
    /// Known from the version check that already ran before any sign-in screen appeared, so the sheet
    /// never has to discover the answer from a 404 halfway through showing a code.
    var supportsDeviceLogin: Bool { PlatformVersion.supportsDeviceLogin(hostVersion: hostVersion) }

    /// Works out the current state: is the host there, and does the stored credential still work?
    func refresh() async {
        if case .unreachable = state {
            state = .connecting
        }

        do {
            // A host older than the bearer release answers 401 to everything this client sends, which
            // presents as a sign-in that succeeds and then immediately un-succeeds. Ask once, up front, so
            // the operator is told to update the host instead of retrying a login that cannot work.
            if !versionChecked {
                let status = try await client.status()
                versionChecked = true
                hostVersion = status.version

                guard status.isSupportedVersion else {
                    state = .unsupported(hostVersion: status.version)
                    return
                }
            }

            let session = try await client.authSession()
            if let user = session.user, session.authenticated {
                state = .signedIn(user)
            } else {
                // Reachable and anonymous. Any stored credential is dead, so drop it rather than letting a
                // stale value linger in the Keychain across launches.
                await endSession()
                state = .signedOut
            }
        } catch let error as CoreError {
            // A 401 is not a failure to report — it is the ordinary end of a session, and the answer is to
            // sign in again. The client has already dropped the credential; the Keychain has to follow, or
            // the next launch would restore the dead one.
            if error.requiresSignIn {
                await endSession()
                state = .signedOut
            } else {
                state = .unreachable(error.localizedDescription)
            }
        } catch {
            state = .unreachable(error.localizedDescription)
        }
    }

    /// Re-reads the host after it has restarted under a new binary.
    ///
    /// The version check is a once-per-session probe because the version cannot change while Core
    /// runs. A Core update is the one thing that breaks that assumption, so applying one has to clear
    /// the answer or the Dashboard would keep showing the version that was replaced.
    func refreshAfterCoreRestart() async {
        versionChecked = false
        await refresh()
    }

    /// Takes the session the login web view harvested and makes it this app's credential.
    func adopt(sessionID: String) async {
        keychain.setSessionID(sessionID, for: connection.origin)
        await client.setSessionID(sessionID)
        await refresh()
    }

    func signOut() async {
        // Ask Core to revoke first: that is what also cascades to the app grants this session authorized.
        // It is best-effort — if the host is unreachable, signing out locally must still work, otherwise a
        // dead host would trap the operator in a session they cannot leave.
        try? await client.logout()

        await endSession()
        await client.setSessionID(nil)
        state = .signedOut
    }

    /// Everything that must go when this session stops being usable, however it stopped.
    ///
    /// The web views go with the credential rather than only when the operator taps Sign out. An
    /// expired or revoked bearer ends the session just as finally, and an app's own grant outlives the
    /// Core session that authorized it — so a loaded workspace left behind would let whoever signs in
    /// next reach the previous user's app identity.
    private func endSession() async {
        keychain.removeSessionID(for: connection.origin)
        await MainActor.run { workspaces.reset() }
    }
}
