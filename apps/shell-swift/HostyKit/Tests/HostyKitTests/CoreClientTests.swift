import Foundation
import Testing

@testable import HostyKit

/// Intercepts requests so the client can be exercised without a host.
///
/// `@unchecked Sendable` with an explicit lock: `URLProtocol` is a Foundation class the runtime
/// instantiates, so its shared fixture state cannot be actor-isolated. The suites using it are
/// `.serialized` for the same reason.
final class StubURLProtocol: URLProtocol, @unchecked Sendable {
    struct Stub: Sendable {
        var status: Int = 200
        var body: Data = Data()
    }

    private static let lock = NSLock()
    nonisolated(unsafe) private static var stubs = [Stub()]
    nonisolated(unsafe) private static var recorded: [(request: URLRequest, body: Data?)] = []

    static func install(status: Int = 200, json: String = "{}") {
        install([Stub(status: status, body: Data(json.utf8))])
    }

    /// A reply per request, in order. The last one repeats once the sequence runs out, so a poll loop
    /// under test cannot run off the end of its fixture and start reading someone else's.
    static func install(_ sequence: [Stub]) {
        lock.withLock {
            stubs = sequence.isEmpty ? [Stub()] : sequence
            recorded = []
        }
    }

    static func stub(status: Int = 200, json: String) -> Stub {
        Stub(status: status, body: Data(json.utf8))
    }

    static var requests: [(request: URLRequest, body: Data?)] {
        lock.withLock { recorded }
    }

    static var configuration: URLSessionConfiguration {
        let configuration = URLSessionConfiguration.hosty
        configuration.protocolClasses = [StubURLProtocol.self]
        return configuration
    }

    override class func canInit(with request: URLRequest) -> Bool { true }

    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        // URLSession hands a POST body to URLProtocol as a stream, not as httpBody, so reading only the
        // latter would make every body assertion silently vacuous.
        let body = request.httpBody ?? request.httpBodyStream.map { stream in
            stream.open()
            defer { stream.close() }
            var data = Data()
            var buffer = [UInt8](repeating: 0, count: 1024)
            while stream.hasBytesAvailable {
                let read = stream.read(&buffer, maxLength: buffer.count)
                guard read > 0 else { break }
                data.append(buffer, count: read)
            }

            return data
        }

        let stub = Self.lock.withLock {
            let stub = Self.stubs.count > 1 ? Self.stubs.removeFirst() : Self.stubs[0]
            Self.recorded.append((request, body))
            return stub
        }

        let response = HTTPURLResponse(
            url: request.url!,
            statusCode: stub.status,
            httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"])!

        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: stub.body)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

/// Both nested suites drive the same `StubURLProtocol`, whose fixture state is necessarily static.
/// `.serialized` here is what keeps them apart: applied to a suite it orders that suite's own tests, and
/// it propagates to nested suites, so nothing sharing the stub ever runs concurrently with anything else
/// that does.
@Suite(.serialized)
struct CoreClientTests {
    @Suite("Core client requests")
    struct CoreClientRequestTests {
        private func client(sessionID: String? = "session_1") throws -> CoreClient {
            CoreClient(
                origin: try HostOrigin(parsing: "10.0.0.5:7070"),
                sessionID: sessionID,
                configuration: StubURLProtocol.configuration)
        }

