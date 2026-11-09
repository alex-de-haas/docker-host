using System.Globalization;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace Haas.Hosty.TelemetryBackend;

internal sealed record CoreTraceCoverage(int ContractVersion, string RunId, bool Capturing, DateTimeOffset? CaptureStartedAt,
    double RootSampleRatio, DateTimeOffset ObservedAt, long FirstAvailableSequence, long LastSequence,
    long DroppedSpans, long TruncatedSpans, string State = "receiving", string? LastGapReason = null,
    DateTimeOffset? LastGapAt = null, long GapCount = 0);
internal sealed record ParsedCoreTracePull(string RunId, long NextCursor, bool HasMore, string? GapReason,
    CoreTraceCoverage Coverage, IReadOnlyList<ParsedOtlpSpan> Spans);
internal sealed record CoreTraceCheckpoint(string RunId, long Cursor, CoreTraceCoverage Coverage);

internal static class CoreTracePullParser
{
    public static ParsedCoreTracePull? Parse(string json)
    {
        if (json.Length > 3 * 1024 * 1024) return null;
        try
        {
            using var document = JsonDocument.Parse(json);
            var root = document.RootElement;
            var version = root.GetProperty("contractVersion").GetInt32();
            if (version != 1) return null;
            var runId = root.GetProperty("runId").GetString()!;
            if (!Guid.TryParseExact(runId, "N", out _)) return null;
            var cursor = root.GetProperty("nextCursor").GetInt64();
            var coverage = new CoreTraceCoverage(version, runId, root.GetProperty("capturing").GetBoolean(),
                root.GetProperty("captureStartedAt").ValueKind == JsonValueKind.Null ? null : root.GetProperty("captureStartedAt").GetDateTimeOffset(),
                root.GetProperty("rootSampleRatio").GetDouble(), root.GetProperty("observedAt").GetDateTimeOffset(),
                root.GetProperty("firstAvailableSequence").GetInt64(), root.GetProperty("lastSequence").GetInt64(),
                root.GetProperty("droppedSpans").GetInt64(), root.GetProperty("truncatedSpans").GetInt64());
            if (cursor < 0 || cursor > coverage.LastSequence || coverage.RootSampleRatio is < 0 or > 1 || !double.IsFinite(coverage.RootSampleRatio)) return null;
            var spans = new List<ParsedOtlpSpan>();
            long previousSequence = 0;
            foreach (var value in root.GetProperty("spans").EnumerateArray())
            {
                if (spans.Count >= 500) return null;
                var sequence = value.GetProperty("sequence").GetInt64();
                if (sequence <= previousSequence || sequence > cursor) return null;
                previousSequence = sequence;
                var traceId = Id(value.GetProperty("traceId").GetString(), 32);
                var spanId = Id(value.GetProperty("spanId").GetString(), 16);
                var parent = value.GetProperty("parentSpanId").GetString();
                if (traceId is null || spanId is null || (parent is not null && Id(parent, 16) is null)) return null;
                var at = value.GetProperty("startedAt").GetDateTimeOffset();
                var duration = value.GetProperty("durationMs").GetDouble();
                if (!double.IsFinite(duration) || duration < 0 || duration > TimeSpan.FromDays(365).TotalMilliseconds) return null;
                var attributes = new Dictionary<string, string>(StringComparer.Ordinal);
                foreach (var attribute in value.GetProperty("attributes").EnumerateObject())
                {
                    if (attributes.Count >= 16 || attribute.Name.Length > 128 || attribute.Value.GetString() is not { Length: <= 256 } text) return null;
                    attributes[attribute.Name] = text;
                }
                attributes["hosty.core.run.id"] = runId;
                attributes["hosty.core.provenance"] = "authenticated-pull";
                var start = checked((at.UtcTicks - DateTimeOffset.UnixEpoch.Ticks) * 100);
                var name = value.GetProperty("name").GetString() ?? "Core operation";
                if (name.Length > 256) return null;
                spans.Add(new(CoreLogPullParser.CoreAppId, new(traceId, spanId, parent, name,
                    (value.GetProperty("kind").GetString() ?? "internal").ToLowerInvariant(), start,
                    checked(start + (long)(duration * 1000000)),
                    (value.GetProperty("status").GetString() ?? "unset").ToLowerInvariant(), null, attributes)));
            }
            return new(runId, cursor, root.GetProperty("hasMore").GetBoolean(), root.GetProperty("gapReason").GetString(), coverage, spans);
        }
        catch (Exception ex) when (ex is JsonException or InvalidOperationException or KeyNotFoundException or FormatException or OverflowException) { return null; }
    }
    private static string? Id(string? id, int length) => id is not null && id.Length == length && id.All(Uri.IsHexDigit) && id.Any(c => c != '0') ? id.ToLowerInvariant() : null;
}

[JsonSourceGenerationOptions(PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase)]
[JsonSerializable(typeof(CoreTraceCoverage))]
internal partial class CoreTraceJsonContext : JsonSerializerContext;
