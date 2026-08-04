import Foundation

/// `POST /api/auth/device/code` — the start of the device authorization flow.
///
/// The two device routes are the only unauthenticated ones Core added for access tokens, because the
/// caller has no credential yet: that is the whole point. What comes back is a code to show a human and
/// a code to poll with, and the two are not interchangeable — see `DeviceLoginPoller`.
public struct DeviceAuthorization: Hashable, Sendable, Codable {
    /// The polling secret. Never shown, never logged: anything holding it collects the credential.
    public let deviceCode: String

    /// The eight characters the operator reads and approves. Core picks them from an alphabet with no
    /// `0/O`, `1/I/L`, `5/S` or `2/Z`, because they are read off a small screen.
    public let userCode: String

    /// Where the code is approved — Shell's Access tokens tab. **Null when the host has no Shell**, which
    /// is not an error: the approval surface is Shell's, so a host without one has nowhere to send anyone.
    public let verificationUri: String?

    public let intervalSeconds: Int
    public let expiresInSeconds: Int

    public init(
        deviceCode: String,
        userCode: String,
        verificationUri: String?,
        intervalSeconds: Int,
        expiresInSeconds: Int
    ) {
        self.deviceCode = deviceCode
        self.userCode = userCode
        self.verificationUri = verificationUri
        self.intervalSeconds = intervalSeconds
        self.expiresInSeconds = expiresInSeconds
    }

    /// The user code as a person reads it back: `ABCD-EFGH`. Core stores it unhyphenated and formats it
    /// the same way in Shell's pending list, so both screens show the same shape.
    public var formattedUserCode: String {
        guard userCode.count == 8 else { return userCode }

        let middle = userCode.index(userCode.startIndex, offsetBy: 4)
        return "\(userCode[userCode.startIndex..<middle])-\(userCode[middle...])"
    }

    /// The approval page, but only when it is a web address.
    ///
    /// `verificationUri` is a string the *host* chose, and this app is about to send its operator there.
    /// Anything that is not `http`/`https` — a `file:`, a custom scheme belonging to some other app — is
    /// not opened at all; the code is still shown, and it can still be approved from a browser the
    /// operator opened themselves.
    public var approvalURL: URL? {
        guard let verificationUri,
              let url = URL(string: verificationUri),
              let scheme = url.scheme?.lowercased(),
              scheme == "http" || scheme == "https" else {
            return nil
        }

        return url
    }

    /// How long this request has left, from the moment it was created.
    public var lifetime: TimeInterval { TimeInterval(expiresInSeconds) }

    /// The gap Core asks the device to leave between polls. Never shorter than a second, whatever the
    /// host reported: a zero or negative interval would turn the loop into a busy wait against it.
    public var pollInterval: Duration { .seconds(max(1, intervalSeconds)) }
}

/// What `POST /api/auth/device/token` answers, as Core sends it.
struct DeviceAuthorizationToken: Sendable, Codable {
    let status: String
    let token: String?
}

/// The end of a device login, or the fact that it has not ended yet.
public enum DeviceLoginOutcome: Hashable, Sendable {
    /// Approved, and this is the credential — an access token, presented exactly like a session id.
    case approved(String)
    /// Someone with a session said no.
    case denied
    /// Nobody answered within the request's ten minutes, or Core forgot it in a restart. Start over.
    case expired

    init?(status: String, token: String?) {
        switch status {
        case "approved":
            // An approval with no token is not an approval. Collecting it again would answer `expired`,
            // so treating this as success would store an empty credential and never recover.
            guard let token, !token.isEmpty else { return nil }
            self = .approved(token)
        case "denied":
            self = .denied
        case "expired":
            self = .expired
        default:
            return nil
        }
    }
}

/// Polls one device authorization request until Core answers something final.
///
/// Separated from the view because the rules are not about SwiftUI: honour the interval Core asked for,
/// stop on any final answer, keep going through a Core that is briefly unavailable — the operator is in
/// their browser and a restart mid-approval must not throw away the request — and stop when the sheet
/// that owns it goes away, which is ordinary task cancellation.
public struct DeviceLoginPoller: Sendable {
    private let client: CoreClient
    private let authorization: DeviceAuthorization
    private let sleep: @Sendable (Duration) async throws -> Void

    public init(
        client: CoreClient,
        authorization: DeviceAuthorization,
        sleep: @escaping @Sendable (Duration) async throws -> Void = { try await Task.sleep(for: $0) }
    ) {
        self.client = client
        self.authorization = authorization
        self.sleep = sleep
    }

    /// Runs until Core answers approved, denied, or expired.
    ///
    /// A transient failure is not an answer: a 5xx, a Core mid-restart, or a network blip is retried on
    /// the same schedule. Anything else — a 404 from a host without these routes, a body that will not
    /// decode — is thrown, because repeating it would only produce the same failure until the request
    /// expires.
    public func run() async throws -> DeviceLoginOutcome {
        // A local backstop for the case where Core stops answering `expired` because it no longer
        // remembers the request at all (pending requests live in memory, and a restart drops them).
        // Without it the loop would keep polling a code that can never be approved.
        let deadline = ContinuousClock.now.advanced(by: .seconds(authorization.expiresInSeconds))

        while !Task.isCancelled {
            do {
                if let outcome = try await client.pollDeviceToken(deviceCode: authorization.deviceCode) {
                    return outcome
                }
            } catch let error as CoreError where error.isTransient {
                // Keep waiting. The operator is mid-approval in a browser; a host that blinks must not
                // cost them the request.
            }

            guard ContinuousClock.now < deadline else {
                return .expired
            }

            try await sleep(authorization.pollInterval)
        }

        throw CancellationError()
    }
}
