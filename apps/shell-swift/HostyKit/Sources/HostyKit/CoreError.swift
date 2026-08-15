import Foundation

/// Core's error body: `{ "code": …, "message": … }`.
public struct CoreErrorPayload: Hashable, Sendable, Codable {
    public let code: String
    public let message: String
}

/// A failure talking to Core.
///
/// The three authenticated statuses mean genuinely different things and the client must not blur them
/// (see docs/features/auth-session-lifecycle/feature.md):
///
/// - **401** — the session is gone, expired, or revoked. Recoverable: sign in again.
/// - **403** — the session is fine and the answer is still no (not an administrator, disabled account, a
///   missing CSRF pair). Signing in again changes nothing, so offering it would be a lie.
/// - **503** — Core is temporarily unable, e.g. mid-restart. Retrying is the right move.
public enum CoreError: Error, Sendable {
    case unauthorized(CoreErrorPayload?)
    case forbidden(CoreErrorPayload?)
    case unavailable(CoreErrorPayload?)
    case http(status: Int, payload: CoreErrorPayload?)
    case transport(URLError)
    case invalidResponse(String)

    /// Whether the right recovery is to sign in again. True for 401 only — never for 403.
    public var requiresSignIn: Bool {
        if case .unauthorized = self { return true }
        return false
    }

    /// Whether the same request is worth repeating unchanged.
    public var isTransient: Bool {
        switch self {
        case .unavailable:
            true
        case .transport(let error):
            // Cancellation is a decision, not a fault; everything else here is a network condition that
            // can clear on its own.
            error.code != .cancelled
        case .http(let status, _):
            status >= 500
        case .unauthorized, .forbidden, .invalidResponse:
            false
        }
    }

    public var payload: CoreErrorPayload? {
        switch self {
        case .unauthorized(let payload), .forbidden(let payload), .unavailable(let payload):
            payload
        case .http(_, let payload):
            payload
        case .transport, .invalidResponse:
            nil
        }
    }

    static func from(status: Int, payload: CoreErrorPayload?) -> CoreError {
        switch status {
        case 401: .unauthorized(payload)
        case 403: .forbidden(payload)
        case 503: .unavailable(payload)
        default: .http(status: status, payload: payload)
        }
    }
}

extension CoreError: LocalizedError {
    public var errorDescription: String? {
        switch self {
        case .unauthorized(let payload):
            payload?.message ?? "Your session has expired. Sign in again."
        case .forbidden(let payload):
            payload?.message ?? "This host user is not allowed to do that."
        case .unavailable(let payload):
            payload?.message ?? "The host is busy. Try again in a moment."
        case .http(let status, let payload):
            payload?.message ?? "The host answered with status \(status)."
        case .transport(let error):
            error.localizedDescription
        case .invalidResponse(let detail):
            detail
        }
    }
}
