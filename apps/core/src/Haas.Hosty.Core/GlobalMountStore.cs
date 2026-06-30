namespace Haas.Hosty.Core;

// Host-level library of named operator host paths ("shared mounts"). A per-app mount binding can
// reference an entry by name instead of carrying an inline path; the path is resolved live from this
// store at start so editing an entry updates every app that references it. Persisted at
// core/global-mounts.json, separate from app records — never backed up or deleted by app lifecycle.
internal sealed class GlobalMountStore(CoreDataPaths paths)
{
    private string StatePath => Path.Combine(paths.CoreRoot, "global-mounts.json");

    public async Task<GlobalMountState> ReadAsync(CancellationToken cancellationToken = default)
        => await JsonStorage.ReadAsync<GlobalMountState>(StatePath, cancellationToken) ??
            new GlobalMountState(1, []);

    public async Task WriteAsync(GlobalMountState state, CancellationToken cancellationToken = default)
        => await JsonStorage.WriteAsync(StatePath, state, restrictToOwner: true, cancellationToken);
}

internal sealed record GlobalMountState(int SchemaVersion, IReadOnlyList<GlobalMount> Mounts);

// A registered shared mount. `Name` matches the mount-label pattern so it doubles as the stable
// container-path label `/mnt/{key}/{name}`. `MaxMode` ("ro"/"rw", default "rw") is an optional cap:
// a referencing app is read-only when either the manifest slot's mode or this is "ro" — the slot
// mode stays authoritative, this only further restricts.
internal sealed record GlobalMount(string Name, string HostPath, string? Description = null, string? MaxMode = null);
