using System.Text.RegularExpressions;

namespace Haas.Hosty.Core;

// Admin operations over the shared-mounts library: list (with per-entry usage), upsert (validated by
// the same MountPathPolicy as inline mounts), and delete (blocked while referenced unless forced).
internal sealed partial class GlobalMountService(GlobalMountStore store, AppRegistryStore apps, MountPathPolicy mountPathPolicy)
{
    [GeneratedRegex("^[a-z0-9][a-z0-9._-]{0,62}$")]
    private static partial Regex NamePattern();

    // Serializes read-modify-write so concurrent upserts/deletes don't clobber each other.
    private readonly SemaphoreSlim mutationLock = new(1, 1);

    public async Task<IReadOnlyList<GlobalMountSummary>> ListAsync(CancellationToken cancellationToken = default)
    {
        var state = await store.ReadAsync(cancellationToken);
        return await BuildSummariesAsync(state, cancellationToken);
    }

    // Look up a single entry by name. Used by the per-app mount config path to resolve a reference.
    public async Task<GlobalMount?> FindAsync(string name, CancellationToken cancellationToken = default)
    {
        var state = await store.ReadAsync(cancellationToken);
        return state.Mounts.FirstOrDefault(mount => string.Equals(mount.Name, name, StringComparison.Ordinal));
    }

    public async Task<IReadOnlyList<GlobalMountSummary>> UpsertAsync(GlobalMountUpsertRequest request, CancellationToken cancellationToken = default)
    {
        var name = request.Name?.Trim() ?? string.Empty;
        if (!NamePattern().IsMatch(name))
        {
            throw new AppLifecycleException("global_mount_name_invalid", $"Shared mount name '{name}' must match ^[a-z0-9][a-z0-9._-]{{0,62}}$.");
        }

        var mode = NormalizeMode(request.Mode);
        var hostPath = mountPathPolicy.NormalizeAndValidate(request.HostPath);
        var description = string.IsNullOrWhiteSpace(request.Description) ? null : request.Description.Trim();
        var entry = new GlobalMount(name, hostPath, description, mode);

        await mutationLock.WaitAsync(cancellationToken);
        try
        {
            var state = await store.ReadAsync(cancellationToken);
            var mounts = state.Mounts
                .Where(existing => !string.Equals(existing.Name, name, StringComparison.Ordinal))
                .Append(entry)
                .OrderBy(mount => mount.Name, StringComparer.Ordinal)
                .ToArray();
            var updated = state with { Mounts = mounts };
            await store.WriteAsync(updated, cancellationToken);
            return await BuildSummariesAsync(updated, cancellationToken);
        }
        finally
        {
            mutationLock.Release();
        }
    }

    public async Task<IReadOnlyList<GlobalMountSummary>> DeleteAsync(string name, bool force, CancellationToken cancellationToken = default)
    {
        await mutationLock.WaitAsync(cancellationToken);
        try
        {
            var state = await store.ReadAsync(cancellationToken);
            if (!state.Mounts.Any(mount => string.Equals(mount.Name, name, StringComparison.Ordinal)))
            {
                throw new AppLifecycleException("global_mount_not_found", $"Shared mount '{name}' was not found.");
            }

            if (!force)
            {
                var usage = await ComputeUsageAsync(cancellationToken);
                var usedBy = usage.GetValueOrDefault(name);
                if (usedBy > 0)
                {
                    throw new AppLifecycleException(
                        "global_mount_in_use",
                        $"Shared mount '{name}' is referenced by {usedBy} app(s). Detach it from those apps first, or force the delete (their bindings become inert).");
                }
            }

            var mounts = state.Mounts
                .Where(mount => !string.Equals(mount.Name, name, StringComparison.Ordinal))
                .ToArray();
            var updated = state with { Mounts = mounts };
            await store.WriteAsync(updated, cancellationToken);
            return await BuildSummariesAsync(updated, cancellationToken);
        }
        finally
        {
            mutationLock.Release();
        }
    }

    private async Task<IReadOnlyList<GlobalMountSummary>> BuildSummariesAsync(GlobalMountState state, CancellationToken cancellationToken)
    {
        var usage = await ComputeUsageAsync(cancellationToken);
        return state.Mounts
            .OrderBy(mount => mount.Name, StringComparer.Ordinal)
            .Select(mount => new GlobalMountSummary(
                mount.Name,
                mount.HostPath,
                NormalizeMode(mount.MaxMode),
                mount.Description,
                usage.GetValueOrDefault(mount.Name)))
            .ToArray();
    }

    // Number of distinct apps that reference each shared mount by name.
    private async Task<IReadOnlyDictionary<string, int>> ComputeUsageAsync(CancellationToken cancellationToken)
    {
        var records = await apps.ListAppRecordsAsync(cancellationToken);
        var counts = new Dictionary<string, int>(StringComparer.Ordinal);
        foreach (var app in records)
        {
            var referenced = new HashSet<string>(StringComparer.Ordinal);
            foreach (var binding in app.Mounts ?? [])
            {
                if (!string.IsNullOrEmpty(binding.GlobalMountName))
                {
                    referenced.Add(binding.GlobalMountName);
                }
            }

            foreach (var name in referenced)
            {
                counts[name] = counts.GetValueOrDefault(name) + 1;
            }
        }

        return counts;
    }

    // "ro"/"rw" only; default "rw" (no extra cap — the manifest slot mode decides).
    public static string NormalizeMode(string? mode)
    {
        var value = mode?.Trim().ToLowerInvariant();
        return value switch
        {
            null or "" or "rw" => "rw",
            "ro" => "ro",
            _ => throw new AppLifecycleException("global_mount_mode_invalid", $"Shared mount mode '{mode}' must be 'ro' or 'rw'."),
        };
    }
}

internal sealed record GlobalMountUpsertRequest(string? Name = null, string? HostPath = null, string? Mode = null, string? Description = null);

internal sealed record GlobalMountSummary(string Name, string HostPath, string Mode, string? Description, int UsedBy);

internal sealed record GlobalMountListResponse(IReadOnlyList<GlobalMountSummary> Mounts);
