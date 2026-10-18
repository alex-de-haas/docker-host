using System.Security.Cryptography;
using System.Text.Json;

namespace Haas.Hosty.Core;

/// <summary>Stable tool identity, independent of labels, order and runtime browser origins.</summary>
internal static class PanelIdentity
{
    public static bool IsExplicitId(string id)
        => id.Length is > 0 and <= 64 && id[0] is >= 'a' and <= 'z'
           && !id.StartsWith("legacy-", StringComparison.Ordinal)
           && id.All(c => c is >= 'a' and <= 'z' or >= '0' and <= '9' or '-');

    public static string Installation(AppRecord app) => app.InstalledAt.ToString("O");

    public static string Resolve(AppSurfaceContract panel, string? effectiveEndpoint)
    {
        if (panel.Id is { } id) return id;
        using var stream = new MemoryStream();
        using (var writer = new Utf8JsonWriter(stream))
        {
            writer.WriteStartArray();
            writer.WriteStringValue(effectiveEndpoint ?? panel.EndpointKey);
            writer.WriteStringValue(panel.Path);
            writer.WriteEndArray();
        }
        return "legacy-" + Convert.ToHexStringLower(SHA256.HashData(stream.ToArray()));
    }
}
