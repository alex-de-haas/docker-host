using System.Diagnostics;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace Haas.Hosty.Launch;

internal sealed record CoreBuildGeneration(string Id, string State, DateTimeOffset CreatedAt,
    int OwnerPid, DateTimeOffset OwnerStartedAt, string? ProjectPath = null);

// Only directories with our versioned marker are eligible. Uncertain ownership or surviving
// runner references disable deletion; cleanup is never a reason to fail a successful launch.
internal static class CoreBuildRetention
{
    public const string Marker = "generation-v1.json";
    public static void Mark(string path, string state, string? project, int? ownerPid = null, DateTimeOffset? started = null)
    {
        using var owner = ownerPid is { } pid ? Process.GetProcessById(pid) : Process.GetCurrentProcess();
        var previous = CoreLaunchFiles.Read(Path.Combine(path, Marker), CoreLaunchJson.Default.CoreBuildGeneration);
        var record = new CoreBuildGeneration(Path.GetFileName(path), state, previous?.CreatedAt ?? DateTimeOffset.UtcNow,
            owner.Id, started ?? owner.StartTime.ToUniversalTime(), project);
        CoreLaunchFiles.Write(Path.Combine(path, Marker), record, CoreLaunchJson.Default.CoreBuildGeneration);
    }

    public static bool IsAlive(int pid, DateTimeOffset started)
    {
        try { using var process = Process.GetProcessById(pid); return !process.HasExited && Math.Abs((process.StartTime.ToUniversalTime() - started.UtcDateTime).TotalMilliseconds) < 100; }
        catch (ArgumentException) { return false; }
        // An inaccessible process is not evidence of death.
    }

    private static bool ContainsLink(string directory)
    {
        foreach (var path in Directory.EnumerateFileSystemEntries(directory))
        {
            var attributes = File.GetAttributes(path);
            if ((attributes & FileAttributes.ReparsePoint) != 0) return true;
            if ((attributes & FileAttributes.Directory) != 0 && ContainsLink(path)) return true;
        }
        return false;
    }

    public static void Cleanup(string root)
    {
        try
        {
            var builds = Path.Combine(root, "core", "builds");
            if (!Directory.Exists(builds)) return;
            if (new DirectoryInfo(builds).LinkTarget is not null)
            {
                Console.Error.WriteLine($"[core builds] Skipping linked build root: {builds}");
                return;
            }
            var candidates = new List<(string Path, CoreBuildGeneration Record)>();
            foreach (var path in Directory.EnumerateDirectories(builds))
            {
                if (new DirectoryInfo(path).LinkTarget is not null)
                {
                    Console.Error.WriteLine($"[core builds] Skipping linked generation: {path}");
                    continue;
                }
                var record = CoreLaunchFiles.Read(Path.Combine(path, Marker), CoreLaunchJson.Default.CoreBuildGeneration);
                if (record is null || record.Id != Path.GetFileName(path) || !Guid.TryParseExact(record.Id, "N", out _)) continue;
                if (record.State is not ("building" or "prepared" or "starting" or "ready" or "failed" or "runner"))
                {
                    Console.Error.WriteLine($"[core builds] Skipping unrecognized generation state: {path}");
                    continue;
                }
                candidates.Add((path, record));
            }
            var keep = new HashSet<string>(OperatingSystem.IsWindows() ? StringComparer.OrdinalIgnoreCase : StringComparer.Ordinal);
            foreach (var item in candidates.Where(x => x.Record.State == "ready").OrderByDescending(x => x.Record.CreatedAt).Take(2)) keep.Add(item.Path);
            foreach (var item in candidates.Where(x => x.Record.State == "failed").OrderByDescending(x => x.Record.CreatedAt).Take(1)) keep.Add(item.Path);
            foreach (var item in candidates.Where(x => x.Record.State is "building" or "prepared" or "starting").OrderByDescending(x => x.Record.CreatedAt).Take(1)) keep.Add(item.Path);
            foreach (var item in candidates)
                if (IsAlive(item.Record.OwnerPid, item.Record.OwnerStartedAt)) keep.Add(item.Path);
            var apps = Path.Combine(root, "apps");
            if (Directory.Exists(apps))
                foreach (var app in Directory.EnumerateDirectories(apps))
                {
                    var run = Path.Combine(app, "run");
                    if (!Directory.Exists(run)) continue;
                    foreach (var path in Directory.EnumerateFiles(run, "*.json"))
                    {
                        using var json = JsonDocument.Parse(File.ReadAllText(path));
                        var value = json.RootElement;
                        if (!value.TryGetProperty("runnerGeneration", out var generation) || generation.ValueKind != JsonValueKind.String) continue;
                        if (value.TryGetProperty("pid", out var pid) && value.TryGetProperty("startedAtUtc", out var started)
                            && IsAlive(pid.GetInt32(), started.GetDateTimeOffset())) keep.Add(generation.GetString()!);
                    }
                }
            foreach (var item in candidates)
                if (!keep.Contains(item.Path))
                {
                    // Never traverse a link planted anywhere in an output tree.
                    if (ContainsLink(item.Path))
                    {
                        Console.Error.WriteLine($"[core builds] Skipping generation containing links: {item.Path}");
                        continue;
                    }
                    try { Directory.Delete(item.Path, true); }
                    catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
                    {
                        Console.Error.WriteLine($"[core builds] Retaining {item.Path}: {ex.Message}");
                    }
                }
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or JsonException or InvalidOperationException or System.ComponentModel.Win32Exception)
        {
            Console.Error.WriteLine($"[core builds] Cleanup skipped because ownership could not be verified: {ex.Message}");
        }
    }
}
