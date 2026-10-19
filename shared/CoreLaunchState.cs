using System.Diagnostics;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace Haas.Hosty.Launch;

internal sealed record CoreLaunchIdentity(string Mode, string? ProjectPath, string? GenerationPath, int ProcessId, DateTimeOffset StartedAt)
{
    public static CoreLaunchIdentity Current()
    {
        var mode = Environment.GetEnvironmentVariable("HOSTY_CORE_LAUNCH_MODE") ?? "unmanaged";
        var project = Environment.GetEnvironmentVariable("HOSTY_CORE_PROJECT");
        var generation = Environment.GetEnvironmentVariable("HOSTY_CORE_GENERATION");
        return new(mode, string.IsNullOrWhiteSpace(project) ? null : project,
            string.IsNullOrWhiteSpace(generation) ? null : generation, Environment.ProcessId,
            Process.GetCurrentProcess().StartTime.ToUniversalTime());
    }
}

internal sealed record CoreSourceSettings(string? OverridePath, string Revision, string? PendingForInstance = null,
    string? RepositoryUrl = null, string? Ref = null,
    string ProjectPath = CoreSourceDefaults.ProjectPath, bool LegacyCheckout = true, int SchemaVersion = 0,
    string? ConnectionOwnerId = null, string? ConnectionId = null);

internal static class CoreSourceDefaults
{
    public const string ProjectPath = "apps/core/src/Haas.Hosty.Core/Haas.Hosty.Core.csproj";
    public const string UpdateRepository = "https://github.com/alex-de-haas/docker-host";
}
internal sealed record CoreLaunchOperation(string Id, string Status, string Mode, string? ProjectPath,
    DateTimeOffset CreatedAt, string? SourceRevision = null, string? Error = null, string? LogPath = null,
    string? GenerationPath = null, int? HelperPid = null, DateTimeOffset? HelperStartedAt = null);

internal static class CoreLaunchFiles
{
    public static string OperationPath(string root, string id)
    {
        if (!Guid.TryParseExact(id, "N", out _)) throw new ArgumentException("Operation id must be a UUID without hyphens.");
        return Path.Combine(root, "core", "operations", id + ".json");
    }
    public static string SourcePath(string root) => Path.Combine(root, "core", "source-settings.json");
    public static T? Read<T>(string path, System.Text.Json.Serialization.Metadata.JsonTypeInfo<T> type)
    {
        if (!File.Exists(path)) return default;
        // A receipt is replaced atomically. Readers retain their old snapshot without preventing
        // another process from publishing its next version on Windows.
        using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
        return JsonSerializer.Deserialize(stream, type);
    }
    public static void Write<T>(string path, T value, System.Text.Json.Serialization.Metadata.JsonTypeInfo<T> type)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        var temp = path + "." + Guid.NewGuid().ToString("N") + ".tmp";
        try
        {
            File.WriteAllText(temp, JsonSerializer.Serialize(value, type));
            if (!OperatingSystem.IsWindows()) File.SetUnixFileMode(temp, UnixFileMode.UserRead | UnixFileMode.UserWrite);
            ReplaceWithSharingRetry(temp, path);
        }
        finally { if (File.Exists(temp)) File.Delete(temp); }
    }
    private static void ReplaceWithSharingRetry(string temp, string path)
    {
        var started = Stopwatch.StartNew();
        while (true)
        {
            try { File.Move(temp, path, true); return; }
            catch (IOException error) when (OperatingSystem.IsWindows() && (error.HResult & 0xffff) is 32 or 33)
            {
                // Legacy/external readers can omit delete sharing. Retry only that transient
                // replacement conflict; ACL, path and other I/O failures retain their original error.
                var remaining = TimeSpan.FromSeconds(2) - started.Elapsed;
                if (remaining <= TimeSpan.Zero) throw;
                Thread.Sleep(remaining < TimeSpan.FromMilliseconds(20) ? remaining : TimeSpan.FromMilliseconds(20));
            }
        }
    }

    public static void AssertNoPendingOperations(string root, string? ownId = null, string? ownWorkspaceId = null)
    {
        WorkspaceActivationSupervisor.AssertNoPending(root, ownWorkspaceId);
        var directory = Path.Combine(root, "core", "operations");
        if (!Directory.Exists(directory)) return;
        foreach (var path in Directory.EnumerateFiles(directory, "*.json"))
        {
            var operation = Read(path, CoreLaunchJson.Default.CoreLaunchOperation);
            if (operation is null || operation.Id == ownId || operation.Status is not ("accepted" or "building" or "starting")) continue;
            if (operation.HelperPid is { } pid && operation.HelperStartedAt is { } started && !CoreBuildRetention.IsAlive(pid, started)
                || operation.HelperPid is null && DateTimeOffset.UtcNow - operation.CreatedAt > TimeSpan.FromMinutes(2))
            {
                Write(path, operation with { Status = "failed", Error = "The restart helper no longer runs; inspect its log before recovery." }, CoreLaunchJson.Default.CoreLaunchOperation);
                continue;
            }
            throw new InvalidOperationException($"Core operation {operation.Id} is still pending; inspect its status and log before retrying.");
        }
    }

    public static FileStream Lock(string root)
    {
        var path = Path.Combine(root, "core", "run", "launch.lock");
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        return new FileStream(path, FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None);
    }
}

[JsonSourceGenerationOptions(PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase)]
[JsonSerializable(typeof(CoreBuildGeneration))]
[JsonSerializable(typeof(CoreLaunchIdentity))]
[JsonSerializable(typeof(CoreLaunchOperation))]
[JsonSerializable(typeof(CoreSourceSettings))]
internal partial class CoreLaunchJson : JsonSerializerContext;
