import Foundation

/// The launch mode a shell declares to the app it opens, carried as one query parameter on the URL the
/// app is loaded with — the same contract the browser Shell's theme parameters travel on.
///
/// This client's mode is `native`. Inside a `WKWebView` the app is the **top** frame, so the SDK's
/// structural heuristic reads it as a plain browser tab; without the declaration the app has no way to
/// tell this workspace from a standalone open, and draws its own name and page navigation underneath
/// the ones the navigation bar and the pages menu already render.
///
/// `native` is deliberately not `embedded`: identity recovery for `embedded` posts to a parent frame,
/// and there is none here. `native` keeps the standalone redirect to Core's `/open`, which is the
/// navigation `WorkspaceStore.RecoveryCoordinator` intercepts to re-mint a launch code.
public enum HostyLaunch {
    /// Frozen — `@hosty-sdk/app` reads this exact name, and an app built against an older SDK ignores
    /// the parameter rather than breaking on it.
    public static let parameter = "hosty_launch"

    /// The mode this client declares.
    public static let nativeMode = "native"

    /// `urlString` with the mode declared: every other query item and the fragment survive, and a value
    /// the URL already carries is replaced rather than added to, so re-declaring is idempotent.
    ///
    /// Anything that is not an absolute URL with a scheme and a host comes back **unchanged**, which is
    /// the whole guard: `URLComponents` accepts far more than it rejects, and parses a string like
    /// `not a url` into a percent-encoded relative path rather than refusing it. Rewriting one of those
    /// would replace the address Core actually advertised with an invented one, and the failure the
    /// operator then sees would be about the wrong URL. Core advertises absolute origins, so this
    /// admits every real workspace URL — the same shape `HostOrigin.advertisesUnreachableLoopback`
    /// requires before it will judge an address at all.
    public static func declaringNativeMode(_ urlString: String) -> String {
        guard var components = URLComponents(string: urlString),
              components.scheme != nil,
              components.host != nil
        else { return urlString }

        var items = (components.queryItems ?? []).filter { $0.name != parameter }
        items.append(URLQueryItem(name: parameter, value: nativeMode))
        components.queryItems = items

        return components.string ?? urlString
    }
}
