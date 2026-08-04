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
    /// A string that cannot be parsed as a URL comes back unchanged. Failing on the URL Core actually
    /// advertised says something truer than failing on one invented here — the same reason
    /// `HostOrigin.advertisesUnreachableLoopback` declines to guess about what it cannot read.
    public static func declaringNativeMode(_ urlString: String) -> String {
        guard var components = URLComponents(string: urlString) else { return urlString }

        var items = (components.queryItems ?? []).filter { $0.name != parameter }
        items.append(URLQueryItem(name: parameter, value: nativeMode))
        components.queryItems = items

        return components.string ?? urlString
    }
}
