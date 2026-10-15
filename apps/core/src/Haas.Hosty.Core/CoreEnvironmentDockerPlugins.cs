using System.Text.Json.Nodes;

namespace Haas.Hosty.Core;

internal static class CoreEnvironmentDockerPlugins
{
    internal static async Task ConfigureAsync(string childHome, string inventory, CancellationToken ct = default)
    {
        var plugins = JsonNode.Parse(inventory) as JsonArray;
        var directories = (plugins ?? []).OfType<JsonObject>()
            .Select(plugin => plugin["Path"]?.GetValue<string>())
            .Where(path => path is not null && Path.IsPathFullyQualified(path) && File.Exists(path))
            .Select(path => Path.GetDirectoryName(path!)!).Distinct(StringComparer.Ordinal).ToArray();
        if (directories.Length == 0) return;

        var directory = Path.Combine(childHome, ".docker");
        var path = Path.Combine(directory, "config.json");
        // Preserve settings and credentials explicitly configured inside this child. Only paths
        // from Docker's public CLI plugin inventory are imported from its parent.
        var config = File.Exists(path) ? JsonNode.Parse(await File.ReadAllTextAsync(path, ct))!.AsObject() : new JsonObject();
        var existing = config["cliPluginsExtraDirs"]?.AsArray()
            .Select(value => value!.GetValue<string>()) ?? [];
        config["cliPluginsExtraDirs"] = new JsonArray(existing.Concat(directories)
            .Distinct(StringComparer.Ordinal).Select(value => (JsonNode?)JsonValue.Create(value)).ToArray());
        await JsonStorage.WriteOwnerFileAsync(path, config, ct);
    }
}
