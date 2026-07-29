import Foundation

/// A Hosty platform version (`apps/core` + `apps/cli`, which share one version).
///
/// This client authenticates **only** with `Authorization: Bearer`, which Core learned to accept in
/// 0.70.0. Against an older host every request answers 401, so a sign-in appears to succeed — the cookie is
/// harvested — and then silently bounces back to the sign-in screen forever. Comparing versions up front
/// turns that loop into one sentence.
public struct PlatformVersion: Hashable, Sendable, Comparable, CustomStringConvertible {
    public let major: Int
    public let minor: Int
    public let patch: Int

    /// The first platform release whose Core accepts a session presented as a bearer token.
    public static let minimumSupported = PlatformVersion(0, 70, 0)

    public init(_ major: Int, _ minor: Int, _ patch: Int) {
        self.major = major
        self.minor = minor
        self.patch = patch
    }

    /// Parses `major.minor.patch`. A build or pre-release suffix (`0.70.0-rc.1`, `0.70.0+abc`) is ignored
    /// rather than rejected: it never changes which contract the host speaks.
    public init?(_ text: String) {
        let core = text
            .trimmingCharacters(in: .whitespaces)
            .prefix { $0 != "-" && $0 != "+" }

        let parts = core.split(separator: ".", omittingEmptySubsequences: false)
        guard (1...3).contains(parts.count) else {
            return nil
        }

        var numbers: [Int] = []
        for part in parts {
            guard let value = Int(part), value >= 0 else {
                return nil
            }

            numbers.append(value)
        }

        // A shortened version ("0.70") means the unnamed components are zero.
        self.init(numbers[0], numbers.count > 1 ? numbers[1] : 0, numbers.count > 2 ? numbers[2] : 0)
    }

    public var description: String { "\(major).\(minor).\(patch)" }

    public static func < (lhs: PlatformVersion, rhs: PlatformVersion) -> Bool {
        (lhs.major, lhs.minor, lhs.patch) < (rhs.major, rhs.minor, rhs.patch)
    }
}

extension CoreStatus {
    public var platformVersion: PlatformVersion? { PlatformVersion(version) }

    /// False when the host is too old to accept this client's bearer-presented session.
    ///
    /// An unparseable version is treated as **supported**: a version string this client cannot read is far
    /// more likely to be a newer scheme than an old host, and refusing to talk to a host over a parsing
    /// failure is the worse mistake.
    public var isSupportedVersion: Bool {
        guard let platformVersion else { return true }
        return platformVersion >= PlatformVersion.minimumSupported
    }
}
