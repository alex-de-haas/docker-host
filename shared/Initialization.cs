using System.Text.Json;
using System.Text.Json.Serialization;

namespace Haas.Hosty.Initialization;

internal sealed record InitializationPort(string AppId, string Service, string PortKey, int Port);
internal sealed record InitializationRequest(string RequestId, string[] Apps,
    InitializationPort[]? Ports = null, string SchemaVersion = "hosty-initialization.0.1");
internal sealed record InitializationAppStatus(string Id, string Title, string State,
    string? Version = null, string? Error = null);
internal sealed record InitializationStatus(string SchemaVersion, string Phase, string? RequestId,
    string[] SelectedApps, IReadOnlyList<InitializationAppStatus> Apps, bool HasAdministrator,
    bool RecoveryRequired, string CoreUrl, string? ShellUrl, string? Error = null, InitializationRequest? Request = null);

// Shared by the local launcher and Core. The intent marker suppresses legacy first-boot seeding
// before an app selection exists. It contains no credentials, app selection or completion claim.
internal static class InitializationFiles
{
    public const string Schema = "hosty-initialization.0.1";
    public static string IntentPath(string root) => Path.Combine(root, "core", "initialization.requested");
    public static string StatePath(string root) => Path.Combine(root, "core", "initialization.json");
    public static bool Requested(string root) => File.Exists(IntentPath(root)) || File.Exists(StatePath(root));
    public static void Request(string root)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(IntentPath(root))!);
        using var file = new FileStream(IntentPath(root), FileMode.OpenOrCreate, FileAccess.Write, FileShare.Read);
    }
    public static bool HasHistory(string root)
    {
        var core = Path.Combine(root, "core");
        if (File.Exists(Path.Combine(core, "distribution-seed.json")) || File.Exists(Path.Combine(core, "bootstrap-choices.json"))) return true;
        var apps = Path.Combine(root, "apps");
        if (Directory.Exists(apps) && Directory.EnumerateDirectories(apps).Any(path => File.Exists(Path.Combine(path, "state.json")))) return true;
        var auth = Path.Combine(core, "auth", "state.json");
        if (!File.Exists(auth)) return false;
        // An unreadable existing account store is an error, never permission to replace identity.
        using var document = JsonDocument.Parse(File.ReadAllBytes(auth));
        return document.RootElement.TryGetProperty("users", out var users) && users.GetArrayLength() > 0;
    }
    public static bool CanStart(string root)
    {
        if (!Requested(root)) return HasHistory(root);
        if (!File.Exists(StatePath(root))) return false;
        using var document = JsonDocument.Parse(File.ReadAllBytes(StatePath(root)));
        if (!document.RootElement.TryGetProperty("schemaVersion", out var schema) || schema.ValueKind != JsonValueKind.String || schema.GetString() != Schema
            || !document.RootElement.TryGetProperty("phase", out var phase) || phase.ValueKind != JsonValueKind.String
            || phase.GetString() is not ("pending" or "preparing" or "failed" or "ready"))
            throw new IOException("Unsupported initialization state. Preserve this data root and use a compatible Hosty version.");
        return phase.GetString() == "ready";
    }
}

[JsonSourceGenerationOptions(PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase, PropertyNameCaseInsensitive = true)]
[JsonSerializable(typeof(InitializationRequest))]
[JsonSerializable(typeof(InitializationStatus))]
internal partial class InitializationJson : JsonSerializerContext;
