import Foundation

/// Public proof handed off by an app document. The private verifier never enters native Shell.
public struct NativeAppSignIn: Hashable, Sendable {
    public let redirectURI: String
    public let state: String
    public let codeChallenge: String
    public let codeChallengeMethod: String
    public let inPlace: Bool

    public init(redirectURI: String, state: String, codeChallenge: String,
        codeChallengeMethod: String, inPlace: Bool = false) {
        self.redirectURI = redirectURI
        self.state = state
        self.codeChallenge = codeChallenge
        self.codeChallengeMethod = codeChallengeMethod
        self.inPlace = inPlace
    }

    /// Recognizes only the configured Core broker path, including malformed requests to cancel.
    public static func isBrokerNavigation(_ url: URL, appID: String, coreOrigin: HostOrigin) -> Bool {
        guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
              components.user == nil, components.password == nil,
              (try? HostOrigin(parsing: url.absoluteString)) == coreOrigin
        else { return false }
        return components.path == "/api/apps/\(appID)/open"
    }

    /// Both frames and the source origin are supplied by WebKit, never by navigation parameters.
    public static func parse(
        _ url: URL, appID: String, coreOrigin: HostOrigin, sourceOrigin: HostOrigin,
        approvedAppURLs: [String], sourceIsMainFrame: Bool, targetIsMainFrame: Bool
    ) -> NativeAppSignIn? {
        guard sourceIsMainFrame, targetIsMainFrame,
              isBrokerNavigation(url, appID: appID, coreOrigin: coreOrigin),
              let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
              components.fragment == nil
        else { return nil }
        let approvedOrigins = approvedAppURLs.compactMap { value -> HostOrigin? in
            guard let url = URL(string: value),
                  let parts = URLComponents(url: url, resolvingAgainstBaseURL: false),
                  ["http", "https"].contains(parts.scheme ?? ""), parts.host != nil,
                  parts.user == nil, parts.password == nil else { return nil }
            return try? HostOrigin(parsing: value)
        }
        guard approvedOrigins.contains(sourceOrigin) else { return nil }
        let items = components.queryItems ?? []
        let inPlace = items.contains { $0.name == "responseMode" && $0.value == "web_message" }
        let allowed = Set(["redirectUri", "state", "codeChallenge", "codeChallengeMethod"] +
            (inPlace ? ["responseMode"] : []))
        guard items.count == allowed.count, Set(items.map(\.name)) == allowed,
              let redirect = items.first(where: { $0.name == "redirectUri" })?.value,
              let state = items.first(where: { $0.name == "state" })?.value,
              let challenge = items.first(where: { $0.name == "codeChallenge" })?.value,
              items.first(where: { $0.name == "codeChallengeMethod" })?.value == "S256",
              state.count == 64, state.utf8.allSatisfy({ (48...57).contains($0) || (97...102).contains($0) }),
              isCanonicalChallenge(challenge),
              let callback = URL(string: redirect),
              let callbackParts = URLComponents(url: callback, resolvingAgainstBaseURL: false),
              ["http", "https"].contains(callbackParts.scheme ?? ""), callbackParts.host != nil,
              callbackParts.user == nil, callbackParts.password == nil, callbackParts.fragment == nil,
              (try? HostOrigin(parsing: redirect)) == sourceOrigin
        else { return nil }
        let callbackItems = callbackParts.queryItems ?? []
        let callbackStates = callbackItems.filter { $0.name == "state" }
        guard callbackStates.count == 1, callbackStates.first?.value == state,
              !callbackItems.contains(where: { ["code", "codeVerifier", "code_verifier"].contains($0.name) })
        else { return nil }
        return NativeAppSignIn(redirectURI: redirect, state: state, codeChallenge: challenge, codeChallengeMethod: "S256", inPlace: inPlace)
    }

    /// A confirmation login cannot silently switch an app away from the native host account.
    public static func acceptsRenewalSession(_ session: AuthSession, expectedUserID: String?) -> Bool {
        guard session.authenticated, let user = session.user, !user.disabled,
              let expectedUserID, !expectedUserID.isEmpty else { return false }
        return user.id == expectedUserID
    }

    public static func isCanonicalChallenge(_ value: String) -> Bool {
        guard value.count == 43,
              value.utf8.allSatisfy({ (65...90).contains($0) || (97...122).contains($0) ||
                  (48...57).contains($0) || $0 == 45 || $0 == 95 }),
              let bytes = Data(base64Encoded: value.replacingOccurrences(of: "-", with: "+")
                  .replacingOccurrences(of: "_", with: "/") + "="), bytes.count == 32
        else { return false }
        return bytes.base64EncodedString().replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "") == value
    }

    /// Core may append only the issued code to this exact callback; late/foreign callbacks are refused.
    public func accepts(_ launch: AppLaunchCode, now: Date = Date()) -> Bool {
        guard !launch.code.isEmpty, launch.expiresAt > now,
              var callback = URLComponents(string: launch.redirectUri),
              let expected = URLComponents(string: redirectURI)
        else { return false }
        let codes = (callback.queryItems ?? []).filter { $0.name == "code" }
        guard codes.count == 1, codes.first?.value == launch.code else { return false }
        callback.queryItems = (callback.queryItems ?? []).filter { $0.name != "code" }
        return callback == expected
    }
}

/// Per-web-view replay/throttle protection. Finishing does not make an attempt redeemable again.
public struct NativeSignInGate: Sendable {
    public private(set) var pendingState: String?
    public private(set) var documentGeneration: UInt64 = 0
    private var claimed: [String: Date] = [:]
    private var lastClaim: Date?
    public init() {}

    public mutating func claim(_ request: NativeAppSignIn, now: Date = Date()) -> Bool {
        claimed = claimed.filter { now.timeIntervalSince($0.value) < 300 }
        guard claimed[request.state] == nil, claimed.count < 16,
              lastClaim.map({ now.timeIntervalSince($0) >= 3 }) ?? true else { return false }
        claimed[request.state] = now
        lastClaim = now
        pendingState = request.state
        return true
    }

    public func isCurrent(_ request: NativeAppSignIn) -> Bool { pendingState == request.state }

    public func isCurrent(_ request: NativeAppSignIn, generation: UInt64) -> Bool {
        isCurrent(request) && documentGeneration == generation
    }

    public mutating func documentChanged() {
        documentGeneration &+= 1
        pendingState = nil
    }

    public mutating func finish(_ request: NativeAppSignIn) {
        if isCurrent(request) { pendingState = nil }
    }
}

/// Primary confirmations live only in this native workspace's memory until ordinary logout cleanup.
public struct NativeConfirmationSessions: Sendable {
    private var clients: [ObjectIdentifier: CoreClient] = [:]
    public init() {}

    public mutating func retain(_ client: CoreClient) {
        clients[ObjectIdentifier(client)] = client
    }

    public mutating func takeAll() -> [CoreClient] {
        let retained = Array(clients.values)
        clients.removeAll()
        return retained
    }
}
