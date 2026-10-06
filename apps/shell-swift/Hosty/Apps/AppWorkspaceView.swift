import HostyKit
import SwiftUI
import WebKit

/// An app's own UI. The app creates its sign-in proof before native Shell authorizes it.
struct AppWorkspaceView: View {
    let app: AppSummary
    let session: HostSession
    let router: ShellRouter

    @Environment(\.openURL) private var openURL
    @State private var state: LoadState = .idle
    @State private var page: AppNavigationItem?
    @State private var showingRenewalLogin = false
    @State private var renewalAttempt: WorkspaceSignIn?
    @State private var renewalLoginError: String?
    @State private var renewalLoginGeneration = UUID()
    @State private var checkingRenewalLogin = false

    private enum LoadState: Equatable {
        case idle
        case launching
        case ready
        case failed(String)
        /// The one failure a client can diagnose before trying: Core advertises this app at a loopback
        /// address, and this device is not the host.
        case unreachableLoopback
    }

    var body: some View {
        content
            .navigationTitle(app.displayName)
            // The app's own interface starts immediately below this bar and has its own header. A large
            // title would put the app's name twice at the top of the screen, in two different type
            // sizes, and take a band of the app away to do it.
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar { toolbar }
            .task(id: app.id) {
                session.workspaces.installRecovery(
                    for: app.id, origin: session.connection.origin,
                    approvedAppURLs: app.pages.compactMap(\.embeddedUrl),
                    signIn: { request in Task { await completeSignIn(request) } },
                    refused: { message in state = .failed(message) })

                await open(page: app.pages.first, reuseLoadedPage: true)
            }
            .sheet(isPresented: $showingRenewalLogin, onDismiss: {
                Task { await cancelRenewalLogin() }
            }) { renewalLoginSheet }
            .onChange(of: session.state) { _, state in
                if case .signedIn = state { return }
                Task { await cancelRenewalLogin() }
            }
            .onChange(of: router.destination.appID) { _, selectedApp in
                if selectedApp != app.id { Task { await cancelRenewalLogin() } }
            }
    }

