import Foundation
import Testing

@testable import HostyKit

@Suite("HostOrigin parsing")
struct HostOriginParsingTests {
    @Test("A bare host:port gets http:// and keeps its port")
    func bareHostAndPort() throws {
        let origin = try HostOrigin(parsing: "192.168.1.50:7070")

        #expect(origin.scheme == "http")
        #expect(origin.host == "192.168.1.50")
        #expect(origin.port == 7070)
        #expect(origin.url.absoluteString == "http://192.168.1.50:7070")
    }

    @Test("A bare host with no port is accepted")
    func bareHost() throws {
        let origin = try HostOrigin(parsing: "hosty.local")

        #expect(origin.scheme == "http")
        #expect(origin.host == "hosty.local")
        #expect(origin.port == nil)
    }

    @Test("An explicit https scheme is preserved")
    func explicitScheme() throws {
        let origin = try HostOrigin(parsing: "https://hosty.example.com")

        #expect(origin.isSecure)
        #expect(origin.url.absoluteString == "https://hosty.example.com")
    }

    @Test("Path, query, and fragment are discarded")
    func extraComponentsDiscarded() throws {
        let origin = try HostOrigin(parsing: "http://10.0.0.5:7070/dashboard?tab=apps#top")

        #expect(origin.url.absoluteString == "http://10.0.0.5:7070")
    }

    @Test("A trailing slash is not part of the origin")
    func trailingSlash() throws {
        let origin = try HostOrigin(parsing: "http://10.0.0.5:7070/")

        #expect(origin.url.absoluteString == "http://10.0.0.5:7070")
    }

    @Test("Scheme and host are lowercased")
    func caseNormalized() throws {
        let origin = try HostOrigin(parsing: "HTTP://Hosty.Example.COM:7070")

        #expect(origin.scheme == "http")
        #expect(origin.host == "hosty.example.com")
    }

    @Test("Surrounding whitespace is ignored")
    func whitespaceTrimmed() throws {
        let origin = try HostOrigin(parsing: "  10.0.0.5:7070\n")

        #expect(origin.url.absoluteString == "http://10.0.0.5:7070")
    }

    @Test("A default port is dropped so it cannot make one origin look like two")
    func defaultPortsDropped() throws {
        #expect(try HostOrigin(parsing: "http://hosty.example.com:80").port == nil)
        #expect(try HostOrigin(parsing: "https://hosty.example.com:443").port == nil)
        #expect(try HostOrigin(parsing: "http://hosty.example.com:443").port == 443)
    }

    @Test("An IPv6 literal keeps the brackets a URL needs")
    func ipv6Literal() throws {
        let origin = try HostOrigin(parsing: "http://[::1]:7070")

        #expect(origin.host == "[::1]")
        #expect(origin.url.absoluteString == "http://[::1]:7070")
        #expect(origin.url(path: "/api/apps").absoluteString == "http://[::1]:7070/api/apps")
    }
}

@Suite("HostOrigin candidates")
struct HostOriginCandidateTests {
    // Guessing http:// for a public name is the worst of the two guesses: App Transport Security refuses
    // the cleartext request and reports a TLS policy error, which tells the operator nothing about adding
    // https://. A LAN address has the opposite need. Neither can be guessed, so both are tried.
    @Test("With no scheme, https is offered before http")
    func bothSchemesOffered() throws {
        let candidates = try HostOrigin.candidates(for: "core.example.com")

        #expect(candidates.map(\.url.absoluteString) == [
            "https://core.example.com",
            "http://core.example.com",
        ])
    }

    @Test("A port survives into both candidates")
    func portPreserved() throws {
        let candidates = try HostOrigin.candidates(for: "192.168.1.50:7070")

        #expect(candidates.map(\.url.absoluteString) == [
            "https://192.168.1.50:7070",
            "http://192.168.1.50:7070",
        ])
    }

    @Test("A typed scheme is obeyed, not second-guessed")
    func explicitSchemeWins() throws {
        #expect(try HostOrigin.candidates(for: "http://10.0.0.5:7070").map(\.url.absoluteString)
            == ["http://10.0.0.5:7070"])
        #expect(try HostOrigin.candidates(for: "https://core.example.com").map(\.url.absoluteString)
            == ["https://core.example.com"])
    }

    @Test("An empty address is still rejected")
    func rejectsEmpty() {
        #expect(throws: HostOriginError.empty) { try HostOrigin.candidates(for: "  ") }
    }
}

