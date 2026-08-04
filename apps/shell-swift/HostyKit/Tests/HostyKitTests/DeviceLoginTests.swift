import Foundation
import Testing

@testable import HostyKit

/// Nested inside `CoreClientTests` rather than standing on its own, because these suites drive the same
/// static `StubURLProtocol` fixture. `.serialized` orders a suite's own tests and propagates into nested
/// suites — but not across two root suites, which would then run concurrently and read each other's
/// stubbed replies.
extension CoreClientTests {
    @Suite("Device authorization requests")
    struct DeviceAuthorizationRequestTests {
        private func client(sessionID: String? = nil) throws -> CoreClient {
            CoreClient(
                origin: try HostOrigin(parsing: "10.0.0.5:7070"),
                sessionID: sessionID,
                configuration: StubURLProtocol.configuration)
        }

        @Test("Requesting a code posts the label and reads Core's answer")
        func requestCode() async throws {
            StubURLProtocol.install(json: #"""
            {"deviceCode":"dev_1","userCode":"ABCDEFGH","verificationUri":"https://shell.example/settings?tab=tokens",
             "intervalSeconds":5,"expiresInSeconds":600}
            """#)

            let authorization = try await client().requestDeviceCode(label: "Alex's Mac")

            #expect(authorization.userCode == "ABCDEFGH")
            #expect(authorization.formattedUserCode == "ABCD-EFGH")

            let sent = try #require(StubURLProtocol.requests.first)
            #expect(sent.request.httpMethod == "POST")
            #expect(sent.request.url?.path == "/api/auth/device/code")
            #expect(sent.request.value(forHTTPHeaderField: "Content-Type") == "application/json")

            let body = try #require(sent.body)
            #expect(try JSONDecoder().decode([String: String].self, from: body) == ["label": "Alex's Mac"])
        }

        // The one endpoint whose purpose is replacing a credential must not present one. A client that
        // still holds a dead session reaches this route precisely because that session stopped working.
        @Test("Neither device route presents a credential, even when the client still holds one")
        func deviceRoutesAreUnauthenticated() async throws {
            StubURLProtocol.install(json: #"""
            {"deviceCode":"dev_1","userCode":"ABCDEFGH","verificationUri":null,"intervalSeconds":5,"expiresInSeconds":600}
            """#)
            _ = try await client(sessionID: "stale_session").requestDeviceCode(label: nil)
            #expect(StubURLProtocol.requests.first?.request.value(forHTTPHeaderField: "Authorization") == nil)

            StubURLProtocol.install(json: #"{"status":"pending","token":null}"#)
            _ = try await client(sessionID: "stale_session").pollDeviceToken(deviceCode: "dev_1")
            #expect(StubURLProtocol.requests.first?.request.value(forHTTPHeaderField: "Authorization") == nil)
        }

        @Test("A pending poll is not an outcome")
        func pendingIsNil() async throws {
            StubURLProtocol.install(json: #"{"status":"pending","token":null}"#)

            #expect(try await client().pollDeviceToken(deviceCode: "dev_1") == nil)
            #expect(StubURLProtocol.requests.first?.request.url?.path == "/api/auth/device/token")
        }

        @Test("Each final status maps to its outcome")
        func finalStatuses() async throws {
            StubURLProtocol.install(json: #"{"status":"approved","token":"hosty_session_value"}"#)
            #expect(try await client().pollDeviceToken(deviceCode: "dev_1") == .approved("hosty_session_value"))

            StubURLProtocol.install(json: #"{"status":"denied","token":null}"#)
            #expect(try await client().pollDeviceToken(deviceCode: "dev_1") == .denied)

            StubURLProtocol.install(json: #"{"status":"expired","token":null}"#)
            #expect(try await client().pollDeviceToken(deviceCode: "dev_1") == .expired)
        }

        // An approval Core consumed but sent no token with cannot be retried — the next poll answers
        // `expired` — so storing an empty credential would strand the operator in a session that is not
        // one. Better to fail loudly here.
        @Test("An approval without a token, or a status this app does not know, is a bad answer")
        func unusableAnswers() async throws {
            // Both are refused, and they say different things: reported as one, an approval that lost
            // its credential would send the reader looking for a protocol mismatch that is not there.
            StubURLProtocol.install(json: #"{"status":"approved","token":null}"#)
            await #expect(throws: CoreError.self) { try await client().pollDeviceToken(deviceCode: "dev_1") }
            #expect(try await message(forPolling: client())?.contains("no credential") == true)

            StubURLProtocol.install(json: #"{"status":"contemplating","token":null}"#)
            await #expect(throws: CoreError.self) { try await client().pollDeviceToken(deviceCode: "dev_1") }
            #expect(try await message(forPolling: client())?.contains("contemplating") == true)
        }

        private func message(forPolling client: CoreClient) async -> String? {
            do {
                _ = try await client.pollDeviceToken(deviceCode: "dev_1")
                return nil
            } catch {
                return error.localizedDescription
            }
        }
    }

    @Suite("Device login polling")
    struct DeviceLoginPollerTests {
        private func authorization(
            verificationUri: String? = "https://shell.example/settings?tab=tokens",
            intervalSeconds: Int = 5,
            expiresInSeconds: Int = 600
        ) -> DeviceAuthorization {
            DeviceAuthorization(
                deviceCode: "dev_1",
                userCode: "ABCDEFGH",
                verificationUri: verificationUri,
                intervalSeconds: intervalSeconds,
                expiresInSeconds: expiresInSeconds)
        }

        private func client() throws -> CoreClient {
            CoreClient(
                origin: try HostOrigin(parsing: "10.0.0.5:7070"),
                configuration: StubURLProtocol.configuration)
        }

        /// Records what the loop would have waited, so the test never actually waits.
        private final class Waits: @unchecked Sendable {
            private let lock = NSLock()
            private var durations: [Duration] = []

            var recorded: [Duration] { lock.withLock { durations } }

            var sleep: @Sendable (Duration) async throws -> Void {
                { duration in self.lock.withLock { self.durations.append(duration) } }
            }
        }

        @Test("It keeps polling while Core answers pending, and waits the interval Core asked for")
        func pollsUntilApproved() async throws {
            StubURLProtocol.install([
                StubURLProtocol.stub(json: #"{"status":"pending","token":null}"#),
                StubURLProtocol.stub(json: #"{"status":"pending","token":null}"#),
                StubURLProtocol.stub(json: #"{"status":"approved","token":"hosty_session_value"}"#),
            ])
            let waits = Waits()

            let outcome = try await DeviceLoginPoller(
                client: try client(),
                authorization: authorization(),
                sleep: waits.sleep).run()

            #expect(outcome == .approved("hosty_session_value"))
            #expect(StubURLProtocol.requests.count == 3)
            #expect(waits.recorded == [.seconds(5), .seconds(5)])
        }

        @Test("A denial and an expiry each end the loop")
        func finalAnswersStop() async throws {
            StubURLProtocol.install(json: #"{"status":"denied","token":null}"#)
            #expect(try await DeviceLoginPoller(client: try client(), authorization: authorization(), sleep: Waits().sleep).run() == .denied)
            #expect(StubURLProtocol.requests.count == 1)

            StubURLProtocol.install(json: #"{"status":"expired","token":null}"#)
            #expect(try await DeviceLoginPoller(client: try client(), authorization: authorization(), sleep: Waits().sleep).run() == .expired)
            #expect(StubURLProtocol.requests.count == 1)
        }

        // The operator is in their browser approving. A Core that restarts mid-approval, or a phone that
        // changes network, must not cost them the request.
        @Test("A host that is briefly unavailable is waited out, not reported")
        func transientFailuresAreRetried() async throws {
            StubURLProtocol.install([
                StubURLProtocol.stub(status: 503, json: #"{"code":"core_restarting","message":"Core is restarting."}"#),
                StubURLProtocol.stub(status: 502, json: "<html>Bad Gateway</html>"),
                StubURLProtocol.stub(json: #"{"status":"approved","token":"hosty_session_value"}"#),
            ])
            let waits = Waits()

            let outcome = try await DeviceLoginPoller(
                client: try client(),
                authorization: authorization(),
                sleep: waits.sleep).run()

            #expect(outcome == .approved("hosty_session_value"))
            #expect(waits.recorded.count == 2)
        }

        // A host with no device routes answers 404 to every poll. Repeating that until the request
        // expires would show a spinner for ten minutes and then blame the operator's timing.
        @Test("A failure that repeating cannot fix is thrown")
        func permanentFailuresStop() async throws {
            StubURLProtocol.install(status: 404, json: #"{"code":"not_found","message":"No route."}"#)

            await #expect(throws: CoreError.self) {
                try await DeviceLoginPoller(client: try client(), authorization: authorization(), sleep: Waits().sleep).run()
            }

            #expect(StubURLProtocol.requests.count == 1)
        }

        // Pending requests live in Core's memory, so a restart drops them and the poll that follows can
        // answer `pending` forever for a code nobody can approve any more.
        @Test("A request that outlives its own lifetime expires locally")
        func localDeadline() async throws {
            StubURLProtocol.install(json: #"{"status":"pending","token":null}"#)

            let outcome = try await DeviceLoginPoller(
                client: try client(),
                authorization: authorization(expiresInSeconds: 0),
                sleep: Waits().sleep).run()

            #expect(outcome == .expired)
        }

        @Test("Zero interval never becomes a busy wait against the host")
        func intervalFloor() {
            #expect(authorization(intervalSeconds: 0).pollInterval == .seconds(1))
            #expect(authorization(intervalSeconds: -5).pollInterval == .seconds(1))
            #expect(authorization(intervalSeconds: 5).pollInterval == .seconds(5))
        }
    }

    @Suite("The approval address")
    struct ApprovalURLTests {
        private func authorization(verificationUri: String?) -> DeviceAuthorization {
            DeviceAuthorization(
                deviceCode: "dev_1",
                userCode: "ABCDEFGH",
                verificationUri: verificationUri,
                intervalSeconds: 5,
                expiresInSeconds: 600)
        }

        @Test("A web address is opened")
        func webAddresses() {
            #expect(authorization(verificationUri: "https://shell.example/settings?tab=tokens").approvalURL != nil)
            #expect(authorization(verificationUri: "http://10.0.0.5:7171/settings?tab=tokens").approvalURL != nil)
        }

        // The address comes from the host, and the app is about to send its operator there. A host is
        // trusted to serve its own Shell, not to hand this app a scheme belonging to some other app.
        @Test("Anything that is not a web address is not opened")
        func nonWebAddresses() {
            #expect(authorization(verificationUri: nil).approvalURL == nil)
            #expect(authorization(verificationUri: "").approvalURL == nil)
            #expect(authorization(verificationUri: "file:///etc/passwd").approvalURL == nil)
            #expect(authorization(verificationUri: "javascript:alert(1)").approvalURL == nil)
            #expect(authorization(verificationUri: "someapp://open").approvalURL == nil)
        }
    }
}
