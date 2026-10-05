import Foundation

/// Native declares its mode on the app URL, hiding app chrome duplicated by the native shell.
/// The app is the top frame of a WKWebView. Its SDK creates the private proof locally and
/// builds a public Core broker navigation which the native coordinator cancels before dispatch.
/// Native forwards only the challenge using its Core session; no verifier enters native Shell.
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
