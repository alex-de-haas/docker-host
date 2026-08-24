import Foundation
import HostyKit

/// Turns a stream payload into a banner.
///
/// The decoding and the link rule live in HostyKit, where they can be tested without a notification
/// centre; this is only the wiring between the stream and the OS.
@MainActor
final class NotificationRouter {
    private let presenter: NotificationPresenter

    private let responder = NotificationResponder()

    init(presenter: NotificationPresenter = NotificationPresenter()) {
        self.presenter = presenter
        // Installed once, up front: a delegate attached only after the first banner would miss a tap
        // on that banner, which is the one most likely to be pressed.
        presenter.handleTaps(with: responder)
    }

    /// Called with the host-relative path of a tapped notification.
    var onOpen: ((String) -> Void)? {
        get { responder.onOpen }
        set { responder.onOpen = newValue }
    }

    /// Banners already raised, so a catch-up read does not re-announce what the operator has seen.
    private var announced: Set<String> = []

    func handle(_ payload: String) async {
        guard let notification = HostNotification.decode(payload) else { return }
        await present(notification)
    }

    /// Raises anything unread that arrived while this client was not listening.
    ///
    /// The stream is not durable — Core keeps nothing for a disconnected subscriber, and the scene
    /// stops the stream when it backgrounds — so without this a session that stopped while the window
    /// was closed reaches nobody, which is the whole promise of the feature.
    func catchUp(_ notifications: [HostNotification]) async {
        for notification in notifications where !notification.read {
            await present(notification)
        }
    }

    private func present(_ notification: HostNotification) async {
        guard announced.insert(notification.id).inserted else { return }
        await presenter.present(notification)
    }
}
