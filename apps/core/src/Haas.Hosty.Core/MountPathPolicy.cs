namespace Haas.Hosty.Core;

// Shared validation for operator-supplied host paths used as external mounts. Used both by per-app
// inline mount bindings (CoreLifecycleService) and by the host-level shared-mounts library
// (GlobalMountService) so the same isolation rules apply wherever an operator names a host path.
internal sealed class MountPathPolicy(CoreDataPaths paths)
{
    private static readonly string[] DenyRoots =
        OperatingSystem.IsWindows()
            ? []
            : ["/etc", "/proc", "/sys", "/dev", "/boot", "/run", "/var/run"];

    private static StringComparison PathComparison
        => OperatingSystem.IsWindows() ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal;

    // Validates and normalizes an operator host path. Shape only — existence is checked at start time.
    public string NormalizeAndValidate(string? raw)
    {
        var value = raw?.Trim();
        if (string.IsNullOrWhiteSpace(value))
        {
            throw new AppLifecycleException("app_mount_path_required", "External mount host path is required.");
        }

        if (!Path.IsPathFullyQualified(value))
        {
            throw new AppLifecycleException("app_mount_path_not_absolute", $"External mount host path must be absolute: {value}");
        }

        // A ':' in a non-Windows host path would break the docker `-v host:container` argument.
        if (!OperatingSystem.IsWindows() && value.Contains(':'))
        {
            throw new AppLifecycleException("app_mount_path_invalid", $"External mount host path may not contain ':': {value}");
        }

        // Paths are injected as a comma-separated HOSTY_MOUNT_{KEY} list, so a ',' would break the
        // contract the app relies on when it splits the variable.
        if (value.Contains(','))
        {
            throw new AppLifecycleException("app_mount_path_invalid", $"External mount host path may not contain ',': {value}");
        }

        var normalized = Path.GetFullPath(value);
        EnsureAllowed(normalized);
        EnsureAllowed(ResolveRealPath(normalized));
        return normalized;
    }

    // Rejects host paths that would breach isolation: anything inside the Hosty data root (would
    // expose core/backups/other-app data) or a sensitive system root. Applied to both the operator
    // path and its symlink-resolved target.
    public void EnsureAllowed(string fullPath)
    {
        if (PathEqualsOrWithin(paths.DataRoot, fullPath))
        {
            throw new AppLifecycleException("app_mount_path_in_data_root", $"External mount host path may not be inside the Hosty data root: {fullPath}");
        }

        if (IsFileSystemRoot(fullPath))
        {
            throw new AppLifecycleException("app_mount_path_forbidden", $"External mount host path may not be the filesystem root: {fullPath}");
        }

        foreach (var denied in DenyRoots)
        {
            if (PathEqualsOrWithin(denied, fullPath))
            {
                throw new AppLifecycleException("app_mount_path_forbidden", $"External mount host path may not be inside the system path '{denied}': {fullPath}");
            }
        }
    }

    public static string ResolveRealPath(string fullPath)
    {
        try
        {
            return new DirectoryInfo(fullPath).ResolveLinkTarget(returnFinalTarget: true)?.FullName ?? fullPath;
        }
        catch (Exception ex) when (ex is ArgumentException or PathTooLongException or System.Security.SecurityException or IOException or UnauthorizedAccessException)
        {
            return fullPath;
        }
    }

    private static bool IsFileSystemRoot(string fullPath)
        => string.Equals(Path.GetFullPath(fullPath), Path.GetPathRoot(fullPath), PathComparison);

    private static bool PathEqualsOrWithin(string root, string candidate)
    {
        var fullRoot = Path.GetFullPath(root).TrimEnd(Path.DirectorySeparatorChar);
        var fullCandidate = Path.GetFullPath(candidate).TrimEnd(Path.DirectorySeparatorChar);
        if (string.Equals(fullRoot, fullCandidate, PathComparison))
        {
            return true;
        }

        return fullCandidate.StartsWith(fullRoot + Path.DirectorySeparatorChar, PathComparison);
    }
}
