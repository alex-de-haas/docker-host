import Foundation

/// One notification as Core puts it on the event stream.
///
/// Only the fields a banner needs. Core's payload carries more — read state, audience, source — but a
/// banner that has already been raised cannot use them, and decoding fields nobody reads is how a
/// client breaks on a field the host later renames.
public struct HostNotification: Decodable, Sendable, Hashable {
    public let id: String
    public let title: String
    public let body: String?
    public let link: String?

    public init(id: String, title: String, body: String? = nil, link: String? = nil) {
        self.id = id
        self.title = title
        self.body = body
        self.link = link
    }

    /// Decodes one `notification` event payload.
    ///
    /// Returns nil rather than throwing: a payload this client cannot read costs a missed banner, and
    /// the notification still reaches the operator through the in-app bell, which reads the same
    /// store. Turning it into an error would cost the event stream instead.
    public static func decode(_ payload: String) -> HostNotification? {
        guard let data = payload.data(using: .utf8) else { return nil }
        return try? JSONDecoder().decode(HostNotification.self, from: data)
    }

    /// Where a tapped banner should land, or nil when it should do nothing.
    ///
    /// Only host-relative links are followed. A notification is written by an **app**, and one that
    /// could send the operator to an arbitrary URL would make an installed app a phishing vector
    /// against the person who installed it — with the host's own banner as the delivery.
    public var destinationPath: String? {
        guard let link, link.hasPrefix("/"), !link.hasPrefix("//") else { return nil }
        return link
    }
}
