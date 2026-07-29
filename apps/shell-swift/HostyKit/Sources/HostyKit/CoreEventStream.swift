import Foundation

/// Event names Core publishes on `GET /api/events`.
public enum CoreEventName: String, Hashable, Sendable {
    case appChanged = "app.changed"
    case appRemoved = "app.removed"
    case appUpdateCheckChanged = "app.update-check.changed"
    case fleetUpdateCheckChanged = "apps.update-check.changed"
    case notification
}

public struct CoreEvent: Hashable, Sendable {
    public let name: String
    public let data: String

    public var known: CoreEventName? { CoreEventName(rawValue: name) }
}

/// What a subscriber receives.
///
/// The bus stores nothing. Events are hints — "re-read this" — never records of what happened, so a client
/// that only listened would serve stale data after any gap: a Core restart drops everything in flight, and
/// a disconnected client misses events until it reconnects. The whole delivery guarantee is the subscriber
/// contract *connect → resync through the API → react*, repeated on **every** reconnect.
///
/// `.resync` is therefore an element of the stream rather than a callback a subscriber may forget to pass.
/// It is impossible to consume this stream without being told when to re-read.
public enum CoreEventStreamElement: Hashable, Sendable {
    /// Connected, or reconnected after a gap. Re-read every piece of state this subscriber renders.
    case resync
    case event(CoreEvent)
    /// The credential this stream authenticates with is finished, and the stream has ended.
    ///
    /// Distinct from a dropped connection, which is ordinary and reconnects silently. Reconnecting past a
    /// 401 would spin against the host forever while the screen kept showing state from a session that no
    /// longer exists — so the failure is handed to the consumer, which owns what "signed out" looks like.
    case unauthorized
}

/// Reads Core's server-sent event stream, reconnecting for as long as the consumer keeps listening.
public struct CoreEventStream: Sendable {
    private let client: CoreClient
    private let backoff: Backoff

    public init(client: CoreClient, backoff: Backoff = .default) {
        self.client = client
        self.backoff = backoff
    }

    /// A stream that yields `.resync` on every (re)connection, then each event until the connection drops.
    ///
    /// It ends only when the consuming task is cancelled. A dropped connection is normal — proxies and
    /// sleeping devices cut long-lived responses constantly — so it is a reconnect, not an error.
    public func elements() -> AsyncStream<CoreEventStreamElement> {
        AsyncStream { continuation in
            let task = Task {
                var attempt = 0
                while !Task.isCancelled {
                    do {
                        let request = await client.eventStreamRequest()
                        let (bytes, _) = try await client.bytes(for: request)

                        attempt = 0
                        continuation.yield(.resync)

                        var parser = ServerSentEventParser()
                        for try await line in bytes.lines {
                            if let event = parser.consume(line: line) {
                                continuation.yield(.event(event))
                            }
                        }
                    } catch is CancellationError {
                        break
                    } catch let error as CoreError where error.requiresSignIn {
                        // Retrying cannot help: the session is gone, and every reconnect would be another
                        // unauthorized request. Tell the consumer and stop.
                        continuation.yield(.unauthorized)
                        break
                    } catch {
                        // Everything else is an ordinary gap — a dropped connection, a restarting host —
                        // and reconnecting is the whole point. The consumer sees it as the next resync.
                    }

                    if Task.isCancelled {
                        break
                    }

                    attempt += 1
                    do {
                        try await Task.sleep(for: backoff.delay(forAttempt: attempt))
                    } catch {
                        break
                    }
                }

                continuation.finish()
            }

            continuation.onTermination = { _ in task.cancel() }
        }
    }

    /// Reconnect delays: quick at first so a Core restart is barely visible, then backing off so a host that
    /// is simply gone is not hammered by every device on the network.
    public struct Backoff: Sendable {
        public let initial: Duration
        public let maximum: Duration

        public static let `default` = Backoff(initial: .seconds(1), maximum: .seconds(30))

        public init(initial: Duration, maximum: Duration) {
            self.initial = initial
            self.maximum = maximum
        }

        public func delay(forAttempt attempt: Int) -> Duration {
            guard attempt > 1 else {
                return initial
            }

            // Doubling, capped. The exponent is clamped before it is applied: a device left asleep for a day
            // can otherwise return with an attempt count that overflows the shift.
            let steps = min(attempt - 1, 16)
            let scaled = initial * (1 << steps)
            return scaled > maximum ? maximum : scaled
        }
    }
}

/// Incremental parser for the `text/event-stream` framing Core emits.
///
/// Core writes `event: <name>\ndata: <json>\n\n` for events, and bare comments (`: connected`, `: ping`) to
/// open the response and to keep it alive while idle. Comments carry no data and must not dispatch — a
/// parser that treated one as an event would fire a spurious hint every 20 seconds.
public struct ServerSentEventParser: Sendable {
    private var name: String?
    private var data: [String] = []

    public init() {}

    /// Feeds one line. Returns an event when that line completed one — SSE dispatches on a blank line.
    public mutating func consume(line: String) -> CoreEvent? {
        // A trailing CR survives when the stream uses CRLF; `lines` only splits on LF.
        let line = line.hasSuffix("\r") ? String(line.dropLast()) : line

        guard !line.isEmpty else {
            return dispatch()
        }

        // A line starting with ":" is a comment. This is the keep-alive path.
        guard !line.hasPrefix(":") else {
            return nil
        }

        let field: String
        var value: String
        if let colon = line.firstIndex(of: ":") {
            field = String(line[..<colon])
            value = String(line[line.index(after: colon)...])
            // Exactly one leading space after the colon is part of the framing, not the value.
            if value.hasPrefix(" ") {
                value.removeFirst()
            }
        } else {
            field = line
            value = ""
        }

        switch field {
        case "event":
            name = value
        case "data":
            data.append(value)
        default:
            // "id" and "retry" are part of SSE but Core sends neither, and an unknown field is required by
            // the spec to be ignored rather than to break the stream.
            break
        }

        return nil
    }

    private mutating func dispatch() -> CoreEvent? {
        defer {
            name = nil
            data = []
        }

        // A blank line after nothing but comments is not an event.
        guard let name, !data.isEmpty else {
            return nil
        }

        // Multiple data lines join with newlines, per the SSE spec. Core sends one, but a client that
        // assumed so would silently corrupt any payload that ever grew.
        return CoreEvent(name: name, data: data.joined(separator: "\n"))
    }
}
