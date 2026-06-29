using System.Globalization;
using System.Text.Json;

namespace Haas.Hosty.Core;

// One OTLP log record parsed from the collector's file-exporter output, paired with the app it was
// attributed to via its `hosty.app.id` resource attribute (the same attribution the metrics scrape
// uses). Records that carry no app id are dropped by the parser, never surfaced here.
internal sealed record ParsedOtlpLog(string AppId, OtlpLogRecord Record);

// Tolerant parser for the OpenTelemetry collector `file` exporter's logs output: newline-delimited
// OTLP/JSON, one ExportLogsServiceRequest-shaped object (`{"resourceLogs":[...]}`) per line. Walks
// the tree with JsonDocument — AOT-safe (no reflection) — and never throws: a malformed line or a
// record missing its app attribution is skipped so one bad line cannot poison a tail. Missing record
// timestamps fall back to `fallbackTimestamp` (the scrape clock) so unstamped records still land in
// the live window. See docs/features/observability.md.
internal static class OtlpLogsJsonParser
{
    // Resource attribute the collector preserves from the OTEL_RESOURCE_ATTRIBUTES Core injects; it
    // attributes each log record to its app. Records without it cannot be attributed and are dropped.
    internal const string AppAttributionAttribute = "hosty.app.id";

    // Bound the per-record attribute count so a pathological producer cannot bloat the store.
    private const int MaxAttributesPerRecord = 32;

    private static readonly IReadOnlyDictionary<string, string> EmptyAttributes =
        new Dictionary<string, string>(StringComparer.Ordinal);

    public static IReadOnlyList<ParsedOtlpLog> Parse(string? ndjson, DateTimeOffset fallbackTimestamp)
    {
        if (string.IsNullOrWhiteSpace(ndjson))
        {
            return [];
        }

        var fallbackMs = fallbackTimestamp.ToUnixTimeMilliseconds();
        var results = new List<ParsedOtlpLog>();
        foreach (var rawLine in ndjson.AsSpan().EnumerateLines())
        {
            var line = rawLine.Trim();
            if (line.IsEmpty || line[0] != '{')
            {
                continue;
            }

            ParseLine(line, fallbackMs, results);
        }

        return results;
    }

    private static void ParseLine(ReadOnlySpan<char> line, long fallbackMs, List<ParsedOtlpLog> results)
    {
        JsonDocument document;
        try
        {
            document = JsonDocument.Parse(line.ToString());
        }
        catch (JsonException)
        {
            return; // A partial or malformed line (e.g. a half-flushed tail) is skipped.
        }

        using (document)
        {
            if (!document.RootElement.TryGetProperty("resourceLogs", out var resourceLogs) ||
                resourceLogs.ValueKind != JsonValueKind.Array)
            {
                return;
            }

            foreach (var resourceLog in resourceLogs.EnumerateArray())
            {
                var appId = ResolveAppId(resourceLog);
                if (string.IsNullOrWhiteSpace(appId))
                {
                    continue;
                }

                if (!resourceLog.TryGetProperty("scopeLogs", out var scopeLogs) ||
                    scopeLogs.ValueKind != JsonValueKind.Array)
                {
                    continue;
                }

                foreach (var scopeLog in scopeLogs.EnumerateArray())
                {
                    if (!scopeLog.TryGetProperty("logRecords", out var logRecords) ||
                        logRecords.ValueKind != JsonValueKind.Array)
                    {
                        continue;
                    }

                    foreach (var logRecord in logRecords.EnumerateArray())
                    {
                        results.Add(new ParsedOtlpLog(appId!, ReadRecord(logRecord, fallbackMs)));
                    }
                }
            }
        }
    }

