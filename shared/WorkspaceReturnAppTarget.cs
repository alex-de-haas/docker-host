using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace Haas.Hosty.Launch;

// Shared by the helper observation and Core's guarded lifecycle action. Mutable runtime state and
// artifact resolution timestamps are deliberately excluded; installation/source identity is not.
internal static class WorkspaceReturnAppTarget
{
    internal static string Fingerprint(JsonElement app)
    {
        var fields = new[] { "id", "installationId", "selectedRuntime", "sourceOverridePath", "sourceLivePath", "version" };
        var value = string.Join("\n", fields.Select(key => key + ":" + Text(app, key)));
        if (app.TryGetProperty("devMode", out var dev) && dev.ValueKind == JsonValueKind.Object) value += "\ndev:" + Text(dev, "operationId");
        if (app.TryGetProperty("artifactLocks", out var artifacts) && artifacts.ValueKind == JsonValueKind.Object)
            foreach (var entry in artifacts.EnumerateObject().OrderBy(p => p.Name, StringComparer.Ordinal))
                foreach (var key in new[] { "kind", "imageDigest", "bundleHash", "commit", "resolvedFromRef" }) value += "\n" + entry.Name + ":" + key + ":" + Text(entry.Value, key);
        return Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(value)));
    }

    private static string? Text(JsonElement value, string key)
        => value.TryGetProperty(key, out var field) && field.ValueKind == JsonValueKind.String ? field.GetString() : null;
}