        @Test("The session travels as a bearer header, never as a cookie")
        func bearerHeader() async throws {
            StubURLProtocol.install(json: #"{"apps": []}"#)

            _ = try await client().apps()

            let sent = try #require(StubURLProtocol.requests.first?.request)
            #expect(sent.value(forHTTPHeaderField: "Authorization") == "Bearer session_1")
            #expect(sent.value(forHTTPHeaderField: "Cookie") == nil)
            #expect(sent.url?.absoluteString == "http://10.0.0.5:7070/api/apps")
        }

        // The reason cookies are off at all. Two hosts differing only by port share a cookie jar (RFC 6265),
        // so a client that let URLSession manage cookies would cross their sessions.
        @Test("The session configuration stores and sends no cookies")
        func cookiesAreOff() {
            let configuration = URLSessionConfiguration.hosty

            #expect(configuration.httpShouldSetCookies == false)
            #expect(configuration.httpCookieAcceptPolicy == .never)
            #expect(configuration.httpCookieStorage == nil)
        }

        @Test("The status probe is unauthenticated, so an address can be checked before signing in")
        func statusIsPublic() async throws {
            StubURLProtocol.install(json: #"{"status":"ok","component":"hosty-core","version":"0.70.0","corePort":7070}"#)

            let status = try await client().status()

            #expect(status.isHostyCore)
            #expect(StubURLProtocol.requests.first?.request.value(forHTTPHeaderField: "Authorization") == nil)
        }

        @Test("Lifecycle verbs post to the app's own path and carry no CSRF token")
        func lifecycleVerbs() async throws {
            StubURLProtocol.install()
            try await client().start(appID: "com.haas.demo-app")
            try expectPostedTo("/api/apps/com.haas.demo-app/start")

            StubURLProtocol.install()
            try await client().stop(appID: "com.haas.demo-app")
            try expectPostedTo("/api/apps/com.haas.demo-app/stop")

            StubURLProtocol.install()
            try await client().restart(appID: "com.haas.demo-app")
            try expectPostedTo("/api/apps/com.haas.demo-app/restart")
        }

        private func expectPostedTo(_ path: String, sourceLocation: SourceLocation = #_sourceLocation) throws {
            let sent = try #require(StubURLProtocol.requests.first?.request, sourceLocation: sourceLocation)

            #expect(sent.httpMethod == "POST", sourceLocation: sourceLocation)
            #expect(sent.url?.path == path, sourceLocation: sourceLocation)
            // Bearer-presented sessions are CSRF-exempt in Core, so the client sends no double-submit pair.
            #expect(sent.value(forHTTPHeaderField: "X-Hosty-CSRF") == nil, sourceLocation: sourceLocation)
        }

        @Test("Applying an update sends the reviewed plan digest")
        func applyUpdateSendsDigest() async throws {
            StubURLProtocol.install()

            try await client().applyUpdate(appID: "demo", planDigest: "sha256:bbb")

            let sent = try #require(StubURLProtocol.requests.first)
            let body = try #require(sent.body)
            let decoded = try JSONDecoder().decode([String: String].self, from: body)

            #expect(sent.request.url?.path == "/api/apps/demo/update")
            #expect(decoded["planDigest"] == "sha256:bbb")
        }

        // Core binds a non-optional `AppUpdatePlanRequest` from the body, so a bodyless POST is rejected
        // by model binding before the handler runs — the review sheet would report an error every time
        // and no update could ever be applied. Every field on that record is optional, so `{}` is
        // "use the defaults", but it has to be sent with a content type.
        @Test("Building an update plan sends a JSON body, because Core requires one")
        func updatePlanSendsBody() async throws {
            StubURLProtocol.install(json: #"""
            {"appId":"demo","currentVersion":"1","targetVersion":"2","currentRuntime":"docker",
             "targetRuntime":"docker","manifestPath":"m","manifestDigest":"d","planDigest":"p",
             "willCreatePreUpdateBackup":false,"changes":[]}
            """#)

            _ = try await client().buildUpdatePlan(appID: "demo")

            let sent = try #require(StubURLProtocol.requests.first)
            #expect(sent.request.httpMethod == "POST")
            #expect(sent.request.url?.path == "/api/apps/demo/update/plan")
            #expect(sent.request.value(forHTTPHeaderField: "Content-Type") == "application/json")
            #expect(sent.body.map { String(decoding: $0, as: UTF8.self) } == "{}")
        }

        // The icon endpoint is session-authorized like any other app read, and the URL Core reports is
        // relative — including a `?v=` cache buster that must survive being turned into a request.
        @Test("A host-relative asset is fetched under the origin, with the session and its cache buster")
        func relativeAssetCarriesTheSession() async throws {
            StubURLProtocol.install(json: "<svg/>")

            _ = try await client().asset(at: "/api/apps/com.haas.shell/assets/icon.svg?v=0.46.0")

            let sent = try #require(StubURLProtocol.requests.first?.request)
            #expect(sent.url?.absoluteString == "http://10.0.0.5:7070/api/apps/com.haas.shell/assets/icon.svg?v=0.46.0")
            #expect(sent.value(forHTTPHeaderField: "Authorization") == "Bearer session_1")
        }

        // A manifest may point its icon at an absolute URL, which can be anywhere. A session id is not
        // something to hand to a third party because an app author put their artwork on a CDN.
        @Test("An off-host asset is fetched without the session")
        func absoluteAssetOmitsTheSession() async throws {
            StubURLProtocol.install(json: "<svg/>")

            _ = try await client().asset(at: "https://cdn.example.com/icons/app.png")

            let sent = try #require(StubURLProtocol.requests.first?.request)
            #expect(sent.url?.absoluteString == "https://cdn.example.com/icons/app.png")
            #expect(sent.value(forHTTPHeaderField: "Authorization") == nil)
        }

        // Same host, spelled differently: the default port is implied and the case differs. Both are this
        // origin, so both are authorized — a field-by-field comparison would have said otherwise.
        @Test("An absolute URL back to this host is recognized as this host")
        func absoluteSameOriginCarriesTheSession() async throws {
            StubURLProtocol.install(json: "<svg/>")

            let client = CoreClient(
                origin: try HostOrigin(parsing: "https://Core.Example.com"),
                sessionID: "session_1",
                configuration: StubURLProtocol.configuration)
            _ = try await client.asset(at: "https://core.example.com:443/api/apps/demo/assets/icon.svg")

            let sent = try #require(StubURLProtocol.requests.first?.request)
            #expect(sent.value(forHTTPHeaderField: "Authorization") == "Bearer session_1")
        }

        // A third-party icon URL can answer 401 for reasons of its own — an auth wall, an expired signed
        // URL. That request never presented the Hosty session, so it says nothing about it; treating it as
        // a dead Core session would sign the operator out of a host that never complained.
        @Test("A 401 from an off-host asset does not sign the operator out of Core")
        func offHostUnauthorizedKeepsTheSession() async throws {
            StubURLProtocol.install(status: 401, json: #"{"code":"unauthorized","message":"nope"}"#)

            let client = try client()
            _ = try? await client.asset(at: "https://cdn.example.com/icons/app.png")

            #expect(await client.isAuthenticated)
        }

        // The inverse, so the exemption above cannot quietly widen: the asset endpoint on this host is
        // session-authorized like any other app read, and its 401 is a dead session.
        @Test("A 401 from the host's own asset endpoint clears the credential")
        func sameOriginUnauthorizedClearsTheSession() async throws {
            StubURLProtocol.install(status: 401, json: #"{"code":"session_invalid","message":"gone"}"#)

            let client = try client()
            _ = try? await client.asset(at: "/api/apps/demo/assets/icon.svg")

            #expect(await client.isAuthenticated == false)
        }

        @Test("An asset address that is not a URL is rejected rather than requested")
        func unusableAssetAddress() async throws {
            StubURLProtocol.install()

            let client = try client()
            await #expect(throws: CoreError.self) { try await client.asset(at: "mailto:someone@example.com") }
            #expect(StubURLProtocol.requests.isEmpty)
        }

        @Test("A refresh is requested as a query item, and omitted otherwise")
        func updateStatusRefresh() async throws {
            let status = #"{"appId":"demo","runtime":"docker","runtimeType":"docker","updatePolicy":"pinned","updateAvailable":false,"services":[]}"#

            StubURLProtocol.install(json: status)
            _ = try await client().updateStatus(appID: "demo", refresh: true)
            #expect(StubURLProtocol.requests.first?.request.url?.query == "refresh=true")

            StubURLProtocol.install(json: status)
            _ = try await client().updateStatus(appID: "demo")
            #expect(StubURLProtocol.requests.first?.request.url?.query == nil)
        }

        @Test("A launch code posts the redirect URI as JSON and carries only the bearer")
        func launchCode() async throws {
            StubURLProtocol.install(json: #"""
            {"code":"abc","redirectUri":"http://127.0.0.1:3100/?code=abc","expiresAt":"2026-07-30T14:05:00Z"}
            """#)

            let launch = try await client().createLaunchCode(
                appID: "com.haas.demo-app",
                redirectURI: "http://127.0.0.1:3100/")

            #expect(launch.redirectUri == "http://127.0.0.1:3100/?code=abc")

            let sent = try #require(StubURLProtocol.requests.first)
            #expect(sent.request.httpMethod == "POST")
            #expect(sent.request.url?.path == "/api/apps/com.haas.demo-app/launch-code")
            #expect(sent.request.value(forHTTPHeaderField: "Content-Type") == "application/json")
            #expect(sent.request.value(forHTTPHeaderField: "Authorization") == "Bearer session_1")

            // Core requires CSRF for a cookie session and exempts a bearer one. This client only ever
            // presents a bearer, so a CSRF header appearing here would mean the credential path changed.
            #expect(sent.request.value(forHTTPHeaderField: "X-Hosty-CSRF") == nil)

            let body = try #require(sent.body)
            let decoded = try JSONDecoder().decode([String: String].self, from: body)
            #expect(decoded == ["redirectUri": "http://127.0.0.1:3100/"])
        }

        @Test("The Core update check reads the same refresh contract as the app one")
        func coreUpdateStatusRefresh() async throws {
            let status = #"""
            {"currentVersion":"0.70.1","updateAvailable":true,"releaseTag":"v0.71.0","checkedAt":"2026-07-30T14:00:00Z","error":null}
            """#

            StubURLProtocol.install(json: status)
            let verdict = try await client().coreUpdateStatus(refresh: true)
            #expect(verdict.canApply)
            #expect(verdict.releaseTag == "v0.71.0")
            #expect(StubURLProtocol.requests.first?.request.url?.path == "/api/core/update-status")
            #expect(StubURLProtocol.requests.first?.request.url?.query == "refresh=true")

            StubURLProtocol.install(json: status)
            _ = try await client().coreUpdateStatus()
            #expect(StubURLProtocol.requests.first?.request.url?.query == nil)
        }

        // A check that could not run is not "up to date", and the update action must not be offered
        // on the strength of a stale verdict beside an error.
        @Test("A failed Core update check is not an invitation to apply one")
        func coreUpdateStatusError() async throws {
            StubURLProtocol.install(json: #"""
            {"currentVersion":"0.70.1","updateAvailable":true,"releaseTag":"v0.71.0","checkedAt":"2026-07-30T14:00:00Z","error":"The release index was unreachable."}
            """#)

            let verdict = try await client().coreUpdateStatus()

            #expect(verdict.updateAvailable)
            #expect(!verdict.canApply)
        }

        // Core answers 202 and then restarts itself, so the reply means "started", not "finished".
        @Test("Applying a Core update is accepted, not completed")
        func applyCoreUpdateAccepted() async throws {
            StubURLProtocol.install(status: 202, json: #"{"status":"updating","logFile":"core-update.log"}"#)

            let acknowledgement = try await client().applyCoreUpdate()

            #expect(acknowledgement.status == "updating")
            #expect(acknowledgement.logFile == "core-update.log")
            #expect(StubURLProtocol.requests.first?.request.httpMethod == "POST")
            #expect(StubURLProtocol.requests.first?.request.url?.path == "/api/core/update")
        }

        // The two ways Core refuses before any work starts. They must not read like the connection
        // loss that a successful update causes — nothing has happened and retrying is pointless until
        // the host is fixed.
        @Test("A Core update that never starts reports a refusal, not a restart")
        func applyCoreUpdateRefused() async throws {
            StubURLProtocol.install(status: 503, json: #"{"code":"cli_not_found","message":"The Hosty CLI could not be located."}"#)
            await #expect(throws: CoreError.self) { try await client().applyCoreUpdate() }

            StubURLProtocol.install(status: 500, json: #"{"code":"spawn_failed","message":"The updater could not be started."}"#)
            await #expect(throws: CoreError.self) { try await client().applyCoreUpdate() }
        }
    }

    @Suite("Core client error mapping")
    struct CoreClientErrorTests {
        private func client(sessionID: String? = "session_1") throws -> CoreClient {
            CoreClient(
                origin: try HostOrigin(parsing: "10.0.0.5:7070"),
                sessionID: sessionID,
                configuration: StubURLProtocol.configuration)
        }

        @Test("401 maps to unauthorized and carries Core's message")
        func unauthorized() async throws {
            StubURLProtocol.install(status: 401, json: #"{"code":"session_invalid","message":"Core session is missing, expired, or revoked."}"#)

            let client = try client()
            await #expect(throws: CoreError.self) { try await client.apps() }

            do {
                _ = try await client.apps()
            } catch let error as CoreError {
                #expect(error.requiresSignIn)
                #expect(error.payload?.code == "session_invalid")
                #expect(!error.isTransient)
            }
        }

        // A dead credential is dropped once, centrally. Otherwise "am I signed in?" would depend on which of
        // several concurrent requests happened to notice the 401 first.
        @Test("A 401 clears the stored credential")
        func unauthorizedClearsCredential() async throws {
            StubURLProtocol.install(status: 401, json: #"{"code":"session_invalid","message":"gone"}"#)
            let client = try client()

            #expect(await client.isAuthenticated)
            _ = try? await client.apps()
            #expect(await client.isAuthenticated == false)
        }

        // The event stream reconnects on its own, so a 401 noticed there and not acted on would keep
        // presenting a dead session forever with nothing else ever being told.
        @Test("A 401 on the event stream clears the credential too")
        func unauthorizedStreamClearsCredential() async throws {
            StubURLProtocol.install(status: 401, json: #"{"code":"session_invalid","message":"gone"}"#)
            let client = try client()

            let request = await client.eventStreamRequest()
            await #expect(throws: CoreError.self) { _ = try await client.bytes(for: request) }

            #expect(await client.isAuthenticated == false)
        }

        // A 403 means the session is perfectly good and the answer is still no. Clearing it would send the
        // operator through a sign-in that cannot change the outcome.
        @Test("A 403 leaves the credential alone")
        func forbiddenKeepsCredential() async throws {
            StubURLProtocol.install(status: 403, json: #"{"code":"admin_required","message":"needs an admin"}"#)
            let client = try client()

            do {
                _ = try await client.apps()
                Issue.record("Expected a forbidden error")
            } catch let error as CoreError {
                #expect(!error.requiresSignIn)
                #expect(error.payload?.code == "admin_required")
            }

            #expect(await client.isAuthenticated)
        }

        @Test("503 is transient, so the caller knows retrying is the right move")
        func unavailable() async throws {
            StubURLProtocol.install(status: 503, json: #"{"code":"core_restarting","message":"Core is restarting."}"#)
            let client = try client()

            do {
                _ = try await client.apps()
                Issue.record("Expected an unavailable error")
            } catch let error as CoreError {
                #expect(error.isTransient)
                #expect(!error.requiresSignIn)
            }
        }

        // A proxy in front of Core answers with HTML, not {code,message}. The status still carries the meaning,
        // so an undecodable body must not turn into a confusing decoding failure.
        @Test("A non-JSON error body keeps the status meaningful")
        func nonJSONErrorBody() async throws {
            StubURLProtocol.install(status: 502, json: "<html>Bad Gateway</html>")
            let client = try client()

            do {
                _ = try await client.apps()
                Issue.record("Expected an http error")
            } catch let error as CoreError {
                guard case .http(let status, let payload) = error else {
                    Issue.record("Expected .http, got \(error)")
                    return
                }

                #expect(status == 502)
                #expect(payload == nil)
                #expect(error.isTransient)
            }
        }

        @Test("A success body that will not decode is reported as an unreadable response")
        func undecodableSuccess() async throws {
            StubURLProtocol.install(status: 200, json: #"{"unexpected": true}"#)
            let client = try client()

            do {
                _ = try await client.apps()
                Issue.record("Expected a decoding failure")
            } catch let error as CoreError {
                guard case .invalidResponse = error else {
                    Issue.record("Expected .invalidResponse, got \(error)")
                    return
                }

                #expect(!error.isTransient)
            }
        }

        @Test("Every error can be shown to a person")
        func errorsAreDescribed() {
            let errors: [CoreError] = [
                .unauthorized(nil),
                .forbidden(CoreErrorPayload(code: "admin_required", message: "Needs an administrator.")),
                .unavailable(nil),
                .http(status: 502, payload: nil),
                .transport(URLError(.cannotConnectToHost)),
                .invalidResponse("nope"),
            ]

            for error in errors {
                #expect(error.errorDescription?.isEmpty == false)
            }
        }
    }
}
