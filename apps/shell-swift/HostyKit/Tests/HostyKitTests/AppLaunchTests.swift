import Foundation
import Testing

@testable import HostyKit

/// Opening an app: which apps offer a UI at all, which pages they offer, and the launch code that
/// carries identity to the app's own origin.
@Suite("Opening an app")
struct AppLaunchTests {
    private func app(embeddedUrl: String?, navigation: [AppNavigationItem]? = nil) -> AppSummary {
        AppSummary(
            id: "com.haas.demo-app",
            displayName: "Demo App",
            description: nil,
            version: "1.0.0",
            kind: "runtime",
            system: false,
            source: "manifest",
            selectedRuntime: "docker",
            autostart: true,
            operationStatus: "started",
            runtimeState: .running,
            lastOperation: nil,
            lastError: nil,
            capabilities: [],
            endpoints: [],
            runtimeProfiles: [],
            updatePolicy: "reviewed",
            artifactLocks: nil,
            manifestError: nil,
            live: false,
            iconUrl: nil,
            updateCheck: nil,
            dependencies: nil,
            embeddedUrl: embeddedUrl,
            navigation: navigation)
    }

    // A headless app exposes endpoints for other apps to consume, not a browser UI. Public endpoints
    // alone must never make it openable — that distinction is the entire membership rule for the Apps
    // surface.
    @Test("An app is openable only when Core resolved a UI for it")
    func headlessAppsAreNotOpenable() {
        #expect(app(embeddedUrl: "http://127.0.0.1:3100/").hasUI)
        #expect(!app(embeddedUrl: nil).hasUI)
        #expect(!app(embeddedUrl: "").hasUI)
        #expect(app(embeddedUrl: nil).pages.isEmpty)
    }

    @Test("A one-page app yields its entry, so no caller special-cases an empty navigation list")
    func singlePageApp() {
        let pages = app(embeddedUrl: "http://127.0.0.1:3100/").pages

        #expect(pages.count == 1)
        #expect(pages.first?.path == "/")
        #expect(pages.first?.embeddedUrl == "http://127.0.0.1:3100/")
        #expect(pages.first?.label == "Demo App")

        // An explicitly empty list means the same thing as an absent one.
        #expect(app(embeddedUrl: "http://127.0.0.1:3100/", navigation: []).pages.count == 1)
    }

    @Test("Declared pages replace the entry, and a page with no URL is dropped rather than offered")
    func navigationPages() {
        let pages = app(
            embeddedUrl: "http://127.0.0.1:3200/",
            navigation: [
                AppNavigationItem(label: "Metrics", path: "/metrics", embeddedUrl: "http://127.0.0.1:3200/metrics", iconUrl: nil),
                AppNavigationItem(label: "Logs", path: "/logs", embeddedUrl: "http://127.0.0.1:3200/logs", iconUrl: nil),
                AppNavigationItem(label: "Broken", path: "/broken", embeddedUrl: nil, iconUrl: nil),
            ]
        ).pages

        #expect(pages.map(\.path) == ["/metrics", "/logs"])
        #expect(pages.map(\.label) == ["Metrics", "Logs"])
    }

