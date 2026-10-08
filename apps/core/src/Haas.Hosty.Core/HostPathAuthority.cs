namespace Haas.Hosty.Core;

// The shared gate lives in AppRegistryStore, so legacy service constructors share it too.
// This class validates paths; its mutation callers hold operation -> host-path -> record locks.
internal sealed class HostPathAuthority(CoreDataPaths paths, AppRegistryStore apps)
{
    private readonly GlobalMountStore globals = new(paths);
    internal static bool Within(string root, string path)
    {
        // macOS commonly uses case-insensitive volumes. Conservatively reject case aliases even
        // on a case-sensitive Mac volume rather than permitting a protected directory alias.
        var comparison = (OperatingSystem.IsWindows() || OperatingSystem.IsMacOS()) ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal;
        root = Path.TrimEndingDirectorySeparator(Path.GetFullPath(root));
        path = Path.GetFullPath(path);
        return string.Equals(root, path, comparison) || path.StartsWith(Path.EndsInDirectorySeparator(root) ? root : root + Path.DirectorySeparatorChar, comparison);
    }
    private static bool Overlap(string a, string b) => Within(a, b) || Within(b, a);
    private static bool Exposes(string a, string b)
        => Overlap(Path.GetFullPath(a), Path.GetFullPath(b)) || Overlap(MountPathPolicy.ResolveRealPath(a), MountPathPolicy.ResolveRealPath(b));

    internal async Task<string> OverrideAsync(AppRecord app, string path, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(path)) throw new AppLifecycleException("source_override_path_required", "Local source override path is required.");
        var lexical = Path.GetFullPath(path);
        var real = MountPathPolicy.ResolveRealPath(lexical);
        if (!Directory.Exists(real)) throw new AppLifecycleException("source_override_not_found", "Local source override directory does not exist.");
        var manifest = Path.GetFullPath(Path.Combine(real, app.SourceState?.ManifestSubpath ?? ""));
        if (Directory.Exists(manifest)) manifest = Path.Combine(manifest, "manifest.json");
        var realManifest = MountPathPolicy.ResolveRealPath(manifest);
        if (!Within(real, realManifest)) throw Forbidden();
        var mountRoots = (await apps.ListAppRecordsAsync(ct)).SelectMany(a => (a.Mounts ?? []).Select(m => m.HostPath).Concat(a.ActiveMountPaths ?? []))
            .Concat((await globals.ReadAsync(ct)).Mounts.Select(m => m.HostPath));
        // Any mounted descendant can contain executable code, even if the manifest is outside it.
        foreach (var root in mountRoots)
            if (Exposes(root, real) || Exposes(root, lexical)) throw Forbidden();
        foreach (var root in new[] { paths.AppsRoot, paths.SourcesRoot })
        {
            var resolvedRoot = MountPathPolicy.ResolveRealPath(root);
            if (Within(root, lexical) || Within(resolvedRoot, real) || Within(resolvedRoot, realManifest)) throw Forbidden();
        }
        return real;
    }
    private static AppLifecycleException Forbidden() => new("source_override_path_forbidden",
        "App storage, managed app sources and external/shared mount directories cannot be used as source overrides.");

    internal async Task MountAsync(string path, CancellationToken ct, AppRecord? candidate = null)
    {
        _ = new MountPathPolicy(paths).EnsureAllowed(path);
        var records = await apps.ListAppRecordsAsync(ct);
        EnsureMountDoesNotExposeSources(path, records, candidate);
    }

    internal static void EnsureMountDoesNotExposeSources(string path, IReadOnlyList<AppRecord> records, AppRecord? candidate = null)
    {
        if (candidate is not null) records = records.Where(a => a.Id != candidate.Id).Append(candidate).ToArray();
        foreach (var app in records)
        {
            foreach (var source in CodePaths(app))
                if (Exposes(path, source)) throw new AppLifecycleException("app_mount_path_is_source",
                    "External/shared mounts must not expose an application's source directory. Use its declared development source mount instead.");
        }
    }
    internal static IEnumerable<string> CodePaths(AppRecord app)
    {
        foreach (var active in app.ActiveSourcePaths ?? []) yield return active;
        if (!string.IsNullOrWhiteSpace(app.SourceState?.LocalOverridePath)) yield return app.SourceState.LocalOverridePath;
        if (app.RuntimeProfiles?.Any(p => p.Development) != true) yield break;
        if (!string.IsNullOrWhiteSpace(app.SourceState?.ManagedCheckoutPath)) yield return app.SourceState.ManagedCheckoutPath;
        if (!string.IsNullOrWhiteSpace(app.InstallManifestPath) && Path.IsPathFullyQualified(app.InstallManifestPath))
            yield return Directory.Exists(app.InstallManifestPath) ? app.InstallManifestPath : Path.GetDirectoryName(app.InstallManifestPath)!;
    }
    internal static AppRecord CaptureRuntimePaths(AppRecord app, GlobalMountState registry)
    {
        if (app.RuntimeState == "stopped") return app;
        return app with
        {
            ActiveMountPaths = app.ActiveMountPaths ?? AppConfigurationFingerprint.ResolveMounts(app, registry)
                .Select(m => MountPathPolicy.ResolveRealPath(m.HostPath)).Distinct().ToArray(),
            ActiveSourcePaths = app.ActiveSourcePaths ?? CodePaths(app).Select(MountPathPolicy.ResolveRealPath).Distinct().ToArray(),
        };
    }

    internal async Task AppAsync(AppRecord app, CancellationToken ct)
    {
        if (app.SourceState?.LocalOverridePath is { Length: > 0 } source) _ = await OverrideAsync(app, source, ct);
        var registry = app.Mounts?.Any(binding => binding.GlobalMountName is not null) == true
            ? await globals.ReadAsync(ct) : new GlobalMountState(1, []);
        foreach (var binding in app.Mounts ?? [])
        {
            var path = binding.GlobalMountName is { } name ? registry.Mounts.FirstOrDefault(m => m.Name == name)?.HostPath : binding.HostPath;
            if (path is not null) await MountAsync(path, ct, app);
        }
    }
}
