using System.Diagnostics;
using System.Text.Json;

namespace Haas.Hosty.Core;

internal sealed class StorageUsageScanner(CoreDataPaths paths, IStorageFileSystem fileSystem, IClock clock)
{
    internal const int MaximumResources = 10_000;
    internal const int MaximumIssues = 100;
    internal const int MaximumEntries = 2_000_000;
    internal static readonly TimeSpan MaximumDuration = TimeSpan.FromMinutes(2);
    internal static readonly string[] Categories = ["apps", "sources", "environments", "backups", "core", "other"];

    public Task<StorageUsageSnapshot> ScanAsync(CancellationToken ct = default)
    {
        var started = clock.UtcNow;
        var timer = Stopwatch.StartNew();
        var resources = new Dictionary<string, MutableResource>(StringComparer.Ordinal);
        var inodes = new HashSet<(ulong Device, ulong Inode, ulong InodeHigh)>();
        var issues = new List<StorageUsageIssue>();
        var labels = new Dictionary<string, string>(StringComparer.Ordinal);
        var associations = new Dictionary<string, HashSet<string>>(StringComparer.Ordinal);
        var workspaces = new Dictionary<string, (string? Name, string? WorkspaceId)>(StringComparer.Ordinal);
        var environmentLabels = new Dictionary<string, string>(StringComparer.Ordinal);
        var workspaceNames = new Dictionary<string, string>(StringComparer.Ordinal);
        var environmentTrees = new Dictionary<string, string[]>(StringComparer.Ordinal);
        long symlinks = 0, mounts = 0;
        var issueCount = 0;
        var allocationAvailable = true;
        var entryCount = 0;
        var truncated = false;
        var metadataLimited = false;
        var metadataCount = 0;
        long metadataBytes = 0;

        void Issue(string path, string code)
        {
            issueCount++;
            if (issues.Count < MaximumIssues) issues.Add(new(path, code));
        }

        foreach (var entry in fileSystem.Walk(paths.DataRoot, ct))
        {
            ct.ThrowIfCancellationRequested();
            if (++entryCount > MaximumEntries || timer.Elapsed > MaximumDuration)
            { Issue("", "scan_limit"); truncated = true; break; }
            if (entry.SymbolicLink) { symlinks++; continue; }
            if (entry.Mount) { mounts++; continue; }
            var (category, kind, resourcePath, appId, part) = Classify(entry.RelativePath);
            if (!resources.TryGetValue(resourcePath, out var resource))
            {
                if (resources.Count >= MaximumResources)
                { Issue("", "resource_limit"); truncated = true; break; }
                resources[resourcePath] = resource = new(category, kind, resourcePath, appId);
            }
            if (entry.Error is { } error)
            {
                Issue(entry.RelativePath, error);
                resource.Partial = true;
                if (error == "scan_limit") { truncated = true; break; }
                if (error == "filesystem_metadata_unavailable" || entry.RelativePath.Length == 0 && error == "root_unreadable") allocationAvailable = false;
            }
            if (entry.Device == 0 && entry.Inode == 0 && entry.InodeHigh == 0) continue; // error-only observation
            if (entry.Metadata is { } document && !metadataLimited)
            {
                metadataBytes += document.LongLength;
                if (++metadataCount > MaximumResources || metadataBytes > 32 * 1024 * 1024)
                { metadataLimited = true; Issue("", "metadata_limit"); }
                try { if (!metadataLimited) ReadMetadata(entry.RelativePath, document, labels, associations, workspaces, environmentLabels, workspaceNames, environmentTrees); }
                catch (Exception ex) when (ex is JsonException or InvalidOperationException or ArgumentException)
                { Issue(entry.RelativePath, "metadata_invalid"); resource.Partial = true; }
            }
            // Shared files consume physical blocks only once across every category. Logical bytes use
            // the same identity rule so category/resource totals remain additive in both views.
            if (!inodes.Add((entry.Device, entry.Inode, entry.InodeHigh))) continue;
            resource.Add(part, entry.AllocatedBytes, entry.LogicalBytes);
        }

        foreach (var (environment, trees) in environmentTrees)
        {
            var related = trees.Where(t => associations.ContainsKey($"core/development/trees/{t}"))
                .SelectMany(t => associations[$"core/development/trees/{t}"]).ToHashSet(StringComparer.Ordinal);
            associations[$"environments/{environment}"] = related;
        }
        var output = resources.Values.Select(r =>
        {
            var name = r.AppId is { } id && labels.TryGetValue(id, out var appName) ? appName : LastSegment(r.Path);
            string? workspaceId = null, worktreeId = null;
            if (r.Kind == "worktree")
            {
                worktreeId = LastSegment(r.Path);
                if (workspaces.TryGetValue(worktreeId, out var tree))
                {
                    workspaceId = tree.WorkspaceId;
                    name = workspaceId is not null && workspaceNames.TryGetValue(workspaceId, out var workspaceName) ? workspaceName : tree.Name ?? name;
                }
            }
            if (r.Kind == "environment" && environmentLabels.TryGetValue(LastSegment(r.Path), out var environmentName)) name = environmentName;
            var related = associations.TryGetValue(r.Path, out var apps) ? apps.Order(StringComparer.Ordinal).ToArray() : [];
            if (r.Kind == "backup" && r.Path.Split('/') is { Length: >= 2 } backup) related = [backup[1]];
            if (r.Kind == "managed-source" && r.Path.Split('/') is { Length: >= 2 } managed)
            {
                related = related.Append(managed[1]).Distinct(StringComparer.Ordinal).Order(StringComparer.Ordinal).ToArray();
                name = labels.GetValueOrDefault(managed[1]) ?? managed[1];
            }
            return new StorageUsageResource(r.Path.Length == 0 ? "root" : r.Path, r.Category, r.Kind,
                r.Path.Length == 0 ? "Hosty" : name, r.Path, allocationAvailable ? r.Allocated : null, r.Logical,
                r.Partial || truncated, r.AppId, related, workspaceId, worktreeId,
                r.Parts.OrderBy(p => p.Key, StringComparer.Ordinal).Select(p => new StorageUsagePart(p.Key,
                    allocationAvailable ? p.Value.Allocated : null, p.Value.Logical)).ToArray());
        }).OrderByDescending(r => r.AllocatedBytes ?? r.LogicalBytes).ThenBy(r => r.Id, StringComparer.Ordinal).ToArray();
        var categories = Categories.Select(id => new StorageUsageCategory(id,
            allocationAvailable ? output.Where(r => r.Category == id).Sum(r => r.AllocatedBytes ?? 0) : null,
            output.Where(r => r.Category == id).Sum(r => r.LogicalBytes), truncated || !allocationAvailable || output.Any(r => r.Category == id && r.Partial))).ToArray();
        return Task.FromResult(new StorageUsageSnapshot(Guid.NewGuid().ToString("D"), started, clock.UtcNow,
            (long)timer.Elapsed.TotalMilliseconds, allocationAvailable ? output.Sum(r => r.AllocatedBytes ?? 0) : null,
            output.Sum(r => r.LogicalBytes), issueCount > 0, Capacity(), categories, output, issues.ToArray(),
            issueCount, symlinks, mounts));
    }

