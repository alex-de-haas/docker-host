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

        // EnsureAllowed resolves internally and checks both the lexical path and its real target
        // against the protected roots; the same check re-runs at start (EnsureMountsReadyForStart) to
        // catch a link repointed after config.
        var normalized = Path.GetFullPath(value);
        EnsureAllowed(normalized);
        return normalized;
    }

    // Whether a validated host path is currently present as a directory. Deliberately NOT part of
    // NormalizeAndValidate: registration must keep accepting paths on drives that are not attached yet
    // (network/removable). Callers decide what a false means — the start gate refuses to start, while
    // the shared-mounts library only flags it, so an operator typo is visible before start time.
    public static bool HostPathExists(string fullPath) => Directory.Exists(fullPath);

    // Rejects host paths that would breach isolation: anything inside the Hosty data root (would
    // expose core/backups/other-app data) or a sensitive system root. Resolves every symlink in the
    // path and checks the real target as well as the lexical path — the ancestor-symlink escape (C-H3)
    // — and does the same for each protected root, so a symlinked ancestor on the root itself
    // (macOS /var -> /private/var, an operator's symlinked home) cannot make the containment check miss
    // in one direction while the other catches nothing. Resolution fails closed via ResolveRealPath.
    //
    // Returns the fully-resolved real path it validated, so the start gate mounts EXACTLY that value
    // instead of resolving a second time — a second resolve would open a fresh TOCTOU window between
    // the path Core validated and the path it mounts.
    public string EnsureAllowed(string fullPath)
    {
        var lexical = Path.GetFullPath(fullPath);
        var real = ResolveRealPath(lexical);

        EnsureNotWithin(lexical, real, paths.DataRoot, "app_mount_path_in_data_root", "External mount host path may not be inside the Hosty data root");

        if (IsFileSystemRoot(lexical) || IsFileSystemRoot(real))
        {
            throw new AppLifecycleException("app_mount_path_forbidden", $"External mount host path may not be the filesystem root: {lexical}");
        }

        foreach (var denied in DenyRoots)
        {
            EnsureNotWithin(lexical, real, denied, "app_mount_path_forbidden", $"External mount host path may not be inside the system path '{denied}'");
        }

        return real;
    }

    // Rejects when the lexical path is within the lexical root OR the resolved path is within the
    // resolved root. Checking both forms on both sides is what makes the containment sound regardless
    // of which side carries a symlinked ancestor; the lexical comparison also covers a not-yet-existent
    // path typed directly into the data root.
    private static void EnsureNotWithin(string lexical, string real, string root, string code, string message)
    {
        var lexicalRoot = Path.GetFullPath(root);
        var realRoot = ResolveRealPath(lexicalRoot);
        if (PathEqualsOrWithin(lexicalRoot, lexical) || PathEqualsOrWithin(realRoot, real))
        {
            throw new AppLifecycleException(code, $"{message}: {lexical}");
        }
    }

    // Kernel MAXSYMLINKS; a chain longer than this is a loop for our purposes.
    private const int MaxSymlinkHops = 40;

    // Canonicalizes a host path by resolving a symlink in EVERY component, not just the final one:
    // `/allowed/link/sub` where `link` points into the data root must resolve to the real location so
    // the isolation check sees it (and so Docker mounts the real target, not a path it would traverse
    // through the link itself). Components that do not exist yet — a not-attached drive, a directory to
    // be created — cannot be links, so they pass through literally, which keeps registration working
    // for removable/network paths. Fails CLOSED: a symlink cycle or an unreadable component throws
    // rather than falling back to the lexical path, so a caller can never validate or mount an
    // unresolved path. TOCTOU across the resolve and the eventual mount remains (a link swapped after
    // this returns), which needs an openat2-class primitive and is out of scope here.
    public static string ResolveRealPath(string fullPath)
    {
        try
        {
            var hops = 0;
            return ResolveWalk(Path.GetFullPath(fullPath), ref hops);
        }
        catch (Exception ex) when (ex is ArgumentException or PathTooLongException or System.Security.SecurityException or IOException or UnauthorizedAccessException or NotSupportedException)
        {
            throw new AppLifecycleException("app_mount_path_unresolved", $"External mount host path could not be resolved: {fullPath} ({ex.Message})");
        }
    }

    private static string ResolveWalk(string input, ref int hops)
    {
        var root = Path.GetPathRoot(input);
        if (string.IsNullOrEmpty(root))
        {
            throw new ArgumentException($"Path is not absolute: {input}");
        }

        var separators = new[] { Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar };
        var stack = new List<string>();
        foreach (var component in input[root.Length..].Split(separators, StringSplitOptions.RemoveEmptyEntries))
        {
            if (component == ".")
            {
                continue;
            }

            if (component == "..")
            {
                if (stack.Count > 0)
                {
                    stack.RemoveAt(stack.Count - 1);
                }

                continue;
            }

            var candidate = Combine(root, stack, component);
            var linkTarget = ReadLinkOneHop(candidate);
            if (linkTarget is null)
            {
                stack.Add(component);
                continue;
            }

            if (++hops > MaxSymlinkHops)
            {
                throw new IOException($"Too many levels of symbolic links resolving '{input}'.");
            }

            // A relative target resolves against the directory holding the link (the current stack);
            // an absolute one restarts from its own root. Either way, resolve the target fully before
            // continuing with the components after the link.
            var targetFull = Path.IsPathRooted(linkTarget)
                ? linkTarget
                : Combine(root, stack, linkTarget);
            var resolvedTarget = ResolveWalk(Path.GetFullPath(targetFull), ref hops);
            root = Path.GetPathRoot(resolvedTarget)!;
            stack = [.. resolvedTarget[root.Length..].Split(separators, StringSplitOptions.RemoveEmptyEntries)];
        }

        return stack.Count == 0 ? root : root + string.Join(Path.DirectorySeparatorChar, stack);
    }

    private static string Combine(string root, List<string> stack, string tail)
        => stack.Count == 0
            ? root + tail
            : root + string.Join(Path.DirectorySeparatorChar, stack) + Path.DirectorySeparatorChar + tail;

    // The immediate (one-hop) symlink target of `path`, or null when it is not a link or does not
    // exist (a non-existent component cannot be a link, so it is treated literally).
    private static string? ReadLinkOneHop(string path)
    {
        FileSystemInfo info = Directory.Exists(path) ? new DirectoryInfo(path) : new FileInfo(path);
        return info.LinkTarget;
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
