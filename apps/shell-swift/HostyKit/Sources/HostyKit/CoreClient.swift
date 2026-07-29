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
        try await decode(send(makeRequest(.post, "/api/apps/\(escape(appID))/update/plan")))
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
                throw CoreError.from(status: http.statusCode, payload: nil)
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

            // A 401 means this credential is finished — expired, revoked, or from a Core that has since
            // forgotten it. Dropping it here, rather than at each call site, keeps "signed out" from
            // depending on which concurrent request happened to notice first. A 403 is deliberately left
            // alone: the session is valid and the answer is still no, so discarding it would send the
            // operator back through a sign-in that changes nothing.
            if error.requiresSignIn {
                sessionID = nil
            }

            throw error
        }

        return data
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
