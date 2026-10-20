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
    // Bound the lock table while serializing same-path publishers within this process. Windows
    // ReplaceFile's backup/unlink sequence can fail when multiple replacements race each other.
    private static readonly object[] PublicationGates = Enumerable.Range(0, 64).Select(_ => new object()).ToArray();

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
        }
        catch
        {
            if (File.Exists(temp)) File.Delete(temp);
            throw;
        }
        PublishTemporaryFile(temp, path);
    }

    // Takes ownership of the complete temporary file, including cleanup or retention after a
    // partial Windows replacement. Callers finish serialization and set permissions beforehand.
    internal static void PublishTemporaryFile(string temp, string path)
    {
        var comparer = OperatingSystem.IsWindows() ? StringComparer.OrdinalIgnoreCase : StringComparer.Ordinal;
        var gate = PublicationGates[comparer.GetHashCode(Path.GetFullPath(path)) & (PublicationGates.Length - 1)];
        lock (gate) PublishTemporaryFileCore(temp, path);
    }

    private static void PublishTemporaryFileCore(string temp, string path)
    {
        var backup = OperatingSystem.IsWindows() ? temp + ".previous" : null;
        var preserveRecovery = false;
        try
        {
            try { ReplaceWithSharingRetry(temp, path, backup); }
            catch (IOException error) when (OperatingSystem.IsWindows() && (error.HResult & 0xffff) is 1176 or 1177)
            {
                preserveRecovery = true;
                RecoverPartialReplacement(path, temp, backup!, error);
                preserveRecovery = false;
                throw;
            }
            if (backup is not null && File.Exists(backup)) File.Delete(backup);
        }
        finally { if (!preserveRecovery && File.Exists(temp)) File.Delete(temp); }
    }

    internal static void RecoverPartialReplacement(string path, string temp, string backup, IOException error)
    {
        Exception? restoreError = null;
        if (File.Exists(backup) && !File.Exists(path))
        {
            try { File.Move(backup, path, overwrite: false); return; }
            catch (Exception failure) when (failure is IOException or UnauthorizedAccessException) { restoreError = failure; }
        }
        // ReplaceFile documents that 1176 retains the old name when a backup was requested.
        if ((error.HResult & 0xffff) == 1176 && File.Exists(path) && !File.Exists(backup)) return;
        throw new IOException($"Receipt replacement failed. Retained recovery files: previous '{backup}', candidate '{temp}', destination '{path}'. No newer receipt was overwritten.",
            restoreError is null ? error : new AggregateException(error, restoreError));
    }

    private static void ReplaceWithSharingRetry(string temp, string path, string? backup)
    {
        var started = Stopwatch.StartNew();
        while (true)
        {
            try
            {
                // MoveFileEx cannot overwrite an open destination even when its readers share
                // delete access. ReplaceFile supports that sharing and preserves the existing ACL.
                if (OperatingSystem.IsWindows() && File.Exists(path)) File.Replace(temp, path, backup, ignoreMetadataErrors: false);
                else File.Move(temp, path, overwrite: !OperatingSystem.IsWindows());
                return;
            }
            catch (IOException error) when (OperatingSystem.IsWindows() && ((error.HResult & 0xffff) is 32 or 33 ||
                (error.HResult & 0xffff) is 80 or 183 && File.Exists(temp) && File.Exists(path)))
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
