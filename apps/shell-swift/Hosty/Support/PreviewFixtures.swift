#if DEBUG
import Foundation
import HostyKit
import SwiftUI

enum PreviewFixtures {
    static let runningApp: AppSummary = decode(
        """
        {
          "id": "com.haas.telemetry",
          "displayName": "Telemetry",
          "description": "Metrics, traces, and logs for this Hosty host.",
          "version": "0.8.0",
          "kind": "app",
          "system": false,
          "source": "bundled",
          "selectedRuntime": "production",
          "autostart": true,
          "operationStatus": "started",
          "runtimeState": "running",
          "lastOperation": "started",
          "lastError": null,
          "capabilities": ["host.metrics", "host.logs"],
          "endpoints": [
            {
              "key": "dashboard",
              "protocol": "http",
              "url": "https://telemetry.hosty.test",
              "public": false,
              "service": "ui",
              "port": "3000",
              "publicOrigin": null,
              "availability": "running"
            }
          ],
          "runtimeProfiles": [
            {
              "key": "production",
              "type": "compose",
              "default": true,
              "development": false,
              "developmentMode": false
            }
          ],
          "updatePolicy": "reviewed",
          "artifactLocks": null,
          "manifestError": null,
          "live": false,
          "iconUrl": "\(telemetryIcon)",
          "updateCheck": {
            "updateAvailable": true,
            "requiresReview": true,
            "planDigest": "preview-plan",
            "checkedAt": "2026-07-29T12:00:00Z",
            "error": null
          },
          "dependencies": []
        }
        """)

    /// A system app, which the list no longer separates out — it carries a badge and sits among the rest.
    static let systemApp: AppSummary = decode(
        """
        {
          "id": "com.haas.shell",
          "displayName": "Shell",
          "description": "The browser UI this host serves.",
          "version": "0.46.0",
          "kind": "app",
          "system": true,
          "source": "bundled",
          "selectedRuntime": "source",
          "autostart": true,
          "operationStatus": "stopped",
          "runtimeState": "stopped",
          "lastOperation": "stopped",
          "lastError": null,
          "capabilities": [],
          "endpoints": [],
          "runtimeProfiles": [
            {
              "key": "source",
              "type": "localCommand",
              "default": true,
              "development": true,
              "developmentMode": true
            }
          ],
          "updatePolicy": "reviewed",
          "artifactLocks": null,
          "manifestError": null,
          "live": true,
          "iconUrl": "\(shellIcon)",
          "updateCheck": null,
          "dependencies": []
        }
        """)

    /// Stand-in artwork for the fixtures' icon URLs. A preview has no host to fetch from, and a column of
    /// placeholders would not show what an icon does to the rhythm of a row.
    static let icons: [String: Image] = [
        telemetryIcon: Image(systemName: "waveform.path.ecg"),
        shellIcon: Image(systemName: "square.grid.2x2.fill"),
    ]

    // Core serves a manifest-declared icon from the app's own folder, cache-busted by the app version.
    private static let telemetryIcon = "/api/apps/com.haas.telemetry/assets/icon.svg?v=0.8.0"
    private static let shellIcon = "/api/apps/com.haas.shell/assets/icon.svg?v=0.46.0"

    private static func decode(_ json: String) -> AppSummary {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601

        do {
            return try decoder.decode(AppSummary.self, from: Data(json.utf8))
        } catch {
            preconditionFailure("Invalid AppSummary preview fixture: \(error)")
        }
    }
}
#endif
