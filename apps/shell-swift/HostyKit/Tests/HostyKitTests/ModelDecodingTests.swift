import Foundation
import Testing

@testable import HostyKit

/// Decoding against payloads shaped like Core's real responses.
///
/// These models are hand-written mirrors of `internal sealed record` types in apps/core with no OpenAPI
/// spec between them, so these fixtures are the only thing that catches a rename. They deliberately
/// include fields the client does not model, and nulls where Core writes nulls.
@Suite("Core response decoding")
struct ModelDecodingTests {
    @Test("An app summary decodes, ignoring the many fields this client does not render")
    func appSummary() throws {
        let json = Data(#"""
        {
          "id": "com.haas.demo-app",
          "displayName": "Demo App",
          "description": "A first-party example runtime app.",
          "version": "0.4.2",
          "kind": "runtime",
          "system": false,
          "source": "git",
          "selectedRuntime": "docker",
          "autostart": true,
          "operationStatus": "idle",
          "runtimeState": "running",
          "lastOperation": "start",
          "lastError": null,
          "capabilities": ["logs"],
          "settings": [{"key": "SOME_KEY", "type": "string", "value": null, "secret": false}],
          "endpoints": [
            {
              "key": "web",
              "protocol": "http",
              "url": "http://127.0.0.1:7301",
              "public": true,
              "service": "web",
              "port": "http",
              "publicOrigin": null,
              "availability": "running"
            }
          ],
          "runtimeProfiles": [
            {"key": "docker", "type": "docker", "default": true, "development": false, "developmentMode": false}
          ],
          "entryPath": "/",
          "embeddedUrl": null,
          "navigation": [],
          "mounts": [],
          "updatePolicy": "pinned",
          "artifactLocks": {"web": {"kind": "image", "imageDigest": "sha256:abc", "resolvedAt": "2026-07-29T12:00:00+00:00"}},
          "manifestError": null,
          "liveChanges": null,
          "live": false,
          "supportsSource": true,
          "iconUrl": "http://127.0.0.1:7070/api/apps/com.haas.demo-app/assets/icon.svg?v=0.4.2",
          "updateCheck": {
            "updateAvailable": true,
            "requiresReview": true,
            "planDigest": "d1e2f3",
            "checkedAt": "2026-07-29T11:59:00.1234567+00:00",
            "error": null
          },
          "dependencies": [
            {"appId": "com.haas.telemetry", "version": null, "required": true, "installed": true, "running": false, "endpoints": []}
          ]
        }
        """#.utf8)

        let app = try JSONDecoder.core.decode(AppSummary.self, from: json)

        #expect(app.id == "com.haas.demo-app")
        #expect(app.version == "0.4.2")
        #expect(app.runtimeState == .running)
        #expect(app.capabilities == ["logs"])
        #expect(app.endpoints.first?.availability == .running)
        #expect(app.runtimeProfiles.first?.default == true)
        #expect(app.updateCheck?.updateAvailable == true)
        #expect(app.updateCheck?.planDigest == "d1e2f3")
        #expect(app.live == false)
        #expect(app.isOperating == false)

        // A required dependency that is installed but stopped is a problem worth showing.
        #expect(app.problems == ["Dependency com.haas.telemetry is not running."])
    }

    @Test("A runtime state this client has never heard of degrades to unknown instead of failing the list")
    func unknownRuntimeState() throws {
        let json = Data(#"{"runtimeState":"quiescing"}"#.utf8)

        struct Wrapper: Decodable { let runtimeState: AppRuntimeState }

        #expect(try JSONDecoder.core.decode(Wrapper.self, from: json).runtimeState == .unknown)
    }

    // Core's own comment warns that `!isUp` is not `isIdle`. Pinning the three predicates keeps a future
    // edit from collapsing them back into one question.
    @Test("The runtime-state predicates stay three different questions")
    func runtimeStatePredicates() {
        #expect(AppRuntimeState.running.isUp)
        #expect(!AppRuntimeState.starting.isUp)

        #expect(AppRuntimeState.starting.isBusy)
        #expect(AppRuntimeState.stopping.isBusy)
        #expect(!AppRuntimeState.stopped.isBusy)

        #expect(AppRuntimeState.stopped.isIdle)
        // The bug the predicates exist to prevent: "not up" must not mean "safe to disturb".
        #expect(!AppRuntimeState.stopping.isUp)
        #expect(!AppRuntimeState.stopping.isIdle)
    }

    @Test("The apps response carries the fleet update-check block, and tolerates its absence")
    func appsResponse() throws {
        let withBlock = Data(#"""
        {"apps": [], "updateCheck": {"running": true, "lastCompletedAt": "2026-07-29T10:00:00+00:00"}}
        """#.utf8)
        let decoded = try JSONDecoder.core.decode(AppsResponse.self, from: withBlock)
        #expect(decoded.updateCheck?.running == true)
        #expect(decoded.updateCheck?.lastCompletedAt != nil)

        // The control-plane list does not attach it.
        let without = Data(#"{"apps": []}"#.utf8)
        #expect(try JSONDecoder.core.decode(AppsResponse.self, from: without).updateCheck == nil)
    }

    @Test("An update plan decodes, and a plan needing review says so")
    func updatePlan() throws {
        let json = Data(#"""
        {
          "appId": "com.haas.demo-app",
          "currentVersion": "0.4.2",
          "targetVersion": "0.5.0",
          "currentRuntime": "docker",
          "targetRuntime": "docker",
          "manifestPath": "apps/demo-app/manifest.json",
          "manifestDigest": "sha256:aaa",
          "planDigest": "sha256:bbb",
          "willCreatePreUpdateBackup": true,
          "changes": ["version 0.4.2 -> 0.5.0", "new external mount: media"],
          "sourceConfigured": true,
          "requiresReview": true
        }
        """#.utf8)

        let plan = try JSONDecoder.core.decode(AppUpdatePlan.self, from: json)

        #expect(plan.planDigest == "sha256:bbb")
        #expect(plan.changes.count == 2)
        #expect(plan.mustBeReviewed)
    }

    // Both fields are defaulted on the C# record, so an older Core omits them entirely. Defaulting
    // `requiresReview` to *false* on absence is the safe direction only because Core also stopped omitting
    // it long ago; the accessor exists so no call site has to think about it.
    @Test("An update plan without the newer fields still decodes")
    func updatePlanWithoutOptionalFields() throws {
        let json = Data(#"""
        {
          "appId": "a", "currentVersion": "1", "targetVersion": "2",
          "currentRuntime": null, "targetRuntime": "docker",
          "manifestPath": "m", "manifestDigest": "d", "planDigest": "p",
          "willCreatePreUpdateBackup": false, "changes": []
        }
        """#.utf8)

        let plan = try JSONDecoder.core.decode(AppUpdatePlan.self, from: json)

        #expect(plan.requiresReview == nil)
        #expect(plan.mustBeReviewed == false)
        #expect(plan.sourceConfigured == nil)
    }

    // The distinction the review screen leans on. With no external source configured, Core could only
    // compare against its own internal copy, so an empty change list means "nothing to compare against",
    // not "up to date" — and the two must not be rendered the same way.
    @Test("An unconfigured source is carried through, so an empty change list is not read as up to date")
    func planWithoutConfiguredSource() throws {
        let json = Data(#"""
        {
          "appId": "a", "currentVersion": "1", "targetVersion": "2",
          "currentRuntime": "docker", "targetRuntime": "docker",
          "manifestPath": "m", "manifestDigest": "d", "planDigest": "p",
          "willCreatePreUpdateBackup": true, "changes": [],
          "sourceConfigured": false, "requiresReview": false
        }
        """#.utf8)

        let plan = try JSONDecoder.core.decode(AppUpdatePlan.self, from: json)

        #expect(plan.changes.isEmpty)
        #expect(plan.sourceConfigured == false)
        #expect(!plan.mustBeReviewed)
    }

    @Test("The fleet check trigger reports whether it started a sweep or joined one")
    func updateCheckTrigger() throws {
        let started = Data(#"""
        {"started": true, "status": {"running": true, "lastCompletedAt": null}}
        """#.utf8)
        let joined = Data(#"""
        {"started": false, "status": {"running": true, "lastCompletedAt": "2026-07-29T10:00:00+00:00"}}
        """#.utf8)

        #expect(try JSONDecoder.core.decode(AppUpdateCheckTrigger.self, from: started).started)
        let joinedTrigger = try JSONDecoder.core.decode(AppUpdateCheckTrigger.self, from: joined)
        #expect(!joinedTrigger.started)
        #expect(joinedTrigger.status.running)
    }

    @Test("Update status decodes with its per-service rows")
    func updateStatus() throws {
        let json = Data(#"""
        {
          "appId": "com.haas.demo-app",
          "runtime": "docker",
          "runtimeType": "docker",
          "updatePolicy": "pinned",
          "updateAvailable": true,
          "services": [
            {"service": "web", "lockedDigest": "sha256:old", "candidateDigest": "sha256:new", "updateAvailable": true, "unknown": false},
            {"service": "worker", "lockedDigest": null, "candidateDigest": null, "updateAvailable": false, "unknown": true}
          ],
          "manifestUpdateAvailable": false,
          "manifestUnknown": false
        }
        """#.utf8)

        let status = try JSONDecoder.core.decode(AppUpdateStatus.self, from: json)

        #expect(status.updateAvailable)
        #expect(status.services.count == 2)
        #expect(status.services[1].unknown)
    }

    @Test("Core status identifies a real Hosty host")
    func coreStatus() throws {
        let json = Data(#"""
        {
          "status": "running", "component": "hosty-core", "version": "0.70.0",
          "dataRoot": "/Users/x/.hosty", "listenUrl": "http://127.0.0.1:7070", "corePort": 7070,
          "corePublicOrigin": null, "shellPublicOrigin": "http://localhost:7171",
          "runtimePublicHost": "127.0.0.1", "shellManifestPath": null, "shellAutostart": true,
          "ingressProvider": "none", "ingressConfigPath": null,
          "warnings": [], "serverTime": "2026-07-29T12:00:00+00:00"
        }
        """#.utf8)

        let status = try JSONDecoder.core.decode(CoreStatus.self, from: json)

        #expect(status.isHostyCore)
        #expect(status.version == "0.70.0")
        #expect(status.corePort == 7070)
    }

    /// Captured verbatim from a running Core (0.69.1) at `GET /api/core/status`, unauthenticated.
    ///
    /// It is here because inventing this fixture got it wrong: the component is `hosty-core`, not `core`,
    /// so a hand-guessed check rejected every genuine host. It also shows the anonymous redaction — empty
    /// `dataRoot`/`listenUrl`, `corePort` 0 — and a five-digit fractional second, which is neither the
    /// three digits nor the seven a reasonable person would test for.
    @Test("The real, unauthenticated payload from a running Core decodes")
    func recordedAnonymousCoreStatus() throws {
        let json = Data(#"""
        {
          "status": "running", "component": "hosty-core", "version": "0.69.1",
          "dataRoot": "", "listenUrl": "", "corePort": 0,
          "corePublicOrigin": null, "shellPublicOrigin": null, "runtimePublicHost": "",
          "shellManifestPath": null, "shellAutostart": false,
          "ingressProvider": "", "ingressConfigPath": null,
          "warnings": [], "serverTime": "2026-07-29T10:46:33.64452+00:00"
        }
        """#.utf8)

        let status = try JSONDecoder.core.decode(CoreStatus.self, from: json)

        #expect(status.isHostyCore)
        #expect(status.version == "0.69.1")
        #expect(status.corePort == 0)
        #expect(status.serverTime != nil)
    }

    @Test("A well-formed JSON reply from something that is not Core is not mistaken for a host")
    func notAHostyHost() throws {
        let json = Data(#"""
        {"status": "ok", "component": "grafana", "version": "11.0.0", "corePort": 3000, "warnings": null}
        """#.utf8)

        #expect(try JSONDecoder.core.decode(CoreStatus.self, from: json).isHostyCore == false)

        // The near miss that the wrong guess would have accepted while rejecting the real thing.
        let almost = Data(#"{"status": "ok", "component": "core", "version": "1.0", "warnings": null}"#.utf8)
        #expect(try JSONDecoder.core.decode(CoreStatus.self, from: almost).isHostyCore == false)
    }

    @Test("An auth session reports the role the whole admin gate depends on")
    func authSession() throws {
        let admin = Data(#"""
        {"authenticated": true, "user": {"id": "user_1", "email": "a@b.test", "displayName": "A",
         "role": "host.admin", "disabled": false, "createdAt": "2026-07-29T12:00:00+00:00",
         "updatedAt": "2026-07-29T12:00:00+00:00"}}
        """#.utf8)
        let decodedAdmin = try JSONDecoder.core.decode(AuthSession.self, from: admin)
        #expect(decodedAdmin.authenticated)
        #expect(decodedAdmin.user?.isAdmin == true)

        let anonymous = Data(#"{"authenticated": false, "user": null}"#.utf8)
        let decodedAnonymous = try JSONDecoder.core.decode(AuthSession.self, from: anonymous)
        #expect(!decodedAnonymous.authenticated)
        #expect(decodedAnonymous.user == nil)
    }

    @Test("An ordinary host user is not an administrator")
    func nonAdminUser() throws {
        let json = Data(#"""
        {"authenticated": true, "user": {"id": "u", "email": null, "displayName": "U",
         "role": "host.user", "disabled": false}}
        """#.utf8)

        let session = try JSONDecoder.core.decode(AuthSession.self, from: json)

        #expect(session.user?.isAdmin == false)
        #expect(session.user?.name == "U")
    }
}
