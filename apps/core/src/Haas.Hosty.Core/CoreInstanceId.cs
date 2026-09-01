namespace Haas.Hosty.Core;

// The per-root instance identity that scopes docker resources (the `hosty.instance` label,
// instance-scoped container/network names, and every ps filter's post-filter). A GUID generated at
// first start and stored in the data root ({root}/core/instance-id), so it survives folder moves.
// The DEFAULT root uses the reserved empty id, which produces today's unscoped names and matches
// containers that predate the label — existing hosts migrate with zero container churn.
internal static class CoreInstanceId
{
    public const string FileName = "instance-id";

    public static string BuildPath(string dataRoot) => Path.Combine(dataRoot, "core", FileName);

    // The default root is a path decision, not an env-var one: HOSTY_HOME pointing at ~/.hosty is
    // still the default instance.
    public static bool IsDefaultDataRoot(string dataRoot)
    {
        var defaultRoot = Path.GetFullPath(Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".hosty"));
        var comparison = OperatingSystem.IsWindows() ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal;
        return string.Equals(
            Path.TrimEndingDirectorySeparator(Path.GetFullPath(dataRoot)),
            Path.TrimEndingDirectorySeparator(defaultRoot),
            comparison);
    }

    // Loads the root's stored id, generating and persisting one on first start. Callers hold the
    // per-root lock, so the create path cannot race a sibling Core of the same root. IO failures
    // propagate: silently minting a NEW id over an unreadable stored one would orphan every
    // container the old id scopes, which is worse than failing the start loudly.
    public static string LoadOrCreate(string dataRoot)
    {
        if (IsDefaultDataRoot(dataRoot))
        {
            return string.Empty;
        }

        var path = BuildPath(dataRoot);
        if (File.Exists(path))
        {
            var existing = File.ReadAllText(path).Trim();
            if (existing.Length > 0)
            {
                return existing;
            }

            // An empty file is a crashed first write with nothing to preserve; fall through.
        }

        var id = Guid.NewGuid().ToString("N");
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        // Temp+rename, never CreateNew+FileShare.None on the real path — an interrupted write must
        // not leave a half-written identity behind.
        var temporaryPath = path + ".tmp";
        File.WriteAllText(temporaryPath, id);
        File.Move(temporaryPath, path, overwrite: true);
        return id;
    }
}