    private var renewalLoginSheet: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 12) {
                Text("Sign in as \(session.user?.name ?? "your Hosty account") to confirm access to \(app.displayName). Your open page stays here.")
                    .padding(.horizontal)
                if let renewalLoginError {
                    Text(renewalLoginError).foregroundStyle(.red).padding(.horizontal)
                }
                if checkingRenewalLogin {
                    ProgressView("Confirming access…").frame(maxWidth: .infinity, maxHeight: .infinity)
                } else {
                    LoginWebView(origin: session.connection.origin) { credential in
                        Task { await confirmRenewalLogin(credential) }
                    }
                    .id(renewalLoginGeneration)
                }
            }
            .navigationTitle("Confirm access")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { Task { await cancelRenewalLogin() } }
                }
            }
        }
        #if os(macOS)
        .frame(minWidth: 520, minHeight: 640)
        #endif
    }

    @ViewBuilder
    private var content: some View {
        switch state {
        case .idle, .launching:
            ProgressView("Opening \(app.displayName)…")

        case .ready:
            // A pure read. The store's other accessor records use and can evict, and writing observed
            // state here would invalidate this very view — the render loop that pinned a core and never
            // got as far as loading the page. `open(page:)` has already prepared the view before it set
            // this state, so the fallback is unreachable in practice and is a spinner rather than a
            // second chance to create one.
            if let webView = session.workspaces.existingWebView(for: app.id) {
                WorkspaceWebView(webView: webView)
                    .ignoresSafeArea(edges: .bottom)
            } else {
                ProgressView("Opening \(app.displayName)…")
            }

        case .unreachableLoopback:
            ContentUnavailableView {
                Label("This app is only reachable on the host", systemImage: "network.slash")
            } description: {
                Text("\(session.connection.displayName) advertises \(app.displayName) at a loopback address, which means \"this machine\" — so it resolves to this device instead of the host. Give the app a public origin on the host, or open it from a browser running on the host itself.")
            }

        case .failed(let message):
            ContentUnavailableView {
                Label("Could not open \(app.displayName)", systemImage: "exclamationmark.triangle")
            } description: {
                Text(message)
            } actions: {
                Button("Try again") { Task { await open(page: page ?? app.pages.first) } }
            }
        }
    }

    @ToolbarContentBuilder
    private var toolbar: some ToolbarContent {
        // The manifest's own pages. Once identity is established these are ordinary loads on the same
        // origin, so they need no new code.
        if app.pages.count > 1 {
            ToolbarItem {
                Menu {
                    ForEach(app.pages) { item in
                        Button(item.label) { Task { await open(page: item) } }
                    }
                } label: {
                    Label(page?.label ?? "Pages", systemImage: "list.bullet")
                }
            }
        }

        ToolbarItem {
            Menu {
                Button("Open in Browser", systemImage: "safari") {
                    Task { await openInBrowser() }
                }

                // Managing an app is a different job on a different screen, and one a non-administrator
                // does not have at all.
                if session.canManageApps {
                    Button("Manage", systemImage: "slider.horizontal.3") {
                        router.manage(appID: app.id)
                    }
                }
            } label: {
                Label("More", systemImage: "ellipsis.circle")
            }
        }
    }

    /// First open loads the approved app URL. Returning to a workspace retains its live document.
    private func open(page target: AppNavigationItem?, reuseLoadedPage: Bool = false) async {
        if reuseLoadedPage, session.workspaces.isLoaded(app.id),
           let rememberedURL = session.workspaces.rememberedPageURL(for: app.id),
           let rememberedPage = app.pages.first(where: { $0.embeddedUrl == rememberedURL }) {
            _ = session.workspaces.prepare(app.id)
            page = rememberedPage
            state = .ready
            return
        }
        guard let target, let embeddedUrl = target.embeddedUrl else {
            state = .failed("\(app.displayName) does not report a page to open.")
            return
        }

        page = target

        guard !session.connection.origin.advertisesUnreachableLoopback(embeddedUrl) else {
            state = .unreachableLoopback
            return
        }

        let webView = session.workspaces.prepare(app.id)

        // The loopback diagnosis above deliberately reads the address
        // Core advertised rather than this one: what it judges is where the app lives, which a
        // parameter cannot change.
        let workspaceUrl = HostyLaunch.declaringNativeMode(embeddedUrl)

        guard let url = URL(string: workspaceUrl) else {
            state = .failed("The app reports a URL this client could not read.")
            return
        }
        // No preissued code. The SDK creates its local proof and the delegate intercepts its broker hop.
        session.workspaces.rememberPage(embeddedUrl, for: app.id)
        webView.load(URLRequest(url: url))
        state = .ready
    }

    private func completeSignIn(_ attempt: WorkspaceSignIn, using confirmationClient: CoreClient? = nil) async {
        let request = attempt.request
        if request.inPlace {
            guard await session.workspaces.prepareInPlaceSignIn(attempt, appID: app.id) else {
                session.workspaces.finishSignIn(attempt, appID: app.id)
                return
            }
            if confirmationClient == nil {
                // Public app navigation proves origin and correlation, never user interaction.
                // Every privileged renewal requires a fresh, separate normal Core login.
                renewalAttempt = attempt
                renewalLoginError = nil
                renewalLoginGeneration = UUID()
                checkingRenewalLogin = false
                showingRenewalLogin = true
                return
            }
        }
        guard session.workspaces.isCurrentSignIn(attempt, appID: app.id) else { return }
        do {
            let launch = try await (confirmationClient ?? session.client).createLaunchCode(
                appID: app.id, redirectURI: request.redirectURI,
                codeChallenge: request.codeChallenge, codeChallengeMethod: request.codeChallengeMethod,
                interactiveRenewal: request.inPlace)
            guard session.workspaces.isCurrentSignIn(attempt, appID: app.id) else { return }
            guard request.accepts(launch), let url = URL(string: launch.redirectUri),
                  let webView = session.workspaces.existingWebView(for: app.id) else {
                if request.inPlace {
                    _ = await session.workspaces.deliverInPlaceSignIn(attempt, appID: app.id,
                        errorCode: "native_callback_invalid",
                        errorMessage: "The host returned a callback that did not match this sign-in attempt.")
                } else {
                    session.workspaces.finishSignIn(attempt, appID: app.id)
                    state = .failed("The host returned a callback that did not match this app's sign-in attempt.")
                }
                return
            }
            if request.inPlace {
                _ = await session.workspaces.deliverInPlaceSignIn(attempt, appID: app.id, code: launch.code)
            } else {
                session.workspaces.finishSignIn(attempt, appID: app.id)
                webView.load(URLRequest(url: url))
                state = .ready
            }
        } catch {
            guard session.workspaces.isCurrentSignIn(attempt, appID: app.id) else { return }
            if let coreError = error as? CoreError, coreError.requiresSignIn, confirmationClient == nil {
                session.workspaces.finishSignIn(attempt, appID: app.id)
                await session.refresh()
            } else if request.inPlace {
                _ = await session.workspaces.deliverInPlaceSignIn(attempt, appID: app.id,
                    errorCode: "native_sign_in_failed", errorMessage: error.localizedDescription)
            } else {
                session.workspaces.finishSignIn(attempt, appID: app.id)
                state = .failed(error.localizedDescription)
            }
        }
    }

    private func confirmRenewalLogin(_ credential: String) async {
        // This client stays only in workspace memory; it never replaces the Keychain device token.
        let confirmation = CoreClient(origin: session.connection.origin, sessionID: credential)
        guard !checkingRenewalLogin, let attempt = renewalAttempt,
              session.workspaces.isCurrentSignIn(attempt, appID: app.id) else {
            try? await confirmation.logout()
            return
        }
        checkingRenewalLogin = true
        session.workspaces.retainConfirmationSession(confirmation)
        do {
            let confirmedSession = try await confirmation.authSession()
            guard session.workspaces.isCurrentSignIn(attempt, appID: app.id) else {
                try? await confirmation.logout()
                return
            }
            guard NativeAppSignIn.acceptsRenewalSession(confirmedSession, expectedUserID: session.user?.id) else {
                try? await confirmation.logout()
                renewalLoginError = "Sign in with the same Hosty account you are using in this window."
                checkingRenewalLogin = false
                renewalLoginGeneration = UUID()
                return
            }
            renewalAttempt = nil
            showingRenewalLogin = false
            checkingRenewalLogin = false
            await completeSignIn(attempt, using: confirmation)
        } catch {
            guard session.workspaces.isCurrentSignIn(attempt, appID: app.id) else { return }
            renewalLoginError = error.localizedDescription
            checkingRenewalLogin = false
            renewalLoginGeneration = UUID()
        }
    }

    private func cancelRenewalLogin() async {
        guard let attempt = renewalAttempt else { return }
        renewalAttempt = nil
        showingRenewalLogin = false
        checkingRenewalLogin = false
        _ = await session.workspaces.deliverInPlaceSignIn(attempt, appID: app.id,
            errorCode: "native_sign_in_cancelled", errorMessage: "Access confirmation was cancelled.")
    }

    /// Opens a plain app URL. The external browser uses its own Core account and sign-in attempt.
    private func openInBrowser() async {
        guard let embeddedUrl = (page ?? app.pages.first)?.embeddedUrl,
              let url = URL(string: embeddedUrl) else { return }
        openURL(url)
    }

}

/// The web view itself, owned by the store rather than by this representable so it survives the view
/// being torn down and rebuilt.
private struct WorkspaceWebView: PlatformViewRepresentable {
    let webView: WKWebView

    #if os(macOS)
    func makeNSView(context: Context) -> WKWebView { webView }
    func updateNSView(_ view: WKWebView, context: Context) {}
    #else
    func makeUIView(context: Context) -> WKWebView { webView }
    func updateUIView(_ view: WKWebView, context: Context) {}
    #endif
}
