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

    // Default managed source checkout for an app. Lives inside the app root so uninstalling an app
    // removes everything about it in one subtree; SourcesRoot remains only as the legacy location
    // that pre-existing records may still point at via AppSourceState.ManagedCheckoutPath.
    public string ResolveManagedCheckoutPath(string appId)
        => Path.Combine(ResolveContainedPath(AppsRoot, appId), "source");

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

    // Normalize a forward-slash relative reference (resolved against `baseDirRootRel`, itself a clean
    // root-relative dir or empty) into a clean root-relative path — no empty, "." or ".." segments in
    // the result. Returns null if the reference is absolute, uses a backslash, contains a ':' or '%'
    // segment (NTFS ADS / percent-encoded traversal), or climbs above the root. Shared by the asset
    // vendor, the AppSummary URL projection, and (implicitly) the asset endpoint so the vendored path,
    // the emitted URL, and the served path are always identical.
    public static string? NormalizeRelativeAssetPath(string? baseDirRootRel, string? reference)
    {
        if (string.IsNullOrWhiteSpace(reference) || reference.IndexOf('\\') >= 0 || reference.StartsWith('/') ||
            Uri.TryCreate(reference, UriKind.Absolute, out _))
        {
            return null;
        }

        var parts = string.IsNullOrEmpty(baseDirRootRel) ? new List<string>() : [.. baseDirRootRel.Split('/')];
        foreach (var segment in reference.Split('/'))
        {
            if (segment.Length == 0 || segment == ".")
            {
                continue;
            }

            if (segment == "..")
            {
                if (parts.Count == 0)
                {
                    return null;
                }

                parts.RemoveAt(parts.Count - 1);
                continue;
            }

            if (segment.IndexOf(':') >= 0 || segment.IndexOf('%') >= 0)
            {
                return null;
            }

            parts.Add(segment);
        }

        return parts.Count == 0 ? null : string.Join('/', parts);
    }

    // Namespaces under apps/<id> that Core and the runtime own. Display-asset vendoring resolves
    // manifest-chosen relative paths against the whole app root, so without this an app-supplied
    // asset reference could land on app data, runtime logs, or Core's own manifest copy.
    private static readonly string[] ReservedAppRootDirectories = ["data", "logs", "run", "runtimes", "source"];
    private static readonly string[] ReservedAppRootFiles = ["manifest.json", "state.json"];

    public static bool IsReservedAppRootPath(string? rootRelativePath)
    {
        if (string.IsNullOrWhiteSpace(rootRelativePath))
        {
            return true;
        }

        var separator = rootRelativePath.IndexOf('/');
        var head = separator < 0 ? rootRelativePath : rootRelativePath[..separator];
        // Both lists are checked against the head whatever its shape. Selecting a list by whether a
        // separator is present leaves two gaps: a bare "data" (no separator, so only the file list is
        // consulted) would be allowed to occupy the reserved directory name, and "manifest.json/x.png"
        // (separator present, so only the directory list is consulted) would be allowed to write
        // underneath a reserved file name.
        //
        // Compared case-insensitively regardless of host: a case-insensitive filesystem would let
        // "Data/x.png" reach the same directory a case-sensitive comparison would wave through.
        return ReservedAppRootFiles.Contains(head, StringComparer.OrdinalIgnoreCase) ||
            ReservedAppRootDirectories.Contains(head, StringComparer.OrdinalIgnoreCase);
    }

    // True if any component of fullPath below root is a symbolic link. Callers that resolved a path
    // lexically use this to fail closed before reading it: lexical containment says nothing about
    // where a link inside the tree actually points. Errors count as "linked" so an unreadable or
    // racing entry is refused rather than followed.
    public static bool ContainsSymbolicLink(string root, string fullPath)
    {
        try
        {
            var boundary = Path.TrimEndingDirectorySeparator(Path.GetFullPath(root));
            var current = Path.GetFullPath(fullPath);
            var comparison = OperatingSystem.IsWindows()
                ? StringComparison.OrdinalIgnoreCase
                : StringComparison.Ordinal;

            while (!string.Equals(current, boundary, comparison))
            {
                FileSystemInfo info = Directory.Exists(current) ? new DirectoryInfo(current) : new FileInfo(current);
                if (info.LinkTarget is not null)
                {
                    return true;
                }

                var parent = Path.GetDirectoryName(current);
                if (string.IsNullOrEmpty(parent) || string.Equals(parent, current, comparison))
                {
                    // Walked past the root without meeting it: treat as out of bounds.
                    return true;
                }

                current = parent;
            }

            return false;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or ArgumentException or NotSupportedException)
        {
            return true;
        }
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
