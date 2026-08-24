import Foundation
import HostyKit
import UserNotifications

/// Handles a tapped banner.
///
/// Without this a tap only activates the app, which is the least useful thing it could do: the
/// operator pressed a notification *about a session*, and landing them on whatever screen they left
/// makes them go find it themselves — the exact work the notification existed to save.
@MainActor
final class NotificationResponder: NSObject, UNUserNotificationCenterDelegate {
    /// Where a tap should land, published for whoever owns navigation.
    private(set) var pendingPath: String?

    var onOpen: ((String) -> Void)?

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse
    ) async {
        let link = response.notification.request.content.userInfo[NotificationPresenter.linkKey] as? String
        // Re-validated here rather than trusted from userInfo: the payload was written by an app, and
        // the rule that only host-relative links are followed has to hold at the point of acting on
        // one, not only where it was stored.
        guard let path = HostNotification(id: "", title: "", link: link).destinationPath else {
            return
        }

        pendingPath = path
        onOpen?(path)
    }

    /// Shows the banner even while the app is frontmost.
    ///
    /// The default is to suppress it, which would mean an operator watching one session never learns
    /// that another has stopped for them — the case this feature is most about.
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification
    ) async -> UNNotificationPresentationOptions {
        [.banner, .sound]
    }
}
