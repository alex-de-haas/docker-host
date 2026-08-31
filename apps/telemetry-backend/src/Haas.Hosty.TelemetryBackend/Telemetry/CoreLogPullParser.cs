using System.Globalization;
using System.Text.Json;

namespace Haas.Hosty.TelemetryBackend;

// One page of Core's own log records, as `GET /api/internal/telemetry/logs` returns it.
internal sealed record ParsedCoreLogPull(string RunId, long NextCursor, IReadOnlyList<ParsedOtlpLog> Records);

// Parses Core's log-pull payload. Core is the host kernel, not an installed app, so it has no
// `hosty.app.id` of its own and no OpenTelemetry SDK to stamp one — the records arrive as Core's own
// small JSON shape and are attributed here to the reserved id every read path already keys by.
//
// Walks the tree with JsonDocument (AOT-safe, no reflection) and never throws: a malformed payload
// yields null and the tick simply contributes nothing, exactly like an unreachable scrape target.
internal static class CoreLogPullParser
{
    // Reserved, and deliberately not an installed app id: the store, the query routes, and the MCP
    // tools all treat an app id as an opaque key, so Core rides the same columns without a schema
    // change. It must never be added to Core's app-directory roster — the ai-gateway reads that same
    // payload for provider discovery.
    internal const string CoreAppId = "hosty.core";

    public static ParsedCoreLogPull? Parse(string json, DateTimeOffset fallbackTimestamp)
    {
        if (string.IsNullOrWhiteSpace(json))
        {
            return null;
        }

        try
        {
            using var document = JsonDocument.Parse(json);
            var root = document.RootElement;
            if (root.ValueKind != JsonValueKind.Object)
            {
                return null;
            }

            var runId = root.TryGetProperty("runId", out var runIdElement) && runIdElement.ValueKind == JsonValueKind.String
                ? runIdElement.GetString() ?? string.Empty
                : string.Empty;
            if (runId.Length == 0)
            {
                // Without a run id a cursor cannot be trusted across a Core restart, which is the one
                // thing this endpoint exists to make safe.
                return null;
            }

            var nextCursor = root.TryGetProperty("nextCursor", out var cursorElement) && cursorElement.ValueKind == JsonValueKind.Number
                ? cursorElement.GetInt64()
                : 0;

            var records = new List<ParsedOtlpLog>();
            if (root.TryGetProperty("records", out var recordsElement) && recordsElement.ValueKind == JsonValueKind.Array)
            {
                foreach (var record in recordsElement.EnumerateArray())
                {
                    if (ParseRecord(record, fallbackTimestamp) is { } parsed)
                    {
                        records.Add(parsed);
                    }
                }
            }

            return new ParsedCoreLogPull(runId, nextCursor, records);
        }
        catch (JsonException)
        {
            return null;
        }
    }

    private static ParsedOtlpLog? ParseRecord(JsonElement record, DateTimeOffset fallbackTimestamp)
    {
        if (record.ValueKind != JsonValueKind.Object)
        {
            return null;
        }

        var message = ReadString(record, "message");
        if (message is null)
        {
            return null;
        }

        var level = ReadString(record, "level") ?? "Information";
        var attributes = new Dictionary<string, string>(StringComparer.Ordinal);
        if (ReadString(record, "category") is { } category)
        {
            attributes["hosty.core.category"] = category;
        }

        if (ReadString(record, "exception") is { } exception)
        {
            attributes["exception.stacktrace"] = exception;
        }

        // A folded run of identical records travels as one row plus its count, so a failing 10-second
        // tick costs the store one row an outage rather than 360 an hour.
        if (record.TryGetProperty("count", out var countElement) &&
            countElement.ValueKind == JsonValueKind.Number &&
            countElement.TryGetInt32(out var count) &&
            count > 1)
        {
            attributes["hosty.core.repeat_count"] = count.ToString(CultureInfo.InvariantCulture);
            if (ReadString(record, "lastSeen") is { } lastSeen)
            {
                attributes["hosty.core.last_seen"] = lastSeen;
            }
        }

        return new ParsedOtlpLog(
            CoreAppId,
            new OtlpLogRecord(
                ReadTimestampMs(record, fallbackTimestamp),
                SeverityNumber(level),
                level.ToUpperInvariant(),
                message,
                attributes,
                TraceId: null,
                SpanId: null));
    }

    private static string? ReadString(JsonElement element, string property)
        => element.TryGetProperty(property, out var value) && value.ValueKind == JsonValueKind.String
            ? value.GetString()
            : null;

    private static long ReadTimestampMs(JsonElement record, DateTimeOffset fallback)
        => ReadString(record, "timestamp") is { } text &&
            DateTimeOffset.TryParse(text, CultureInfo.InvariantCulture, DateTimeStyles.AdjustToUniversal, out var parsed)
            ? parsed.ToUnixTimeMilliseconds()
            : fallback.ToUnixTimeMilliseconds();

    // The OTLP severity numbers for .NET's LogLevel names, so Core's records sort and filter beside
    // every app's on the store's existing severity column.
    private static int SeverityNumber(string level) => level.ToLowerInvariant() switch
    {
        "trace" => 1,
        "debug" => 5,
        "information" => 9,
        "warning" => 13,
        "error" => 17,
        "critical" => 21,
        _ => 9,
    };
}
