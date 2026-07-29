import Foundation

/// `GET /api/core/status` — public, and the probe that confirms an address is really a Hosty host.
///
/// The endpoint is unauthenticated and, under cloudflared, published at `core.<domain>`, so Core redacts
/// most of it for an anonymous caller: `dataRoot` and `listenUrl` come back empty and `corePort` as `0`.
/// Only `status`, `component`, `version`, `warnings`, and `serverTime` are meaningful before signing in,
/// which is exactly enough to answer "is a Hosty host here, and which version?".
public struct CoreStatus: Sendable, Codable {
    public let status: String
    public let component: String
    public let version: String

    /// Redacted to `0` for an anonymous caller. Do not use it to reach the host — the operator's typed
    /// origin is the only address that matters.
    public let corePort: Int?

    public let corePublicOrigin: String?
    public let shellPublicOrigin: String?
    public let ingressProvider: String?
    public let warnings: [String]?
    public let serverTime: Date?

    /// The exact value Core reports for itself (`HostyCoreApplication.cs`). Not "core": anything else
    /// answering at the address is not a Hosty host, however well-formed its JSON.
    public static let componentName = "hosty-core"

    public var isHostyCore: Bool { component == Self.componentName }
}

/// `GET /api/auth/session`.
public struct AuthSession: Sendable, Codable {
    public let authenticated: Bool
    public let user: HostUser?
}

public struct HostUser: Identifiable, Hashable, Sendable, Codable {
    public let id: String
    public let email: String?
    public let displayName: String?
    public let role: String
    public let disabled: Bool

    /// Installed Apps, every lifecycle verb, and every update endpoint are administrator-only. A signed-in
    /// non-administrator gets an explicit "not an administrator" screen rather than an empty list.
    public var isAdmin: Bool { role == "host.admin" }

    public var name: String { displayName ?? email ?? id }
}
