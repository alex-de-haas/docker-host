import HostyKit
import SwiftUI
import WebKit

/// An app's own UI, opened with a Core-issued launch code.
///
/// The mechanism is the browser Shell's exactly, and needs nothing new from Core: mint a one-time code
/// against the URL Core advertises for the app, load the URL it returns, and let the app exchange the
/// code for its own identity. The code is single-use and expires in five minutes, so re-opening always
/// mints again rather than reloading a URL whose code has been spent — that would land on a signed-out
/// app.
struct AppWorkspaceView: View {
    let app: AppSummary
    let session: HostSession
    let router: ShellRouter

    @Environment(\.openURL) private var openURL
    @State private var state: LoadState = .idle
    @State private var page: AppNavigationItem?

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
                session.workspaces.installRecovery(for: app.id, origin: session.connection.origin) {
                    Task { await open(page: page ?? app.pages.first) }
                }

                await open(page: app.pages.first)
            }
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

    /// Loads a page, minting a code when this app has no live session in its web view yet.
    private func open(page target: AppNavigationItem?) async {
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

        // Declared on both paths below. The loopback diagnosis above deliberately reads the address
        // Core advertised rather than this one: what it judges is where the app lives, which a
        // parameter cannot change.
        let workspaceUrl = HostyLaunch.declaringNativeMode(embeddedUrl)

        // A page switch inside an app that is already open is a plain navigation: the app's own cookie
        // is already set on that origin, so a second code would be minted for nothing.
        if session.workspaces.isLoaded(app.id), let url = URL(string: workspaceUrl) {
            webView.load(URLRequest(url: url))
            state = .ready
            return
        }

        state = .launching

        do {
            let launch = try await session.client.createLaunchCode(appID: app.id, redirectURI: workspaceUrl)
            guard let url = URL(string: launch.redirectUri) else {
                state = .failed("The host returned a launch URL this app could not read.")
                return
            }

            webView.load(URLRequest(url: url))
            state = .ready
        } catch let error as CoreError {
            if error.requiresSignIn {
                await session.refresh()
                return
            }

            state = .failed(error.localizedDescription)
        } catch {
            state = .failed(error.localizedDescription)
        }
    }

    /// Hands the app to the system browser.
    ///
    /// A *fresh* code, minted immediately before the handover: the URL already loaded in the web view
    /// carries a code that has been spent, and following it would open a signed-out app.
    private func openInBrowser() async {
        // No launch mode declared: this hand-off exists to leave the client, and a browser tab has
        // nothing else drawing the app's name and pages.
        guard let embeddedUrl = (page ?? app.pages.first)?.embeddedUrl else { return }

        do {
            let launch = try await session.client.createLaunchCode(appID: app.id, redirectURI: embeddedUrl)
            if let url = URL(string: launch.redirectUri) {
                openURL(url)
            }
        } catch let error as CoreError {
            if error.requiresSignIn {
                await session.refresh()
                return
            }

            state = .failed(error.localizedDescription)
        } catch {
            state = .failed(error.localizedDescription)
        }
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
