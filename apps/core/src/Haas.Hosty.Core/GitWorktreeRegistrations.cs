namespace Haas.Hosty.Core;

internal static class GitWorktreeRegistrations
{
    // Consume `git worktree list --porcelain -z`: paths are unquoted and may contain newlines.
    internal static bool Contains(string porcelain, string path, string? branchReference = null)
    {
        var comparison = OperatingSystem.IsWindows() ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal;
        var expected = Path.TrimEndingDirectorySeparator(Path.GetFullPath(path));
        foreach (var field in porcelain.Split('\0', StringSplitOptions.RemoveEmptyEntries))
        {
            if (branchReference is not null && field == "branch " + branchReference) return true;
            if (!field.StartsWith("worktree ", StringComparison.Ordinal)) continue;
            var registered = field[9..];
            if (!Path.IsPathFullyQualified(registered))
                throw new IOException("A Git worktree registration has an invalid absolute path.");
            // Git uses forward slashes on Windows; compare native absolute paths, without
            // resolving links or inspecting any registered worktree outside this allocation.
            var actual = Path.TrimEndingDirectorySeparator(Path.GetFullPath(registered));
            if (string.Equals(actual, expected, comparison)) return true;
        }
        return false;
    }
}
