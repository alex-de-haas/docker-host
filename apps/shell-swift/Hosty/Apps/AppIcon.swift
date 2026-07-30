import HostyKit
import SwiftUI
import WebKit

#if canImport(UIKit)
import UIKit
typealias PlatformImage = UIImage
#else
import AppKit
typealias PlatformImage = NSImage
#endif

/// An app's manifest-declared display icon, or a placeholder in its place.
///
/// The placeholder covers three cases on purpose — no icon declared, not fetched yet, and an icon that
/// would not resolve — because none of them is worth a distinct appearance in a list: an icon that is
/// still arriving and one that never will look the same to a person glancing at a row.
struct AppIconView: View {
    let app: AppSummary
    let icons: AppIconStore

    /// The icon's edge at the standard text size. Dynamic Type scales it from there, so an icon keeps its
    /// proportion to the name beside it instead of shrinking into a dot at accessibility sizes.
    var edge: CGFloat = 30

    @ScaledMetric(relativeTo: .body) private var scale: CGFloat = 1

    private var side: CGFloat { edge * scale }

    var body: some View {
        Group {
            if let url = app.iconUrl, let image = icons.image(for: url) {
                image
                    .resizable()
                    .scaledToFit()
            } else {
                placeholder
            }
        }
        .frame(width: side, height: side)
        .clipShape(RoundedRectangle(cornerRadius: side * 0.22, style: .continuous))
        .task(id: app.iconUrl) {
            if let url = app.iconUrl {
                icons.load(url)
            }
        }
        // The row states the app's name and everything else about it; an icon repeating that name is one
        // more stop for a VoiceOver user and no more information.
        .accessibilityHidden(true)
    }

    private var placeholder: some View {
        RoundedRectangle(cornerRadius: side * 0.22, style: .continuous)
            .fill(.quaternary)
            .overlay {
                Image(systemName: "shippingbox.fill")
                    .resizable()
                    .scaledToFit()
                    .padding(side * 0.24)
                    .foregroundStyle(.secondary)
            }
    }
}

/// The display icons of one host's apps: fetched once, kept for the session, handed to rows as images.
///
/// Deliberately not `AsyncImage`. Core's asset endpoint is session-authorized and this client presents its
/// credential as a header, which an image view cannot do; and the icons Hosty apps actually ship are SVG,
/// which no Apple image decoder reads on iOS.
@Observable
final class AppIconStore {
    private let client: CoreClient

    private var images: [String: Image] = [:]

    /// URLs that answered, but not with an icon this client can render — an asset that was never vendored,
    /// or a format it cannot decode. Remembered so a missing icon is asked for once per session rather
    /// than on every scroll.
    private var failed: Set<String> = []

    /// Icons still to fetch, oldest first, and the one task draining them.
    ///
    /// One at a time, deliberately: an SVG is rasterized through a `WKWebView`, and a web view is a
    /// process. Letting every row that scrolls into view start its own would spawn a dozen of them for a
    /// dozen files of a few kilobytes each.
    private var queue: [String] = []
    private var queued: Set<String> = []
    private var drain: Task<Void, Never>?

    init(client: CoreClient) {
        self.client = client
    }

    #if DEBUG
    /// A store for SwiftUI previews, which have no host to fetch from. Icons handed in here are already
    /// resolved; anything else falls back to the placeholder.
    init(previewImages: [String: Image]) {
        guard let origin = try? HostOrigin(parsing: "https://preview.hosty.invalid") else {
            preconditionFailure("The static preview origin must be valid.")
        }

        self.client = CoreClient(origin: origin)
        self.images = previewImages
        // Nothing is reachable from a preview, so never let a row start a fetch that can only time out.
        self.failed = Set(previewImages.keys)
    }
    #endif

    /// The icon, if it is already in hand. Reading it here is what subscribes the row to its arrival.
    func image(for url: String) -> Image? {
        images[url]
    }

    /// Asks for an icon. Idempotent — a URL already held, already queued, or known not to resolve is left
    /// alone — so a row may call this every time it appears.
    func load(_ url: String) {
        guard images[url] == nil, !failed.contains(url), queued.insert(url).inserted else { return }

        queue.append(url)
        startDraining()
    }

    private func startDraining() {
        guard drain == nil else { return }

        // `self` stays weak: the store owns this task, so promoting it once would close the ring and keep
        // a host's icons alive after the operator switched to another host.
        drain = Task { [weak self] in
            while let url = self?.nextInQueue() {
                await self?.fetch(url)
            }

            self?.drain = nil
        }
    }

    private func nextInQueue() -> String? {
        queue.isEmpty ? nil : queue.removeFirst()
    }

