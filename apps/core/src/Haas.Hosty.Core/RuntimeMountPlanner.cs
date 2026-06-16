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
    // value = comma-joined paths. Under docker the app sees container paths; under localCommand
    // it reads the host paths directly. Mounts arrive already sorted by (key, label).
    public static IReadOnlyDictionary<string, string> BuildMountEnvironment(
        IReadOnlyList<RuntimeMount> mounts,
        bool useContainerPath)
    {
        var environment = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var group in mounts.GroupBy(mount => mount.Key, StringComparer.Ordinal))
        {
            var name = $"HOSTY_MOUNT_{RuntimePortHelper.NormalizeEnvironmentKey(group.Key)}";
            environment[name] = string.Join(',', group.Select(mount => useContainerPath ? mount.ContainerPath : mount.HostPath));
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
