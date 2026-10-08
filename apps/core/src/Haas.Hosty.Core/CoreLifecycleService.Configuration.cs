namespace Haas.Hosty.Core;

internal sealed partial class CoreLifecycleService
{
    /// <summary>Reports launch requirements without exposing setting values or host paths.</summary>
    internal async Task<AppConfigurationReadiness> GetConfigurationReadinessAsync(
        AppRecord app, CancellationToken cancellationToken)
        => (await ReadConfigurationSnapshotAsync(app, cancellationToken)).Readiness;

    private async Task<(GlobalMountState? Library, AppConfigurationReadiness Readiness)> ReadConfigurationSnapshotAsync(
        AppRecord app, CancellationToken cancellationToken, IReadOnlyList<AppRecord>? installed = null)
    {
        try
        {
            // An unrelated shared-library failure cannot block an app which has no shared binding.
            var library = app.Mounts?.Any(binding => binding.GlobalMountName is not null) == true
                ? await globalMounts.ReadAsync(cancellationToken) : new GlobalMountState(1, []);
            var records = app.Mounts is { Count: > 0 } ? installed ?? await apps.ListAppRecordsAsync(cancellationToken) : [];
            return (library, GetConfigurationReadiness(app, library, records));
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException or System.Text.Json.JsonException or ArgumentException)
        {
            return (null, new(true, CollectMissingRequiredSettings(app), [], "mounts_unavailable"));
        }
    }

    /// <summary>Evaluates the same defaults, retained values and overrides that apply installs and updates.</summary>
    internal async Task<AppConfigurationReadiness> GetCandidateConfigurationReadinessAsync(
        RuntimeAppManifestSelection selection,
        AppRecord? existing,
        IReadOnlyDictionary<string, string?>? suppliedSettings,
        CancellationToken cancellationToken)
    {
        var candidate = BuildAppRecord(selection, Path.Combine(GetAppRoot(selection.Manifest.Id!), "manifest.json"),
            selection.ManifestUrl, existing?.System ?? IsSystemManifest(selection.Manifest), existing);
        if (existing is null && await TryReadRetainedConfigAsync(candidate.Id, cancellationToken) is { } retained)
        {
            candidate = candidate with
            {
                Settings = OverlayRetainedSettings(candidate.Settings, retained.Settings),
                Mounts = PreserveMounts(selection.Manifest, retained.Mounts),
            };
        }
        if (suppliedSettings is { Count: > 0 })
            candidate = candidate with { Settings = MergeSettings(candidate.Settings, suppliedSettings) };
        return await GetConfigurationReadinessAsync(candidate, cancellationToken);
    }

    private AppConfigurationReadiness GetConfigurationReadiness(AppRecord app, GlobalMountState library, IReadOnlyList<AppRecord> installed)
    {
        var missingSettings = CollectMissingRequiredSettings(app);
        var issues = new List<AppConfigurationMountIssue>();
        var mounts = AppConfigurationFingerprint.ResolveMounts(app, library);
        issues.AddRange(CollectMountMultiplicityIssues(app, mounts));
        var configuredKeys = mounts.Select(mount => mount.Key).ToHashSet(StringComparer.Ordinal);
        var sharedNames = library.Mounts.Select(mount => mount.Name).ToHashSet(StringComparer.Ordinal);
        foreach (var slot in app.MountSlots ?? [])
        {
            if (!slot.Required || configuredKeys.Contains(slot.Key)) continue;
            var missingReferences = (app.Mounts ?? []).Where(binding => binding.Key == slot.Key &&
                binding.GlobalMountName is { } name && !sharedNames.Contains(name)).ToArray();
            if (missingReferences.Length == 0)
                issues.Add(new(slot.Key, null, "required"));
            else
                issues.AddRange(missingReferences.Select(binding => new AppConfigurationMountIssue(slot.Key, binding.Label, "reference_missing")));
        }
        // Optional configured mounts also have to pass the existing startup path checks. Missing
        // optional shared references remain inert, matching MaterializeBindings and startup.
        foreach (var mount in mounts)
        {
            try
            {
                var realPath = mountPathPolicy.EnsureAllowed(mount.HostPath);
                HostPathAuthority.EnsureMountDoesNotExposeSources(realPath, installed, app);
                if (!MountPathPolicy.HostPathExists(realPath))
                    issues.Add(new(mount.Key, mount.Label, "source_missing"));
            }
            catch (Exception error) when (error is AppLifecycleException or IOException or UnauthorizedAccessException or ArgumentException)
            {
                // Path-policy messages can contain private paths. Only the stable slot identifier
                // and reason belong in review/status projections.
                issues.Add(new(mount.Key, mount.Label, "source_unsafe"));
            }
        }
        return new(missingSettings.Count > 0 || issues.Count > 0, missingSettings, issues);
    }

    // Count the same materialized bindings supplied to startup. Deleted shared references are
    // inert; a single-binding slot cannot launch with two remaining paths after a schema update.
    private static IReadOnlyList<AppConfigurationMountIssue> CollectMountMultiplicityIssues(
        AppRecord app, IReadOnlyList<RuntimeMount> mounts)
    {
        var counts = mounts.GroupBy(mount => mount.Key, StringComparer.Ordinal)
            .ToDictionary(group => group.Key, group => group.Count(), StringComparer.Ordinal);
        return (app.MountSlots ?? []).Where(slot => !slot.Multiple && counts.GetValueOrDefault(slot.Key) > 1)
            .Select(slot => new AppConfigurationMountIssue(slot.Key, null, "multiple_not_allowed"))
            .ToArray();
    }

    private static void EnsureMountMultiplicityForStart(RuntimeLifecycleContext context)
    {
        if (CollectMountMultiplicityIssues(context.App, context.Mounts).FirstOrDefault() is { } issue)
            throw new AppLifecycleException("app_mount_multiple_not_allowed",
                $"External mount '{issue.Key}' does not allow more than one host path. Configure it before starting the app.");
    }

    internal async Task<bool> RequiresConfigurationAsync(string appId, CancellationToken cancellationToken)
        => (await apps.GetAppAsync(appId, cancellationToken)) is { } app &&
            (await GetConfigurationReadinessAsync(app, cancellationToken)).Required;
}

internal sealed record AppConfigurationReadiness(
    bool Required,
    IReadOnlyList<string> MissingSettings,
    IReadOnlyList<AppConfigurationMountIssue> Mounts,
    string? Error = null);

internal sealed record AppConfigurationMountIssue(string Key, string? Label, string Reason);
