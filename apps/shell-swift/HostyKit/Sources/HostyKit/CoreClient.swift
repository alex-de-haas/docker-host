import Foundation

#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

extension URLSessionConfiguration {
    /// The configuration every Core client uses.
    ///
    /// Cookie handling is **off**, and that is the design rather than a detail. Cookies are not isolated by
    /// port (RFC 6265), so `http://10.0.0.5:7070` and `http://10.0.0.5:7071` share one jar — two Hosty
    /// hosts on a single machine would overwrite each other's sessions. The client attaches its credential
    /// explicitly on every request instead, and Core accepts it as a bearer.
    public static var hosty: URLSessionConfiguration {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpShouldSetCookies = false
        configuration.httpCookieAcceptPolicy = .never
        configuration.httpCookieStorage = nil
        configuration.timeoutIntervalForRequest = 30
        return configuration
    }
}

/// Talks to one Hosty Core.
///
/// An actor because the credential is mutable shared state: a 401 on any in-flight request can clear it
/// while others are still running.
public actor CoreClient {
    /// Core sends `: ping` every 20 seconds on an idle event stream. The stream's idle timeout has to clear
    /// that comfortably, or a quiet host looks like a dropped connection and the client reconnects forever.
    static let eventStreamTimeout: TimeInterval = 60

    public let origin: HostOrigin

    private let session: URLSession
    private let decoder = JSONDecoder.core
    private var sessionID: String?

    public init(
        origin: HostOrigin,
        sessionID: String? = nil,
        configuration: URLSessionConfiguration = .hosty
    ) {
        self.origin = origin
        self.sessionID = sessionID
        self.session = URLSession(configuration: configuration)
    }

    public var isAuthenticated: Bool { sessionID != nil }

    public func setSessionID(_ id: String?) {
        sessionID = id
    }

    // MARK: - Status and session

    /// Public probe: confirms a Hosty Core answers at this origin. Needs no credential.
    public func status() async throws -> CoreStatus {
        try await get("/api/core/status", authenticated: false)
    }

    public func authSession() async throws -> AuthSession {
        try await get("/api/auth/session")
    }

    public func logout() async throws {
        _ = try await send(makeRequest(.post, "/api/auth/logout"))
        sessionID = nil
    }

    // MARK: - Apps

    public func apps() async throws -> AppsResponse {
        try await get("/api/apps")
    }

    public func start(appID: String) async throws {
        try await lifecycle(appID: appID, verb: "start")
    }

    public func stop(appID: String) async throws {
        try await lifecycle(appID: appID, verb: "stop")
    }

    public func restart(appID: String) async throws {
        try await lifecycle(appID: appID, verb: "restart")
    }

    private func lifecycle(appID: String, verb: String) async throws {
        _ = try await send(makeRequest(.post, "/api/apps/\(escape(appID))/\(verb)"))
    }

    // MARK: - Display assets

    /// Fetches one of an app's manifest-declared display assets — in practice, its icon.
    ///
    /// Core reports the address in one of two shapes, and which one it is decides the credential. A
    /// manifest-relative icon is vendored into the app's folder and served from *this* host
    /// (`/api/apps/{id}/assets/{path}?v=<version>`), authorized by the session like any other app read; an
    /// absolute `https://` icon points somewhere else entirely, and that somewhere is not given this host's
    /// session id because an app author chose to host their icon on a CDN.
    ///
    /// This is also why an icon cannot simply be handed to `AsyncImage`: the relative form needs a bearer
    /// header, and an image view has nowhere to put one.
    public func asset(at url: String) async throws -> Data {
        // Resolved against the origin rather than assembled from a path, so the relative form keeps its
        // cache-busting query — `origin.url(path:)` would percent-encode the `?` into the path itself.
        guard let resolved = URL(string: url, relativeTo: origin.url)?.absoluteURL,
              let scheme = resolved.scheme?.lowercased(),
              scheme == "http" || scheme == "https" else {
            throw CoreError.invalidResponse("The host reported an asset address this app cannot read: \(url)")
        }

        var request = URLRequest(url: resolved)
        if isSameOrigin(resolved), let sessionID {
            request.setValue("Bearer \(sessionID)", forHTTPHeaderField: "Authorization")
        }

        return try await send(request)
    }

    /// Whether this host serves the URL, which is what decides whether the session travels with it.
    /// Compared through `HostOrigin` rather than field by field so both sides get the same normalization:
    /// default ports, letter case, and IPv6 brackets.
    private func isSameOrigin(_ url: URL) -> Bool {
        (try? HostOrigin(parsing: url.absoluteString)) == origin
    }

    // MARK: - Updates

    public func updateStatus(appID: String, refresh: Bool = false) async throws -> AppUpdateStatus {
        try await get(
            "/api/apps/\(escape(appID))/update-status",
            queryItems: refresh ? [URLQueryItem(name: "refresh", value: "true")] : [])
    }

    public func triggerFleetUpdateCheck() async throws -> AppUpdateCheckTrigger {
        try await decode(send(makeRequest(.post, "/api/apps/update-check")))
    }

    /// Builds (and caches) the reviewed plan. The digest it returns is what an apply must echo back.
    public func buildUpdatePlan(appID: String) async throws -> AppUpdatePlan {
        var request = makeRequest(.post, "/api/apps/\(escape(appID))/update/plan")

        // Core binds a non-optional `AppUpdatePlanRequest` from the body, so a POST with no body and no
        // content type is rejected by model binding before the handler ever runs. Every field on that
        // record is optional, so an empty object is exactly "use the defaults" — but it has to be sent.
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = Data("{}".utf8)

        return try decode(await send(request))
    }

    public func pendingUpdatePlan(appID: String) async throws -> AppUpdatePlan? {
        let response: AppPendingUpdatePlan = try await get("/api/apps/\(escape(appID))/update/plan")
        return response.plan
    }

    /// Applies a plan the operator has seen. Core requires the reviewed digest, and returns as soon as the
    /// apply is enqueued — progress shows up as `operationStatus: "updating"` on the app record.
    public func applyUpdate(appID: String, planDigest: String) async throws {
        var request = makeRequest(.post, "/api/apps/\(escape(appID))/update")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(["planDigest": planDigest])
        _ = try await send(request)
    }

    // MARK: - Core updates

    /// `refresh` bypasses Core's TTL cache — the operator's explicit "check now", not something to do
    /// on every appearance.
    public func coreUpdateStatus(refresh: Bool = false) async throws -> CoreUpdateStatus {
        try await get(
            "/api/core/update-status",
            queryItems: refresh ? [URLQueryItem(name: "refresh", value: "true")] : [])
    }

    /// Starts the Core self-update. Returns as soon as Core has spawned the CLI; Core then restarts
    /// itself, so the caller must expect its next requests to fail while that happens. See
    /// `CoreUpdateAcknowledgement`.
    public func applyCoreUpdate() async throws -> CoreUpdateAcknowledgement {
        try decode(await send(makeRequest(.post, "/api/core/update")))
    }

    // MARK: - Opening an app

    /// Mints a one-time code for `redirectUri` and returns the URL carrying it.
    ///
    /// Core requires CSRF on this endpoint for a cookie session; a bearer-presented session is exempt,
    /// and this client only ever presents a bearer, so no CSRF pair is involved.
    ///
    /// The redirect URI must be same-origin with one of the app's declared endpoints or Core answers
    /// `redirect_uri_denied` — which is why callers pass a URL that came from Core (`embeddedUrl` or a
    /// navigation page) rather than one they assembled.
    public func createLaunchCode(appID: String, redirectURI: String) async throws -> AppLaunchCode {
        var request = makeRequest(.post, "/api/apps/\(escape(appID))/launch-code")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(["redirectUri": redirectURI])
        return try decode(await send(request))
    }

    // MARK: - Events

    /// The URL and headers for the event stream, so `CoreEventStream` can own the connection lifecycle
    /// without reaching into the client's credential.
    func eventStreamRequest() -> URLRequest {
        var request = makeRequest(.get, "/api/events")
        request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        request.timeoutInterval = Self.eventStreamTimeout
        return request
    }

    func bytes(for request: URLRequest) async throws -> (URLSession.AsyncBytes, HTTPURLResponse) {
        do {
            let (bytes, response) = try await session.bytes(for: request)
            guard let http = response as? HTTPURLResponse else {
                throw CoreError.invalidResponse("The host did not answer with HTTP.")
            }

            guard (200..<300).contains(http.statusCode) else {
                let error = CoreError.from(status: http.statusCode, payload: nil)

                // Same rule as `send`: a 401 on a request that presented the credential means that
                // credential is finished, wherever it was noticed. The event stream reconnects on its own,
                // so without this it would keep presenting a dead session forever and nothing else would
                // ever be told.
                if error.requiresSignIn, presentsCredential(request) {
                    sessionID = nil
                }

                throw error
            }

            return (bytes, http)
        } catch let error as URLError {
            throw CoreError.transport(error)
        }
    }

    // MARK: - Plumbing

    private enum Method: String {
        case get = "GET"
        case post = "POST"
    }

    private func makeRequest(_ method: Method, _ path: String, queryItems: [URLQueryItem] = []) -> URLRequest {
        var request = URLRequest(url: origin.url(path: path, queryItems: queryItems))
        request.httpMethod = method.rawValue
        request.setValue("application/json", forHTTPHeaderField: "Accept")

        // The credential is attached here and nowhere else. Core reads it as a bearer session; no CSRF pair
        // is needed, because a header this client sets cannot be produced by a cross-origin page.
        if let sessionID {
            request.setValue("Bearer \(sessionID)", forHTTPHeaderField: "Authorization")
        }

        return request
    }

    private func get<T: Decodable>(
        _ path: String,
        queryItems: [URLQueryItem] = [],
        authenticated: Bool = true
    ) async throws -> T {
        var request = makeRequest(.get, path, queryItems: queryItems)
        if !authenticated {
            request.setValue(nil, forHTTPHeaderField: "Authorization")
        }

        return try decode(await send(request))
    }

    private func send(_ request: URLRequest) async throws -> Data {
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch let error as URLError {
            throw CoreError.transport(error)
        }

        guard let http = response as? HTTPURLResponse else {
            throw CoreError.invalidResponse("The host did not answer with HTTP.")
        }

        guard (200..<300).contains(http.statusCode) else {
            // Core answers errors as {code, message}, but a proxy in front of it may not, so a body that
            // will not decode is not itself an error — the status still carries the meaning.
            let error = CoreError.from(
                status: http.statusCode,
                payload: try? decoder.decode(CoreErrorPayload.self, from: data))

            // A 401 on a request that presented the credential means that credential is finished —
            // expired, revoked, or from a Core that has since forgotten it. Dropping it here, rather than
            // at each call site, keeps "signed out" from depending on which concurrent request happened to
            // notice first. A 403 is deliberately left alone: the session is valid and the answer is still
            // no, so discarding it would send the operator back through a sign-in that changes nothing.
            if error.requiresSignIn, presentsCredential(request) {
                sessionID = nil
            }

            throw error
        }

        return data
    }

    /// Whether the request actually offered this client's credential.
    ///
    /// A 401 only condemns the session when the session was presented. Two requests here never present
    /// it: the public status probe, and an off-host asset — a manifest icon on a CDN, which may sit behind
    /// an auth wall or a signed URL that has expired. Their 401s say nothing about Core, and acting on one
    /// would sign the operator out of a host that never complained.
    private func presentsCredential(_ request: URLRequest) -> Bool {
        request.value(forHTTPHeaderField: "Authorization") != nil
    }

    private func decode<T: Decodable>(_ data: Data) throws -> T {
        do {
            return try decoder.decode(T.self, from: data)
        } catch {
            throw CoreError.invalidResponse("The host sent a \(T.self) this app could not read: \(error)")
        }
    }

    private func escape(_ component: String) -> String {
        component.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? component
    }
}
