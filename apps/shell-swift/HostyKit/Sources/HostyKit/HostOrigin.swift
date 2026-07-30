import Foundation

/// A validated Hosty Core origin — scheme, host, and port, with no path, query, or fragment.
///
/// Origins are typed by hand ("192.168.1.50:7070"), so parsing is lenient about what it accepts and
/// strict about what it stores: everything downstream builds request URLs from a `HostOrigin`, and
/// a host that lost its port would quietly point at the wrong Hosty.
public struct HostOrigin: Hashable, Sendable {
    /// Lowercased, always `http` or `https`.
    public let scheme: String

    /// Lowercased and URL-ready: an IPv6 literal keeps its brackets, because that is the form both
    /// `URLComponents` and a display string need.
    public let host: String

    /// `nil` when the origin uses its scheme's default port, so `http://h` and `http://h:80` are
    /// the same origin rather than two that merely behave alike.
    public let port: Int?

    /// The origin as a URL: scheme, host, port, and nothing else.
    public let url: URL

    public init(parsing raw: String) throws {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            throw HostOriginError.empty
        }

        // A bare "host:7070" is what people actually type. Handed to URLComponents as-is it parses
        // as scheme "host" with path "7070" — the port silently disappears, which is the one
        // failure this type must never allow: two Hosty hosts on one machine differ only by port.
        let candidate = trimmed.contains("://") ? trimmed : "http://\(trimmed)"

        guard let components = URLComponents(string: candidate), let rawScheme = components.scheme else {
            throw HostOriginError.malformed
        }

        let scheme = rawScheme.lowercased()
        guard scheme == "http" || scheme == "https" else {
            throw HostOriginError.unsupportedScheme(scheme)
        }

        guard let rawHost = components.host, !rawHost.isEmpty else {
            throw HostOriginError.missingHost
        }

        if let port = components.port, !(1...65_535).contains(port) {
            throw HostOriginError.invalidPort(port)
        }