    // The app id from the resource's `hosty.app.id` attribute, or null when the resource carries none.
    private static string? ResolveAppId(JsonElement resourceLog)
    {
        if (!resourceLog.TryGetProperty("resource", out var resource) ||
            !resource.TryGetProperty("attributes", out var attributes) ||
            attributes.ValueKind != JsonValueKind.Array)
        {
            return null;
        }

        foreach (var attribute in attributes.EnumerateArray())
        {
            if (attribute.TryGetProperty("key", out var key) &&
                key.ValueKind == JsonValueKind.String &&
                string.Equals(key.GetString(), AppAttributionAttribute, StringComparison.Ordinal) &&
                attribute.TryGetProperty("value", out var value))
            {
                var resolved = StringifyAnyValue(value);
                return string.IsNullOrWhiteSpace(resolved) ? null : resolved;
            }
        }

        return null;
    }

    private static OtlpLogRecord ReadRecord(JsonElement logRecord, long fallbackMs)
    {
        var timestampMs = ReadTimestampMs(logRecord, fallbackMs);
        var severityNumber = ReadSeverityNumber(logRecord);
        var severityText = ReadSeverityText(logRecord, severityNumber);
        var body = logRecord.TryGetProperty("body", out var bodyValue) ? StringifyAnyValue(bodyValue) : string.Empty;
        var attributes = ReadAttributes(logRecord);
        var traceId = ReadHexId(logRecord, "traceId");
        var spanId = ReadHexId(logRecord, "spanId");
        return new OtlpLogRecord(timestampMs, severityNumber, severityText, body, attributes, traceId, spanId);
    }

    // OTLP timestamps are int64 nanoseconds, encoded as a JSON string in protojson (but tolerate a
    // raw number). Prefers timeUnixNano, falls back to observedTimeUnixNano, then the scrape clock.
    private static long ReadTimestampMs(JsonElement logRecord, long fallbackMs)
    {
        if (TryReadUnixNanos(logRecord, "timeUnixNano", out var ms) ||
            TryReadUnixNanos(logRecord, "observedTimeUnixNano", out ms))
        {
            return ms;
        }

        return fallbackMs;
    }

    private static bool TryReadUnixNanos(JsonElement logRecord, string property, out long milliseconds)
    {
        milliseconds = 0;
        if (!logRecord.TryGetProperty(property, out var element))
        {
            return false;
        }

        long nanos;
        switch (element.ValueKind)
        {
            case JsonValueKind.String when long.TryParse(element.GetString(), NumberStyles.Integer, CultureInfo.InvariantCulture, out var parsed):
                nanos = parsed;
                break;
            case JsonValueKind.Number when element.TryGetInt64(out var number):
                nanos = number;
                break;
            default:
                return false;
        }

        if (nanos <= 0)
        {
            return false;
        }

        milliseconds = nanos / 1_000_000;
        return true;
    }

    // severityNumber is normally the integer OTLP enum value; tolerate the enum name string too.
    private static int ReadSeverityNumber(JsonElement logRecord)
    {
        if (!logRecord.TryGetProperty("severityNumber", out var element))
        {
            return 0;
        }

        return element.ValueKind switch
        {
            JsonValueKind.Number when element.TryGetInt32(out var number) => number,
            JsonValueKind.String => SeverityNumberFromName(element.GetString()),
            _ => 0,
        };
    }

    private static string ReadSeverityText(JsonElement logRecord, int severityNumber)
    {
        if (logRecord.TryGetProperty("severityText", out var element) &&
            element.ValueKind == JsonValueKind.String &&
            element.GetString() is { Length: > 0 } text)
        {
            return text;
        }

        return SeverityTextFromNumber(severityNumber);
    }

    private static IReadOnlyDictionary<string, string> ReadAttributes(JsonElement logRecord)
    {
        if (!logRecord.TryGetProperty("attributes", out var attributes) ||
            attributes.ValueKind != JsonValueKind.Array)
        {
            return EmptyAttributes;
        }

        Dictionary<string, string>? parsed = null;
        foreach (var attribute in attributes.EnumerateArray())
        {
            if ((parsed?.Count ?? 0) >= MaxAttributesPerRecord)
            {
                break;
            }

            if (attribute.TryGetProperty("key", out var key) &&
                key.ValueKind == JsonValueKind.String &&
                key.GetString() is { Length: > 0 } name &&
                attribute.TryGetProperty("value", out var value))
            {
                (parsed ??= new Dictionary<string, string>(StringComparer.Ordinal))[name] = StringifyAnyValue(value);
            }
        }

        return parsed ?? EmptyAttributes;
    }

