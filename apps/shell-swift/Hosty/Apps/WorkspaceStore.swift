import Foundation
import HostyKit
import Observation
import WebKit

/// The web views one host's apps are running in.
///
/// Kept per host session rather than per screen: switching to Dashboard and back, or between two apps,
/// must not reload the page and re-run the code exchange — the app would sign the operator in again
/// every time they looked away.
///
/// Bounded rather than unbounded. A `WKWebView` is an expensive object, and an operator with a dozen
/// apps would otherwise accumulate a dozen live ones; the least recently used are dropped, and an
/// evicted app re-opens by minting a fresh code, which is the same path a first open takes.
@MainActor
@Observable
final class WorkspaceStore {
    /// Enough for the handful an operator moves between, few enough that the rest are reclaimed.
    static let capacity = 4

    private var webViews: [String: WKWebView] = [:]
    /// Least recently used first.
    private var order: [String] = []

    /// One data store for this host's apps, so their identity cookies coexist without any of them
    /// outliving the session. Non-persistent on purpose: the server-side logout cascade already ends
    /// these grants, and nothing here should survive it on disk.
    private let dataStore = WKWebsiteDataStore.nonPersistent()

    private var recoveries: [String: RecoveryCoordinator] = [:]

    /// The web view for an app, created on first use.
    func webView(for appID: String) -> WKWebView {
        touch(appID)

        if let existing = webViews[appID] {
            return existing
        }

        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = dataStore

        let webView = WKWebView(frame: .zero, configuration: configuration)
        // Attached here, not only in `installRecovery`: on a first open the view does not exist yet
        // when recovery is installed, so an assignment made only there would land on nothing and the
        // app would follow its own redirect to Core's login page instead of being re-launched.
        webView.navigationDelegate = recoveries[appID]
        webViews[appID] = webView
        evictIfNeeded()
        return webView
    }

    /// Installs identity recovery for an app.
    ///
    /// In a web view the app is the top frame, so when its identity expires the app SDK takes its
    /// standalone path: a redirect to Core's `/api/apps/{id}/open`, which without a Core cookie lands
    /// on `/login`. That navigation is this client's cue — the native equivalent of the browser
    /// Shell's `hosty:auth-required` — and nothing in the SDK changes for it.
    /// Safe in either order: it registers the coordinator for this app, and attaches it to the web
    /// view if one already exists — `webView(for:)` attaches it to any view created later.
    func installRecovery(for appID: String, origin: HostOrigin, reopen: @escaping () -> Void) {
        let coordinator = recoveries[appID] ?? RecoveryCoordinator(appID: appID, origin: origin)
        coordinator.reopen = reopen
        recoveries[appID] = coordinator
        webViews[appID]?.navigationDelegate = coordinator
    }

    /// True when this app has a recovery coordinator registered. Exists so a test — and a reader —
    /// can tell installation from the no-op it used to be.
    func hasRecovery(for appID: String) -> Bool {
        recoveries[appID] != nil
    }

    /// True when this app already has a loaded page, so opening it again is a switch rather than a
    /// launch. A caller uses this to decide whether a fresh code is needed at all.
    func isLoaded(_ appID: String) -> Bool {
        webViews[appID]?.url != nil
    }

    /// Drops everything. Called when the session ends: the credential that authorized these grants is
    /// gone, so the pages holding them must go too.
    func reset() {
        for webView in webViews.values {
            webView.stopLoading()
            webView.loadHTMLString("", baseURL: nil)
        }

        webViews.removeAll()
        order.removeAll()
        recoveries.removeAll()
    }

    private func touch(_ appID: String) {
        order.removeAll { $0 == appID }
        order.append(appID)
    }

    private func evictIfNeeded() {
        while order.count > Self.capacity, let oldest = order.first {
            order.removeFirst()
            webViews.removeValue(forKey: oldest)?.stopLoading()
            recoveries.removeValue(forKey: oldest)
        }
    }
}

/// Turns an app's own "I need identity again" navigation into a fresh launch.
///
/// Narrow on purpose, for the same reason the browser Shell's handler is: only a main-frame
/// navigation, only to this host's own Core origin, only for this app, and at most one recovery every
/// few seconds. An app that fails immediately after recovering would otherwise drive an unbounded
/// mint-and-reload loop against Core; past the throttle the navigation is simply allowed, and whatever
/// Core answers is what the operator sees.
@MainActor
private final class RecoveryCoordinator: NSObject, WKNavigationDelegate {
    /// Long enough that a broken app cannot spin, short enough that a genuine expiry recovers while the
    /// operator is still looking at the screen.
    private static let throttle: TimeInterval = 3

    private let appID: String
    private let origin: HostOrigin
    private var lastRecovery: Date?

    var reopen: (() -> Void)?

    init(appID: String, origin: HostOrigin) {
        self.appID = appID
        self.origin = origin
    }

    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationAction: WKNavigationAction,
        decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
    ) {
        guard navigationAction.targetFrame?.isMainFrame ?? false,
              let url = navigationAction.request.url,
              isRecoveryNavigation(url),
              allowedByThrottle()
        else {
            decisionHandler(.allow)
            return
        }

        decisionHandler(.cancel)
        lastRecovery = Date()
        reopen?()
    }

    /// Core's own origin, and one of the two paths the SDK's standalone recovery uses: the open
    /// endpoint for this app, or the login page it bounces to without a Core cookie. Anything else on
    /// Core's origin is left alone.
    private func isRecoveryNavigation(_ url: URL) -> Bool {
        guard (try? HostOrigin(parsing: url.absoluteString)) == origin else { return false }

        if url.path == "/login" { return true }

        return url.path == "/api/apps/\(appID)/open"
            || url.path == "/api/apps/\(appID.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? appID)/open"
    }

    private func allowedByThrottle() -> Bool {
        guard let lastRecovery else { return true }
        return Date().timeIntervalSince(lastRecovery) > Self.throttle
    }
}
