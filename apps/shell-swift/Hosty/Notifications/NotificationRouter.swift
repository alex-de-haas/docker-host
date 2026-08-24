import Foundation
import HostyKit

/// Turns a stream payload into a banner.
///
/// The decoding and the link rule live in HostyKit, where they can be tested without a notification
/// centre; this is only the wiring between the stream and the OS.
@MainActor
final class NotificationRouter {
    private let presenter: NotificationPresenter

    init(presenter: NotificationPresenter = NotificationPresenter()) {
        self.presenter = presenter
    }

    func handle(_ payload: String) async {
        guard let notification = HostNotification.decode(payload) else { return }
        await presenter.present(notification)
    }
}
