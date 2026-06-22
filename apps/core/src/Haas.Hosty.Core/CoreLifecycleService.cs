using System.Security.Cryptography;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.Extensions.Logging;

namespace Haas.Hosty.Core;

internal sealed class CoreLifecycleService(
    CoreDataPaths paths,
    AppRegistryStore apps,
    AppManifestService manifests,
    AppBackupService backups,
    AppSourceService sources,
    IEnumerable<IAppRuntimeAdapter> adapters,
    IIngressController ingress,
    ILogger<CoreLifecycleService> logger)
{
    private static readonly Regex BackupReasonPattern = new("^[a-z0-9][a-z0-9-]{0,30}$", RegexOptions.Compiled);
    private static readonly Regex MountLabelPattern = new("^[a-z0-9][a-z0-9._-]{0,62}$", RegexOptions.Compiled);

    public async Task<IReadOnlyList<AppSummary>> ListAppsAsync(CancellationToken cancellationToken = default)
    {
        var records = await apps.ListAppRecordsAsync(cancellationToken);
        var summaries = new List<AppSummary>(records.Count);
        foreach (var app in records)
        {
            var reconciled = await ReconcileRuntimeStateForSummaryAsync(app, cancellationToken);
            summaries.Add(await BuildAppSummaryAsync(reconciled, cancellationToken));
        }

        return summaries;
    }

    public async Task<AppInstallPlan> CreateInstallPlanAsync(AppInstallPlanRequest request, CancellationToken cancellationToken = default)
    {
        var selection = await manifests.LoadAsync(request.ManifestPath, request.SelectedRuntime, cancellationToken);
        var existing = await apps.GetAppAsync(selection.Manifest.Id!, cancellationToken);
        string? currentManifestDigest = null;
        if (!string.IsNullOrWhiteSpace(existing?.ManifestPath) && File.Exists(existing.ManifestPath))
        {
            try
            {
                currentManifestDigest = (await manifests.LoadAsync(existing.ManifestPath, existing.SelectedRuntime, cancellationToken)).ManifestDigest;
            }
            catch (AppManifestException)
            {
                currentManifestDigest = null;
            }
        }

        return new AppInstallPlan(
            AppId: selection.Manifest.Id!,
            DisplayName: selection.Manifest.Name!,
            Description: selection.Manifest.Description,
            Action: existing is null ? "install" : "already-installed",
            CurrentVersion: existing?.Version,
            TargetVersion: selection.Manifest.Version!,
            CurrentRuntime: existing?.SelectedRuntime,
            TargetRuntime: selection.RuntimeProfile.Key,
            TargetRuntimeType: selection.RuntimeProfile.Type,
            ManifestPath: selection.ManifestPath,
            CurrentManifestDigest: currentManifestDigest,
            TargetManifestDigest: selection.ManifestDigest,
            SelectedChannel: request.SelectedChannel,
            DefaultAutostart: request.Autostart ?? true,
            RuntimeProfiles: BuildRuntimeProfileSummaries(selection.Manifest),
            Settings: selection.Manifest.Settings
                .Where(setting => !PublicOriginSettings.IsSettingKey(setting.Key))
                .Select(setting => new AppInstallSetting(setting.Key, setting.Type, setting.Secret ? null : setting.Default, setting.Secret, setting.Required))
                .ToArray());
    }

    public async Task<AppLifecycleResponse> InstallAsync(AppInstallRequest request, CancellationToken cancellationToken = default)
    {
        var selection = await manifests.LoadAsync(request.ManifestPath, request.SelectedRuntime, cancellationToken);
        var appRoot = GetAppRoot(selection.Manifest.Id!);
        var manifestCopyPath = Path.Combine(appRoot, "manifest.json");

        await manifests.SaveManifestCopyAsync(selection, appRoot, cancellationToken);
        if (selection.Manifest.Data?.Enabled == true)
        {
            Directory.CreateDirectory(GetAppDataPath(selection.Manifest.Id!));
        }

        var record = BuildAppRecord(
            selection,
            manifestCopyPath,
            manifestUrl: selection.ManifestUrl,
            selectedChannel: request.SelectedChannel,
            system: request.System,
            existing: null) with
        {
            OperationStatus = "installed",
            RuntimeState = "stopped",
            LastOperation = "install",
            Autostart = request.Autostart ?? true,
        };
        if (request.Settings is { Count: > 0 })
        {
            ValidatePublicOriginSettings(request.Settings);
            record = record with { Settings = MergeSettings(record.Settings, request.Settings) };
        }

        var document = await apps.UpsertAppAsync(record, cancellationToken);
        return new AppLifecycleResponse(AppSummary.From(document.App), null, "installed");
    }

    public async Task<AppLifecycleResponse> ConfigureAsync(string appId, AppConfigureRequest request, CancellationToken cancellationToken = default)
    {
        var document = await apps.UpdateAppAsync(appId, app =>
        {
            ValidatePublicOriginSettings(request.Settings);
            return app with
            {
                Settings = request.Settings is { Count: > 0 } ? MergeSettings(app.Settings, request.Settings) : app.Settings,
                Autostart = request.Autostart ?? app.Autostart,
                OperationStatus = "configured",
                LastOperation = "configure",
                LastError = null,
            };
        }, cancellationToken);

        return new AppLifecycleResponse(AppSummary.From(document.App), null, "configured");
    }

    public async Task<AppLifecycleResponse> ConfigureAutostartAsync(
        string appId,
        AppAutostartRequest request,
        CancellationToken cancellationToken = default)
    {
        var document = await apps.UpdateAppAsync(appId, app => app with
        {
            Autostart = request.Autostart,
            OperationStatus = "configured",
            LastOperation = "configure-autostart",
            LastError = null,
        }, cancellationToken);

        return new AppLifecycleResponse(AppSummary.From(document.App), null, "configured");
    }

    // Operator-configured external mount bindings. Replaces the full set for the app (idempotent
    // PUT semantics), validating each host path against the manifest-declared slots and the path
    // policy before persisting. Existence of the host paths is enforced lazily at start time.
    public async Task<AppLifecycleResponse> ConfigureMountsAsync(
        string appId,
        AppMountsRequest request,
        CancellationToken cancellationToken = default)
    {
        var document = await apps.UpdateAppAsync(appId, app => app with
        {
            Mounts = ValidateMountBindings(app, request.Mounts ?? []),
            OperationStatus = "configured",
            LastOperation = "configure-mounts",
            LastError = null,
        }, cancellationToken);

        return new AppLifecycleResponse(AppSummary.From(document.App), null, "configured");
    }

    private IReadOnlyList<AppMountBinding> ValidateMountBindings(AppRecord app, IReadOnlyList<AppMountBindingInput> inputs)
    {
        var slots = (app.MountSlots ?? []).ToDictionary(slot => slot.Key, StringComparer.Ordinal);
        var seen = new HashSet<string>(StringComparer.Ordinal);
        var perKeyCount = new Dictionary<string, int>(StringComparer.Ordinal);
        var result = new List<AppMountBinding>(inputs.Count);

        foreach (var input in inputs)
        {
            var key = input.Key?.Trim() ?? string.Empty;
            if (!slots.TryGetValue(key, out var slot))
            {
                throw new AppLifecycleException("app_mount_slot_unknown", $"App '{app.Id}' does not declare an external mount slot '{key}'.");
            }

            var label = input.Label?.Trim() ?? string.Empty;
            if (!MountLabelPattern.IsMatch(label) || label is "." or "..")
            {
                throw new AppLifecycleException("app_mount_label_invalid", $"External mount label '{label}' must match ^[a-z0-9][a-z0-9._-]{{0,62}}$.");
            }

            if (!seen.Add($"{key}/{label}"))
            {
                throw new AppLifecycleException("app_mount_label_duplicate", $"External mount '{key}' declares the label '{label}' more than once.");
            }

            perKeyCount[key] = perKeyCount.GetValueOrDefault(key) + 1;
            if (!slot.Multiple && perKeyCount[key] > 1)
            {
                throw new AppLifecycleException("app_mount_multiple_not_allowed", $"External mount '{key}' does not allow more than one host path.");
            }

            result.Add(new AppMountBinding(key, label, NormalizeAndValidateMountHostPath(input.HostPath)));
        }

        return result;
    }

    private string NormalizeAndValidateMountHostPath(string? raw)
    {
        var value = raw?.Trim();
        if (string.IsNullOrWhiteSpace(value))
        {
            throw new AppLifecycleException("app_mount_path_required", "External mount host path is required.");
        }

        if (!Path.IsPathFullyQualified(value))
        {
            throw new AppLifecycleException("app_mount_path_not_absolute", $"External mount host path must be absolute: {value}");
        }

        // A ':' in a non-Windows host path would break the docker `-v host:container` argument.
        if (!OperatingSystem.IsWindows() && value.Contains(':'))
        {
            throw new AppLifecycleException("app_mount_path_invalid", $"External mount host path may not contain ':': {value}");
        }

        // Paths are injected as a comma-separated HOSTY_MOUNT_{KEY} list, so a ',' would break the
        // contract the app relies on when it splits the variable.
        if (value.Contains(','))
        {
            throw new AppLifecycleException("app_mount_path_invalid", $"External mount host path may not contain ',': {value}");
        }

        var normalized = Path.GetFullPath(value);
        EnsureMountPathAllowed(normalized);
        EnsureMountPathAllowed(ResolveRealPath(normalized));
        return normalized;
    }

    // Rejects host paths that would breach isolation: anything inside the Hosty data root (would
    // expose core/backups/other-app data) or a sensitive system root. Applied to both the
    // operator path and its symlink-resolved target.
    private void EnsureMountPathAllowed(string fullPath)
    {
        if (PathEqualsOrWithin(paths.DataRoot, fullPath))
        {
            throw new AppLifecycleException("app_mount_path_in_data_root", $"External mount host path may not be inside the Hosty data root: {fullPath}");
        }

        if (IsFileSystemRoot(fullPath))
        {
            throw new AppLifecycleException("app_mount_path_forbidden", $"External mount host path may not be the filesystem root: {fullPath}");
        }

        foreach (var denied in MountDenyRoots)
        {
            if (PathEqualsOrWithin(denied, fullPath))
            {
                throw new AppLifecycleException("app_mount_path_forbidden", $"External mount host path may not be inside the system path '{denied}': {fullPath}");
            }
        }
    }

    private static string ResolveRealPath(string fullPath)
    {
        try
        {
            return new DirectoryInfo(fullPath).ResolveLinkTarget(returnFinalTarget: true)?.FullName ?? fullPath;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            return fullPath;
        }
    }

    private static bool IsFileSystemRoot(string fullPath)
        => string.Equals(Path.GetFullPath(fullPath), Path.GetPathRoot(fullPath), PathComparison);

    private static bool PathEqualsOrWithin(string root, string candidate)
    {
        var fullRoot = Path.GetFullPath(root).TrimEnd(Path.DirectorySeparatorChar);
        var fullCandidate = Path.GetFullPath(candidate).TrimEnd(Path.DirectorySeparatorChar);
        if (string.Equals(fullRoot, fullCandidate, PathComparison))
        {
            return true;
        }

        return fullCandidate.StartsWith(fullRoot + Path.DirectorySeparatorChar, PathComparison);
    }

    private static StringComparison PathComparison
        => OperatingSystem.IsWindows() ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal;

    private static readonly string[] MountDenyRoots =
        OperatingSystem.IsWindows()
            ? []
            : ["/etc", "/proc", "/sys", "/dev", "/boot", "/run", "/var/run"];

    public async Task<AppLifecycleResponse> StartAsync(string appId, CancellationToken cancellationToken = default)
    {
        var app = await RequireAppAsync(appId, cancellationToken);
        IAppRuntimeAdapter? adapter = null;
        RuntimeLifecycleContext? context = null;
        var runtimeStarted = false;
        try
        {
            var selection = await LoadSelectionForAppAsync(app, cancellationToken);
            app = await EnsureLocalCommandSourceReadyAsync(app, selection, cancellationToken);
            app = await EnsureIngressPublicOriginsAsync(app, selection, cancellationToken);
            adapter = ResolveAdapter(selection.RuntimeProfile.Type);
            context = await CreateRuntimeContextAsync(app, selection, cancellationToken);
            EnsureMountsReadyForStart(context);
            var result = await adapter.StartAsync(context, cancellationToken);
            runtimeStarted = true;
            var updated = await apps.UpdateAppAsync(appId, current => current with
            {
                RuntimeState = result.RuntimeState,
                OperationStatus = "started",
                LastOperation = "start",
                LastError = null,
                Endpoints = MergeEndpointUrls(current.Endpoints, result.Endpoints, selection),
            }, cancellationToken);

            await ReconcileIngressAsync(cancellationToken);
            return new AppLifecycleResponse(AppSummary.From(updated.App), null, "started");
        }
        catch (Exception ex) when (IsRecordableLifecycleFailure(ex))
        {
            if (runtimeStarted && adapter is not null && context is not null)
            {
                await TryStopRuntimeAsync(adapter, context);
            }

            await RecordForegroundLifecycleFailureAsync(appId, "start", "stopped", ex.Message, cancellationToken);
            throw;
        }
    }

    public async Task<AppLifecycleResponse> StopAsync(string appId, CancellationToken cancellationToken = default)
    {
        var app = await RequireAppAsync(appId, cancellationToken);
        var selection = await LoadSelectionForAppAsync(app, cancellationToken);
        var adapter = ResolveAdapter(selection.RuntimeProfile.Type);
        var result = await adapter.StopAsync(await CreateRuntimeContextAsync(app, selection, cancellationToken), cancellationToken);
        var updated = await apps.UpdateAppAsync(appId, current => current with
        {
            RuntimeState = result.RuntimeState,
            OperationStatus = "stopped",
            LastOperation = "stop",
            LastError = null,
        }, cancellationToken);

        await ReconcileIngressAsync(cancellationToken);
        return new AppLifecycleResponse(AppSummary.From(updated.App), null, "stopped");
    }

    public async Task<AppLifecycleResponse> RestartAsync(string appId, CancellationToken cancellationToken = default)
    {
        var app = await RequireAppAsync(appId, cancellationToken);
        IAppRuntimeAdapter? adapter = null;
        RuntimeLifecycleContext? context = null;
        var runtimeStarted = false;
        try
        {
            var selection = await LoadSelectionForAppAsync(app, cancellationToken);
            adapter = ResolveAdapter(selection.RuntimeProfile.Type);
            context = await CreateRuntimeContextAsync(app, selection, cancellationToken);
            EnsureMountsReadyForStart(context);
            _ = await adapter.StopAsync(context, cancellationToken);
            var start = await adapter.StartAsync(context, cancellationToken);
            runtimeStarted = true;
            var updated = await apps.UpdateAppAsync(appId, current => current with
            {
                RuntimeState = start.RuntimeState,
                OperationStatus = "restarted",
                LastOperation = "restart",
                LastError = null,
                Endpoints = MergeEndpointUrls(current.Endpoints, start.Endpoints, selection),
            }, cancellationToken);

            return new AppLifecycleResponse(AppSummary.From(updated.App), null, "restarted");
        }
        catch (Exception ex) when (IsRecordableLifecycleFailure(ex))
        {
            if (runtimeStarted && adapter is not null && context is not null)
            {
                await TryStopRuntimeAsync(adapter, context);
            }

            await RecordForegroundLifecycleFailureAsync(appId, "restart", "stopped", ex.Message, cancellationToken);
            throw;
        }
    }

    public async Task<AppUpdatePlan> CreateUpdatePlanAsync(string appId, AppUpdatePlanRequest request, CancellationToken cancellationToken = default)
    {
        var app = await RequireAppAsync(appId, cancellationToken);
        var manifestPath = request.ManifestPath ?? app.ManifestUrl ?? app.ManifestPath;
        if (string.IsNullOrWhiteSpace(manifestPath))
        {
            throw new AppLifecycleException("manifest_path_required", "Installed app has no manifest path and update request did not provide one.");
        }

        var currentSelection = await LoadSelectionForAppAsync(app, cancellationToken);
        var selection = await manifests.LoadAsync(manifestPath, request.SelectedRuntime ?? app.SelectedRuntime, cancellationToken);
        if (!string.Equals(selection.Manifest.Id, app.Id, StringComparison.Ordinal))
        {
            throw new AppLifecycleException("manifest_app_mismatch", $"Update manifest app id '{selection.Manifest.Id}' does not match installed app '{app.Id}'.");
        }

        var willCreateBackup = Directory.Exists(GetAppDataPath(appId));
        var changes = BuildUpdateChanges(app, currentSelection, selection);
        var seed = new AppUpdatePlanDigestSeed(
            appId,
            app.Version,
            selection.Manifest.Version,
            app.SelectedRuntime,
            selection.RuntimeProfile.Key,
            request.TargetChannel ?? app.SelectedChannel,
            currentSelection.ManifestDigest,
            selection.ManifestDigest,
            willCreateBackup,
            changes);
        var digest = HashPlanSeed(seed);
        return new AppUpdatePlan(
            AppId: appId,
            CurrentVersion: app.Version,
            TargetVersion: selection.Manifest.Version!,
            CurrentRuntime: app.SelectedRuntime,
            TargetRuntime: selection.RuntimeProfile.Key,
            TargetChannel: request.TargetChannel ?? app.SelectedChannel,
            ManifestPath: selection.ManifestPath,
            ManifestDigest: selection.ManifestDigest,
            PlanDigest: digest,
            WillCreatePreUpdateBackup: willCreateBackup,
            Changes: changes);
    }

    public async Task<AppLifecycleResponse> ApplyUpdateAsync(string appId, AppUpdateApplyRequest request, CancellationToken cancellationToken = default)
    {
        var plan = await CreateUpdatePlanAsync(appId, new AppUpdatePlanRequest(request.ManifestPath, request.SelectedRuntime, request.TargetChannel), cancellationToken);
        if (!string.Equals(plan.PlanDigest, request.PlanDigest, StringComparison.Ordinal))
        {
            throw new AppLifecycleException("update_plan_digest_mismatch", "Update plan digest does not match the current update plan.");
        }

        var app = await RequireAppAsync(appId, cancellationToken);
        var selection = await manifests.LoadAsync(plan.ManifestPath, plan.TargetRuntime, cancellationToken);
        var currentSelection = await LoadSelectionForAppAsync(app, cancellationToken);
        var adapter = ResolveAdapter(currentSelection.RuntimeProfile.Type);
        var wasRunning = string.Equals(app.RuntimeState, "running", StringComparison.Ordinal);
        if (wasRunning)
        {
            _ = await adapter.StopAsync(await CreateRuntimeContextAsync(app, currentSelection, cancellationToken), cancellationToken);
            _ = await apps.UpdateAppAsync(appId, current => current with { RuntimeState = "stopped" }, cancellationToken);
        }

        var backup = plan.WillCreatePreUpdateBackup
            ? await backups.CreateBackupAsync(appId, "pre-update", cancellationToken: cancellationToken)
            : null;

        await manifests.SaveManifestCopyAsync(selection, GetAppRoot(appId), cancellationToken);
        var manifestCopyPath = Path.Combine(GetAppRoot(appId), "manifest.json");
        var next = BuildAppRecord(
            selection,
            manifestCopyPath,
            manifestUrl: selection.ManifestUrl,
            selectedChannel: plan.TargetChannel,
            system: app.System,
            existing: app) with
        {
            OperationStatus = "updated",
            RuntimeState = "stopped",
            LastOperation = "update",
            LastError = null,
        };
        var document = await apps.UpsertAppAsync(next, cancellationToken);
        if (wasRunning)
        {
            var restarted = await StartAsync(appId, cancellationToken);
            return new AppLifecycleResponse(restarted.App, backup, "updated");
        }

        return new AppLifecycleResponse(AppSummary.From(document.App), backup, "updated");
    }

    public async Task<AppRuntimeSwitchPlan> CreateRuntimeSwitchPlanAsync(
        string appId,
        AppRuntimeSwitchPlanRequest request,
        CancellationToken cancellationToken = default)
    {
        var app = await RequireAppAsync(appId, cancellationToken);
        if (string.IsNullOrWhiteSpace(request.TargetRuntime))
        {
            throw new AppLifecycleException("target_runtime_required", "Target runtime is required.");
        }

        if (string.IsNullOrWhiteSpace(app.ManifestPath))
        {
            throw new AppLifecycleException("manifest_path_required", $"Runtime app '{appId}' has no manifest path.");
        }

        var currentSelection = await LoadSelectionForAppAsync(app, cancellationToken);
        var selection = await manifests.LoadAsync(app.ManifestPath, request.TargetRuntime, cancellationToken);
        var willCreateBackup = Directory.Exists(GetAppDataPath(appId));
        if (willCreateBackup &&
            app.StorageMappings.Any(mapping => string.Equals(mapping.Key, "data", StringComparison.Ordinal)) &&
            selection.DataTarget is null)
        {
            throw new AppLifecycleException(
                "runtime_switch_data_incompatible",
                $"Target runtime '{selection.RuntimeProfile.Key}' does not declare a compatible primary data directory target.");
        }

        var changes = BuildRuntimeSwitchChanges(app, currentSelection, selection);
        var seed = new AppRuntimeSwitchDigestSeed(
            appId,
            app.SelectedRuntime,
            selection.RuntimeProfile.Key,
            app.Version,
            selection.ManifestDigest,
            willCreateBackup,
            changes);
        return new AppRuntimeSwitchPlan(
            AppId: appId,
            CurrentRuntime: app.SelectedRuntime,
            TargetRuntime: selection.RuntimeProfile.Key,
            TargetRuntimeType: selection.RuntimeProfile.Type,
            PlanDigest: HashPlanSeed(seed),
            AutomaticBackup: willCreateBackup,
            Changes: changes);
    }

    public async Task<AppLifecycleResponse> ApplyRuntimeSwitchAsync(
        string appId,
        AppRuntimeSwitchApplyRequest request,
        CancellationToken cancellationToken = default)
    {
        var plan = await CreateRuntimeSwitchPlanAsync(appId, new AppRuntimeSwitchPlanRequest(request.TargetRuntime), cancellationToken);
        if (!string.Equals(plan.PlanDigest, request.PlanDigest, StringComparison.Ordinal))
        {
            throw new AppLifecycleException("runtime_switch_plan_digest_mismatch", "Runtime switch plan digest does not match the current switch plan.");
        }

        var app = await RequireAppAsync(appId, cancellationToken);
        var currentSelection = await LoadSelectionForAppAsync(app, cancellationToken);
        var wasRunning = string.Equals(app.RuntimeState, "running", StringComparison.Ordinal);
        if (wasRunning)
        {
            await ResolveAdapter(currentSelection.RuntimeProfile.Type).StopAsync(await CreateRuntimeContextAsync(app, currentSelection, cancellationToken), cancellationToken);
            _ = await apps.UpdateAppAsync(appId, current => current with { RuntimeState = "stopped" }, cancellationToken);
        }

        var backup = plan.AutomaticBackup
            ? await backups.CreateBackupAsync(appId, "pre-runtime-switch", cancellationToken: cancellationToken)
            : null;

        var targetSelection = await manifests.LoadAsync(app.ManifestPath!, request.TargetRuntime, cancellationToken);
        var next = BuildAppRecord(
            targetSelection,
            app.ManifestPath!,
            manifestUrl: app.ManifestUrl,
            selectedChannel: app.SelectedChannel,
            system: app.System,
            existing: app) with
        {
            SelectedRuntime = targetSelection.RuntimeProfile.Key,
            RuntimeState = "stopped",
            OperationStatus = "runtime-switched",
            LastOperation = "switch-runtime",
            LastError = null,
        };
        await apps.UpsertAppAsync(next, cancellationToken);

        if (wasRunning)
        {
            try
            {
                var restarted = await StartAsync(appId, cancellationToken);
                return new AppLifecycleResponse(restarted.App, backup, "runtime-switched");
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                await RollBackRuntimeSwitchStateAsync(app, currentSelection, ex, cancellationToken);
                throw new AppLifecycleException(
                    "runtime_switch_restart_failed",
                    $"Runtime switch to '{targetSelection.RuntimeProfile.Key}' failed while restarting. Selected runtime was restored to '{currentSelection.RuntimeProfile.Key}' and the app was left stopped. {ex.Message}");
            }
        }

        var document = await apps.GetAppAsync(appId, cancellationToken);
        return new AppLifecycleResponse(document is null ? null : AppSummary.From(document), backup, "runtime-switched");
    }

    public async Task<AppChannelsResponse> ListChannelsAsync(
        string appId,
        AppChannelsRequest request,
        CancellationToken cancellationToken = default)
    {
        var app = await RequireAppAsync(appId, cancellationToken);
        var index = await LoadChannelIndexAsync(app, request.ChannelsPath, cancellationToken);
        return new AppChannelsResponse(appId, index.Channels);
    }

    public async Task<AppChannelSwitchPlan> CreateChannelSwitchPlanAsync(
        string appId,
        AppChannelSwitchPlanRequest request,
        CancellationToken cancellationToken = default)
    {
        var app = await RequireAppAsync(appId, cancellationToken);
        var index = await LoadChannelIndexAsync(app, request.ChannelsPath, cancellationToken);
        var channel = index.Channels.FirstOrDefault(candidate => string.Equals(candidate.Id, request.Channel, StringComparison.Ordinal)) ??
            throw new AppLifecycleException("channel_not_found", $"Channel '{request.Channel}' was not found.");
        var manifestPath = ResolveChannelManifestPath(app.ManifestPath, channel);
        var updatePlan = await CreateUpdatePlanAsync(appId, new AppUpdatePlanRequest(
            ManifestPath: manifestPath,
            SelectedRuntime: request.SelectedRuntime ?? app.SelectedRuntime,
            TargetChannel: channel.Id), cancellationToken);
        return new AppChannelSwitchPlan(
            AppId: appId,
            Channel: channel,
            UpdatePlan: updatePlan,
            PlanDigest: updatePlan.PlanDigest);
    }

    public async Task<AppLifecycleResponse> ApplyChannelSwitchAsync(
        string appId,
        AppChannelSwitchApplyRequest request,
        CancellationToken cancellationToken = default)
    {
        var plan = await CreateChannelSwitchPlanAsync(appId, new AppChannelSwitchPlanRequest(
            Channel: request.Channel,
            ChannelsPath: request.ChannelsPath,
            SelectedRuntime: request.SelectedRuntime), cancellationToken);
        if (!string.Equals(plan.PlanDigest, request.PlanDigest, StringComparison.Ordinal))
        {
            throw new AppLifecycleException("channel_switch_plan_digest_mismatch", "Channel switch plan digest does not match the current switch plan.");
        }

        return await ApplyUpdateAsync(appId, new AppUpdateApplyRequest(
            PlanDigest: plan.UpdatePlan.PlanDigest,
            ManifestPath: plan.UpdatePlan.ManifestPath,
            SelectedRuntime: plan.UpdatePlan.TargetRuntime,
            TargetChannel: plan.Channel.Id), cancellationToken);
    }

    public async Task<AppLifecycleResponse> RemoveAsync(string appId, AppRemoveRequest request, CancellationToken cancellationToken = default)
    {
        var app = await apps.GetAppAsync(appId, cancellationToken);
        if (app is not null && !string.IsNullOrWhiteSpace(app.ManifestPath))
        {
            try
            {
                var selection = await LoadSelectionForAppAsync(app, cancellationToken);
                await ResolveAdapter(selection.RuntimeProfile.Type).RemoveAsync(await CreateRuntimeContextAsync(app, selection, cancellationToken), cancellationToken);
            }
            catch (Exception ex) when (ex is AppLifecycleException or AppManifestException)
            {
                if (!request.IgnoreRuntimeErrors)
                {
                    throw;
                }
            }
        }

        if (request.DeleteRuntimeState)
        {
            TryDelete(Path.Combine(GetAppRoot(appId), "state.json"));
            TryDelete(Path.Combine(GetAppRoot(appId), "manifest.json"));
        }

        if (request.DeleteData)
        {
            TryDeleteDirectory(GetAppDataPath(appId));
        }

        if (request.DeleteBackups)
        {
            await backups.DeleteAllBackupsAsync(appId, cancellationToken);
        }

        if (request.DeleteSource)
        {
            TryDeleteDirectory(CoreDataPaths.ResolveContainedPath(paths.SourcesRoot, appId));
        }

        TryDeleteDirectoryIfEmpty(GetAppRoot(appId));
        await ReconcileIngressAsync(cancellationToken);
        return new AppLifecycleResponse(app is null ? null : AppSummary.From(app), null, "removed");
    }

    public async Task<AppBackupsResponse> ListBackupsAsync(string appId, CancellationToken cancellationToken = default)
    {
        _ = await RequireAppAsync(appId, cancellationToken);
        return new AppBackupsResponse(await backups.ListBackupsAsync(appId, cancellationToken));
    }

    public async Task<AppBackupResponse> CreateManualBackupAsync(string appId, AppManualBackupRequest request, CancellationToken cancellationToken = default)
    {
        var app = await RequireAppAsync(appId, cancellationToken);
        var reason = string.IsNullOrWhiteSpace(request.Reason) ? "manual" : request.Reason.Trim();
        if (!BackupReasonPattern.IsMatch(reason))
        {
            throw new AppLifecycleException("backup_reason_invalid", "Backup reason must match ^[a-z0-9][a-z0-9-]{0,30}$.");
        }

        if (AppBackupService.IsReservedReason(reason))
        {
            throw new AppLifecycleException("backup_reason_reserved", $"{reason} backup reason is reserved for Core lifecycle and app-initiated operations.");
        }

        // Stop the app while its data directory is copied so the snapshot is consistent.
        // Core zips the live data directory with no app-side coordination, so a running app
        // could be mid-write (e.g. an open SQLite transaction) and produce a torn archive.
        // The other Core-initiated backups (pre-update/-runtime-switch/-restore) already copy
        // stopped data; this mirrors that stop->operate->restart pattern for operator backups.
        var wasRunning = string.Equals(app.RuntimeState, "running", StringComparison.Ordinal);
        try
        {
            // Stop inside the try so the finally restart still runs if the stop sequence itself
            // throws partway (e.g. UpdateAppAsync fails after the runtime is already stopped).
            if (wasRunning)
            {
                var selection = await LoadSelectionForAppAsync(app, cancellationToken);
                _ = await ResolveAdapter(selection.RuntimeProfile.Type)
                    .StopAsync(await CreateRuntimeContextAsync(app, selection, cancellationToken), cancellationToken);
                _ = await apps.UpdateAppAsync(appId, current => current with { RuntimeState = "stopped" }, cancellationToken);
            }

            return new AppBackupResponse(await backups.CreateBackupAsync(appId, reason, cancellationToken: cancellationToken));
        }
        finally
        {
            // Always attempt to restore the prior running state, even if the backup failed or was
            // cancelled, so an operator-triggered backup never silently leaves a running app stopped.
            // Use CancellationToken.None so a cancelled backup still restarts; a restart failure
            // surfaces through StartAsync (recorded + thrown), which is the right signal.
            if (wasRunning)
            {
                _ = await StartAsync(appId, CancellationToken.None);
            }
        }
    }

    public async Task<AppBackupResponse> RestoreBackupAsync(string appId, string backupId, AppRestoreBackupRequest request, CancellationToken cancellationToken = default)
    {
        var app = await RequireAppAsync(appId, cancellationToken);
        if (string.Equals(app.RuntimeState, "running", StringComparison.Ordinal))
        {
            throw new AppLifecycleException("app_must_be_stopped", "Stop the runtime app before restoring data.");
        }

        return new AppBackupResponse(await backups.RestoreBackupAsync(appId, backupId, request.CreatePreRestoreBackup, cancellationToken));
    }

    public async Task<AppBackupDeleteResponse> DeleteBackupAsync(string appId, string backupId, CancellationToken cancellationToken = default)
    {
        _ = await RequireAppAsync(appId, cancellationToken);
        return new AppBackupDeleteResponse(await backups.DeleteBackupAsync(appId, backupId, cancellationToken));
    }

    public async Task<AppBackupCleanupPlan> CreateBackupCleanupPlanAsync(string appId, CancellationToken cancellationToken = default)
    {
        _ = await RequireAppAsync(appId, cancellationToken);
        return await backups.CreateCleanupPlanAsync(appId, cancellationToken);
    }

    public async Task<AppBackupCleanupApplyResponse> ApplyBackupCleanupAsync(
        string appId,
        AppBackupCleanupApplyRequest request,
        CancellationToken cancellationToken = default)
    {
        _ = await RequireAppAsync(appId, cancellationToken);
        return await backups.ApplyCleanupAsync(appId, request, cancellationToken);
    }

    public async Task<AppLogsResponse> GetLogsAsync(string appId, int tail, CancellationToken cancellationToken = default)
    {
        var app = await RequireAppAsync(appId, cancellationToken);
        var selection = await LoadSelectionForAppAsync(app, cancellationToken);
        var logs = await ResolveAdapter(selection.RuntimeProfile.Type).GetLogsAsync(await CreateRuntimeContextAsync(app, selection, cancellationToken), tail, cancellationToken);
        var services = (logs.Services ?? [])
            .Select(segment => new AppLogsServiceSegment(segment.Service, segment.Text))
            .ToArray();
        return new AppLogsResponse(appId, logs.Text, services);
    }

    public async Task<AppRuntimeHealthResponse> GetHealthAsync(string appId, CancellationToken cancellationToken = default)
    {
        var app = await RequireAppAsync(appId, cancellationToken);
        var selection = await LoadSelectionForAppAsync(app, cancellationToken);
        var health = await ResolveAdapter(selection.RuntimeProfile.Type).GetHealthAsync(
            await CreateRuntimeContextAsync(app, selection, cancellationToken),
            cancellationToken);
        return new AppRuntimeHealthResponse(
            AppId: appId,
            Runtime: selection.RuntimeProfile.Key,
            RuntimeType: selection.RuntimeProfile.Type,
            Status: health.Status,
            Services: health.Services);
    }

    public async Task<IReadOnlyList<AppBackgroundLifecycleResult>> StartAutostartAppsAsync(CancellationToken cancellationToken = default)
    {
        var results = new List<AppBackgroundLifecycleResult>();
        var records = await apps.ListAppRecordsAsync(cancellationToken);
        foreach (var app in records.Where(app =>
            string.Equals(app.Kind, "runtime", StringComparison.Ordinal) &&
            (app.Autostart ?? true)).OrderBy(app => app.Id, StringComparer.Ordinal))
        {
            cancellationToken.ThrowIfCancellationRequested();
            results.Add(await RunBackgroundLifecycleActionAsync(
                app.Id,
                "autostart",
                async () => await StartAsync(app.Id, cancellationToken),
                cancellationToken));
        }

        return results;
    }

    public async Task<IReadOnlyList<AppBackgroundLifecycleResult>> StopAutostartDisabledAppsAsync(CancellationToken cancellationToken = default)
    {
        var results = new List<AppBackgroundLifecycleResult>();
        var records = await apps.ListAppRecordsAsync(cancellationToken);
        foreach (var app in records.Where(app =>
            string.Equals(app.Kind, "runtime", StringComparison.Ordinal) &&
            !(app.Autostart ?? true)).OrderByDescending(app => app.Id, StringComparer.Ordinal))
        {
            cancellationToken.ThrowIfCancellationRequested();
            results.Add(await RunBackgroundLifecycleActionAsync(
                app.Id,
                "autostart-disabled-stop",
                async () => await StopAsync(app.Id, cancellationToken),
                cancellationToken));
        }

        return results;
    }

    public async Task<IReadOnlyList<AppBackgroundLifecycleResult>> StopRuntimeAppsAsync(CancellationToken cancellationToken = default)
    {
        var results = new List<AppBackgroundLifecycleResult>();
        var records = await apps.ListAppRecordsAsync(cancellationToken);
        foreach (var app in records.Where(app =>
            string.Equals(app.Kind, "runtime", StringComparison.Ordinal)).OrderByDescending(app => app.Id, StringComparer.Ordinal))
        {
            cancellationToken.ThrowIfCancellationRequested();
            results.Add(await RunBackgroundLifecycleActionAsync(
                app.Id,
                "core-shutdown-stop",
                async () => await StopAsync(app.Id, cancellationToken),
                cancellationToken));
        }

        return results;
    }

    private AppRecord BuildAppRecord(
        RuntimeAppManifestSelection selection,
        string manifestPath,
        string? manifestUrl,
        string? selectedChannel,
        bool system,
        AppRecord? existing)
    {
        var manifest = selection.Manifest;
        var settings = BuildSettingDefinitions(selection).ToDictionary(
            setting => setting.Key,
            setting =>
            {
                var current = existing?.Settings.GetValueOrDefault(setting.Key);
                return new AppSettingValue(setting.Key, setting.Type, current?.Value ?? setting.Default, setting.Secret, setting.Required);
            },
            StringComparer.Ordinal);
        var storageMappings = selection.DataTarget is null
            ? []
            : new AppStorageMapping[]
            {
                new(
                    Key: "data",
                    HostPath: GetAppDataPath(manifest.Id!),
                    TargetPath: selection.DataTarget.ContainerPath ?? GetAppDataPath(manifest.Id!),
                    ReadOnly: false),
            };
        var dependencies = manifest.Dependencies
            .Select(dependency => new AppDependencyContract(dependency.Id, dependency.Id, "default"))
            .ToArray();
        var endpointContracts = manifest.Endpoints.Count == 0
            ? selection.Services.SelectMany(service => service.Runtime.Ports.Select(port => new AppEndpointContract(
                Key: $"{service.Key}.{port.Key ?? port.ContainerPort?.ToString(System.Globalization.CultureInfo.InvariantCulture) ?? "port"}",
                Protocol: string.IsNullOrWhiteSpace(port.Protocol) ? "http" : port.Protocol,
                Url: null,
                Public: port.Public ?? false,
                Service: service.Key,
                Port: port.Key ?? port.ContainerPort?.ToString(System.Globalization.CultureInfo.InvariantCulture) ?? "port"))).ToArray()
            : manifest.Endpoints.Select(endpoint => new AppEndpointContract(
                Key: endpoint.Key,
                Protocol: endpoint.Protocol ?? "http",
                Url: null,
                Public: endpoint.Public,
                Service: endpoint.Service,
                Port: endpoint.Port)).ToArray();
        var endpoints = PreserveEndpointUrls(endpointContracts, existing?.Endpoints);

        return new AppRecord(
            Id: manifest.Id!,
            DisplayName: manifest.Name!,
            Description: manifest.Description,
            Version: manifest.Version!,
            Kind: "runtime",
            System: system,
            Source: manifest.Source?.Repository ?? "manifest",
            ManifestPath: manifestPath,
            ManifestUrl: manifestUrl,
            SelectedChannel: selectedChannel,
            SelectedRuntime: selection.RuntimeProfile.Key,
            OperationStatus: existing?.OperationStatus ?? "installed",
            RuntimeState: existing?.RuntimeState ?? "stopped",
            LastOperation: existing?.LastOperation,
            LastError: existing?.LastError,
            Capabilities: ResolveCapabilities(manifest),
            Settings: settings,
            StorageMappings: storageMappings,
            Dependencies: dependencies,
            Endpoints: endpoints,
            InstalledAt: existing?.InstalledAt ?? default,
            UpdatedAt: default,
            SourceState: BuildSourceState(selection, existing),
            Ui: AppUiContract.FromManifest(manifest.Ui),
            Autostart: existing?.Autostart ?? true,
            RuntimeProfiles: BuildRuntimeProfileSummaries(manifest),
            MountSlots: BuildMountSlots(manifest),
            Mounts: PreserveMounts(manifest, existing?.Mounts));
    }

    // External-mount slots are redeclared from the manifest on every (re)build, like runtime
    // profiles. Operator bindings are preserved from the existing record (like settings) so they
    // survive update / runtime-switch; bindings whose slot the manifest no longer declares are
    // dropped here so they cannot linger as orphans.
    private static IReadOnlyList<AppMountSlot> BuildMountSlots(RuntimeAppManifest manifest)
        => manifest.ExternalMounts
            .OrderBy(entry => entry.Key, StringComparer.Ordinal)
            .Select(entry => new AppMountSlot(entry.Key, entry.Value.Mode, entry.Value.Multiple, entry.Value.Required, entry.Value.Service))
            .ToArray();

    private static IReadOnlyList<AppMountBinding> PreserveMounts(
        RuntimeAppManifest manifest,
        IReadOnlyList<AppMountBinding>? existing)
    {
        if (existing is null || existing.Count == 0)
        {
            return [];
        }

        return existing
            .Where(binding => manifest.ExternalMounts.ContainsKey(binding.Key))
            .ToArray();
    }

    private static IReadOnlyList<AppEndpointContract> PreserveEndpointUrls(
        IReadOnlyList<AppEndpointContract> endpoints,
        IReadOnlyList<AppEndpointContract>? existing)
    {
        if (existing is null || existing.Count == 0)
        {
            return endpoints;
        }

        return endpoints.Select(endpoint =>
        {
            var match = existing.FirstOrDefault(candidate =>
                    string.Equals(candidate.Key, endpoint.Key, StringComparison.Ordinal) &&
                    !string.IsNullOrWhiteSpace(candidate.Url)) ??
                existing.FirstOrDefault(candidate =>
                    string.Equals(candidate.Service, endpoint.Service, StringComparison.Ordinal) &&
                    string.Equals(candidate.Port, endpoint.Port, StringComparison.Ordinal) &&
                    !string.IsNullOrWhiteSpace(candidate.Url));

            return string.IsNullOrWhiteSpace(match?.Url)
                ? endpoint
                : endpoint with { Url = match.Url };
        }).ToArray();
    }

    private async Task<AppSummary> BuildAppSummaryAsync(AppRecord app, CancellationToken cancellationToken)
    {
        if (app.RuntimeProfiles is { Count: > 0 })
        {
            return AppSummary.From(app);
        }

        return AppSummary.From(app, await TryLoadRuntimeProfilesForSummaryAsync(app, cancellationToken));
    }

    private async Task<IReadOnlyList<AppRuntimeProfileSummary>> TryLoadRuntimeProfilesForSummaryAsync(
        AppRecord app,
        CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(app.ManifestPath))
        {
            return [];
        }

        try
        {
            var selection = await manifests.LoadAsync(app.ManifestPath, app.SelectedRuntime, cancellationToken);
            return string.Equals(selection.Manifest.Id, app.Id, StringComparison.Ordinal)
                ? BuildRuntimeProfileSummaries(selection.Manifest)
                : [];
        }
        catch (Exception ex) when (ex is AppManifestException or IOException or UnauthorizedAccessException or JsonException or HttpRequestException)
        {
            return [];
        }
    }

    private async Task<AppBackgroundLifecycleResult> RunBackgroundLifecycleActionAsync(
        string appId,
        string operation,
        Func<Task<AppLifecycleResponse>> action,
        CancellationToken cancellationToken)
    {
        try
        {
            var response = await action();
            return new AppBackgroundLifecycleResult(appId, operation, Succeeded: true, ErrorCode: null, Message: response.Status);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception ex) when (ex is AppLifecycleException or AppManifestException or IOException or UnauthorizedAccessException or JsonException)
        {
            var code = ex is AppLifecycleException lifecycleException
                ? lifecycleException.Code
                : ex is AppManifestException manifestException
                    ? manifestException.Code
                    : "background_lifecycle_failed";
            await RecordBackgroundLifecycleFailureAsync(appId, operation, ex.Message, cancellationToken);
            return new AppBackgroundLifecycleResult(appId, operation, Succeeded: false, ErrorCode: code, Message: ex.Message);
        }
    }

    private async Task RecordBackgroundLifecycleFailureAsync(
        string appId,
        string operation,
        string message,
        CancellationToken cancellationToken)
    {
        try
        {
            await apps.UpdateAppAsync(appId, current => current with
            {
                OperationStatus = "failed",
                LastOperation = operation,
                LastError = message,
            }, cancellationToken);
        }
        catch (Exception ex) when (ex is InvalidOperationException or IOException or UnauthorizedAccessException or JsonException)
        {
        }
    }

    private async Task RecordForegroundLifecycleFailureAsync(
        string appId,
        string operation,
        string runtimeState,
        string message,
        CancellationToken cancellationToken)
    {
        try
        {
            await apps.UpdateAppAsync(appId, current => current with
            {
                RuntimeState = runtimeState,
                OperationStatus = "failed",
                LastOperation = operation,
                LastError = message,
            }, cancellationToken);
        }
        catch (Exception ex) when (ex is InvalidOperationException or IOException or UnauthorizedAccessException or JsonException)
        {
        }
    }

    private static async Task TryStopRuntimeAsync(IAppRuntimeAdapter adapter, RuntimeLifecycleContext context)
    {
        try
        {
            _ = await adapter.StopAsync(context, CancellationToken.None);
        }
        catch
        {
        }
    }

    private static bool IsRecordableLifecycleFailure(Exception ex)
        => ex is AppLifecycleException or AppManifestException or IOException or UnauthorizedAccessException or JsonException;

    private AppSourceState? BuildSourceState(RuntimeAppManifestSelection selection, AppRecord? existing)
    {
        var source = selection.Manifest.Source;
        var localOverridePath = ResolveInstallLocalSourcePath(selection, source);
        if (source?.Repository is null)
        {
            if (!string.Equals(selection.RuntimeProfile.Type, "localCommand", StringComparison.Ordinal))
            {
                return existing?.SourceState;
            }

            return existing?.SourceState ?? (localOverridePath is null
                ? null
                : new AppSourceState(
                    Type: "local",
                    Repository: null,
                    ResolvedRef: null,
                    Commit: null,
                    ManagedCheckoutPath: Path.Combine(paths.SourcesRoot, selection.Manifest.Id!),
                    LocalOverridePath: localOverridePath,
                    UpdatedAt: null));
        }

        var resolvedRef = source.Commit ?? source.Tag ?? source.Branch;
        if (existing?.SourceState is not null &&
            string.Equals(existing.SourceState.Repository, source.Repository, StringComparison.Ordinal))
        {
            var resolvedRefChanged = !string.Equals(existing.SourceState.ResolvedRef, resolvedRef, StringComparison.Ordinal);
            return existing.SourceState with
            {
                Type = source.Type,
                Repository = source.Repository,
                ResolvedRef = resolvedRef ?? existing.SourceState.ResolvedRef,
                Commit = source.Commit ?? (resolvedRefChanged ? null : existing.SourceState.Commit),
                ManagedCheckoutPath = existing.SourceState.ManagedCheckoutPath ?? Path.Combine(paths.SourcesRoot, selection.Manifest.Id!),
                LocalOverridePath = existing.SourceState.LocalOverridePath ?? localOverridePath,
            };
        }

        return new AppSourceState(
            Type: source.Type,
            Repository: source.Repository,
            ResolvedRef: resolvedRef,
            Commit: source.Commit,
            ManagedCheckoutPath: Path.Combine(paths.SourcesRoot, selection.Manifest.Id!),
            LocalOverridePath: localOverridePath,
            UpdatedAt: null);
    }

    private string? ResolveInstallLocalSourcePath(RuntimeAppManifestSelection selection, RuntimeAppSource? source)
    {
        if (!string.IsNullOrWhiteSpace(selection.ManifestUrl) ||
            string.IsNullOrWhiteSpace(selection.ManifestPath))
        {
            return null;
        }

        var manifestDirectory = Path.GetDirectoryName(Path.GetFullPath(selection.ManifestPath));
        if (string.IsNullOrWhiteSpace(manifestDirectory))
        {
            return null;
        }

        var repository = source?.Repository?.Trim();
        if (!string.IsNullOrWhiteSpace(repository))
        {
            if (Uri.TryCreate(repository, UriKind.Absolute, out var repositoryUri) && repositoryUri.IsFile)
            {
                return Directory.Exists(repositoryUri.LocalPath)
                    ? Path.GetFullPath(repositoryUri.LocalPath)
                    : null;
            }

            if (Path.IsPathFullyQualified(repository))
            {
                return Directory.Exists(repository) ? Path.GetFullPath(repository) : null;
            }
        }

        var gitRoot = FindGitRoot(manifestDirectory);
        if (gitRoot is not null)
        {
            return gitRoot;
        }

        if (string.IsNullOrWhiteSpace(repository))
        {
            return InferLocalSourceRootFromWorkingDirectories(manifestDirectory, selection) ?? manifestDirectory;
        }

        if (Uri.TryCreate(repository, UriKind.Absolute, out var absoluteRepositoryUri) && !absoluteRepositoryUri.IsFile)
        {
            return null;
        }

        if (repository == ".")
        {
            return manifestDirectory;
        }

        var manifestRelativePath = Path.GetFullPath(Path.Combine(manifestDirectory, repository));
        if (Directory.Exists(manifestRelativePath))
        {
            return manifestRelativePath;
        }

        return InferLocalSourceRootFromWorkingDirectories(manifestDirectory, selection) ?? manifestDirectory;
    }

    private static string? InferLocalSourceRootFromWorkingDirectories(
        string manifestDirectory,
        RuntimeAppManifestSelection selection)
    {
        foreach (var workingDirectory in selection.Services
            .Select(service => service.Runtime.WorkingDirectory)
            .Where(directory => !string.IsNullOrWhiteSpace(directory))
            .Distinct(StringComparer.Ordinal))
        {
            var root = TryStripRelativeSuffix(manifestDirectory, workingDirectory!);
            if (root is not null)
            {
                return root;
            }
        }

        return null;
    }

    private static string? TryStripRelativeSuffix(string path, string suffix)
    {
        if (Path.IsPathFullyQualified(suffix))
        {
            return null;
        }

        var suffixParts = suffix
            .Replace('\\', Path.DirectorySeparatorChar)
            .Replace('/', Path.DirectorySeparatorChar)
            .Split(Path.DirectorySeparatorChar, StringSplitOptions.RemoveEmptyEntries)
            .Where(part => part != ".")
            .ToArray();
        if (suffixParts.Length == 0)
        {
            return path;
        }

        if (suffixParts.Any(part => part == ".."))
        {
            return null;
        }

        var current = new DirectoryInfo(path);
        for (var index = suffixParts.Length - 1; index >= 0; index--)
        {
            if (!string.Equals(current.Name, suffixParts[index], StringComparison.Ordinal))
            {
                return null;
            }

            current = current.Parent ?? current;
        }

        return current.FullName;
    }

    private static string? FindGitRoot(string startDirectory)
    {
        var directory = new DirectoryInfo(startDirectory);
        while (directory is not null)
        {
            var gitPath = Path.Combine(directory.FullName, ".git");
            if (Directory.Exists(gitPath) || File.Exists(gitPath))
            {
                return directory.FullName;
            }

            directory = directory.Parent;
        }

        return null;
    }

    private static IReadOnlyList<AppEndpointContract> MergeEndpointUrls(
        IReadOnlyList<AppEndpointContract> current,
        IReadOnlyList<AppEndpointContract> started,
        RuntimeAppManifestSelection selection)
    {
        var baseEndpoints = BuildEndpointContracts(selection);
        if (baseEndpoints.Count == 0)
        {
            baseEndpoints = current;
        }

        var startedByKey = started.ToDictionary(endpoint => endpoint.Key, StringComparer.Ordinal);
        var aliases = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var endpoint in selection.Manifest.Endpoints)
        {
            if (!string.IsNullOrWhiteSpace(endpoint.Key) &&
                !string.IsNullOrWhiteSpace(endpoint.Service) &&
                !string.IsNullOrWhiteSpace(endpoint.Port))
            {
                aliases.TryAdd(endpoint.Key, $"{endpoint.Service}.{endpoint.Port}");
            }
        }
        var usedStartedKeys = new HashSet<string>(StringComparer.Ordinal);
        var merged = baseEndpoints.Select(endpoint =>
        {
            if (startedByKey.TryGetValue(endpoint.Key, out var direct))
            {
                usedStartedKeys.Add(direct.Key);
                return endpoint with
                {
                    Url = direct.Url,
                    Protocol = direct.Protocol,
                    Public = endpoint.Public,
                    Service = endpoint.Service ?? direct.Service,
                    Port = endpoint.Port ?? direct.Port,
                };
            }

            if (aliases.TryGetValue(endpoint.Key, out var runtimeKey) &&
                startedByKey.TryGetValue(runtimeKey, out var aliased))
            {
                usedStartedKeys.Add(aliased.Key);
                return endpoint with
                {
                    Url = aliased.Url,
                    Protocol = aliased.Protocol,
                    Public = endpoint.Public,
                    Service = endpoint.Service ?? aliased.Service,
                    Port = endpoint.Port ?? aliased.Port,
                };
            }

            return endpoint;
        }).ToArray();

        // When the manifest declares an explicit endpoint set, that set is authoritative: persist
        // only the declared endpoints (enriched with runtime URLs above). Runtime-reported ports
        // that have no declared endpoint — e.g. an internal-only HTTP port or a raw TCP/UDP port —
        // must NOT be appended here. Otherwise they linger in the persisted record while the update
        // plan rebuilds its target from the manifest (declared endpoints only), so every check
        // reports them as "removed" and the plan never converges.
        if (selection.Manifest.Endpoints.Count > 0)
        {
            return merged;
        }

        return merged
            .Concat(started.Where(endpoint =>
                !usedStartedKeys.Contains(endpoint.Key) &&
                baseEndpoints.All(existing => !string.Equals(existing.Key, endpoint.Key, StringComparison.Ordinal))))
            .ToArray();
    }

    private async Task RollBackRuntimeSwitchStateAsync(
        AppRecord app,
        RuntimeAppManifestSelection currentSelection,
        Exception error,
        CancellationToken cancellationToken)
    {
        var rolledBack = BuildAppRecord(
            currentSelection,
            app.ManifestPath!,
            manifestUrl: app.ManifestUrl,
            selectedChannel: app.SelectedChannel,
            system: app.System,
            existing: app) with
        {
            SelectedRuntime = currentSelection.RuntimeProfile.Key,
            RuntimeState = "stopped",
            OperationStatus = "runtime-switch-rollback",
            LastOperation = "switch-runtime",
            LastError = $"Target runtime failed to start: {error.Message}",
        };
        await apps.UpsertAppAsync(rolledBack, cancellationToken);
    }

    private async Task<RuntimeLifecycleContext> CreateRuntimeContextAsync(
        AppRecord app,
        RuntimeAppManifestSelection selection,
        CancellationToken cancellationToken)
        => new(
            app,
            selection,
            GetAppRoot(app.Id),
            GetAppDataPath(app.Id),
            await ResolveDependencyUrlsAsync(app, cancellationToken),
            RuntimeMountPlanner.Resolve(app.MountSlots, app.Mounts));

    // Start-time gate for external mounts: a declared-required slot must have a binding, every
    // configured host path must still pass the path policy (defense-in-depth against a binding
    // tampered on disk), and must exist as a directory. We check existence in Core rather than
    // let docker bind a missing path, which would silently create an empty root-owned dir.
    private void EnsureMountsReadyForStart(RuntimeLifecycleContext context)
    {
        RuntimeMountPlanner.EnsureRequiredConfigured(context.App.MountSlots, context.App.Mounts);
        foreach (var mount in context.Mounts)
        {
            // Re-check both the stored path and its symlink-resolved target: a path validated at
            // config time could have been repointed at a forbidden location since (TOCTOU).
            EnsureMountPathAllowed(mount.HostPath);
            EnsureMountPathAllowed(ResolveRealPath(mount.HostPath));
            if (!Directory.Exists(mount.HostPath))
            {
                throw new AppLifecycleException(
                    "app_mount_source_missing",
                    $"External mount '{mount.Key}/{mount.Label}' host path was not found or is not a directory: {mount.HostPath}");
            }
        }
    }

    private async Task<AppRecord> EnsureLocalCommandSourceReadyAsync(
        AppRecord app,
        RuntimeAppManifestSelection selection,
        CancellationToken cancellationToken)
    {
        if (!string.Equals(selection.RuntimeProfile.Type, "localCommand", StringComparison.Ordinal))
        {
            return app;
        }

        var source = app.SourceState;
        if (!string.IsNullOrWhiteSpace(source?.LocalOverridePath))
        {
            if (!Directory.Exists(source.LocalOverridePath))
            {
                throw new AppLifecycleException(
                    "source_override_not_found",
                    $"Local source override path was not found: {source.LocalOverridePath}");
            }

            return app;
        }

        if (string.IsNullOrWhiteSpace(app.ManifestUrl))
        {
            throw new AppLifecycleException(
                "local_command_source_root_required",
                $"Runtime app '{app.Id}' uses localCommand but no local source root was resolved.");
        }

        if (string.IsNullOrWhiteSpace(selection.Manifest.Source?.Repository))
        {
            throw new AppLifecycleException(
                "source_required_for_local_command",
                $"Remote manifest runtime '{selection.RuntimeProfile.Key}' uses localCommand and must declare source.repository.");
        }

        if (IsRelativeSourceRepository(selection.Manifest.Source.Repository))
        {
            throw new AppLifecycleException(
                "source_repository_relative_remote_unsupported",
                $"Remote manifest runtime '{selection.RuntimeProfile.Key}' uses localCommand, so source.repository must be an absolute Git URL or local repository path.");
        }

        var checkoutPath = source?.ManagedCheckoutPath ?? Path.Combine(paths.SourcesRoot, app.Id);
        if (Directory.Exists(Path.Combine(checkoutPath, ".git")) &&
            !string.IsNullOrWhiteSpace(source?.Commit))
        {
            return app;
        }

        await sources.ResolveManagedAsync(
            app.Id,
            new AppSourceResolveRequest(
                Branch: selection.Manifest.Source.Branch,
                Tag: selection.Manifest.Source.Tag,
                Commit: selection.Manifest.Source.Commit,
                Fetch: !string.IsNullOrWhiteSpace(selection.Manifest.Source.Branch)),
            cancellationToken);

        return await RequireAppAsync(app.Id, cancellationToken);
    }

    private static bool IsRelativeSourceRepository(string repository)
    {
        var trimmed = repository.Trim();
        if (Uri.TryCreate(trimmed, UriKind.Absolute, out var uri) && !string.IsNullOrWhiteSpace(uri.Scheme))
        {
            return false;
        }

        if (Path.IsPathFullyQualified(trimmed))
        {
            return false;
        }

        return true;
    }

    private async Task<IReadOnlyDictionary<string, string>> ResolveDependencyUrlsAsync(AppRecord app, CancellationToken cancellationToken)
    {
        var urls = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var dependency in app.Dependencies)
        {
            var dependencyApp = await apps.GetAppAsync(dependency.AppId, cancellationToken);
            var endpoint = dependencyApp?.Endpoints.FirstOrDefault(candidate =>
                    string.Equals(candidate.Key, dependency.Endpoint, StringComparison.Ordinal)) ??
                dependencyApp?.Endpoints.FirstOrDefault(candidate => !string.IsNullOrWhiteSpace(candidate.Url));
            if (!string.IsNullOrWhiteSpace(endpoint?.Url))
            {
                urls[dependency.Key] = endpoint.Url;
            }
        }

        return urls;
    }

    private async Task<AppRecord> RequireAppAsync(string appId, CancellationToken cancellationToken)
        => await apps.GetAppAsync(appId, cancellationToken) ??
            throw new AppLifecycleException("app_not_found", $"Runtime app '{appId}' was not found.");

    private async Task<RuntimeAppManifestSelection> LoadSelectionForAppAsync(AppRecord app, CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(app.ManifestPath))
        {
            throw new AppLifecycleException("manifest_path_required", $"Runtime app '{app.Id}' has no manifest path.");
        }

        return await manifests.LoadAsync(app.ManifestPath, app.SelectedRuntime, cancellationToken);
    }

    private IAppRuntimeAdapter ResolveAdapter(string? runtimeType)
        => adapters.FirstOrDefault(adapter => string.Equals(adapter.Type, runtimeType, StringComparison.Ordinal))
            ?? throw new AppLifecycleException("runtime_adapter_missing", $"Runtime adapter '{runtimeType}' is not available.");

    private string GetAppRoot(string appId)
        => CoreDataPaths.ResolveContainedPath(paths.AppsRoot, appId);

    private string GetAppDataPath(string appId)
        => Path.Combine(GetAppRoot(appId), "data");

    private static string HashPlanSeed<T>(T seed)
    {
        var json = JsonSerializer.Serialize(seed, CoreJson.TypeInfo<T>());
        return Convert.ToHexString(SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(json))).ToLowerInvariant();
    }

    private IReadOnlyList<string> BuildUpdateChanges(
        AppRecord app,
        RuntimeAppManifestSelection currentSelection,
        RuntimeAppManifestSelection targetSelection)
    {
        var changes = new List<string>();
        if (!string.Equals(app.Version, targetSelection.Manifest.Version, StringComparison.Ordinal))
        {
            changes.Add($"version:{app.Version}->{targetSelection.Manifest.Version}");
        }

        if (!string.Equals(app.SelectedRuntime, targetSelection.RuntimeProfile.Key, StringComparison.Ordinal))
        {
            changes.Add($"runtime:{app.SelectedRuntime}->{targetSelection.RuntimeProfile.Key}");
        }

        AddUpdateServiceChanges(changes, currentSelection, targetSelection);
        AddSettingChanges(changes, app.Settings, BuildSettingDefinitions(targetSelection));
        AddDependencyChanges(changes, app.Dependencies, targetSelection.Manifest.Dependencies);
        AddEndpointChanges(changes, app.Endpoints, BuildEndpointContracts(targetSelection));
        AddUpdateDataTargetChanges(changes, app, targetSelection);
        AddCapabilityChanges(changes, app.Capabilities, ResolveCapabilities(targetSelection.Manifest));

        if (changes.Count == 0 &&
            !string.Equals(currentSelection.ManifestDigest, targetSelection.ManifestDigest, StringComparison.Ordinal))
        {
            changes.Add("manifest");
        }

        return changes;
    }

    private static void AddUpdateServiceChanges(
        List<string> changes,
        RuntimeAppManifestSelection currentSelection,
        RuntimeAppManifestSelection targetSelection)
    {
        var currentServices = currentSelection.Services.ToDictionary(service => service.Key, StringComparer.Ordinal);
        var targetServices = targetSelection.Services.ToDictionary(service => service.Key, StringComparer.Ordinal);
        foreach (var key in currentServices.Keys.Concat(targetServices.Keys).Distinct(StringComparer.Ordinal).Order(StringComparer.Ordinal))
        {
            var hasCurrent = currentServices.TryGetValue(key, out var current);
            var hasTarget = targetServices.TryGetValue(key, out var target);
            if (!hasCurrent)
            {
                changes.Add($"service:{key}:added:{target!.Runtime.Type}");
                continue;
            }

            if (!hasTarget)
            {
                changes.Add($"service:{key}:removed:{current!.Runtime.Type}");
                continue;
            }

            if (!string.Equals(current!.Runtime.Type, target!.Runtime.Type, StringComparison.Ordinal))
            {
                changes.Add($"service:{key}:runtimeType:{current.Runtime.Type}->{target.Runtime.Type}");
            }

            AddImageChange(changes, key, current, target);
            AddCommandChanges(changes, key, current, target);
            AddNetworkChange(changes, key, current, target);
            AddCapabilityChanges(changes, key, current, target);
            AddPortChanges(changes, key, current.Runtime.Ports, target.Runtime.Ports);
            AddEnvironmentChanges(changes, key, current.Runtime.Environment, target.Runtime.Environment);
        }
    }

    private IReadOnlyList<string> BuildRuntimeSwitchChanges(
        AppRecord app,
        RuntimeAppManifestSelection currentSelection,
        RuntimeAppManifestSelection targetSelection)
    {
        var changes = new List<string>
        {
            $"runtime:{app.SelectedRuntime}->{targetSelection.RuntimeProfile.Key}",
        };

        changes.Add(string.Equals(currentSelection.RuntimeProfile.Type, targetSelection.RuntimeProfile.Type, StringComparison.Ordinal)
            ? $"runtimeType:{targetSelection.RuntimeProfile.Type}"
            : $"runtimeType:{currentSelection.RuntimeProfile.Type}->{targetSelection.RuntimeProfile.Type}");

        AddServiceChanges(changes, app.Id, currentSelection, targetSelection);
        AddSettingChanges(changes, app.Settings, BuildSettingDefinitions(targetSelection));
        AddDependencyChanges(changes, app.Dependencies, targetSelection.Manifest.Dependencies);
        AddEndpointChanges(changes, app.Endpoints, BuildEndpointContracts(targetSelection));
        AddDataTargetChanges(changes, app, targetSelection);

        return changes;
    }

    private static void AddServiceChanges(
        List<string> changes,
        string appId,
        RuntimeAppManifestSelection currentSelection,
        RuntimeAppManifestSelection targetSelection)
    {
        var currentServices = currentSelection.Services.ToDictionary(service => service.Key, StringComparer.Ordinal);
        var targetServices = targetSelection.Services.ToDictionary(service => service.Key, StringComparer.Ordinal);
        foreach (var key in currentServices.Keys.Concat(targetServices.Keys).Distinct(StringComparer.Ordinal).Order(StringComparer.Ordinal))
        {
            var hasCurrent = currentServices.TryGetValue(key, out var current);
            var hasTarget = targetServices.TryGetValue(key, out var target);
            if (!hasCurrent)
            {
                changes.Add($"service:{key}:added:{target!.Runtime.Type}");
            }
            else if (!hasTarget)
            {
                changes.Add($"service:{key}:removed:{current!.Runtime.Type}");
            }
            else
            {
                AddImageChange(changes, key, current!, target!);
                AddCommandChanges(changes, key, current!, target!);
                AddNetworkChange(changes, key, current!, target!);
                AddCapabilityChanges(changes, key, current!, target!);
                AddPortChanges(changes, key, current!.Runtime.Ports, target!.Runtime.Ports);
                AddEnvironmentChanges(changes, key, current.Runtime.Environment, target.Runtime.Environment);
            }

            AddContainerNameChanges(changes, appId, key, current, target);
        }
    }

    private static void AddImageChange(
        List<string> changes,
        string serviceKey,
        RuntimeSelectedService current,
        RuntimeSelectedService target)
    {
        var currentImage = current.Image?.Reference;
        var targetImage = target.Image?.Reference;
        if (!string.Equals(currentImage, targetImage, StringComparison.Ordinal))
        {
            changes.Add($"image:{serviceKey}:{currentImage ?? "none"}->{targetImage ?? "none"}");
        }
    }

    private static void AddCommandChanges(
        List<string> changes,
        string serviceKey,
        RuntimeSelectedService current,
        RuntimeSelectedService target)
    {
        if (!string.Equals(current.Runtime.Command, target.Runtime.Command, StringComparison.Ordinal))
        {
            changes.Add($"command:{serviceKey}:changed");
        }

        if (!string.Equals(current.Runtime.WorkingDirectory, target.Runtime.WorkingDirectory, StringComparison.Ordinal))
        {
            changes.Add($"workingDirectory:{serviceKey}:{current.Runtime.WorkingDirectory ?? "."}->{target.Runtime.WorkingDirectory ?? "."}");
        }
    }

    private static void AddNetworkChange(
        List<string> changes,
        string serviceKey,
        RuntimeSelectedService current,
        RuntimeSelectedService target)
    {
        // Toggling the docker network mode (bridge<->host) changes how the container is launched
        // (`--network host` vs the user/bridge network and `-p` publishing), so it must trigger a
        // restart. null/empty normalizes to "bridge" so declaring the default explicitly is inert.
        var currentNetwork = NormalizeNetwork(current.Runtime.Network);
        var targetNetwork = NormalizeNetwork(target.Runtime.Network);
        if (!string.Equals(currentNetwork, targetNetwork, StringComparison.Ordinal))
        {
            changes.Add($"network:{serviceKey}:{currentNetwork}->{targetNetwork}");
        }
    }

    private static string NormalizeNetwork(string? network)
        => string.IsNullOrWhiteSpace(network) ? "bridge" : network.ToLowerInvariant();

    private static void AddCapabilityChanges(
        List<string> changes,
        string serviceKey,
        RuntimeSelectedService current,
        RuntimeSelectedService target)
    {
        // Capabilities (`--cap-add`) and devices (`--device`) are container launch args, so adding or
        // removing any must trigger a restart. Compare order-insensitively on the normalized set.
        var currentCaps = NormalizeList(current.Runtime.Capabilities, LinuxCapabilities.Normalize);
        var targetCaps = NormalizeList(target.Runtime.Capabilities, LinuxCapabilities.Normalize);
        if (!string.Equals(currentCaps, targetCaps, StringComparison.Ordinal))
        {
            changes.Add($"capabilities:{serviceKey}:{currentCaps}->{targetCaps}");
        }

        var currentDevices = NormalizeList(current.Runtime.Devices, device => device.Trim());
        var targetDevices = NormalizeList(target.Runtime.Devices, device => device.Trim());
        if (!string.Equals(currentDevices, targetDevices, StringComparison.Ordinal))
        {
            changes.Add($"devices:{serviceKey}:{currentDevices}->{targetDevices}");
        }
    }

    private static string NormalizeList(IReadOnlyList<string> values, Func<string, string> normalize)
    {
        var joined = string.Join(",", values.Select(normalize).Order(StringComparer.Ordinal));
        return joined.Length == 0 ? "none" : joined;
    }

    private static void AddPortChanges(
        List<string> changes,
        string serviceKey,
        IReadOnlyList<RuntimePortManifest> currentPorts,
        IReadOnlyList<RuntimePortManifest> targetPorts)
    {
        var current = BuildPortMap(currentPorts);
        var target = BuildPortMap(targetPorts);
        foreach (var key in current.Keys.Concat(target.Keys).Distinct(StringComparer.Ordinal).Order(StringComparer.Ordinal))
        {
            var hasCurrent = current.TryGetValue(key, out var currentSignature);
            var hasTarget = target.TryGetValue(key, out var targetSignature);
            if (!hasCurrent)
            {
                changes.Add($"port:{serviceKey}.{key}:added:{targetSignature}");
            }
            else if (!hasTarget)
            {
                changes.Add($"port:{serviceKey}.{key}:removed:{currentSignature}");
            }
            else if (!string.Equals(currentSignature, targetSignature, StringComparison.Ordinal))
            {
                changes.Add($"port:{serviceKey}.{key}:{currentSignature}->{targetSignature}");
            }
        }
    }

    private static void AddEnvironmentChanges(
        List<string> changes,
        string serviceKey,
        IReadOnlyDictionary<string, string> current,
        IReadOnlyDictionary<string, string> target)
    {
        foreach (var key in current.Keys.Concat(target.Keys).Distinct(StringComparer.Ordinal).Order(StringComparer.Ordinal))
        {
            var hasCurrent = current.ContainsKey(key);
            var hasTarget = target.ContainsKey(key);
            if (!hasCurrent)
            {
                changes.Add($"environment:{serviceKey}.{key}:added");
            }
            else if (!hasTarget)
            {
                changes.Add($"environment:{serviceKey}.{key}:removed");
            }
            else if (!string.Equals(current[key], target[key], StringComparison.Ordinal))
            {
                changes.Add($"environment:{serviceKey}.{key}:changed");
            }
        }
    }

    private static void AddContainerNameChanges(
        List<string> changes,
        string appId,
        string serviceKey,
        RuntimeSelectedService? current,
        RuntimeSelectedService? target)
    {
        var currentIsDocker = string.Equals(current?.Runtime.Type, "docker", StringComparison.Ordinal);
        var targetIsDocker = string.Equals(target?.Runtime.Type, "docker", StringComparison.Ordinal);
        if (!currentIsDocker && !targetIsDocker)
        {
            return;
        }

        var containerName = DockerRuntimeAdapter.BuildContainerName(appId, serviceKey);
        if (currentIsDocker && targetIsDocker)
        {
            changes.Add($"container:{serviceKey}:preserved:{containerName}");
        }
        else if (targetIsDocker)
        {
            changes.Add($"container:{serviceKey}:added:{containerName}");
        }
        else
        {
            changes.Add($"container:{serviceKey}:removed:{containerName}");
        }
    }

    private static void AddSettingChanges(
        List<string> changes,
        IReadOnlyDictionary<string, AppSettingValue> currentSettings,
        IReadOnlyList<RuntimeAppSettingManifest> targetSettings)
    {
        var targetByKey = targetSettings.ToDictionary(setting => setting.Key, StringComparer.Ordinal);
        foreach (var key in currentSettings.Keys.Concat(targetByKey.Keys).Distinct(StringComparer.Ordinal).Order(StringComparer.Ordinal))
        {
            var hasCurrent = currentSettings.TryGetValue(key, out var current);
            var hasTarget = targetByKey.TryGetValue(key, out var target);
            if (!hasCurrent)
            {
                changes.Add($"setting:{key}:added");
            }
            else if (!hasTarget)
            {
                changes.Add($"setting:{key}:removed");
            }
            else
            {
                if (!string.Equals(current!.Type, target!.Type, StringComparison.Ordinal))
                {
                    changes.Add($"setting:{key}:type:{current.Type}->{target.Type}");
                }

                if (current.Secret != target.Secret)
                {
                    changes.Add($"setting:{key}:secret:{current.Secret}->{target.Secret}");
                }
            }
        }
    }

    private static void AddDependencyChanges(
        List<string> changes,
        IReadOnlyList<AppDependencyContract> currentDependencies,
        IReadOnlyList<RuntimeAppDependencyManifest> targetDependencies)
    {
        var current = currentDependencies.ToDictionary(dependency => dependency.Key, StringComparer.Ordinal);
        var target = targetDependencies
            .Select(dependency => new AppDependencyContract(dependency.Id, dependency.Id, "default"))
            .ToDictionary(dependency => dependency.Key, StringComparer.Ordinal);
        foreach (var key in current.Keys.Concat(target.Keys).Distinct(StringComparer.Ordinal).Order(StringComparer.Ordinal))
        {
            var hasCurrent = current.TryGetValue(key, out var currentDependency);
            var hasTarget = target.TryGetValue(key, out var targetDependency);
            if (!hasCurrent)
            {
                changes.Add($"dependency:{key}:added");
            }
            else if (!hasTarget)
            {
                changes.Add($"dependency:{key}:removed");
            }
            else if (!string.Equals(DependencySignature(currentDependency!), DependencySignature(targetDependency!), StringComparison.Ordinal))
            {
                changes.Add($"dependency:{key}:{DependencySignature(currentDependency!)}->{DependencySignature(targetDependency!)}");
            }
        }
    }

    private static void AddEndpointChanges(
        List<string> changes,
        IReadOnlyList<AppEndpointContract> currentEndpoints,
        IReadOnlyList<AppEndpointContract> targetEndpoints)
    {
        var current = currentEndpoints.ToDictionary(endpoint => endpoint.Key, StringComparer.Ordinal);
        var target = targetEndpoints.ToDictionary(endpoint => endpoint.Key, StringComparer.Ordinal);
        foreach (var key in current.Keys.Concat(target.Keys).Distinct(StringComparer.Ordinal).Order(StringComparer.Ordinal))
        {
            var hasCurrent = current.TryGetValue(key, out var currentEndpoint);
            var hasTarget = target.TryGetValue(key, out var targetEndpoint);
            if (!hasCurrent)
            {
                changes.Add($"endpoint:{key}:added:{EndpointSignature(targetEndpoint!)}");
            }
            else if (!hasTarget)
            {
                changes.Add($"endpoint:{key}:removed:{EndpointSignature(currentEndpoint!)}");
            }
            else if (!string.Equals(EndpointSignature(currentEndpoint!), EndpointSignature(targetEndpoint!), StringComparison.Ordinal))
            {
                changes.Add($"endpoint:{key}:{EndpointSignature(currentEndpoint!)}->{EndpointSignature(targetEndpoint!)}");
            }
        }
    }

    private void AddDataTargetChanges(List<string> changes, AppRecord app, RuntimeAppManifestSelection targetSelection)
    {
        var currentData = app.StorageMappings.FirstOrDefault(mapping => string.Equals(mapping.Key, "data", StringComparison.Ordinal));
        var targetPath = targetSelection.DataTarget is null
            ? null
            : targetSelection.DataTarget.ContainerPath ?? GetAppDataPath(app.Id);
        if (currentData is null && targetPath is null)
        {
            return;
        }

        if (currentData is null)
        {
            changes.Add($"data:added:{targetPath}");
        }
        else if (targetPath is null)
        {
            changes.Add($"data:removed:{currentData.TargetPath}");
        }
        else if (!string.Equals(currentData.TargetPath, targetPath, StringComparison.Ordinal))
        {
            changes.Add($"data:target:{currentData.TargetPath}->{targetPath}");
        }
        else
        {
            changes.Add("data:compatible");
        }
    }

    private void AddUpdateDataTargetChanges(List<string> changes, AppRecord app, RuntimeAppManifestSelection targetSelection)
    {
        var currentData = app.StorageMappings.FirstOrDefault(mapping => string.Equals(mapping.Key, "data", StringComparison.Ordinal));
        var targetPath = targetSelection.DataTarget is null
            ? null
            : targetSelection.DataTarget.ContainerPath ?? GetAppDataPath(app.Id);
        if (currentData is null && targetPath is null)
        {
            return;
        }

        if (currentData is null)
        {
            changes.Add($"data:added:{targetPath}");
        }
        else if (targetPath is null)
        {
            changes.Add($"data:removed:{currentData.TargetPath}");
        }
        else if (!string.Equals(currentData.TargetPath, targetPath, StringComparison.Ordinal))
        {
            changes.Add($"data:target:{currentData.TargetPath}->{targetPath}");
        }
    }

    private static void AddCapabilityChanges(List<string> changes, IReadOnlyList<string> currentCapabilities, IReadOnlyList<string> targetCapabilities)
    {
        var current = currentCapabilities.ToHashSet(StringComparer.Ordinal);
        var target = targetCapabilities.ToHashSet(StringComparer.Ordinal);
        foreach (var key in current.Concat(target).Distinct(StringComparer.Ordinal).Order(StringComparer.Ordinal))
        {
            var hasCurrent = current.Contains(key);
            var hasTarget = target.Contains(key);
            if (!hasCurrent)
            {
                changes.Add($"capability:{key}:added");
            }
            else if (!hasTarget)
            {
                changes.Add($"capability:{key}:removed");
            }
        }
    }

    private static IReadOnlyList<string> ResolveCapabilities(RuntimeAppManifest manifest)
        => manifest.Capabilities.Count == 0 ? DefaultCapabilities : manifest.Capabilities;

    private static IReadOnlyDictionary<string, string> BuildPortMap(IReadOnlyList<RuntimePortManifest> ports)
    {
        var map = new Dictionary<string, string>(StringComparer.Ordinal);
        for (var index = 0; index < ports.Count; index++)
        {
            var port = ports[index];
            var key = port.Key ??
                port.ContainerPort?.ToString(System.Globalization.CultureInfo.InvariantCulture) ??
                $"index-{index}";
            map[key] = PortSignature(port);
        }

        return map;
    }

    private static string PortSignature(RuntimePortManifest port)
    {
        var protocol = string.IsNullOrWhiteSpace(port.Protocol) ? "http" : port.Protocol;
        var containerPort = port.ContainerPort?.ToString(System.Globalization.CultureInfo.InvariantCulture) ?? "none";
        var hostPort = port.LocalPort ?? port.HostPort;
        var host = hostPort?.ToString(System.Globalization.CultureInfo.InvariantCulture) ?? "auto";
        var isPublic = port.Public ?? false;
        var expose = string.IsNullOrWhiteSpace(port.Expose) ? "loopback" : port.Expose.ToLowerInvariant();
        var transport = port.Transport is { Count: > 0 } transports
            ? string.Join("+", transports.Select(value => value.ToLowerInvariant()).OrderBy(value => value, StringComparer.Ordinal))
            : "tcp";
        return $"{protocol}:{host}->{containerPort}:public={isPublic}:expose={expose}:transport={transport}";
    }

    private static string EndpointSignature(AppEndpointContract endpoint)
    {
        var service = string.IsNullOrWhiteSpace(endpoint.Service) ? "none" : endpoint.Service;
        var port = string.IsNullOrWhiteSpace(endpoint.Port) ? "none" : endpoint.Port;
        return $"{endpoint.Protocol}:public={endpoint.Public}:service={service}:port={port}";
    }

    private static string DependencySignature(AppDependencyContract dependency)
        => $"{dependency.AppId}:{dependency.Endpoint}";

    private static IReadOnlyList<AppEndpointContract> BuildEndpointContracts(RuntimeAppManifestSelection selection)
    {
        if (selection.Manifest.Endpoints.Count > 0)
        {
            return selection.Manifest.Endpoints.Select(endpoint => new AppEndpointContract(
                Key: endpoint.Key,
                Protocol: endpoint.Protocol ?? "http",
                Url: null,
                Public: endpoint.Public,
                Service: endpoint.Service,
                Port: endpoint.Port)).ToArray();
        }

        return selection.Services.SelectMany(service => service.Runtime.Ports.Select(port => new AppEndpointContract(
            Key: $"{service.Key}.{port.Key ?? port.ContainerPort?.ToString(System.Globalization.CultureInfo.InvariantCulture) ?? "port"}",
            Protocol: string.IsNullOrWhiteSpace(port.Protocol) ? "http" : port.Protocol,
            Url: null,
            Public: port.Public ?? false,
            Service: service.Key,
            Port: port.Key ?? port.ContainerPort?.ToString(System.Globalization.CultureInfo.InvariantCulture) ?? "port"))).ToArray();
    }

    // When an ingress provider manages public origins (e.g. cloudflared), persist the derived
    // HOSTY_PUBLIC_ORIGIN_<endpoint> values before start so the existing settings->env pipeline
    // injects them. The host is deterministic, so this runs before the runtime port is known.
    private async Task<AppRecord> EnsureIngressPublicOriginsAsync(
        AppRecord app,
        RuntimeAppManifestSelection selection,
        CancellationToken cancellationToken)
    {
        if (!ingress.ManagesPublicOrigins)
        {
            return app;
        }

        var publicEndpointKeys = BuildEndpointContracts(selection)
            .Where(endpoint => endpoint.Public && !string.IsNullOrWhiteSpace(endpoint.Key))
            .Select(endpoint => endpoint.Key)
            .Distinct(StringComparer.Ordinal)
            .ToArray();
        if (publicEndpointKeys.Length == 0)
        {
            return app;
        }

        var subdomainOverride = app.Settings.TryGetValue(CloudflaredIngressPlanner.SubdomainSettingKey, out var subdomain)
            ? subdomain.Value
            : null;
        var desired = ingress.ResolvePublicOrigins(app.Id, subdomainOverride, publicEndpointKeys);
        var changed = desired.Any(entry =>
            !app.Settings.TryGetValue(entry.Key, out var current) ||
            !string.Equals(current.Value, entry.Value, StringComparison.Ordinal));
        if (!changed)
        {
            return app;
        }

        var updated = await apps.UpdateAppAsync(app.Id, current =>
        {
            var settings = new Dictionary<string, AppSettingValue>(current.Settings, StringComparer.Ordinal);
            foreach (var entry in desired)
            {
                settings[entry.Key] = new AppSettingValue(entry.Key, "url", entry.Value, Secret: false);
            }

            return current with { Settings = settings };
        }, cancellationToken);
        return updated.App;
    }

    // Re-render the ingress provider's config from the current set of apps. Best-effort: an ingress
    // failure must never fail the lifecycle operation that triggered it.
    public async Task ReconcileIngressAsync(CancellationToken cancellationToken = default)
    {
        try
        {
            var records = await apps.ListAppRecordsAsync(cancellationToken);
            await ingress.ReconcileAsync(records, cancellationToken);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or JsonException)
        {
            // Best-effort: ingress reconciliation runs on the startup BackgroundService path too,
            // so it must never throw (an unhandled exception there would crash the host). Log for
            // visibility rather than swallowing silently.
            logger.LogWarning(ex, "Hosty ingress reconciliation did not complete.");
        }
    }

    private static IReadOnlyList<RuntimeAppSettingManifest> BuildSettingDefinitions(RuntimeAppManifestSelection selection)
    {
        var settings = selection.Manifest.Settings
            .Where(setting => !PublicOriginSettings.IsSettingKey(setting.Key))
            .ToDictionary(setting => setting.Key, StringComparer.Ordinal);
        foreach (var endpoint in BuildEndpointContracts(selection).Where(endpoint => endpoint.Public))
        {
            var key = PublicOriginSettings.BuildSettingKey(endpoint.Key);
            settings.TryAdd(key, new RuntimeAppSettingManifest
            {
                Key = key,
                Type = "url",
                Default = null,
                Secret = false,
            });
        }

        return settings.Values.ToArray();
    }

    private static IReadOnlyDictionary<string, AppSettingValue> MergeSettings(
        IReadOnlyDictionary<string, AppSettingValue> current,
        IReadOnlyDictionary<string, string?> incoming)
    {
        var settings = current.ToDictionary(pair => pair.Key, pair => pair.Value, StringComparer.Ordinal);
        foreach (var (key, value) in incoming)
        {
            if (settings.TryGetValue(key, out var existing))
            {
                settings[key] = existing with { Value = value };
            }
            else
            {
                settings[key] = new AppSettingValue(key, PublicOriginSettings.IsSettingKey(key) ? "url" : "string", value, Secret: false);
            }
        }

        return settings;
    }

    private static void ValidatePublicOriginSettings(IReadOnlyDictionary<string, string?>? settings)
    {
        if (settings is null)
        {
            return;
        }

        foreach (var (key, value) in settings)
        {
            if (!PublicOriginSettings.IsSettingKey(key) ||
                string.IsNullOrWhiteSpace(value))
            {
                continue;
            }

            if (!PublicOriginSettings.TryNormalizeOrigin(value, out _))
            {
                throw new AppLifecycleException(
                    "public_origin_invalid",
                    $"Setting '{key}' must be an absolute http(s) origin without a path, query, or fragment.");
            }
        }
    }

    private static string? ResolveDefaultRuntime(RuntimeAppManifest manifest)
        => string.IsNullOrWhiteSpace(manifest.DefaultRuntime)
            ? manifest.RuntimeProfiles.FirstOrDefault(profile => profile.Default)?.Key ?? manifest.RuntimeProfiles.FirstOrDefault()?.Key
            : manifest.DefaultRuntime;

    private static IReadOnlyList<AppRuntimeProfileSummary> BuildRuntimeProfileSummaries(RuntimeAppManifest manifest)
    {
        var defaultRuntime = ResolveDefaultRuntime(manifest);
        return manifest.RuntimeProfiles
            .Select(profile => new AppRuntimeProfileSummary(
                profile.Key,
                profile.Type,
                string.Equals(profile.Key, defaultRuntime, StringComparison.Ordinal)))
            .ToArray();
    }

    private async Task<AppChannelIndex> LoadChannelIndexAsync(
        AppRecord app,
        string? channelsPath,
        CancellationToken cancellationToken)
    {
        var path = ResolveChannelIndexPath(app.ManifestPath, channelsPath);
        if (string.IsNullOrWhiteSpace(path) || !File.Exists(path))
        {
            throw new AppLifecycleException("channels_index_not_found", "Runtime app channel index was not found.");
        }

        await using var stream = File.OpenRead(path);
        return await System.Text.Json.JsonSerializer.DeserializeAsync(stream, CoreJsonSerializerContext.Default.AppChannelIndex, cancellationToken) ??
            throw new AppLifecycleException("channels_index_invalid", "Runtime app channel index is invalid.");
    }

    private static string? ResolveChannelIndexPath(string? manifestPath, string? channelsPath)
    {
        if (!string.IsNullOrWhiteSpace(channelsPath))
        {
            return Path.GetFullPath(channelsPath);
        }

        if (string.IsNullOrWhiteSpace(manifestPath) || !File.Exists(manifestPath))
        {
            return null;
        }

        var manifest = System.Text.Json.JsonSerializer.Deserialize(File.ReadAllText(manifestPath), CoreJsonSerializerContext.Default.RuntimeAppManifest);
        if (string.IsNullOrWhiteSpace(manifest?.ChannelsUrl))
        {
            return null;
        }

        return Path.IsPathRooted(manifest.ChannelsUrl)
            ? manifest.ChannelsUrl
            : Path.GetFullPath(Path.Combine(Path.GetDirectoryName(manifestPath) ?? ".", manifest.ChannelsUrl));
    }

    private static string ResolveChannelManifestPath(string? installedManifestPath, AppChannelEntry channel)
    {
        var manifestPath = channel.ManifestPath ?? channel.ManifestUrl;
        if (string.IsNullOrWhiteSpace(manifestPath))
        {
            throw new AppLifecycleException("channel_manifest_missing", $"Channel '{channel.Id}' does not declare a manifest path.");
        }

        if (Uri.TryCreate(manifestPath, UriKind.Absolute, out var manifestUri) &&
            (string.Equals(manifestUri.Scheme, Uri.UriSchemeHttp, StringComparison.OrdinalIgnoreCase) ||
                string.Equals(manifestUri.Scheme, Uri.UriSchemeHttps, StringComparison.OrdinalIgnoreCase)))
        {
            return manifestUri.AbsoluteUri;
        }

        if (Path.IsPathRooted(manifestPath))
        {
            return manifestPath;
        }

        var baseDirectory = string.IsNullOrWhiteSpace(installedManifestPath)
            ? Directory.GetCurrentDirectory()
            : Path.GetDirectoryName(installedManifestPath) ?? Directory.GetCurrentDirectory();
        return Path.GetFullPath(Path.Combine(baseDirectory, manifestPath));
    }

    private async Task<AppRecord> ReconcileRuntimeStateForSummaryAsync(AppRecord app, CancellationToken cancellationToken)
    {
        if (!string.Equals(app.Kind, "runtime", StringComparison.Ordinal) ||
            !string.Equals(app.RuntimeState, "running", StringComparison.Ordinal) ||
            string.IsNullOrWhiteSpace(app.ManifestPath))
        {
            return app;
        }

        RuntimeAppManifestSelection selection;
        try
        {
            selection = await LoadSelectionForAppAsync(app, cancellationToken);
        }
        catch (Exception ex) when (ex is AppManifestException or IOException or UnauthorizedAccessException or JsonException)
        {
            return app;
        }

        if (!string.Equals(selection.RuntimeProfile.Type, "localCommand", StringComparison.Ordinal))
        {
            return app;
        }

        AppRuntimeHealthResult health;
        try
        {
            health = await ResolveAdapter(selection.RuntimeProfile.Type).GetHealthAsync(
                await CreateRuntimeContextAsync(app, selection, cancellationToken),
                cancellationToken);
        }
        catch (Exception ex) when (ex is AppLifecycleException or IOException or UnauthorizedAccessException)
        {
            return app;
        }

        var observedRuntimeState = ResolveRuntimeStateFromHealth(health);
        if (observedRuntimeState is null ||
            string.Equals(observedRuntimeState, app.RuntimeState, StringComparison.Ordinal))
        {
            return app;
        }

        var updated = await apps.UpdateAppAsync(app.Id, current => current with
        {
            RuntimeState = observedRuntimeState,
        }, cancellationToken);
        return updated.App;
    }

    private static string? ResolveRuntimeStateFromHealth(AppRuntimeHealthResult health)
        => health.Status switch
        {
            "healthy" => "running",
            "stopped" => "stopped",
            "unhealthy" => "unknown",
            _ => null,
        };

    private static void TryDelete(string path)
    {
        try
        {
            if (File.Exists(path))
            {
                File.Delete(path);
            }
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
        }
    }

    private static void TryDeleteDirectory(string path)
    {
        try
        {
            if (Directory.Exists(path))
            {
                Directory.Delete(path, recursive: true);
            }
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
        }
    }

    private static void TryDeleteDirectoryIfEmpty(string path)
    {
        try
        {
            if (Directory.Exists(path) && !Directory.EnumerateFileSystemEntries(path).Any())
            {
                Directory.Delete(path);
            }
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
        }
    }

    private static readonly string[] DefaultCapabilities = ["open", "update", "restart", "stop", "remove", "backup", "restore", "logs"];
}