    @Test("An app summary decodes the UI fields Core sends, and tolerates a Core that omits them")
    func decodesCoreShape() throws {
        let withUI = #"""
        {
          "id": "com.haas.telemetry-ui", "displayName": "Observability", "version": "0.4.10",
          "kind": "runtime", "system": true, "source": "feed", "autostart": true,
          "operationStatus": "started", "runtimeState": "running", "capabilities": [],
          "endpoints": [], "runtimeProfiles": [], "updatePolicy": "reviewed", "live": false,
          "embeddedUrl": "http://127.0.0.1:3200/",
          "navigation": [
            {"label": "Metrics", "path": "/metrics", "entryPath": "/metrics", "embeddedUrl": "http://127.0.0.1:3200/metrics", "iconUrl": null}
          ]
        }
        """#

        let decoded = try JSONDecoder.core.decode(AppSummary.self, from: Data(withUI.utf8))
        #expect(decoded.embeddedUrl == "http://127.0.0.1:3200/")
        #expect(decoded.navigation?.count == 1)
        #expect(decoded.pages.map(\.path) == ["/metrics"])

        // Both fields are optional in the contract: an older Core omitting them must not fail the
        // whole list decode, it must simply describe an app with no UI.
        let headless = #"""
        {
          "id": "com.haas.worker", "displayName": "Worker", "version": "1.0.0", "kind": "runtime",
          "system": false, "source": "manifest", "autostart": true, "operationStatus": "started",
          "runtimeState": "running", "capabilities": [], "endpoints": [], "runtimeProfiles": [],
          "updatePolicy": "reviewed", "live": false
        }
        """#

        let decodedHeadless = try JSONDecoder.core.decode(AppSummary.self, from: Data(headless.utf8))
        #expect(!decodedHeadless.hasUI)
        #expect(decodedHeadless.pages.isEmpty)
    }

    @Test("A launch code decodes with its expiry, which is what makes re-opening re-mint")
    func launchCodeDecoding() throws {
        let json = #"""
        {
          "code": "abc123",
          "redirectUri": "http://127.0.0.1:3100/?code=abc123",
          "expiresAt": "2026-07-30T14:05:00.1234567+00:00"
        }
        """#

        let launch = try JSONDecoder.core.decode(AppLaunchCode.self, from: Data(json.utf8))

        #expect(launch.code == "abc123")
        #expect(launch.redirectUri == "http://127.0.0.1:3100/?code=abc123")
        #expect(launch.expiresAt.timeIntervalSince1970 > 0)
    }
}

/// The one reachability question a client can answer before trying: a loopback app URL read from
/// somewhere that is not the host itself.
@Suite("Loopback reachability")
struct LoopbackReachabilityTests {
    @Test("The whole loopback space counts, not just the literal Core defaults to")
    func loopbackHosts() throws {
        for raw in ["127.0.0.1:7070", "localhost:7070", "127.1.2.3:7070", "[::1]:7070"] {
            #expect(try HostOrigin(parsing: raw).isLoopback, "\(raw) is loopback")
        }

        for raw in ["192.168.1.50:7070", "hosty.example.com", "10.0.0.5:7070", "127.example.com"] {
            #expect(try !HostOrigin(parsing: raw).isLoopback, "\(raw) is not loopback")
        }
    }

    @Test("A loopback app URL is unreachable from anywhere but the host itself")
    func loopbackAppUrlFromRemote() throws {
        let remote = try HostOrigin(parsing: "192.168.1.50:7070")

        #expect(remote.advertisesUnreachableLoopback("http://127.0.0.1:3100/"))
        #expect(remote.advertisesUnreachableLoopback("http://localhost:3100/reports"))
        #expect(remote.advertisesUnreachableLoopback("http://[::1]:3100/"))

        // An operator-configured public origin is exactly the case this must not flag.
        #expect(!remote.advertisesUnreachableLoopback("https://demo.example.com/"))
        #expect(!remote.advertisesUnreachableLoopback("http://192.168.1.50:3100/"))
    }

    @Test("On the host itself a loopback app URL is correct, so nothing is flagged")
    func loopbackAppUrlFromTheHost() throws {
        let local = try HostOrigin(parsing: "127.0.0.1:7070")

        #expect(!local.advertisesUnreachableLoopback("http://127.0.0.1:3100/"))
        #expect(!local.advertisesUnreachableLoopback("https://demo.example.com/"))
    }

    // Guessing here would replace a truthful load failure with a wrong explanation.
    @Test("A missing or unparseable URL is not reported as unreachable")
    func unparseableUrls() throws {
        let remote = try HostOrigin(parsing: "192.168.1.50:7070")

        #expect(!remote.advertisesUnreachableLoopback(nil))
        #expect(!remote.advertisesUnreachableLoopback(""))
        #expect(!remote.advertisesUnreachableLoopback("not a url"))
    }
}