@Suite("HostOrigin rejection")
struct HostOriginRejectionTests {
    @Test("An empty or whitespace-only address is rejected")
    func empty() {
        #expect(throws: HostOriginError.empty) { try HostOrigin(parsing: "") }
        #expect(throws: HostOriginError.empty) { try HostOrigin(parsing: "   ") }
    }

    @Test("A non-HTTP scheme is rejected by name")
    func unsupportedScheme() {
        #expect(throws: HostOriginError.unsupportedScheme("ftp")) {
            try HostOrigin(parsing: "ftp://hosty.example.com")
        }
    }

    @Test("An address with no host is rejected")
    func missingHost() {
        #expect(throws: HostOriginError.missingHost) { try HostOrigin(parsing: "http:///dashboard") }
    }

    @Test("Every rejection carries a message fit to show a person")
    func errorsAreDescribed() {
        let errors: [HostOriginError] = [
            .empty, .malformed, .missingHost, .unsupportedScheme("ftp"), .invalidPort(0),
        ]

        for error in errors {
            #expect(error.errorDescription?.isEmpty == false)
        }
    }
}

@Suite("HostOrigin identity")
struct HostOriginIdentityTests {
    // The reason this type exists. Cookies are not isolated by port (RFC 6265), so two Hosty hosts
    // on one address are indistinguishable to a cookie jar — every credential the client holds is
    // keyed by HostOrigin instead, and that only works if the port is part of identity.
    @Test("Two hosts that differ only by port are different origins")
    func portIsPartOfIdentity() throws {
        let first = try HostOrigin(parsing: "http://10.0.0.5:7070")
        let second = try HostOrigin(parsing: "http://10.0.0.5:7071")

        #expect(first != second)
        #expect(first.hashValue != second.hashValue)
    }

    @Test("The same host written two ways is one origin")
    func equivalentSpellings() throws {
        let typed = try HostOrigin(parsing: "10.0.0.5:7070")
        let full = try HostOrigin(parsing: "HTTP://10.0.0.5:7070/")

        #expect(typed == full)
    }

    @Test("Request URLs are built under the origin, port included")
    func requestURLs() throws {
        let origin = try HostOrigin(parsing: "10.0.0.5:7070")

        #expect(origin.url(path: "/api/apps").absoluteString == "http://10.0.0.5:7070/api/apps")
        #expect(origin.url(path: "api/apps").absoluteString == "http://10.0.0.5:7070/api/apps")
        #expect(
            origin.url(path: "/api/apps/demo/update-status", queryItems: [.init(name: "refresh", value: "true")])
                .absoluteString == "http://10.0.0.5:7070/api/apps/demo/update-status?refresh=true")
    }

    @Test("An origin survives a Codable round trip as its origin string")
    func codableRoundTrip() throws {
        let origin = try HostOrigin(parsing: "10.0.0.5:7070")
        let encoded = try JSONEncoder().encode(origin)

        #expect(String(decoding: encoded, as: UTF8.self) == "\"http:\\/\\/10.0.0.5:7070\"")
        #expect(try JSONDecoder().decode(HostOrigin.self, from: encoded) == origin)
    }

    @Test("Display names drop the scheme unless it is worth saying")
    func displayNames() throws {
        #expect(try HostOrigin(parsing: "10.0.0.5:7070").displayName == "10.0.0.5:7070")
        #expect(try HostOrigin(parsing: "hosty.local").displayName == "hosty.local")
        #expect(try HostOrigin(parsing: "https://hosty.example.com").displayName == "https://hosty.example.com")
    }
}