internal sealed record AppUpdatePlanDigestSeed(
    string AppId,
    string CurrentVersion,
    string? TargetVersion,
    string? CurrentRuntime,
    string TargetRuntime,
    string? TargetChannel,
    string? CurrentManifestDigest,
    string TargetManifestDigest,
    bool WillCreateBackup,
    IReadOnlyList<string> Changes);

internal sealed record AppRuntimeSwitchDigestSeed(
    string AppId,
    string? CurrentRuntime,
    string TargetRuntime,
    string Version,
    string ManifestDigest,
    bool AutomaticBackup,
    IReadOnlyList<string> Changes);

internal sealed record AppInstallPlanRequest(
    string ManifestPath,
    string? SelectedRuntime = null,
    string? SelectedChannel = null,
    bool System = false,
    bool? Autostart = null);

internal sealed record AppInstallRequest(
    string ManifestPath,
    string? SelectedRuntime = null,
    string? SelectedChannel = null,
    bool System = false,
    IReadOnlyDictionary<string, string?>? Settings = null,
    bool? Autostart = null);

internal sealed record AppConfigureRequest(
    IReadOnlyDictionary<string, string?>? Settings = null,
    bool? Autostart = null);

internal sealed record AppAutostartRequest(bool Autostart);

internal sealed record AppMountsRequest(IReadOnlyList<AppMountBindingInput>? Mounts = null);