    // trace_id / span_id are lowercase-hex strings in OTLP/JSON; an all-zero or empty id means absent.
    private static string? ReadHexId(JsonElement logRecord, string property)
    {
        if (!logRecord.TryGetProperty(property, out var element) || element.ValueKind != JsonValueKind.String)
        {
            return null;
        }

        var value = element.GetString();
        if (string.IsNullOrEmpty(value) || value.All(static ch => ch == '0'))
        {
            return null;
        }

        return value;
    }

    // Flattens an OTLP AnyValue to a string: scalars become their text, composites their raw JSON.
    private static string StringifyAnyValue(JsonElement value)
    {
        if (value.ValueKind != JsonValueKind.Object)
        {
            return value.ValueKind switch
            {
                JsonValueKind.String => value.GetString() ?? string.Empty,
                JsonValueKind.Null or JsonValueKind.Undefined => string.Empty,
                _ => value.GetRawText(),
            };
        }

        if (value.TryGetProperty("stringValue", out var stringValue) && stringValue.ValueKind == JsonValueKind.String)
        {
            return stringValue.GetString() ?? string.Empty;
        }

        if (value.TryGetProperty("intValue", out var intValue))
        {
            return intValue.ValueKind == JsonValueKind.String ? intValue.GetString() ?? string.Empty : intValue.GetRawText();
        }

        if (value.TryGetProperty("doubleValue", out var doubleValue))
        {
            return doubleValue.GetRawText();
        }

        if (value.TryGetProperty("boolValue", out var boolValue) &&
            boolValue.ValueKind is JsonValueKind.True or JsonValueKind.False)
        {
            return boolValue.GetBoolean() ? "true" : "false";
        }

        if (value.TryGetProperty("bytesValue", out var bytesValue) && bytesValue.ValueKind == JsonValueKind.String)
        {
            return bytesValue.GetString() ?? string.Empty;
        }

        // arrayValue / kvlistValue (and anything unexpected): keep the structure as compact JSON.
        return value.GetRawText();
    }

    // Maps the OTLP SeverityNumber enum name (e.g. "SEVERITY_NUMBER_INFO2") to its integer value.
    private static int SeverityNumberFromName(string? name)
    {
        if (string.IsNullOrWhiteSpace(name))
        {
            return 0;
        }

        var token = name.StartsWith("SEVERITY_NUMBER_", StringComparison.OrdinalIgnoreCase)
            ? name["SEVERITY_NUMBER_".Length..]
            : name;

        var offset = 0;
        if (token.Length > 0 && char.IsDigit(token[^1]))
        {
            offset = token[^1] - '1'; // INFO=…0, INFO2=…1, …, INFO4=…3
            token = token[..^1];
        }

        var baseValue = token.ToUpperInvariant() switch
        {
            "TRACE" => 1,
            "DEBUG" => 5,
            "INFO" => 9,
            "WARN" => 13,
            "ERROR" => 17,
            "FATAL" => 21,
            _ => 0,
        };

        return baseValue == 0 ? 0 : baseValue + Math.Clamp(offset, 0, 3);
    }

    private static string SeverityTextFromNumber(int severityNumber) => severityNumber switch
    {
        >= 1 and <= 4 => "TRACE",
        >= 5 and <= 8 => "DEBUG",
        >= 9 and <= 12 => "INFO",
        >= 13 and <= 16 => "WARN",
        >= 17 and <= 20 => "ERROR",
        >= 21 and <= 24 => "FATAL",
        _ => string.Empty,
    };
}
