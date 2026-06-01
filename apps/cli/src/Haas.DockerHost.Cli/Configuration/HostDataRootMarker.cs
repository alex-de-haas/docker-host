namespace Haas.DockerHost.Cli.Configuration;

using System.Text.Json;
using System.Text.Json.Nodes;

internal sealed record HostDataRootMarker(string Id, string Path)
{
    public const string FileName = ".docker-host-root.json";
    public const string EnvironmentVariable = "HOST_DATA_ROOT_MARKER";
    private const string SchemaVersion = "0.1";

    public static HostDataRootMarker Ensure(string dataRoot, string? expectedId = null)
    {
        var markerPath = System.IO.Path.Combine(dataRoot, FileName);
        if (File.Exists(markerPath))
        {
            var existingId = ReadExistingId(markerPath);
            if (!string.IsNullOrWhiteSpace(expectedId) &&
                !string.Equals(existingId, expectedId.Trim(), StringComparison.Ordinal))
            {
                throw new ConfigurationException(
                    $"Host data root marker '{markerPath}' does not match the existing Host container. " +
                    "Verify HOST_DATA_ROOT_HOST points at the expected data root, then run 'docker-host restart' again.");
            }

            return new HostDataRootMarker(existingId, markerPath);
        }

        if (!string.IsNullOrWhiteSpace(expectedId))
        {
            throw new ConfigurationException(
                $"Host data root marker '{markerPath}' is missing, but the existing Host container expects it. " +
                "The configured data root may not be mounted yet. Verify the disk or mount, then run 'docker-host restart' again.");
        }

        Directory.CreateDirectory(dataRoot);
        var id = "root_" + Guid.NewGuid().ToString("D");
        var marker = new JsonObject
        {
            ["schemaVersion"] = SchemaVersion,
            ["id"] = id,
            ["createdAt"] = DateTimeOffset.UtcNow.ToString("O"),
        };
        var json = marker.ToJsonString(new JsonSerializerOptions { WriteIndented = true }) + Environment.NewLine;
        File.WriteAllText(markerPath, json);

        return new HostDataRootMarker(id, markerPath);
    }

    private static string ReadExistingId(string markerPath)
    {
        try
        {
            using var parsed = JsonDocument.Parse(File.ReadAllText(markerPath));
            if (parsed.RootElement.ValueKind == JsonValueKind.Object &&
                parsed.RootElement.TryGetProperty("id", out var idElement) &&
                idElement.ValueKind == JsonValueKind.String)
            {
                var id = idElement.GetString();
                if (!string.IsNullOrWhiteSpace(id))
                {
                    return id.Trim();
                }
            }
        }
        catch (Exception ex) when (ex is JsonException or IOException or UnauthorizedAccessException)
        {
            throw new ConfigurationException($"Unable to read Host data root marker '{markerPath}': {ex.Message}", ex);
        }

        throw new ConfigurationException($"Host data root marker '{markerPath}' must contain a non-empty id.");
    }
}
