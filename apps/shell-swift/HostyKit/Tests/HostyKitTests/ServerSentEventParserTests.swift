import Foundation
import Testing

@testable import HostyKit

@Suite("Server-sent event framing")
struct ServerSentEventParserTests {
    /// Feeds a whole stream fragment and returns everything it dispatched.
    private func parse(_ stream: String) -> [CoreEvent] {
        var parser = ServerSentEventParser()
        return stream.components(separatedBy: "\n").compactMap { parser.consume(line: $0) }
    }

    @Test("A named event with data dispatches on the blank line")
    func namedEvent() {
        let events = parse("event: app.changed\ndata: {\"appId\":\"demo\"}\n\n")

        #expect(events.count == 1)
        #expect(events.first?.name == "app.changed")
        #expect(events.first?.data == #"{"appId":"demo"}"#)
        #expect(events.first?.known == .appChanged)
    }

    // The keep-alive path. Core opens with ": connected" and sends ": ping" every 20 seconds while idle.
    // A parser that dispatched on those would fire a spurious "re-read everything" hint three times a
    // minute, on every connected device.
    @Test("Comments never dispatch")
    func commentsAreNotEvents() {
        #expect(parse(": connected\n\n").isEmpty)
        #expect(parse(": ping\n\n").isEmpty)
        #expect(parse(": connected\n\n: ping\n\n: ping\n\n").isEmpty)
    }

    @Test("Comments interleaved with real events do not disturb them")
    func commentsBetweenEvents() {
        let events = parse("""
        : connected

        event: app.changed
        data: {"appId":"a"}

        : ping

        event: app.removed
        data: {"appId":"b"}


        """)

        #expect(events.map(\.name) == ["app.changed", "app.removed"])
    }

    @Test("Exactly one space after the colon is framing, further spaces are data")
    func leadingSpaceHandling() {
        #expect(parse("event: x\ndata:  padded\n\n").first?.data == " padded")
        #expect(parse("event:x\ndata:tight\n\n").first?.data == "tight")
    }

    // Core sends single-line JSON today. A parser that assumed so would silently truncate the moment a
    // payload contained a newline, which is exactly the kind of bug that surfaces in production only.
    @Test("Multiple data lines join with newlines, per the spec")
    func multiLineData() {
        let events = parse("event: notification\ndata: {\ndata:   \"id\": 1\ndata: }\n\n")

        #expect(events.count == 1)
        #expect(events.first?.data == "{\n  \"id\": 1\n}")
    }

    @Test("A CRLF stream parses the same as an LF one")
    func carriageReturns() {
        var parser = ServerSentEventParser()
        let lines = ["event: app.changed\r", "data: {}\r", "\r"]
        let events = lines.compactMap { parser.consume(line: $0) }

        #expect(events.first?.name == "app.changed")
        #expect(events.first?.data == "{}")
    }

    @Test("Data with no event name does not dispatch")
    func dataWithoutName() {
        #expect(parse("data: {\"orphan\":true}\n\n").isEmpty)
    }

    @Test("Unknown SSE fields are ignored rather than breaking the stream")
    func unknownFields() {
        let events = parse("id: 17\nretry: 5000\nevent: app.changed\ndata: {}\n\n")

        #expect(events.count == 1)
        #expect(events.first?.name == "app.changed")
    }

    @Test("An event name this client does not know still arrives, just unclassified")
    func unknownEventName() {
        let events = parse("event: something.new\ndata: {}\n\n")

        #expect(events.first?.name == "something.new")
        #expect(events.first?.known == nil)
    }

    @Test("Every name Core publishes is recognised")
    func knownNames() {
        let published = [
            "app.changed", "app.removed", "app.update-check.changed",
            "apps.update-check.changed", "notification",
        ]

        for name in published {
            #expect(CoreEventName(rawValue: name) != nil, "Core publishes \(name) but the client ignores it")
        }
    }
}

@Suite("Event stream reconnect backoff")
struct BackoffTests {
    @Test("The first reconnect is immediate-ish, then it doubles")
    func doubles() {
        let backoff = CoreEventStream.Backoff(initial: .seconds(1), maximum: .seconds(30))

        #expect(backoff.delay(forAttempt: 1) == .seconds(1))
        #expect(backoff.delay(forAttempt: 2) == .seconds(2))
        #expect(backoff.delay(forAttempt: 3) == .seconds(4))
        #expect(backoff.delay(forAttempt: 4) == .seconds(8))
    }

    @Test("It never exceeds the ceiling")
    func caps() {
        let backoff = CoreEventStream.Backoff(initial: .seconds(1), maximum: .seconds(30))

        #expect(backoff.delay(forAttempt: 10) == .seconds(30))
        // A device asleep for a day comes back with a large attempt count; the exponent is clamped before
        // it is applied, so this returns the ceiling rather than overflowing the shift.
        #expect(backoff.delay(forAttempt: 100_000) == .seconds(30))
    }
}