    private StorageDiskCapacity? Capacity()
    {
        try
        {
            var root = Path.GetFullPath(paths.DataRoot);
            var comparison = OperatingSystem.IsWindows() ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal;
            var drive = DriveInfo.GetDrives().Where(d => root.Equals(Path.TrimEndingDirectorySeparator(d.Name), comparison)
                || root.StartsWith(Path.EndsInDirectorySeparator(d.Name) ? d.Name : d.Name + Path.DirectorySeparatorChar, comparison))
                .OrderByDescending(d => d.Name.Length).FirstOrDefault();
            return drive is { IsReady: true } ? new(drive.TotalSize, drive.AvailableFreeSpace) : null;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or ArgumentException) { return null; }
    }

    private static (string Category, string Kind, string Path, string? AppId, string Part) Classify(string path)
    {
        var p = path.Split('/');
        if (path == "apps") return ("apps", "other", path, null, "installed");
        if (p[0] == "apps" && p.Length >= 2)
        {
            var app = p[1];
            if (p.Length >= 3 && p[2] == "source") return ("sources", "managed-source", $"apps/{app}/source", null, "source");
            var part = p.Length >= 3 ? p[2] switch { "data" => "data", "cache" => "cache", "logs" => "logs", _ => "installed" } : "installed";
            return ("apps", "app", $"apps/{app}", app, part);
        }
        if (p[0] == "sources") return ("sources", "repository", string.Join('/', p.Take(Math.Min(2, p.Length))), null, "source");
        if (p.Length >= 4 && p[0] == "core" && p[1] == "development" && p[2] is "trees" or "repositories")
            return ("sources", p[2] == "trees" ? "worktree" : "repository", string.Join('/', p.Take(4)), null, "source");
        if (p.Length >= 2 && p[0] == "core" && p[1] == "source")
            return ("sources", "repository", "core/source", null, "source");
        if (p.Length >= 2 && p[0] == "core" && p[1] == "sources")
            return ("sources", "repository", string.Join('/', p.Take(Math.Min(3, p.Length))), null, "source");
        if (p[0] == "environments") return ("environments", "environment", string.Join('/', p.Take(Math.Min(2, p.Length))), null, "environment");
        if (p[0] == "backups") return ("backups", "backup", string.Join('/', p.Take(Math.Min(3, p.Length))), null, "backup");
        if (p[0] == "core") return ("core", "core", string.Join('/', p.Take(Math.Min(2, p.Length))), null, "core");
        return ("other", "other", p[0], null, "other");
    }

