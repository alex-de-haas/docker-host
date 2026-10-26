namespace Haas.Hosty.Core;

/// <summary>Read-only app-scoped export collection; skill selection never grants host source access.</summary>
internal static class AgentSkillMounts
{
    internal static string Root(CoreDataPaths paths, string appId) =>
        Path.Combine(paths.CoreRoot, "skills", "exports", AgentSkillLibrary.Id("app:" + appId));

    internal static bool IsOwnedRoot(CoreDataPaths paths, AppRecord app, string path)
    {
        if (app.MountSlots?.Any(s => s.Kind == "agent-skills") != true ||
            !(app.GrantedCorePermissions ?? []).Contains(CoreAppPermissions.ReadSkills)) return false;
        var expected = Path.GetFullPath(Root(paths, app.Id));
        var comparison = OperatingSystem.IsWindows() ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal;
        return Path.GetFullPath(path).Equals(expected, comparison) &&
            MountPathPolicy.ResolveRealPath(expected).Equals(Path.Combine(MountPathPolicy.ResolveRealPath(paths.CoreRoot),
                "skills", "exports", AgentSkillLibrary.Id("app:" + app.Id)), comparison);
    }

    internal static IEnumerable<RuntimeMount> Resolve(CoreDataPaths paths, AppRecord app, RuntimeAppManifest manifest)
    {
        foreach (var (key, declaration) in manifest.ExternalMounts.Where(p => p.Value.Kind == "agent-skills"))
        {
            var mount = new RuntimeMount(key, "skills", Root(paths, app.Id), $"/mnt/{key}", true,
                declaration.Service, ManagedCollection: true);
            Validate(paths, app, manifest, mount);
            Directory.CreateDirectory(mount.HostPath);
            yield return mount;
        }
    }

    internal static string Validate(CoreDataPaths paths, AppRecord app, RuntimeAppManifest manifest, RuntimeMount mount)
    {
        if (!mount.ManagedCollection || !manifest.ExternalMounts.TryGetValue(mount.Key, out var declaration) ||
            declaration.Kind != "agent-skills" || declaration.Scope != "instance" || declaration.Mode != "ro" ||
            !(app.GrantedCorePermissions ?? []).Contains(CoreAppPermissions.ReadSkills) ||
            mount.Label != "skills" || mount.Service != declaration.Service || !mount.ReadOnly ||
            mount.ContainerPath != $"/mnt/{mount.Key}" || !IsOwnedRoot(paths, app, mount.HostPath))
            throw new AppLifecycleException("app_collection_invalid", "Invalid read-only skill export collection.");
        return MountPathPolicy.ResolveRealPath(mount.HostPath);
    }
}
