import Foundation

/// Parses the timestamps Core emits.
///
/// Core serializes `DateTimeOffset` through System.Text.Json, which writes up to **seven** fractional
/// digits (`2026-07-29T12:00:00.1234567+00:00`) and a numeric offset rather than `Z`. Neither of
/// Foundation's obvious parsers handles that as-is: `ISO8601DateFormatter` with `.withFractionalSeconds`
/// accepts exactly three fractional digits and fails on seven, and `.iso8601` without the option fails on
/// any fraction at all.
///
/// So the fraction is normalized to at most three digits before parsing. Truncating is deliberate —
/// sub-millisecond precision has no consumer here, and every alternative (rejecting, or rounding into the
/// next second) is worse than dropping digits nothing reads.
enum CoreTimestamp {
    static func parse(_ text: String) -> Date? {
        let normalized = normalizeFractionalSeconds(text)

        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = normalized.hasFraction
            ? [.withInternetDateTime, .withFractionalSeconds]
            : [.withInternetDateTime]

        return formatter.date(from: normalized.value)
    }

    /// Truncates the fractional part to at most three digits, keeping it declared either way.
    ///
    /// Truncation never removes the fraction: three digits of a non-empty run is still non-empty, so a
    /// string that had a fraction going in has one coming out. The two ways to come back with no fraction
    /// are both about the input — no `.` at all, or a `.` with no digits after it.
    private static func normalizeFractionalSeconds(_ text: String) -> (value: String, hasFraction: Bool) {
        guard let dot = text.firstIndex(of: ".") else {
            return (text, false)
        }

        let afterDot = text.index(after: dot)
        let digits = text[afterDot...].prefix(while: \.isNumber)
        guard !digits.isEmpty else {
            // A "." with no digits is malformed; hand it back untouched and let the formatter reject it.
            return (text, false)
        }

        let kept = digits.prefix(3)
        let suffix = text[text.index(afterDot, offsetBy: digits.count)...]

        // ".000" is a fraction that carries nothing, but it still has to be *declared* to the formatter,
        // so it is kept rather than stripped — the option must match the string exactly either way.
        return (text[..<dot] + "." + kept + suffix, true)
    }
}

extension JSONDecoder {
    /// A decoder configured for Core's responses: camelCase names map to Swift property names directly
    /// (Core serializes with `JsonSerializerDefaults.Web`), and timestamps go through `CoreTimestamp`.
    static var core: JSONDecoder {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .custom { decoder in
            let container = try decoder.singleValueContainer()
            let text = try container.decode(String.self)
            guard let date = CoreTimestamp.parse(text) else {
                throw DecodingError.dataCorruptedError(
                    in: container,
                    debugDescription: "Not a timestamp Core could have produced: \(text)")
            }

            return date
        }

        return decoder
    }
}
