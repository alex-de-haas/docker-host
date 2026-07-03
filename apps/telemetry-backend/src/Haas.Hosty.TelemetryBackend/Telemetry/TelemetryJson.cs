using System.Buffers;
using System.Text;
using System.Text.Json;

namespace Haas.Hosty.TelemetryBackend;

// Canonical, reflection-free (AOT-clean) JSON helpers for the string maps the store persists — metric
// label sets and log/span attributes. Serialization sorts keys so an identical label set always
// produces an identical string, which lets the metric store group points into series by their stored
// labels_json. Deserialization walks with JsonDocument and never throws.
internal static class TelemetryJson
{
    private static readonly IReadOnlyDictionary<string, string> Empty =
        new Dictionary<string, string>(StringComparer.Ordinal);

    // Canonical JSON object for a string map: keys sorted ordinal. "{}" for the empty/unlabelled set.
    public static string SerializeStringMap(IReadOnlyDictionary<string, string> map)
    {
        if (map.Count == 0)
        {
            return "{}";
        }

        var keys = map.Keys.ToArray();
        Array.Sort(keys, StringComparer.Ordinal);

        var buffer = new ArrayBufferWriter<byte>();
        using (var writer = new Utf8JsonWriter(buffer))
        {
            writer.WriteStartObject();
            foreach (var key in keys)
            {
                writer.WriteString(key, map[key]);
            }

            writer.WriteEndObject();
        }

        return Encoding.UTF8.GetString(buffer.WrittenSpan);
    }

    // Rebuilds a string map from stored JSON. Tolerant: null/empty/malformed yields the empty map, and
    // non-string values keep their raw JSON (mirroring how the parser flattens AnyValue).
    public static IReadOnlyDictionary<string, string> DeserializeStringMap(string? json)
    {
        if (string.IsNullOrEmpty(json) || json == "{}")
        {
            return Empty;
        }

        try
        {
            using var document = JsonDocument.Parse(json);
            if (document.RootElement.ValueKind != JsonValueKind.Object)
            {
                return Empty;
            }

            Dictionary<string, string>? map = null;
            foreach (var property in document.RootElement.EnumerateObject())
            {
                (map ??= new Dictionary<string, string>(StringComparer.Ordinal))[property.Name] =
                    property.Value.ValueKind == JsonValueKind.String
                        ? property.Value.GetString() ?? string.Empty
                        : property.Value.GetRawText();
            }

            return map ?? Empty;
        }
        catch (JsonException)
        {
            return Empty;
        }
    }
}
