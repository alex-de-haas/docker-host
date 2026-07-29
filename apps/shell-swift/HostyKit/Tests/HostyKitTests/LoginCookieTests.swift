import Foundation
import Testing

@testable import HostyKit

@Suite("Login cookie extraction")
struct LoginCookieTests {
    private func cookie(name: String, value: String, domain: String, path: String = "/") throws -> HTTPCookie {
        try #require(HTTPCookie(properties: [
            .name: name,
            .value: value,
            .domain: domain,
            .path: path,
        ]))
    }

    @Test("The session cookie for the host is found")
    func findsSessionCookie() throws {
        let origin = try HostOrigin(parsing: "10.0.0.5:7070")
        let cookies = [
            try cookie(name: "hosty_csrf", value: "csrf-value", domain: "10.0.0.5"),
            try cookie(name: "hosty_session", value: "session-value", domain: "10.0.0.5"),
        ]

        #expect(LoginCookie.session(in: cookies, for: origin) == "session-value")
    }

    @Test("No session cookie yet means no session yet")
    func noSessionCookie() throws {
        let origin = try HostOrigin(parsing: "10.0.0.5:7070")
        let cookies = [try cookie(name: "hosty_csrf", value: "csrf-value", domain: "10.0.0.5")]

        #expect(LoginCookie.session(in: cookies, for: origin) == nil)
        #expect(LoginCookie.session(in: [], for: origin) == nil)
    }

    // A login web view follows Core's redirects wherever they go — including to a Shell public origin on a
    // different host. "A cookie named hosty_session exists" is not the same question as "this host issued
    // a session", and answering the wrong one would attach another host's credential to this connection.
    @Test("A session cookie from a different host is ignored")
    func ignoresOtherHosts() throws {
        let origin = try HostOrigin(parsing: "10.0.0.5:7070")
        let cookies = [try cookie(name: "hosty_session", value: "elsewhere", domain: "10.0.0.9")]

        #expect(LoginCookie.session(in: cookies, for: origin) == nil)
    }

    // Cookies ignore ports (RFC 6265), so the jar cannot tell two Hosty hosts on one machine apart. That is
    // exactly why the harvested value is stored per HostOrigin and sent explicitly afterwards, rather than
    // being left in a shared cookie jar to be attached automatically.
    @Test("A host differing only by port yields the same cookie, which is why cookies are not kept")
    func portIsInvisibleToCookies() throws {
        let sevenZeroSeventy = try HostOrigin(parsing: "10.0.0.5:7070")
        let sevenZeroSeventyOne = try HostOrigin(parsing: "10.0.0.5:7071")
        let cookies = [try cookie(name: "hosty_session", value: "shared", domain: "10.0.0.5")]

        #expect(LoginCookie.session(in: cookies, for: sevenZeroSeventy) == "shared")
        #expect(LoginCookie.session(in: cookies, for: sevenZeroSeventyOne) == "shared")
        #expect(sevenZeroSeventy != sevenZeroSeventyOne)
    }

    @Test("An empty cookie value is not a session")
    func emptyValue() throws {
        let origin = try HostOrigin(parsing: "10.0.0.5:7070")
        let cookies = [try cookie(name: "hosty_session", value: "", domain: "10.0.0.5")]

        #expect(LoginCookie.session(in: cookies, for: origin) == nil)
    }

    @Test("An IPv6 host matches despite the brackets the URL form needs")
    func ipv6Host() throws {
        let origin = try HostOrigin(parsing: "http://[::1]:7070")
        let cookies = [try cookie(name: "hosty_session", value: "v6", domain: "::1")]

        #expect(origin.host == "[::1]")
        #expect(LoginCookie.session(in: cookies, for: origin) == "v6")
    }

    @Suite("Domain matching")
    struct DomainMatching {
        @Test("A host-only cookie must match exactly")
        func hostOnly() {
            #expect(LoginCookie.domainMatches("hosty.example.com", host: "hosty.example.com"))
            #expect(!LoginCookie.domainMatches("hosty.example.com", host: "other.example.com"))
            #expect(!LoginCookie.domainMatches("example.com", host: "hosty.example.com"))
        }

        @Test("A domain cookie covers the domain and its subdomains")
        func domainCookie() {
            #expect(LoginCookie.domainMatches(".example.com", host: "example.com"))
            #expect(LoginCookie.domainMatches(".example.com", host: "hosty.example.com"))
            #expect(!LoginCookie.domainMatches(".example.com", host: "notexample.com"))
        }

        @Test("Matching ignores case")
        func caseInsensitive() {
            #expect(LoginCookie.domainMatches("Hosty.Example.COM", host: "hosty.example.com"))
        }
    }
}
