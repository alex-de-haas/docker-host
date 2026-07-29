import Foundation

/// A Hosty host this client knows about.
///
/// Identity is the `origin`, not the operator's label: two entries pointing at the same scheme, host, and
/// port are the same host however they are named. `HostOrigin` already treats the port as part of identity,
/// which is what keeps two Hosty hosts on one address apart.
public struct HostConnection: Identifiable, Hashable, Sendable, Codable {
    public var id: HostOrigin { origin }

    public let origin: HostOrigin

    /// An operator-chosen label. Nil means "call it what it is".
    public var name: String?

    public init(origin: HostOrigin, name: String? = nil) {
        self.origin = origin
        self.name = name?.trimmingCharacters(in: .whitespacesAndNewlines).nilWhenEmpty
    }

    public var displayName: String {
        name ?? origin.displayName
    }
}

extension String {
    var nilWhenEmpty: String? {
        isEmpty ? nil : self
    }
}
