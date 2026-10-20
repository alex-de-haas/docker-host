using System.IO.Compression;
using System.Security.Cryptography;
using System.Text.Json.Serialization;

namespace Haas.Hosty.Launch;

internal sealed record CoreStateSnapshotRecord(string Id, string Archive, string Sha256, int Files, DateTimeOffset CreatedAt);
internal static class CoreStateSnapshot
{
    // Ordinary app data and sources are deliberately outside this snapshot. App writers can stay
    // alive while Core-owned stores and app installation metadata are copied under the root lock.
    private static readonly HashSet<string> ExcludedCore = new(StringComparer.OrdinalIgnoreCase)
        { "run", "logs", "builds", "bin", "source", "sources", "workspace-activations", "workspace-snapshots" };
    private static readonly HashSet<string> ExcludedDevelopment = new(StringComparer.OrdinalIgnoreCase)
        { "trees", "repositories" };
    private static string DirectoryFor(string root) => Path.Combine(root, "core", "workspace-snapshots");
    internal static void Preflight(string root)
    {
        var directory = DirectoryFor(root);
        RejectLink(root);
        RejectLink(Path.Combine(root, "core"));
        if (Directory.Exists(directory) || new DirectoryInfo(directory).LinkTarget is not null) RejectLink(directory);
        Directory.CreateDirectory(directory);
        RejectLink(directory);
        if (!OperatingSystem.IsWindows()) File.SetUnixFileMode(directory, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
        var probe = Path.Combine(directory, ".probe-" + Guid.NewGuid().ToString("N"));
        using (new FileStream(probe, FileMode.CreateNew, FileAccess.Write, FileShare.None)) { }
        File.Delete(probe);
        _ = Entries(root).ToArray();
    }

    internal static CoreStateSnapshotRecord Create(string root, string id)
    {
        _ = WorkspaceRuntimeFiles.PathFor(root, id);
        // Core holds this file for its entire lifetime, independently of the CLI launch lock.
        using var stopped = new FileStream(Path.Combine(root, "core", "run", "core.lock"), FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None);
        Preflight(root);
        var archive = Path.Combine(DirectoryFor(root), id + ".zip");
        var metadata = archive + ".json";
        if (File.Exists(metadata))
        {
            RejectLink(metadata);
            RejectLink(archive);
            var existing = CoreLaunchFiles.Read(metadata, CoreStateSnapshotJson.Default.CoreStateSnapshotRecord)!;
            if (existing.Id != id || existing.Archive != archive || Digest(archive) != existing.Sha256)
                throw new IOException("The retained Core snapshot is missing or changed.");
            return existing;
        }
        if (File.Exists(archive) || new FileInfo(archive).LinkTarget is not null)
            throw new IOException("A Core snapshot without its receipt already exists; retain it for recovery.");
        var temporary = archive + "." + Guid.NewGuid().ToString("N") + ".incomplete";
        try
        {
            var entries = Entries(root).ToArray();
            using (var stream = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None))
            {
                if (!OperatingSystem.IsWindows()) File.SetUnixFileMode(temporary, UnixFileMode.UserRead | UnixFileMode.UserWrite);
                using var zip = new ZipArchive(stream, ZipArchiveMode.Create);
                foreach (var file in entries)
                    zip.CreateEntryFromFile(file, Path.GetRelativePath(root, file).Replace('\\', '/'), CompressionLevel.Optimal);
            }
            using (var zip = ZipFile.OpenRead(temporary))
            {
                if (zip.Entries.Count != entries.Length) throw new IOException("Core snapshot coverage could not be verified.");
                foreach (var entry in zip.Entries)
                {
                    using var input = entry.Open();
                    using var source = File.OpenRead(Path.Combine(root, entry.FullName));
                    if (!SHA256.HashData(input).SequenceEqual(SHA256.HashData(source))) throw new IOException("Core state changed while taking its snapshot.");
                }
            }
            File.Move(temporary, archive);
            var record = new CoreStateSnapshotRecord(id, archive, Digest(archive), entries.Length, DateTimeOffset.UtcNow);
            CoreLaunchFiles.Write(metadata, record, CoreStateSnapshotJson.Default.CoreStateSnapshotRecord);
            return record;
        }
        finally { File.Delete(temporary); }
    }

    private static string Digest(string path) { using var file = File.OpenRead(path); return Convert.ToHexString(SHA256.HashData(file)); }
    private static void RejectLink(string path)
    {
        if ((File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0) throw new IOException("Core snapshot refuses linked state paths.");
    }
    private static IEnumerable<string> Entries(string root)
    {
        IEnumerable<string> Walk(string directory)
        {
            RejectLink(directory);
            foreach (var path in Directory.EnumerateFileSystemEntries(directory).Order(StringComparer.Ordinal))
            {
                var relative = Path.GetRelativePath(Path.Combine(root, "core"), path).Replace('\\', '/');
                var segments = relative.Split('/');
                if (ExcludedCore.Contains(segments[0]) || segments.Length > 1 && segments[0] == "development" && ExcludedDevelopment.Contains(segments[1])) continue;
                RejectLink(path);
                if (Directory.Exists(path)) { foreach (var nested in Walk(path)) yield return nested; }
                else yield return path;
            }
        }
        foreach (var path in Walk(Path.Combine(root, "core"))) yield return path;
        var apps = Path.Combine(root, "apps");
        if (!Directory.Exists(apps)) yield break;
        RejectLink(apps);
        foreach (var app in Directory.EnumerateDirectories(apps).Order(StringComparer.Ordinal))
        {
            RejectLink(app);
            foreach (var name in new[] { "state.json", "manifest.json", "secrets.json" })
                if (File.Exists(Path.Combine(app, name))) { RejectLink(Path.Combine(app, name)); yield return Path.Combine(app, name); }
        }
    }
}
[JsonSourceGenerationOptions(PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase)]
[JsonSerializable(typeof(CoreStateSnapshotRecord))]
internal partial class CoreStateSnapshotJson : JsonSerializerContext;
