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

    public let offerId: String?
    public let operationId: String?
    public let readiness: String?

    /// A ready offer or an explicitly resumable operation is required; legacy verdicts stay read-only.
    public var canApply: Bool {
        guard let offerId, Self.validID(offerId) else { return false }
        return (updateAvailable && (error ?? "").isEmpty)
            || (readiness == "recovery-required" && operationId.map(Self.validID) == true)
    }

    public static func validID(_ value: String) -> Bool {
        value.utf8.count == 32 && value.utf8.allSatisfy { (48...57).contains($0) || (97...102).contains($0) }
    }
}

/// `POST /api/core/update` — accepted, not finished.
///
/// Core durably accepts the exact offer and request before spawning the updater. A 202 response is
/// not completion; read the operation until Core reports completed. A dropped response or preparation
/// error preserves the request identity for explicit recovery.
public struct CoreUpdateAcknowledgement: Hashable, Sendable, Codable {
    public let id: String?
    public let status: String
    public let releaseId: String?
    public let error: String?
    public let logFile: String?
}

/// Retain this exact request across uncertain transport outcomes and explicit retries.
public struct CoreUpdateAttempt: Hashable, Sendable, Encodable {
    public let offerId: String
    public let requestId: String

    public init(status: CoreUpdateStatus, requestID: UUID = UUID()) throws {
        guard status.canApply, let offerId = status.offerId else {
            throw CoreError.invalidResponse("Refresh Core update availability before applying an update.")
        }
        self.offerId = offerId
        self.requestId = status.operationId ?? requestID.uuidString.replacingOccurrences(of: "-", with: "").lowercased()
        guard CoreUpdateStatus.validID(self.requestId) else {
            throw CoreError.invalidResponse("Core returned an invalid update operation ID.")
        }
    }
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