    private void ReadMetadata(string path, byte[] bytes, Dictionary<string, string> labels,
        Dictionary<string, HashSet<string>> associations, Dictionary<string, (string?, string?)> workspaces,
        Dictionary<string, string> environments, Dictionary<string, string> workspaceNames, Dictionary<string, string[]> environmentTrees)
    {
        using var document = JsonDocument.Parse(bytes);
        var root = document.RootElement;
        var p = path.Split('/');
        static string? Text(JsonElement node, string key) => node.TryGetProperty(key, out var value) && value.ValueKind == JsonValueKind.String
            && value.GetString() is { Length: <= 2048 } text ? text : null;
        void Associate(string? relative, string app)
        {
            if (relative is null) return;
            if (!associations.TryGetValue(relative, out var ids)) associations[relative] = ids = new(StringComparer.Ordinal);
            ids.Add(app);
        }
        if (p[0] == "apps" && root.TryGetProperty("app", out var record) && Text(record, "id") == p[1])
        {
            if (Text(record, "displayName") is { } display) labels[p[1]] = display;
            Associate($"apps/{p[1]}/source", p[1]);
            if (record.TryGetProperty("sourceState", out var source) && source.ValueKind == JsonValueKind.Object)
                foreach (var key in new[] { "managedCheckoutPath", "localOverridePath" })
                    if (Text(source, key) is { } sourcePath && Relative(sourcePath) is { } relative)
                        Associate(Classify(relative).Path, p[1]);
        }
        else if (p.Length == 4 && p[1] == "development" && p[2] == "metadata")
        {
            if (Text(root, "name") is { } name) workspaceNames[Path.GetFileNameWithoutExtension(p[^1])] = name;
        }
        else if (p.Length == 4 && p[1] == "development" && p[2] == "workspaces")
        {
            var id = Path.GetFileNameWithoutExtension(p[^1]);
            if (Text(root, "id") != id) return;
            var workspaceId = Text(root, "workspaceId");
            workspaces[id] = (Text(root, "name"), workspaceId);
            var treePath = $"core/development/trees/{id}";
            var repoId = Text(root, "repositoryId");
            if (root.TryGetProperty("apps", out var apps) && apps.ValueKind == JsonValueKind.Array)
                foreach (var app in apps.EnumerateArray().Take(256))
                    if (Text(app, "appId") is { } appId)
                    {
                        Associate(treePath, appId);
                        if (repoId is not null) Associate($"core/development/repositories/{repoId}.git", appId);
                    }
        }
        else if (p.Length == 3 && p[1] == "environments" && root.TryGetProperty("request", out var request))
        {
            var id = Path.GetFileNameWithoutExtension(p[^1]);
            if (Text(root, "id") == id && Text(request, "label") is { } label) environments[id] = label;
            if (Text(root, "id") == id && request.TryGetProperty("worktreeIds", out var trees) && trees.ValueKind == JsonValueKind.Array)
                environmentTrees[id] = trees.EnumerateArray().Take(256).Where(t => t.ValueKind == JsonValueKind.String && t.GetString()!.Length <= 2048).Select(t => t.GetString()!).ToArray();
        }
        // Backup ownership is projected from its containing app-id directory, independently of whether
        // that app is still installed. It is a relation, not part of the app's own storage total.
    }

    private string? Relative(string path)
    {
        var relative = Path.GetRelativePath(Path.GetFullPath(paths.DataRoot), Path.GetFullPath(path)).Replace(Path.DirectorySeparatorChar, '/');
        return relative == ".." || relative.StartsWith("../", StringComparison.Ordinal) || Path.IsPathRooted(relative) ? null : relative;
    }
    private static string LastSegment(string path) => path[(path.LastIndexOf('/') + 1)..];
    private sealed class MutableResource(string category, string kind, string path, string? appId)
    {
        public string Category { get; } = category;
        public string Kind { get; } = kind;
        public string Path { get; } = path;
        public string? AppId { get; } = appId;
        public long Allocated, Logical;
        public bool Partial;
        public Dictionary<string, (long Allocated, long Logical)> Parts { get; } = new(StringComparer.Ordinal);
        public void Add(string part, long allocated, long logical)
        {
            Allocated = checked(Allocated + allocated); Logical = checked(Logical + logical);
            var previous = Parts.GetValueOrDefault(part);
            Parts[part] = (checked(previous.Allocated + allocated), checked(previous.Logical + logical));
        }
    }
}
