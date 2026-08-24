import Foundation
import HostyKit
import UserNotifications

/// Raises the operator's attention when the host asks for it.
///
/// A banner is the only reason this client exists on a Mac rather than a browser tab: an agent
/// session that stops on an approval waits for a **person**, and a person who has closed the window
/// has no other way to learn about it.
@MainActor
final class NotificationPresenter {
    private let center: UNUserNotificationCenter
    private var authorized = false
    private var asked = false

    init(center: UNUserNotificationCenter = .current()) {
        self.center = center
    }

    /// Installs the tap handler. Held here because the centre keeps its delegate weakly, and a
    /// responder that fell out of memory would make every tap silently do nothing again.
    private var responder: NotificationResponder?

    func handleTaps(with responder: NotificationResponder) {
        self.responder = responder
        center.delegate = responder
    }

    /// Asks once, when there is something worth asking for.
    ///
    /// Deliberately not at launch: a permission prompt on first open, before the operator has seen
    /// anything that would ever notify them, is the prompt people deny — and a denial is far harder
    /// to undo than a delay. Asked instead the first time a notification actually arrives.
    private func ensureAuthorized() async -> Bool {
        if authorized { return true }
        if asked { return false }
        asked = true
        do {
            authorized = try await center.requestAuthorization(options: [.alert, .sound])
        } catch {
            // A refusal and a failure are the same thing here: no banner. The in-app bell still shows
            // it, so the notification is not lost, only quieter.
            authorized = false
        }
        return authorized
    }

    /// Shows one notification, carrying its link so a tap can act on it.
    func present(_ notification: HostNotification) async {
        guard await ensureAuthorized() else { return }

        let content = UNMutableNotificationContent()
        content.title = notification.title
        if let body = notification.body, !body.isEmpty {
            content.body = body
        }
        if let link = notification.link {
            content.userInfo = [Self.linkKey: link]
        }

        // Identified by the host's own id, so the same notification arriving twice — a reconnect
        // replays what was missed — replaces its banner instead of stacking a second one.
        let request = UNNotificationRequest(identifier: notification.id, content: content, trigger: nil)
        try? await center.add(request)
    }

    static let linkKey = "hosty.link"
}