internal sealed record AppMountBindingInput(string Key, string Label, string HostPath);

internal sealed record AppUpdatePlanRequest(
    string? ManifestPath = null,
    string? SelectedRuntime = null,
    string? TargetChannel = null);

internal sealed record AppUpdateApplyRequest(
    string PlanDigest,
    string? ManifestPath = null,
    string? SelectedRuntime = null,
    string? TargetChannel = null);

internal sealed record AppRemoveRequest(
    bool DeleteRuntimeState = true,
    bool DeleteData = false,
    bool DeleteBackups = false,
    bool DeleteSource = false,
    bool IgnoreRuntimeErrors = false);

internal sealed record AppManualBackupRequest(string? Reason = null);

internal sealed record AppRestoreBackupRequest(bool CreatePreRestoreBackup = false);

internal sealed record AppRuntimeSwitchPlanRequest(string TargetRuntime);

internal sealed record AppRuntimeSwitchApplyRequest(string TargetRuntime, string PlanDigest);

internal sealed record AppChannelsRequest(string? ChannelsPath = null);

internal sealed record AppChannelSwitchPlanRequest(string Channel, string? ChannelsPath = null, string? SelectedRuntime = null);

internal sealed record AppChannelSwitchApplyRequest(string Channel, string PlanDigest, string? ChannelsPath = null, string? SelectedRuntime = null);

