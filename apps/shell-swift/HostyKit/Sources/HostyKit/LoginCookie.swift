import Foundation

/// Extracting the Core session from the cookies a login web view collected.
///
/// Core has no JSON login: a session is created only by the HTML form at `/login`, so the app shows Core's
/// own page in a web view and takes the resulting cookie **once**. Everything afterwards is a bearer
/// header — the web view is how a session is born, not how it is used.
///
/// Success is detected by seeing the cookie, never by watching for the redirect. `returnTo` cannot be
/// pointed at anything the app controls (Core allows only `/api/apps/*/open` paths), so a successful login
/// redirects to the Shell public origin — which a phone may be unable to reach — or renders Core's "this
/// host has no web UI installed" page. Both are successes, and a failed navigation to an unreachable Shell
/// must never be reported as a failed login.
public enum LoginCookie {
    /// The cookie Core sets on a successful login. `HttpOnly`, which is why page script cannot read it and
    /// why a bearer header built from it cannot be forged by a hostile origin.
    public static let sessionName = "hosty_session"

    /// The session cookie for `origin`, or nil when the web view has not produced one yet.
    ///
    /// Cookies from any other host are ignored. A login web view follows redirects wherever Core sends it,
    /// so "some cookie named hosty_session exists" is not the same question as "this host issued a session".
    public static func session(in cookies: [HTTPCookie], for origin: HostOrigin) -> String? {
        cookies.first { cookie in
            cookie.name == sessionName
                && !cookie.value.isEmpty
                && domainMatches(cookie.domain, host: origin.host)
        }?.value
    }

    /// Cookie-domain matching, narrowed to what this app needs.
    ///
    /// A host-only cookie (no `Domain` attribute, which is what Core sets) must equal the host exactly. A
    /// domain cookie (`.example.com`) matches that domain and its subdomains. Deliberately *not*
    /// implemented: any notion of a public suffix — this only ever runs against a host the operator typed.
    static func domainMatches(_ cookieDomain: String, host: String) -> Bool {
        // `HostOrigin.host` keeps the brackets an IPv6 literal needs in a URL; a cookie domain has none.
        let host = host.lowercased().trimmingCharacters(in: CharacterSet(charactersIn: "[]"))
        let cookieDomain = cookieDomain.lowercased()

        guard cookieDomain.hasPrefix(".") else {
            return cookieDomain == host
        }

        return host == cookieDomain.dropFirst() || host.hasSuffix(cookieDomain)
    }
}
