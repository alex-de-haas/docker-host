using System.Globalization;
using System.Text.Json;

namespace Haas.Hosty.Core;

// Shared low-level readers for the OpenTelemetry collector `file` exporter's OTLP/JSON output, used
// by both the logs and the traces parser (the two signals share the OTLP resource/attribute/AnyValue
// encoding; only the record shapes differ). All readers are tolerant and never throw — a missing or
// malformed field yields its neutral value so one bad record cannot poison a tail.
internal static class OtlpJsonParsing
{
    // Resource attribute the collector preserves from the OTEL_RESOURCE_ATTRIBUTES Core injects; it
    // attributes each record to its app. Records without it cannot be attributed and are dropped.
    internal const string AppAttributionAttribute = "hosty.app.id";

    internal static readonly IReadOnlyDictionary<string, string> EmptyAttributes =
        new Dictionary<string, string>(StringComparer.Ordinal);

    // The app id from the container's `resource.attributes` `hosty.app.id` entry, or null when the
    // resource carries none. `resourceContainer` is one resourceLogs/resourceSpans array element.
    internal static string? ResolveAppId(JsonElement resourceContainer)
    {
        if (!resourceContainer.TryGetProperty("resource", out var resource) ||
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

    // OTLP timestamps are int64 nanoseconds, encoded as a JSON string in protojson (but tolerate a
    // raw number). False when the property is absent, malformed, or non-positive.
    internal static bool TryReadUnixNanos(JsonElement parent, string property, out long nanos)
    {
        nanos = 0;
        if (!parent.TryGetProperty(property, out var element))
        {
            return false;
        }

        long parsed;
        switch (element.ValueKind)
        {
            case JsonValueKind.String when long.TryParse(element.GetString(), NumberStyles.Integer, CultureInfo.InvariantCulture, out var fromText):
                parsed = fromText;
                break;
            case JsonValueKind.Number when element.TryGetInt64(out var fromNumber):
                parsed = fromNumber;
                break;
            default:
                return false;
        }

        if (parsed <= 0)
        {
            return false;
        }

        nanos = parsed;
        return true;
    }

    // The record's own `attributes` list flattened to strings, capped at `maxAttributes` so a
    // pathological producer cannot bloat the store.
    internal static IReadOnlyDictionary<string, string> ReadAttributes(JsonElement parent, int maxAttributes)
    {
        if (!parent.TryGetProperty("attributes", out var attributes) ||
            attributes.ValueKind != JsonValueKind.Array)
        {
            return EmptyAttributes;
        }

        Dictionary<string, string>? parsed = null;
        foreach (var attribute in attributes.EnumerateArray())
        {
            if ((parsed?.Count ?? 0) >= maxAttributes)
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
    internal static string? ReadHexId(JsonElement parent, string property)
    {
        if (!parent.TryGetProperty(property, out var element) || element.ValueKind != JsonValueKind.String)
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
    internal static string StringifyAnyValue(JsonElement value)
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
}