    private func fetch(_ url: String) async {
        // Clearing this on every outcome is what allows a retry: `load` still refuses to re-queue a URL
        // that succeeded or is known bad, because it checks `images` and `failed` first.
        defer { queued.remove(url) }

        do {
            let data = try await client.asset(at: url)
            guard let image = await AppIconRenderer.image(from: data) else {
                failed.insert(url)
                return
            }

            images[url] = image
        } catch {
            // Only a definite answer *about the asset* is remembered — a 404 for an icon that was never
            // vendored. A host that is briefly unreachable, a Core mid-restart, or an expired session has
            // told us nothing about the icon, so those are retried on the next appearance. Remembering a
            // 401 in particular would leave a screen of placeholders behind the operator for the rest of
            // the store's life, including after they signed back in.
            guard !Task.isCancelled,
                  let error = error as? CoreError,
                  !error.isTransient,
                  !error.requiresSignIn else { return }

            failed.insert(url)
        }
    }
}

/// Turns downloaded asset bytes into something SwiftUI can draw.
enum AppIconRenderer {
    /// The edge of a rasterized SVG, in points. Sized for the largest place an icon appears — app detail
    /// at an accessibility text size — and rendered once per icon, since the result is cached and every
    /// smaller use scales it down.
    private static let canvasEdge: CGFloat = 128

    static func image(from data: Data) async -> Image? {
        // Every raster format Core's asset endpoint serves (PNG, JPEG, GIF, WebP, AVIF) decodes here — and
        // so does SVG on macOS, where NSImage reads it natively and keeps it vector.
        if let decoded = PlatformImage(data: data) {
            return Image(platformImage: decoded)
        }

        guard looksLikeSVG(data), let rasterized = await SVGRasterizer(edge: canvasEdge).image(from: data) else {
            return nil
        }

        return Image(platformImage: rasterized)
    }

    /// Whether the bytes are worth handing to WebKit at all.
    ///
    /// Without this, anything that is not a decodable image — an HTML error page from a proxy in front of
    /// Core, most of all — would be *rendered as a page* and snapshotted, and the operator would get a
    /// thumbnail of an error where an icon belongs.
    private static func looksLikeSVG(_ data: Data) -> Bool {
        String(decoding: data.prefix(1024), as: UTF8.self).contains("<svg")
    }
}

/// Draws an SVG into a bitmap, because Apple's image decoders do not read SVG on iOS.
///
/// The SVG is loaded through an `<img>` tag rather than as the document itself, and that is the security
/// property, not a convenience: an SVG loaded as an image runs no script and fetches no subresources —
/// exactly the guarantee the browser Shell gets by rendering these same files in `<img>`.
@MainActor
private final class SVGRasterizer: NSObject, WKNavigationDelegate {
    /// A load that neither finishes nor fails would strand the caller forever. A local data URI with no
    /// script has nothing to wait on, so reaching this is a bug in WebKit rather than a slow network — but
    /// the caller is a list row, and a list row must not hang.
    private static let loadTimeout: Duration = .seconds(5)

    private let webView: WKWebView
    private var loaded: CheckedContinuation<Bool, Never>?

    init(edge: CGFloat) {
        let configuration = WKWebViewConfiguration()
        // Nothing here needs script, and nothing here is a document to run.
        configuration.defaultWebpagePreferences.allowsContentJavaScript = false
        configuration.websiteDataStore = .nonPersistent()

        webView = WKWebView(frame: CGRect(x: 0, y: 0, width: edge, height: edge), configuration: configuration)
        super.init()
        webView.navigationDelegate = self

        // Icons are transparent around their artwork, and a white page behind one would turn every icon
        // into a white tile in dark mode.
        #if os(macOS)
        webView.setValue(false, forKey: "drawsBackground")
        #else
        webView.isOpaque = false
        webView.backgroundColor = .clear
        webView.scrollView.backgroundColor = .clear
        #endif
    }

    func image(from data: Data) async -> PlatformImage? {
        let html = """
        <!doctype html>
        <html>
        <head><meta name="viewport" content="width=device-width,initial-scale=1"></head>
        <body style="margin:0;background:transparent">
        <img style="width:100vw;height:100vh;object-fit:contain;display:block" \
        src="data:image/svg+xml;base64,\(data.base64EncodedString())">
        </body>
        </html>
        """

        let timeout = Task {
            try? await Task.sleep(for: Self.loadTimeout)
            guard !Task.isCancelled else { return }

            self.finish(loaded: false)
        }

        defer { timeout.cancel() }

        let didLoad = await withCheckedContinuation { continuation in
            loaded = continuation
            webView.loadHTMLString(html, baseURL: nil)
        }

        guard didLoad else { return nil }

        let configuration = WKSnapshotConfiguration()
        configuration.rect = CGRect(origin: .zero, size: webView.bounds.size)
        return try? await webView.takeSnapshot(configuration: configuration)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        finish(loaded: true)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: any Error) {
        finish(loaded: false)
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: any Error) {
        finish(loaded: false)
    }

    /// Resumes the caller exactly once: the delegate and the timeout race, and both arrive here.
    private func finish(loaded: Bool) {
        self.loaded?.resume(returning: loaded)
        self.loaded = nil
    }
}

private extension Image {
    init(platformImage: PlatformImage) {
        #if canImport(UIKit)
        self.init(uiImage: platformImage)
        #else
        self.init(nsImage: platformImage)
        #endif
    }
}
