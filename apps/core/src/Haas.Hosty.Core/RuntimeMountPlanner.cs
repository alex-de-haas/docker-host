namespace Haas.Hosty.Core;

// Pure resolution + formatting of external host-path mounts. Takes the manifest-declared
// slots and the operator-configured bindings and produces the concrete binds Core injects
// into a runtime. No filesystem access here (existence is checked at start time elsewhere)
// so this stays deterministic and unit-testable.
internal static class RuntimeMountPlanner
{
    // Container path a bind is exposed at inside a docker container. Derived from the
    // operator-chosen label so it is stable when sibling binds are added/removed/reordered.
    public static string BuildContainerPath(string key, string label) => $"/mnt/{key}/{label}";

    // Resolves declared slots × operator bindings into concrete mounts. Bindings whose key is
    // not a declared slot are ignored (the manifest may have dropped the slot). Output is sorted
    // by (key, label) so injection and env ordering are deterministic across restarts.
    public static IReadOnlyList<RuntimeMount> Resolve(
        IReadOnlyList<AppMountSlot>? slots,
        IReadOnlyList<AppMountBinding>? bindings)
    {
        if (slots is null || slots.Count == 0 || bindings is null || bindings.Count == 0)
        {
            return [];
        }

        var slotsByKey = slots.ToDictionary(slot => slot.Key, StringComparer.Ordinal);
        return bindings
            .Where(binding => slotsByKey.ContainsKey(binding.Key))
            .OrderBy(binding => binding.Key, StringComparer.Ordinal)
            .ThenBy(binding => binding.Label, StringComparer.Ordinal)
            .Select(binding => new RuntimeMount(
                binding.Key,
                binding.Label,
                binding.HostPath,
                BuildContainerPath(binding.Key, binding.Label),
                ReadOnly: string.Equals(slotsByKey[binding.Key].Mode, "ro", StringComparison.Ordinal),
                Service: slotsByKey[binding.Key].Service))
            .ToArray();
    }

    // Materializes operator bindings against the shared-mounts library before resolution: a global
    // ref binding (GlobalMountName set) takes its host path from the named library entry and is
    // dropped (inert) if that entry no longer exists; an inline binding passes through unchanged.
    // Also returns the (key, label) pairs whose library entry caps the mode to read-only, so the
    // caller can apply that cap on top of the slot mode. Pure: the library snapshot is passed in.
    public static (IReadOnlyList<AppMountBinding> Bindings, IReadOnlySet<(string Key, string Label)> ForcedReadOnly) MaterializeBindings(
        IReadOnlyList<AppMountBinding>? bindings,
        IReadOnlyDictionary<string, GlobalMount> globalsByName)
    {
        var forcedReadOnly = new HashSet<(string, string)>();
        if (bindings is null || bindings.Count == 0)
        {
            return ([], forcedReadOnly);
        }

        var materialized = new List<AppMountBinding>(bindings.Count);
        foreach (var binding in bindings)
        {
            if (binding.GlobalMountName is null)
            {
                materialized.Add(binding);
                continue;
            }

            if (!globalsByName.TryGetValue(binding.GlobalMountName, out var entry))
            {
                continue;
            }

            materialized.Add(binding with { Label = entry.Name, HostPath = entry.HostPath });
            if (string.Equals(entry.MaxMode, "ro", StringComparison.Ordinal))
            {
                forcedReadOnly.Add((binding.Key, entry.Name));
            }
        }

        return (materialized, forcedReadOnly);
    }

    // Mounts that target the given service: a slot with no declared service applies to every
    // service in the app; a slot that names a service only binds into that one.
    public static IReadOnlyList<RuntimeMount> ForService(IReadOnlyList<RuntimeMount> mounts, string serviceKey)
        => mounts
            .Where(mount => mount.Service is null || string.Equals(mount.Service, serviceKey, StringComparison.Ordinal))
            .ToArray();

    // Throws if a slot declared `required: true` has no operator bindings yet. Called on the
    // start path only — an unconfigured required mount must not silently start with no storage.
    public static void EnsureRequiredConfigured(
        IReadOnlyList<AppMountSlot>? slots,
        IReadOnlyList<AppMountBinding>? bindings)
    {
        if (slots is null)
        {
            return;
        }

        var configuredKeys = (bindings ?? [])
            .Select(binding => binding.Key)
            .ToHashSet(StringComparer.Ordinal);

        foreach (var slot in slots)
        {
            if (slot.Required && !configuredKeys.Contains(slot.Key))
            {
                throw new AppLifecycleException(
                    "app_mount_required_unconfigured",
                    $"External mount '{slot.Key}' is required but no host path is configured. Configure it before starting the app.");
            }
        }
    }

    // Builds the `HOSTY_MOUNT_{KEY}` environment variables, one per slot key that has bindings,
    // value = comma-joined `label=path` entries. The operator-chosen label is the stable per-bind
    // key a consumer addresses a mount by — e.g. to pair a catalog root with a sibling app's
    // downloads mount that shares the same host path. Under docker the path is the container path;
    // under localCommand the host path. A host path may itself contain '=', so consumers must split
    // each entry on the FIRST '=' only (labels match ^[a-z0-9][a-z0-9._-]{0,62}$ and never contain
    // '='). Mounts arrive already sorted by (key, label).
    public static IReadOnlyDictionary<string, string> BuildMountEnvironment(
        IReadOnlyList<RuntimeMount> mounts,
        bool useContainerPath)
    {
        var environment = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var group in mounts.GroupBy(mount => mount.Key, StringComparer.Ordinal))
        {
            var name = $"HOSTY_MOUNT_{RuntimePortHelper.NormalizeEnvironmentKey(group.Key)}";
            environment[name] = string.Join(',', group.Select(mount =>
                $"{mount.Label}={(useContainerPath ? mount.ContainerPath : mount.HostPath)}"));
        }

        return environment;
    }

    // Builds the docker `-v host:container[:ro]` argument pairs for the resolved mounts.
    public static IReadOnlyList<string> BuildDockerVolumeArguments(IReadOnlyList<RuntimeMount> mounts)
    {
        var args = new List<string>(mounts.Count * 2);
        foreach (var mount in mounts)
        {
            args.Add("-v");
            args.Add(mount.ReadOnly
                ? $"{mount.HostPath}:{mount.ContainerPath}:ro"
                : $"{mount.HostPath}:{mount.ContainerPath}");
        }

        return args;
    }
}

internal sealed record RuntimeMount(
    string Key,
    string Label,
    string HostPath,
    string ContainerPath,
    bool ReadOnly,
    string? Service);
