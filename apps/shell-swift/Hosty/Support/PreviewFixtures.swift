#if DEBUG
import Foundation
import HostyKit

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
          "iconUrl": null,
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
