import Foundation
import Observation

/// Where the operator is, in one place.
///
/// Hoisted out of the views because the destinations cross-reference each other: opening an app from
/// its management detail moves to a different tab, and managing an app from its workspace moves back
/// and selects it. With the selection living inside each screen those jumps would each need their own
/// binding chain.
@Observable
final class ShellRouter {
    /// The three destinations, plus one case per open app.
    ///
    /// An app is a tab rather than a pushed screen because that is what makes the sidebar on iPad and
    /// macOS list apps beside Dashboard and Settings, which is the whole shape being adopted. On a
    /// phone the same selection renders full-screen with a way back to the list.
    enum Destination: Hashable {
        case dashboard
        case apps
        case settings
        case app(String)

        var appID: String? {
            if case .app(let id) = self { return id }
            return nil
        }
    }

    var destination: Destination = .dashboard

    /// The app selected in Dashboard's management list. Independent of `destination`: an operator can
    /// leave a detail open, go use the app, and come back to it.
    var managedAppID: String?

    /// Opens an app's UI.
    func open(appID: String) {
        destination = .app(appID)
    }

    /// Shows an app's management detail, from wherever the operator was.
    func manage(appID: String) {
        managedAppID = appID
        destination = .dashboard
    }

    /// A host change invalidates every per-host selection. Left behind, an app id from the previous
    /// host either selects nothing or — worse, if two hosts run the same app — silently opens a
    /// different machine's copy.
    func resetForHostChange() {
        destination = .dashboard
        managedAppID = nil
    }

    /// Keeps the selection pointing at something that exists. An app can be removed by another
    /// administrator while its tab is open, and a `Destination.app` naming a vanished id would render
    /// an empty tab that cannot be left except by picking another one.
    func reconcile(availableAppIDs: Set<String>) {
        if let id = destination.appID, !availableAppIDs.contains(id) {
            destination = .apps
        }

        if let managedAppID, !availableAppIDs.contains(managedAppID) {
            self.managedAppID = nil
        }
    }
}
