using System.Text.Json.Nodes;

namespace Haas.Hosty.Core;

internal static class AppCreationBootstrap
{
    internal static IReadOnlyDictionary<string, string> Files(string appId, string name, string? description, bool hasIcon = false)
    {
        var files = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var file in new[] { "manifest.json", "package.json", "gitignore", "index.html", "client.tsx", "server.ts", "auth.ts" })
        {
            using var stream = typeof(AppCreationBootstrap).Assembly.GetManifestResourceStream("Hosty.AppBootstrap." + file)
                ?? throw new InvalidOperationException("Bootstrap resource is missing: " + file);
            using var reader = new StreamReader(stream);
            files[file == "gitignore" ? ".gitignore" : file] = reader.ReadToEnd();
        }
        var manifest = JsonNode.Parse(files["manifest.json"])!.AsObject();
        manifest["id"] = appId;
        manifest["name"] = name;
        manifest["description"] = description;
        if (hasIcon) manifest["catalogMetadata"] = new JsonObject { ["icon"] = "icon.png" };
        files["manifest.json"] = manifest.ToJsonString(JsonStorage.Options) + "\n";
        return files;
    }
}
