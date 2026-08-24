import Testing
@testable import HostyKit

// The banner is the only reason this client exists on a Mac rather than a browser tab: a session that
// stops on an approval waits for a person, and a person who closed the window has no other way to
// learn. What can break is the payload and the link, so those are what is tested.
struct HostNotificationTests {
    @Test func decodesWhatABannerNeeds() {
        let notification = HostNotification.decode("""
        {"id":"n1","title":"The assistant needs approval","body":"A session is paused.",
         "link":"/","createdAt":"2026-08-20T10:00:00Z","read":false,"audience":"user"}
        """)

        #expect(notification?.id == "n1")
        #expect(notification?.title == "The assistant needs approval")
        #expect(notification?.body == "A session is paused.")
        // Fields a banner cannot use are ignored rather than decoded, so a host renaming one of them
        // does not stop the banner this client exists to raise.
        #expect(notification?.link == "/")
    }

    @Test func aPayloadThisClientCannotReadCostsOnlyTheBanner() {
        // The notification still reaches the operator through the in-app bell, which reads the same
        // store. Throwing here would cost the event stream instead.
        #expect(HostNotification.decode("not json") == nil)
        #expect(HostNotification.decode("{}") == nil)
    }

    @Test func knowsWhatTheOperatorHasAlreadySeen() {
        // The catch-up read must not re-announce what was read elsewhere, and a live event carries no
        // read state at all — it is new by definition.
        #expect(HostNotification.decode(#"{"id":"n","title":"t"}"#)?.read == false)
        #expect(HostNotification.decode(#"{"id":"n","title":"t","readAt":"2026-08-20T10:00:00Z"}"#)?.read == true)
    }

    @Test func followsOnlyHostRelativeLinks() {
        // A notification is written by an app. One that could send the operator to an arbitrary URL
        // would make an installed app a phishing vector against the person who installed it, with the
        // host's own banner as the delivery.
        #expect(HostNotification(id: "n", title: "t", link: "/dashboard").destinationPath == "/dashboard")
        #expect(HostNotification(id: "n", title: "t", link: "https://evil.test").destinationPath == nil)
        #expect(HostNotification(id: "n", title: "t", link: "//evil.test/x").destinationPath == nil)
        #expect(HostNotification(id: "n", title: "t", link: nil).destinationPath == nil)
    }
}
