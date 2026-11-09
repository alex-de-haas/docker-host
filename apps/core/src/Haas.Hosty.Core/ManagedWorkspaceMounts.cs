namespace Haas.Hosty.Core;

/// <summary>Reviewed access to a Core-owned source collection; not a lease on every child tree.</summary>
internal static class ManagedWorkspaceMounts
{
    // Older starts recorded these automatic roots as operator mounts. Recognize only exact,
    // canonical collection roots on an installation that declares and is authorized for them.
    internal static bool IsOwnedRoot(CoreDataPaths paths, AppRecord app, string path)
    {
        if (AgentSkillMounts.IsOwnedRoot(paths, app, path)) return true;
        if (app.MountSlots?.Any(slot => slot.Kind == "managed-workspaces") != true
            || !(app.GrantedCorePermissions ?? []).Contains(CoreAppPermissions.Sources)) return false;
        var comparison = OperatingSystem.IsWindows() ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal;
        var full = Path.GetFullPath(path);
        foreach (var name in new[] { "trees", "repositories" })
        {
            var expected = Path.Combine(paths.CoreRoot, "development", name);
            var canonical = Path.Combine(MountPathPolicy.ResolveRealPath(paths.CoreRoot), "development", name);
            if ((string.Equals(full, Path.GetFullPath(expected), comparison) || string.Equals(full, canonical, comparison))
                && string.Equals(MountPathPolicy.ResolveRealPath(full), canonical, comparison)) return true;
        }
        return false;
    }

    internal static IReadOnlyList<RuntimeMount> Resolve(CoreDataPaths paths, AppRecord app, RuntimeAppManifest manifest)
    {
        var mounts = new List<RuntimeMount>();
        foreach (var (key, declaration) in manifest.ExternalMounts.Where(pair => pair.Value.Kind == "managed-workspaces"))
        {
            if (!(app.GrantedCorePermissions ?? []).Contains(CoreAppPermissions.Sources))
                throw new AppLifecycleException("app_collection_permission_required", "Managed workspace access requires approved full-source authority.");
            foreach (var name in new[] { "trees", "repositories" })
            {
                var source = Path.Combine(paths.CoreRoot, "development", name);
                var mount = new RuntimeMount(key, name, source, $"/mnt/{key}/managed/{name}",
                    name == "repositories" || declaration.Mode == "ro", declaration.Service, ManagedCollection: true);
                Validate(paths, app, manifest, mount);
                Directory.CreateDirectory(source);
                mounts.Add(mount);
            }
        }
        mounts.AddRange(AgentSkillMounts.Resolve(paths, app, manifest));
        return mounts;
    }

    internal static bool IsCollectionAccess(CoreDataPaths paths, AppRecord app, RuntimeAppManifest manifest, System.Text.Json.JsonElement mount, string? service)
    {
        if (!mount.TryGetProperty("Source", out var source) || !mount.TryGetProperty("Destination", out var target)) return false;
        try
        {
            foreach (var expected in Resolve(paths, app, manifest))
                if (service == expected.Service && DockerMountPaths.Equivalent(source.GetString() ?? "", MountPathPolicy.ResolveRealPath(expected.HostPath))
                    && target.GetString() == expected.ContainerPath && mount.TryGetProperty("RW", out var rw) && rw.GetBoolean() != expected.ReadOnly) return true;
        }
        catch (Exception error) when (error is AppLifecycleException or ArgumentException or InvalidOperationException) { return false; }
        return false;
    }

    internal static string Validate(CoreDataPaths paths, AppRecord app, RuntimeAppManifest manifest, RuntimeMount mount)
    {
        if (manifest.ExternalMounts.TryGetValue(mount.Key, out var skillDeclaration) && skillDeclaration.Kind == "agent-skills")
            return AgentSkillMounts.Validate(paths, app, manifest, mount);
        if (!mount.ManagedCollection || !manifest.ExternalMounts.TryGetValue(mount.Key, out var declaration)
            || declaration.Kind != "managed-workspaces" || declaration.Scope != "instance"
            || !(app.GrantedCorePermissions ?? []).Contains(CoreAppPermissions.Sources)
            || mount.Label is not ("trees" or "repositories") || mount.Service != declaration.Service
            || mount.ReadOnly != (mount.Label == "repositories" || declaration.Mode == "ro")
            || mount.ContainerPath != $"/mnt/{mount.Key}/managed/{mount.Label}")
            throw new AppLifecycleException("app_collection_invalid", "Invalid managed workspace collection binding.");
        var expected = Path.GetFullPath(Path.Combine(paths.CoreRoot, "development", mount.Label));
        var real = MountPathPolicy.ResolveRealPath(expected);
        var comparison = OperatingSystem.IsWindows() ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal;
        // Allow an already canonical Core root, never a redirected collection child or ancestor.
        var canonicalExpected = Path.Combine(MountPathPolicy.ResolveRealPath(paths.CoreRoot), "development", mount.Label);
        if (!string.Equals(Path.GetFullPath(mount.HostPath), expected, comparison) || !string.Equals(real, canonicalExpected, comparison))
            throw new AppLifecycleException("app_collection_path_invalid", "Managed workspace roots must not redirect through links or junctions.");
        return real;
    }
}
