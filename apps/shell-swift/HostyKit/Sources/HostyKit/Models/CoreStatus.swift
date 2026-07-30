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

/// `GET /api/core/update-status` — is a newer Core binary available on the selected release channel?
///
/// Administrator-only, like every Core update surface. `error` is set when the check itself could not
/// run (the release index was unreachable); that is not "up to date", and a client must not render it
/// as one.
public struct CoreUpdateStatus: Hashable, Sendable, Codable {
    public let currentVersion: String
    public let updateAvailable: Bool
    public let releaseTag: String
    public let checkedAt: Date
    public let error: String?

    /// Whether to offer the update action. A failed check is not an invitation to apply one.
    public var canApply: Bool { updateAvailable && (error ?? "").isEmpty }
}

/// `POST /api/core/update` — accepted, not finished.
///
/// Core answers `202` and then spawns the CLI, which replaces the binary and restarts Core. Everything
/// after that reads as a connection failure to a client that is still waiting, so the reply has to be
/// treated as "the work has started": the disconnect that follows is the update working, not an error.
/// The two ways it refuses before any work starts — `503` when the CLI cannot be located and `500`
/// when the spawn itself fails — are ordinary errors and must read differently.
public struct CoreUpdateAcknowledgement: Hashable, Sendable, Codable {
    public let status: String
    public let logFile: String?
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
