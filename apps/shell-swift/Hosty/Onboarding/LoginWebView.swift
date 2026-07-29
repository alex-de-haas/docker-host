import HostyKit
import SwiftUI
import WebKit

#if os(macOS)
typealias PlatformViewRepresentable = NSViewRepresentable
#else
typealias PlatformViewRepresentable = UIViewRepresentable
#endif

/// Core's own `/login` page, shown just long enough to produce a session.
///
/// Core has no JSON login, and keeping the login inside Core's page is deliberate rather than a
/// workaround: whatever Core supports now or later — local password, a future OIDC provider, a trusted
/// proxy — works here without a line changing in this app.
///
/// Completion is detected by **polling for the session cookie**, never by watching navigation. After a
/// successful login Core redirects to the Shell public origin, and `returnTo` cannot be aimed anywhere
/// this app controls, so the final navigation may well fail on a device that cannot reach Shell — or land
/// on Core's "this host has no web UI installed" page when no Shell is installed. Both are successful
/// logins. Treating a navigation failure as a failed login would break the common case.
struct LoginWebView: PlatformViewRepresentable {
    let origin: HostOrigin
    let onSession: (String) -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(origin: origin, onSession: onSession)
    }

    #if os(macOS)
    func makeNSView(context: Context) -> WKWebView { makeWebView(context: context) }
    func updateNSView(_ webView: WKWebView, context: Context) {}
    static func dismantleNSView(_ webView: WKWebView, coordinator: Coordinator) { coordinator.stop() }
    #else
    func makeUIView(context: Context) -> WKWebView { makeWebView(context: context) }
    func updateUIView(_ webView: WKWebView, context: Context) {}
    static func dismantleUIView(_ webView: WKWebView, coordinator: Coordinator) { coordinator.stop() }
    #endif

    private func makeWebView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        // A non-persistent store: the login sheet starts from a clean slate every time, and nothing it
        // collects outlives the sheet. The session leaves here as a value, not as a cookie the app keeps.
        configuration.websiteDataStore = .nonPersistent()

        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.load(URLRequest(url: origin.url(path: "/login")))
        context.coordinator.watch(webView)
        return webView
    }

    @MainActor
    final class Coordinator {
        private let origin: HostOrigin
        private let onSession: (String) -> Void
        private var pollTask: Task<Void, Never>?

        init(origin: HostOrigin, onSession: @escaping (String) -> Void) {
            self.origin = origin
            self.onSession = onSession
        }

        func watch(_ webView: WKWebView) {
            let store = webView.configuration.websiteDataStore.httpCookieStore
            pollTask = Task { [origin, onSession] in
                // Polling rather than a navigation delegate, because there is no navigation that reliably
                // marks success: Core sets the cookie on the 302, and where that redirect lands is a
                // property of the host's configuration, not of the login.
                while !Task.isCancelled {
                    let cookies = await store.allCookies()
                    if let session = LoginCookie.session(in: cookies, for: origin) {
                        onSession(session)
                        return
                    }

                    try? await Task.sleep(for: .milliseconds(300))
                }
            }
        }

        func stop() {
            pollTask?.cancel()
            pollTask = nil
        }

        deinit {
            pollTask?.cancel()
        }
    }
}

/// The sheet the sign-in button presents.
struct LoginSheet: View {
    let origin: HostOrigin
    let onSession: (String) -> Void

    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            LoginWebView(origin: origin) { session in
                onSession(session)
                dismiss()
            }
            .ignoresSafeArea(edges: .bottom)
            .navigationTitle("Sign in to \(origin.displayName)")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
            }
        }
    }
}
