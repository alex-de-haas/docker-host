import Foundation
import Testing

@testable import HostyKit

/// Core serializes `DateTimeOffset` with System.Text.Json, which writes a numeric offset rather than `Z`
/// and up to seven fractional digits. Both break Foundation's obvious parsers, so every shape Core can
/// actually emit is pinned here.
@Suite("Core timestamp parsing")
struct CoreTimestampTests {
    private static let noon = Date(timeIntervalSince1970: 1_785_326_400) // 2026-07-29T12:00:00Z

    @Test("No fractional seconds, numeric offset — the common case")
    func numericOffset() throws {
        let date = try #require(CoreTimestamp.parse("2026-07-29T12:00:00+00:00"))
        #expect(date == Self.noon)
    }

    @Test("Seven fractional digits, which ISO8601DateFormatter rejects unaided")
    func sevenFractionalDigits() throws {
        let date = try #require(CoreTimestamp.parse("2026-07-29T12:00:00.1234567+00:00"))

        // Truncated to milliseconds, deliberately: nothing here reads below that.
        #expect(abs(date.timeIntervalSince(Self.noon) - 0.123) < 0.0005)
    }

    @Test("Three fractional digits")
    func threeFractionalDigits() throws {
        let date = try #require(CoreTimestamp.parse("2026-07-29T12:00:00.500+00:00"))
        #expect(abs(date.timeIntervalSince(Self.noon) - 0.5) < 0.0005)
    }

    @Test("A single fractional digit is tenths, not milliseconds")
    func oneFractionalDigit() throws {
        let date = try #require(CoreTimestamp.parse("2026-07-29T12:00:00.5+00:00"))
        #expect(abs(date.timeIntervalSince(Self.noon) - 0.5) < 0.0005)
    }

    @Test("An all-zero fraction still parses")
    func zeroFraction() throws {
        let date = try #require(CoreTimestamp.parse("2026-07-29T12:00:00.0000000+00:00"))
        #expect(date == Self.noon)
    }

    @Test("A Z suffix parses")
    func zuluSuffix() throws {
        #expect(try #require(CoreTimestamp.parse("2026-07-29T12:00:00Z")) == Self.noon)
        #expect(try #require(CoreTimestamp.parse("2026-07-29T12:00:00.250Z")) != Self.noon)
    }

    @Test("A non-UTC offset is honoured, not ignored")
    func nonUTCOffset() throws {
        let date = try #require(CoreTimestamp.parse("2026-07-29T15:00:00+03:00"))
        #expect(date == Self.noon)
    }

    @Test("Nonsense is rejected rather than silently becoming a date")
    func rejectsNonsense() {
        #expect(CoreTimestamp.parse("") == nil)
        #expect(CoreTimestamp.parse("yesterday") == nil)
        #expect(CoreTimestamp.parse("2026-07-29") == nil)
    }

    @Test("The decoder wires the parser in, and reports an unparseable timestamp as a decoding error")
    func decoderIntegration() throws {
        struct Wrapper: Decodable { let checkedAt: Date }

        let good = Data(#"{"checkedAt":"2026-07-29T12:00:00.1234567+00:00"}"#.utf8)
        #expect(try JSONDecoder.core.decode(Wrapper.self, from: good).checkedAt != Date(timeIntervalSince1970: 0))

        let bad = Data(#"{"checkedAt":"not-a-time"}"#.utf8)
        #expect(throws: DecodingError.self) { try JSONDecoder.core.decode(Wrapper.self, from: bad) }
    }
}
