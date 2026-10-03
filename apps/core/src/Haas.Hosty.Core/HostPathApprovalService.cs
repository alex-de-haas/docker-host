using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Serialization;

namespace Haas.Hosty.Core;

internal sealed record HostPathChange(string Kind, string? AppId = null, AppSourceOverrideRequest? Source = null,
    AppMountsRequest? Mounts = null, GlobalMountUpsertRequest? GlobalMount = null)
{
    [JsonIgnore]
    public string Permission => Kind switch
    {
        "source-override" when AppId is not null && Source is not null && Mounts is null && GlobalMount is null => CoreAppPermissions.AppLifecycle,
        "app-mounts" when AppId is not null && Mounts is not null && Source is null && GlobalMount is null => CoreAppPermissions.ConfigureApps,
        "global-mount" when AppId is null && GlobalMount is not null && Source is null && Mounts is null => CoreAppPermissions.ConfigureCore,
        _ => throw new AppLifecycleException("host_path_request_invalid", "Choose one source or mount operation."),
    };
}

internal sealed record HostPathApprovalPlan(HostPathChange Change, string DisplayName, IReadOnlyList<string> Details)
{
    internal string Fingerprint { get; init; } = "";
}

// Approval grants a particular path transition. Rebuild the same snapshot while holding the
// writer's locks, so a changed installation, manifest, symlink or mount entry requires a new review.
internal sealed class HostPathApprovalService(CoreDataPaths paths, AppRegistryStore apps, AppSourceService sources,
    AppManifestService manifests, CoreLifecycleService lifecycle, GlobalMountStore globals, GlobalMountService globalService,
    PrivateSourceService? privateSources = null)
{
    public async Task<HostPathApprovalPlan> PrepareAsync(HostPathChange change, string userId, CancellationToken ct)
    {
        _ = change.Permission;
        var policy = new HostPathAuthority(paths, apps);
        var details = new List<string>();
        var fingerprint = new List<string> { CoreJson.Text(change) };
        string name;
        if (change.AppId is { } id)
        {
            var app = await apps.GetAppAsync(id, ct) ?? throw new AppLifecycleException("app_not_found", "The target app is no longer installed.");
            name = app.DisplayName;
            fingerprint.AddRange([app.Id, app.InstalledAt.ToString("O"), app.ManifestPath ?? "", app.SelectedRuntime ?? "",
                CoreJson.Text(app.SourceState), CoreJson.Text(app.Mounts), CoreJson.Text(app.MountSlots)]);
            if (change.Source is { } source)
            {
                foreach (var grant in new[] { app.PrivateSources?.Manifest, app.PrivateSources?.Git }.OfType<SourceReadGrant>())
                {
                    if (grant.OwnerId != userId) throw PrivateSourceService.Denied("Only the source owner can select this app's private source.");
                }
                if (app.PrivateSources is not null)
                    await (privateSources ?? throw PrivateSourceService.Denied()).ValidateAsync(app.PrivateSources, ct);
                var real = await policy.OverrideAsync(app, source.Path, ct);
                var manifestPath = Path.Combine(real, app.SourceState?.ManifestSubpath ?? "");
                var selection = await manifests.LoadAsync(manifestPath, app.SelectedRuntime, ct,
                    validateAllProfiles: true, forceRead: true, allowUnsupportedPermissions: true);
                if (selection.Manifest.Id != app.Id)
                    throw new AppLifecycleException("source_override_app_mismatch", "The source manifest belongs to a different app.");
                fingerprint.AddRange([real, MountPathPolicy.ResolveRealPath(selection.ManifestPath), selection.ManifestDigest,
                    CoreJson.Text(app.PrivateSources)]);
                details.Add($"Run {app.DisplayName} ({app.Id}) from {real}.");
                details.Add("Hosty may execute code from this folder directly on the host, including future changes. This approval trusts the folder, not just its current contents.");
                details.Add($"Repository: {selection.Manifest.Source?.Repository ?? "local folder"}");
                foreach (var profile in selection.Manifest.RuntimeProfiles.Where(p => p.Development))
                    foreach (var service in selection.Manifest.Services)
                        if (service.Runtimes.TryGetValue(profile.Key, out var runtime))
                            details.Add($"{profile.Key} / {service.Key}: {runtime.Type ?? profile.Type}; directory: {runtime.WorkingDirectory ?? "."}; setup: {runtime.Setup ?? "none"}; command: {runtime.Command ?? "none"}");
            }
            else
            {
                // Freeze a private copy of the caller's collection before storing the plan.
                change = change with { Mounts = new(change.Mounts!.Mounts?.ToArray()) };
                var registry = await globals.ReadAsync(ct);
                var bindings = lifecycle.ValidateMountBindings(app, change.Mounts.Mounts ?? [], registry);
                await policy.AppAsync(app with { Mounts = bindings }, ct);
                details.Add($"Replace external mount bindings for {app.DisplayName} ({app.Id}).");
                foreach (var binding in bindings)
                {
                    var real = MountPathPolicy.ResolveRealPath(binding.HostPath);
                    var global = registry.Mounts.FirstOrDefault(m => m.Name == binding.GlobalMountName);
                    fingerprint.AddRange([real, CoreJson.Text(global)]);
                    var mode = global?.MaxMode == "ro" ? "ro" : app.MountSlots?.FirstOrDefault(s => s.Key == binding.Key)?.Mode ?? "rw";
                    details.Add($"{binding.Key} / {binding.Label}: {real} ({mode})");
                }
                fingerprint.Add(CoreJson.Text(bindings));
                details.Add("The app can read these host folders and, for writable mounts, change or delete their contents. Changes take effect on its next start.");
            }
        }
        else
        {
            var input = change.GlobalMount!;
            name = input.Name?.Trim() ?? "Shared mount";
            var path = new MountPathPolicy(paths).NormalizeAndValidate(input.HostPath);
            await policy.MountAsync(path, ct);
            var real = MountPathPolicy.ResolveRealPath(path);
            var previous = (await globals.ReadAsync(ct)).Mounts.FirstOrDefault(m => m.Name == name);
            fingerprint.AddRange([real, CoreJson.Text(previous)]);
            details.Add($"Shared mount {name}: {real} ({input.Mode ?? "rw"}).");
            if (previous is not null) details.Add($"Previously: {previous.HostPath} ({previous.MaxMode ?? "rw"}). Existing users of this shared mount receive the changed path on their next start.");
            details.Add("Apps with mount configuration access can use this shared host folder without another confirmation. Writable access allows changing and deleting its contents.");
        }
        return new(change, name, details) { Fingerprint = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(string.Join("\0", fingerprint)))) };
    }

    public async Task ApplyAsync(HostPathApprovalPlan plan, string userId, CancellationToken ct, Func<Task>? revalidateCaller = null)
    {
        async Task Verify()
        {
            if (revalidateCaller is not null) await revalidateCaller();
            var current = await PrepareAsync(plan.Change, userId, ct);
            if (current.Fingerprint != plan.Fingerprint)
                throw new AppLifecycleException("host_path_plan_stale", "The app, manifest or host path changed. Prepare and review a new request.");
        }
        if (plan.Change.Source is { } source)
            await sources.WithSourceLockAsync(plan.Change.AppId!, async app =>
            {
                await Verify();
                return await sources.SetLocalOverrideCoreAsync(app, source, ct);
            }, ct);
        else if (plan.Change.Mounts is { } mounts)
            await lifecycle.WithAppLockAsync(plan.Change.AppId!, async () =>
            {
                await apps.HostPathMutationLock.WaitAsync(ct);
                try { await Verify(); return await lifecycle.ConfigureMountsCoreAsync(plan.Change.AppId!, mounts, ct); }
                finally { apps.HostPathMutationLock.Release(); }
            }, ct);
        else
            await globalService.UpsertAsync(plan.Change.GlobalMount!, ct, verifyReview: Verify);
    }
}