        self.scheme = scheme
        self.host = Self.urlReadyHost(rawHost)
        self.port = components.port == Self.defaultPort(for: scheme) ? nil : components.port
        self.url = Self.buildURL(scheme: self.scheme, host: self.host, port: self.port, path: "", queryItems: [])
    }

    /// The origins to try for an address the operator typed, most likely first.
    ///
    /// A typed scheme is obeyed. Without one there is no good default: a LAN host is plain HTTP
    /// (`192.168.1.50:7070`), while a host published through a tunnel is HTTPS-only
    /// (`core.example.com`) — and guessing `http` there fails in the least helpful way possible, as App
    /// Transport Security refuses the cleartext request to a public name and reports a TLS policy error
    /// rather than "try https".
    ///
    /// So both are offered and the caller probes in order. HTTPS leads because guessing wrong that way is
    /// a fast connection refusal, whereas a wrong HTTP guess is an ATS wall.
    public static func candidates(for raw: String) throws -> [HostOrigin] {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            throw HostOriginError.empty
        }

        guard !trimmed.contains("://") else {
            return [try HostOrigin(parsing: trimmed)]
        }

        return [
            try HostOrigin(parsing: "https://\(trimmed)"),
            try HostOrigin(parsing: "http://\(trimmed)"),
        ]
    }

    /// How the origin is shown to a person: `192.168.1.50:7070`, `hosty.example.com`, `[::1]:7070`.
    /// The scheme is omitted unless it is `https`, which is the part worth calling out.
    public var displayName: String {
        let authority = port.map { "\(host):\($0)" } ?? host
        return scheme == "https" ? "https://\(authority)" : authority
    }

    public var isSecure: Bool {
        scheme == "https"
    }

    /// Does this origin's host name only ever mean "this machine"?
    ///
    /// The whole loopback space, not the one literal Core happens to default to: `localhost`, every
    /// address in `127.0.0.0/8`, and `[::1]`. A URL on any of them is correct exactly when the client
    /// runs on the Hosty host itself and points at the wrong computer everywhere else.
    public var isLoopback: Bool {
        Self.isLoopbackHost(host)
    }

    /// Can this client reach an app advertised at `urlString`?
    ///
    /// The one case that cannot work is a loopback app URL on a host this client did not itself reach
    /// over loopback: Core advertises `127.0.0.1:<port>` by default, which resolves to the reader's own
    /// machine rather than the host's. Every other combination is left alone — an unreachable LAN
    /// address or a misconfigured public origin is a runtime failure to observe, not something a
    /// predicate can rule out in advance.
    ///
    /// A URL that cannot be parsed is not reported as unreachable: opening it will fail on its own and
    /// say something truer than a guess made here.
    public func advertisesUnreachableLoopback(_ urlString: String?) -> Bool {
        guard !isLoopback else { return false }
        guard let urlString, let host = URLComponents(string: urlString)?.host else { return false }

        return Self.isLoopbackHost(Self.urlReadyHost(host))
    }

    private static func isLoopbackHost(_ host: String) -> Bool {
        if host == "localhost" || host == "[::1]" || host == "::1" {
            return true
        }

        // 127.0.0.0/8 in full: Core defaults to 127.0.0.1, but an operator may have set any of them,
        // and every one of them means the same thing.
        let octets = host.split(separator: ".", omittingEmptySubsequences: false)
        guard octets.count == 4, octets.first == "127" else { return false }

        return octets.allSatisfy { part in
            guard let value = Int(part), (0...255).contains(value) else { return false }
            return String(value) == part
        }
    }

    /// Builds a request URL under this origin.
    ///
    /// Paths come from call sites as literals, so a path that cannot form a URL is a programming
    /// error rather than a runtime condition to propagate.
    public func url(path: String, queryItems: [URLQueryItem] = []) -> URL {
        Self.buildURL(
            scheme: scheme,
            host: host,
            port: port,
            path: path.hasPrefix("/") ? path : "/\(path)",
            queryItems: queryItems)
    }

    private static func buildURL(
        scheme: String,
        host: String,
        port: Int?,
        path: String,
        queryItems: [URLQueryItem]
    ) -> URL {
        var components = URLComponents()
        components.scheme = scheme
        components.host = host
        components.port = port
        components.path = path
        if !queryItems.isEmpty {
            components.queryItems = queryItems
        }

        guard let url = components.url else {
            preconditionFailure("HostOrigin could not build a URL for path \(path)")
        }

        return url
    }

    private static func urlReadyHost(_ host: String) -> String {
        let lowered = host.lowercased()
        // URLComponents hands back an IPv6 literal without its brackets, and putting that straight
        // back into a URL produces "http://::1", which is not a URL at all.
        guard lowered.contains(":"), !lowered.hasPrefix("[") else {
            return lowered
        }

        return "[\(lowered)]"
    }

    private static func defaultPort(for scheme: String) -> Int {
        scheme == "https" ? 443 : 80
    }
}

extension HostOrigin: Codable {
    // Persisted as the origin string rather than as a record of its parts: stored connections stay
    // readable, and decoding re-runs the same validation as first-time entry.
    public init(from decoder: any Decoder) throws {
        let container = try decoder.singleValueContainer()
        try self.init(parsing: container.decode(String.self))
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(url.absoluteString)
    }
}

extension HostOrigin: CustomStringConvertible {
    public var description: String {
        url.absoluteString
    }
}

public enum HostOriginError: Error, Equatable, Sendable {
    case empty
    case malformed
    case missingHost
    case unsupportedScheme(String)
    case invalidPort(Int)
}

extension HostOriginError: LocalizedError {
    public var errorDescription: String? {
        switch self {
        case .empty:
            "Enter the address of your Hosty host."
        case .malformed:
            "That does not look like a valid address."
        case .missingHost:
            "The address is missing a host name."
        case .unsupportedScheme(let scheme):
            "Hosty needs an http:// or https:// address, not \(scheme)://."
        case .invalidPort(let port):
            "\(port) is not a valid port number."
        }
    }
}
