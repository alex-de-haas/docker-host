namespace Haas.Hosty.Core;

internal sealed record CoreDataPaths(
    string DataRoot,
    string CoreRoot,
    string AppsRoot,
    string BackupsRoot,
    string SourcesRoot,
    string AuthRoot,
    string AuditLogPath)
{
    public static CoreDataPaths FromConfig(HostyCoreRuntimeConfig config)
    {
        var coreRoot = Path.Combine(config.DataRoot, "core");
        return new CoreDataPaths(
            config.DataRoot,
            coreRoot,
            Path.Combine(config.DataRoot, "apps"),
            Path.Combine(config.DataRoot, "backups"),
            Path.Combine(config.DataRoot, "sources"),
            Path.Combine(coreRoot, "auth"),
            Path.Combine(coreRoot, "audit", "audit.ndjson"));
    }

    public static bool IsSafePathSegment(string segment)
        => TryResolveContainedPath(Path.GetTempPath(), segment, out _);

    public static string ResolveContainedPath(string root, string segment)
        => TryResolveContainedPath(root, segment, out var fullPath)
            ? fullPath
            : throw new AppLifecycleException("app_id_invalid", $"App id '{segment}' is not a safe path segment.");

    public static bool TryResolveContainedPath(string root, string segment, out string fullPath)
    {
        fullPath = string.Empty;
        if (string.IsNullOrWhiteSpace(segment) ||
            segment is "." or ".." ||
            segment.IndexOfAny(['/', '\\']) >= 0 ||
            segment.Contains(Path.DirectorySeparatorChar) ||
            segment.Contains(Path.AltDirectorySeparatorChar))
        {
            return false;
        }

        return TryContain(root, segment, out fullPath);
    }

    // Resolve a forward-slash-separated relative path (e.g. "docs/store.md") under <root>, enforcing
    // containment. Each segment must be a plain name — no empty/./.. segments, no backslash, and no ':'
    // (which would allow an NTFS alternate data stream). The combined path is normalized and required
    // to stay strictly under root; a caller that needs symlink-escape protection resolves link targets
    // separately. Used by the per-app asset endpoint to serve a manifest-relative asset path.
    public static bool TryResolveContainedRelativePath(string root, string relativePath, out string fullPath)
    {
        fullPath = string.Empty;
        if (string.IsNullOrWhiteSpace(relativePath) || relativePath.IndexOf('\\') >= 0)
        {
            return false;
        }

        var segments = relativePath.Split('/');
        foreach (var segment in segments)
        {
            if (string.IsNullOrEmpty(segment) || segment is "." or ".." || segment.IndexOf(':') >= 0)
            {
                return false;
            }
        }

        return TryContain(root, string.Join(Path.DirectorySeparatorChar, segments), out fullPath);
    }

    private static bool TryContain(string root, string relative, out string fullPath)
    {
        fullPath = string.Empty;
        var fullRoot = Path.GetFullPath(root);
        var combined = Path.GetFullPath(Path.Combine(fullRoot, relative));
        var rootPrefix = fullRoot.EndsWith(Path.DirectorySeparatorChar)
            ? fullRoot
            : fullRoot + Path.DirectorySeparatorChar;
        var comparison = OperatingSystem.IsWindows()
            ? StringComparison.OrdinalIgnoreCase
            : StringComparison.Ordinal;
        if (!combined.StartsWith(rootPrefix, comparison) || combined.Length <= rootPrefix.Length)
        {
            return false;
        }

        fullPath = combined;
        return true;
    }
}
