import Foundation
import HostyKit
import Observation
import WebKit

/// Captured from one approved app document; replacement views/documents cannot receive its result.
struct WorkspaceSignIn {
    let request: NativeAppSignIn
    let coordinatorID: UUID
    let generation: UInt64
    let sourceFrame: WKFrameInfo
    let documentToken = UUID().uuidString
}

/// The web views one host's apps are running in.
///
/// Kept per host session rather than per screen: switching to Dashboard and back, or between two apps,
/// must not reload the page and re-run the code exchange — the app would sign the operator in again
/// every time they looked away.
///
/// Bounded rather than unbounded. A `WKWebView` is an expensive object, and an operator with a dozen
/// apps would otherwise accumulate a dozen live ones; the least recently used are dropped, and an
/// evicted app re-opens at its own origin and creates a fresh sign-in attempt.
@MainActor
@Observable
final class WorkspaceStore {
    /// Enough for the handful an operator moves between, few enough that the rest are reclaimed.
    static let capacity = 4

    private var webViews: [String: WKWebView] = [:]
    private var pageURLs: [String: String] = [:]
    /// Least recently used first.
    private var order: [String] = []

    /// One data store for this host's apps, so their identity cookies coexist without any of them
    /// outliving the session. Non-persistent on purpose: the server-side logout cascade already ends
    /// these grants, and nothing here should survive it on disk.
    private let dataStore = WKWebsiteDataStore.nonPersistent()

    private var recoveries: [String: RecoveryCoordinator] = [:]
    private var confirmationSessions = NativeConfirmationSessions()

    func retainConfirmationSession(_ client: CoreClient) { confirmationSessions.retain(client) }

    /// The web view an app already has, or nil.
    ///
    /// **The only accessor a `body` may call**, because it is the only one that writes nothing. Its
    /// mutating sibling below records use and can evict, and observed state written while SwiftUI is
    /// rendering invalidates the very view being rendered: `body` → `prepare(_:)` → `order` → willSet →
    /// invalidate → `body`, a loop that pins a core and grows the transaction graph until the process
    /// is killed. The app never opened, because the run loop never got as far as loading the page.
    func existingWebView(for appID: String) -> WKWebView? {
        webViews[appID]
    }

    func rememberedPageURL(for appID: String) -> String? { pageURLs[appID] }

    func rememberPage(_ url: String, for appID: String) { pageURLs[appID] = url }