internal sealed record AppBackgroundLifecycleResult(
    string AppId,
    string Operation,
    bool Succeeded,
    string? ErrorCode,
    string? Message);

internal sealed record AppLifecycleResponse(AppSummary? App, AppBackupRecord? Backup, string Status);

internal sealed record AppInstallPlan(
    string AppId,
    string DisplayName,
    string? Description,
    string Action,
    string? CurrentVersion,
    string TargetVersion,
    string? CurrentRuntime,
    string TargetRuntime,
    string TargetRuntimeType,
    string ManifestPath,
    string? CurrentManifestDigest,
    string TargetManifestDigest,
    string? SelectedChannel,
    bool DefaultAutostart,
    IReadOnlyList<AppRuntimeProfileSummary> RuntimeProfiles,
    IReadOnlyList<AppInstallSetting> Settings);

internal sealed record AppInstallSetting(string Key, string Type, string? DefaultValue, bool Secret, bool Required = false);

internal sealed record AppUpdatePlan(
    string AppId,
    string CurrentVersion,
    string TargetVersion,
    string? CurrentRuntime,
    string TargetRuntime,
    string? TargetChannel,
    string ManifestPath,
    string ManifestDigest,
    string PlanDigest,
    bool WillCreatePreUpdateBackup,
    IReadOnlyList<string> Changes);

