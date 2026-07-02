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
// the live window. Low-level OTLP/JSON readers are shared with the traces parser (OtlpJsonParsing).
// See docs/features/observability.md.
internal static class OtlpLogsJsonParser
{
    internal const string AppAttributionAttribute = OtlpJsonParsing.AppAttributionAttribute;

    // Bound the per-record attribute count so a pathological producer cannot bloat the store.
    private const int MaxAttributesPerRecord = 32;

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
                var appId = OtlpJsonParsing.ResolveAppId(resourceLog);
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

    private static OtlpLogRecord ReadRecord(JsonElement logRecord, long fallbackMs)
    {
        var timestampMs = ReadTimestampMs(logRecord, fallbackMs);
        var severityNumber = ReadSeverityNumber(logRecord);
        var severityText = ReadSeverityText(logRecord, severityNumber);
        var body = logRecord.TryGetProperty("body", out var bodyValue)
            ? OtlpJsonParsing.StringifyAnyValue(bodyValue)
            : string.Empty;
        var attributes = OtlpJsonParsing.ReadAttributes(logRecord, MaxAttributesPerRecord);
        var traceId = OtlpJsonParsing.ReadHexId(logRecord, "traceId");
        var spanId = OtlpJsonParsing.ReadHexId(logRecord, "spanId");
        return new OtlpLogRecord(timestampMs, severityNumber, severityText, body, attributes, traceId, spanId);
    }

    // Prefers timeUnixNano, falls back to observedTimeUnixNano, then the scrape clock.
    private static long ReadTimestampMs(JsonElement logRecord, long fallbackMs)
    {
        if (OtlpJsonParsing.TryReadUnixNanos(logRecord, "timeUnixNano", out var nanos) ||
            OtlpJsonParsing.TryReadUnixNanos(logRecord, "observedTimeUnixNano", out nanos))
        {
            return nanos / 1_000_000;
        }

        return fallbackMs;
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