    /// The web view for an app, created on first use and marked as most recently used.
    ///
    /// Call it from a task or an event handler, never from `body` — see above.
    func prepare(_ appID: String) -> WKWebView {
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

    /// Installs the native handoff for proof created by this app's own main-frame document.
    func installRecovery(
        for appID: String, origin: HostOrigin, approvedAppURLs: [String],
        signIn: @escaping (WorkspaceSignIn) -> Void, refused: @escaping (String) -> Void
    ) {
        let coordinator = recoveries[appID] ?? RecoveryCoordinator(appID: appID, origin: origin)
        coordinator.approvedAppURLs = approvedAppURLs
        coordinator.signIn = signIn
        coordinator.refused = refused
        recoveries[appID] = coordinator
        webViews[appID]?.navigationDelegate = coordinator
    }

    func isCurrentSignIn(_ attempt: WorkspaceSignIn, appID: String) -> Bool {
        guard let coordinator = recoveries[appID], coordinator.identifier == attempt.coordinatorID,
              coordinator.gate.isCurrent(attempt.request, generation: attempt.generation),
              let loadedURL = webViews[appID]?.url,
              (try? HostOrigin(parsing: loadedURL.absoluteString)) ==
                (try? HostOrigin(parsing: attempt.request.redirectURI))
        else { return false }
        return true
    }

    func finishSignIn(_ attempt: WorkspaceSignIn, appID: String) {
        guard recoveries[appID]?.identifier == attempt.coordinatorID,
              recoveries[appID]?.gate.documentGeneration == attempt.generation else { return }
        recoveries[appID]?.gate.finish(attempt.request)
    }

    /// A page-world marker ties asynchronous delivery to this exact document, not only its origin.
    func prepareInPlaceSignIn(_ attempt: WorkspaceSignIn, appID: String) async -> Bool {
        guard isCurrentSignIn(attempt, appID: appID), let view = webViews[appID],
              let origin = try? HostOrigin(parsing: attempt.request.redirectURI) else { return false }
        do {
            let result = try await runDocumentScript("""
                if (window.location.origin !== expectedOrigin) return false;
                Object.defineProperty(window, '__hostyNativeAuthDocument', {
                    configurable: true, value: documentToken
                });
                return true;
                """, arguments: ["expectedOrigin": origin.url.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/")),
                    "documentToken": attempt.documentToken], frame: attempt.sourceFrame, view: view)
            return result && isCurrentSignIn(attempt, appID: appID)
        } catch { return false }
    }

    /// Delivers public code/state only. No URL load, verifier or grant crosses the native boundary.
    func deliverInPlaceSignIn(_ attempt: WorkspaceSignIn, appID: String, code: String = "",
        errorCode: String = "", errorMessage: String = "") async -> Bool {
        guard isCurrentSignIn(attempt, appID: appID), let view = webViews[appID],
              let origin = try? HostOrigin(parsing: attempt.request.redirectURI) else { return false }
        do {
            let result = try await runDocumentScript("""
                if (window.location.origin !== expectedOrigin ||
                    window.__hostyNativeAuthDocument !== documentToken) return false;
                delete window.__hostyNativeAuthDocument;
                const detail = errorCode ? {state, error: {code: errorCode, message: errorMessage}} : {state, code};
                window.dispatchEvent(new CustomEvent('hosty:native-auth-result', {detail}));
                return true;
                """, arguments: [
                    "expectedOrigin": origin.url.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/")),
                    "documentToken": attempt.documentToken, "state": attempt.request.state,
                    "code": code, "errorCode": errorCode, "errorMessage": errorMessage,
                ], frame: attempt.sourceFrame, view: view)
            let accepted = result && isCurrentSignIn(attempt, appID: appID)
            finishSignIn(attempt, appID: appID)
            return accepted
        } catch {
            finishSignIn(attempt, appID: appID)
            return false
        }
    }

    private func runDocumentScript(_ body: String, arguments: [String: Any],
        frame: WKFrameInfo, view: WKWebView) async throws -> Bool {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Bool, Error>) in
            view.callAsyncJavaScript(body, arguments: arguments, in: frame, in: .page) { result in
                switch result {
                case .success(let value): continuation.resume(returning: value as? Bool == true)
                case .failure(let error): continuation.resume(throwing: error)
                }
            }
        }
    }

    /// True when this app has a recovery coordinator registered. Exists so a test — and a reader —
    /// can tell installation from the no-op it used to be.
    func hasRecovery(for appID: String) -> Bool {
        recoveries[appID] != nil
    }

    /// True when this app already has a loaded page, so opening it again is a switch rather than a
    /// launch. A caller uses this to retain the existing document on a workspace remount.
    func isLoaded(_ appID: String) -> Bool {
        webViews[appID]?.url != nil
    }

    /// Drops everything. Called when the session ends: the credential that authorized these grants is
    /// gone, so the pages holding them must go too.
    func reset() -> [CoreClient] {
        for webView in webViews.values {
            webView.stopLoading()
            webView.loadHTMLString("", baseURL: nil)
        }

        webViews.removeAll()
        pageURLs.removeAll()
        order.removeAll()
        recoveries.removeAll()
        return confirmationSessions.takeAll()
    }

    private func touch(_ appID: String) {
        order.removeAll { $0 == appID }
        order.append(appID)
    }

    private func evictIfNeeded() {
        while order.count > Self.capacity, let oldest = order.first {
            order.removeFirst()
            webViews.removeValue(forKey: oldest)?.stopLoading()
            pageURLs.removeValue(forKey: oldest)
            recoveries.removeValue(forKey: oldest)
        }
    }
}

/// Cancels the public proof navigation before dispatch and hands only its challenge to Core.
@MainActor
private final class RecoveryCoordinator: NSObject, WKNavigationDelegate {
    private let appID: String
    private let origin: HostOrigin
    let identifier = UUID()
    var gate = NativeSignInGate()
    var approvedAppURLs: [String] = []
    var signIn: ((WorkspaceSignIn) -> Void)?
    var refused: ((String) -> Void)?

    init(appID: String, origin: HostOrigin) {
        self.appID = appID
        self.origin = origin
    }

    func webView(
        _ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
        decisionHandler: @escaping @MainActor (WKNavigationActionPolicy) -> Void
    ) {
        guard let url = navigationAction.request.url,
              NativeAppSignIn.isBrokerNavigation(url, appID: appID, coreOrigin: origin)
        else {
            if navigationAction.targetFrame?.isMainFrame == true { gate.documentChanged() }
            decisionHandler(.allow)
            return
        }
        decisionHandler(.cancel)
        let source = navigationAction.sourceFrame.securityOrigin
        var sourceURL = URLComponents()
        sourceURL.scheme = source.protocol
        sourceURL.host = source.host
        if source.port > 0 { sourceURL.port = source.port }
        guard let sourceString = sourceURL.string,
              let sourceOrigin = try? HostOrigin(parsing: sourceString),
              let request = NativeAppSignIn.parse(
                url, appID: appID, coreOrigin: origin, sourceOrigin: sourceOrigin,
                approvedAppURLs: approvedAppURLs,
                sourceIsMainFrame: navigationAction.sourceFrame.isMainFrame,
                targetIsMainFrame: navigationAction.targetFrame?.isMainFrame == true)
        else {
            refused?("The app's sign-in request did not match its approved origin and proof.")
            return
        }
        guard gate.claim(request) else { return }
        signIn?(WorkspaceSignIn(request: request, coordinatorID: identifier,
            generation: gate.documentGeneration, sourceFrame: navigationAction.sourceFrame))
    }
}