internal sealed record AppRuntimeSwitchPlan(
    string AppId,
    string? CurrentRuntime,
    string TargetRuntime,
    string TargetRuntimeType,
    string PlanDigest,
    bool AutomaticBackup,
    IReadOnlyList<string> Changes);

internal sealed record AppChannelIndex(IReadOnlyList<AppChannelEntry> Channels);

internal sealed record AppChannelEntry(
    string Id,
    string Label,
    string? ManifestPath,
    string? ManifestUrl,
    string? SourceRef);

internal sealed record AppChannelsResponse(string AppId, IReadOnlyList<AppChannelEntry> Channels);

internal sealed record AppChannelSwitchPlan(
    string AppId,
    AppChannelEntry Channel,
    AppUpdatePlan UpdatePlan,
    string PlanDigest);

internal sealed record AppBackupsResponse(IReadOnlyList<AppBackupRecord> Backups);

internal sealed record AppBackupResponse(AppBackupRecord? Backup);

internal sealed record AppBackupDeleteResponse(bool Deleted);

internal sealed record AppLogsResponse(string AppId, string Text, IReadOnlyList<AppLogsServiceSegment> Services);

internal sealed record AppLogsServiceSegment(string Service, string Text);

internal sealed record AppRuntimeHealthResponse(
    string AppId,
    string Runtime,
    string RuntimeType,
    string Status,
    IReadOnlyList<AppRuntimeServiceHealth> Services);
