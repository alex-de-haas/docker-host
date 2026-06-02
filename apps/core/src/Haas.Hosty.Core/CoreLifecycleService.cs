using System.Security.Cryptography;
using System.Text.Json;

namespace Haas.Hosty.Core;

internal sealed class CoreLifecycleService(
    CoreDataPaths paths,
    AppRegistryStore apps,
    AppManifestService manifests,
    AppBackupService backups,
    IEnumerable<IAppRuntimeAdapter> adapters)
{
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
            selectedChannel: request.SelectedChannel,
            system: request.System,
            existing: null) with
        {
            OperationStatus = "installed",
            RuntimeState = "stopped",
            LastOperation = "install",
        };
        var document = await apps.UpsertAppAsync(record, cancellationToken);
        return new AppLifecycleResponse(AppSummary.From(document.App), null, "installed");
    }

    public async Task<AppLifecycleResponse> ConfigureAsync(string appId, AppConfigureRequest request, CancellationToken cancellationToken = default)
    {
        var document = await apps.UpdateAppAsync(appId, app =>
        {
            var settings = app.Settings.ToDictionary(pair => pair.Key, pair => pair.Value, StringComparer.Ordinal);
            foreach (var (key, value) in request.Settings)
            {
                if (settings.TryGetValue(key, out var existing))
                {
                    settings[key] = existing with { Value = value };
                }
                else
                {
                    settings[key] = new AppSettingValue(key, "string", value, Secret: false);
                }
            }

            return app with
            {
                Settings = settings,
                OperationStatus = "configured",
                LastOperation = "configure",
                LastError = null,
            };
        }, cancellationToken);

        return new AppLifecycleResponse(AppSummary.From(document.App), null, "configured");
    }

    public async Task<AppLifecycleResponse> StartAsync(string appId, CancellationToken cancellationToken = default)
    {
        var app = await RequireAppAsync(appId, cancellationToken);
        var selection = await LoadSelectionForAppAsync(app, cancellationToken);
        var adapter = ResolveAdapter(selection.RuntimeProfile.Type);
        var result = await adapter.StartAsync(await CreateRuntimeContextAsync(app, selection, cancellationToken), cancellationToken);
        var updated = await apps.UpdateAppAsync(appId, current => current with
        {
            RuntimeState = result.RuntimeState,
            OperationStatus = "started",
            LastOperation = "start",
            LastError = null,
            Endpoints = MergeEndpointUrls(current.Endpoints, result.Endpoints),
        }, cancellationToken);

        return new AppLifecycleResponse(AppSummary.From(updated.App), null, "started");
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

        return new AppLifecycleResponse(AppSummary.From(updated.App), null, "stopped");
    }

    public async Task<AppLifecycleResponse> RestartAsync(string appId, CancellationToken cancellationToken = default)
    {
        var app = await RequireAppAsync(appId, cancellationToken);
        var selection = await LoadSelectionForAppAsync(app, cancellationToken);
        var adapter = ResolveAdapter(selection.RuntimeProfile.Type);
        var context = await CreateRuntimeContextAsync(app, selection, cancellationToken);
        _ = await adapter.StopAsync(context, cancellationToken);
        var start = await adapter.StartAsync(context, cancellationToken);
        var updated = await apps.UpdateAppAsync(appId, current => current with
        {
            RuntimeState = start.RuntimeState,
            OperationStatus = "restarted",
            LastOperation = "restart",
            LastError = null,
            Endpoints = MergeEndpointUrls(current.Endpoints, start.Endpoints),
        }, cancellationToken);

        return new AppLifecycleResponse(AppSummary.From(updated.App), null, "restarted");
    }

    public async Task<AppUpdatePlan> CreateUpdatePlanAsync(string appId, AppUpdatePlanRequest request, CancellationToken cancellationToken = default)
    {
        var app = await RequireAppAsync(appId, cancellationToken);
        var manifestPath = request.ManifestPath ?? app.ManifestPath;
        if (string.IsNullOrWhiteSpace(manifestPath))
        {
            throw new AppLifecycleException("manifest_path_required", "Installed app has no manifest path and update request did not provide one.");
        }

        var selection = await manifests.LoadAsync(manifestPath, request.SelectedRuntime ?? app.SelectedRuntime, cancellationToken);
        if (!string.Equals(selection.Manifest.Id, app.Id, StringComparison.Ordinal))
        {
            throw new AppLifecycleException("manifest_app_mismatch", $"Update manifest app id '{selection.Manifest.Id}' does not match installed app '{app.Id}'.");
        }

        var willCreateBackup = Directory.Exists(GetAppDataPath(appId));
        var seed = new
        {
            appId,
            currentVersion = app.Version,
            targetVersion = selection.Manifest.Version,
            currentRuntime = app.SelectedRuntime,
            targetRuntime = selection.RuntimeProfile.Key,
            targetChannel = request.TargetChannel ?? app.SelectedChannel,
            selection.ManifestDigest,
            willCreateBackup,
        };
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
            Changes: BuildUpdateChanges(app, selection));
    }

    public async Task<AppLifecycleResponse> ApplyUpdateAsync(string appId, AppUpdateApplyRequest request, CancellationToken cancellationToken = default)
    {
        var plan = await CreateUpdatePlanAsync(appId, new AppUpdatePlanRequest(request.ManifestPath, request.SelectedRuntime, request.TargetChannel), cancellationToken);
        if (!string.Equals(plan.PlanDigest, request.PlanDigest, StringComparison.Ordinal))
        {
            throw new AppLifecycleException("update_plan_digest_mismatch", "Update plan digest does not match the current update plan.");
        }

        var app = await RequireAppAsync(appId, cancellationToken);
        var backup = plan.WillCreatePreUpdateBackup
            ? await backups.CreateBackupAsync(appId, "pre-update", cancellationToken)
            : null;

        var selection = await manifests.LoadAsync(plan.ManifestPath, plan.TargetRuntime, cancellationToken);
        var currentSelection = await LoadSelectionForAppAsync(app, cancellationToken);
        var adapter = ResolveAdapter(currentSelection.RuntimeProfile.Type);
        if (string.Equals(app.RuntimeState, "running", StringComparison.Ordinal))
        {
            _ = await adapter.StopAsync(await CreateRuntimeContextAsync(app, currentSelection, cancellationToken), cancellationToken);
        }

        await manifests.SaveManifestCopyAsync(selection, GetAppRoot(appId), cancellationToken);
        var manifestCopyPath = Path.Combine(GetAppRoot(appId), "manifest.json");
        var nextRuntimeState = "stopped";
        var next = BuildAppRecord(
            selection,
            manifestCopyPath,
            selectedChannel: plan.TargetChannel,
            system: app.System,
            existing: app) with
        {
            OperationStatus = "updated",
            RuntimeState = nextRuntimeState,
            LastOperation = "update",
            LastError = null,
        };
        var document = await apps.UpsertAppAsync(next, cancellationToken);
        if (string.Equals(app.RuntimeState, "running", StringComparison.Ordinal))
        {
            return await StartAsync(appId, cancellationToken);
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

        var selection = await manifests.LoadAsync(app.ManifestPath, request.TargetRuntime, cancellationToken);
        var seed = new
        {
            appId,
            currentRuntime = app.SelectedRuntime,
            targetRuntime = selection.RuntimeProfile.Key,
            app.Version,
            selection.ManifestDigest,
            automaticBackup = false,
        };
        return new AppRuntimeSwitchPlan(
            AppId: appId,
            CurrentRuntime: app.SelectedRuntime,
            TargetRuntime: selection.RuntimeProfile.Key,
            TargetRuntimeType: selection.RuntimeProfile.Type,
            PlanDigest: HashPlanSeed(seed),
            AutomaticBackup: false,
            Changes: BuildRuntimeSwitchChanges(app, selection));
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
        if (string.Equals(app.RuntimeState, "running", StringComparison.Ordinal))
        {
            await ResolveAdapter(currentSelection.RuntimeProfile.Type).StopAsync(await CreateRuntimeContextAsync(app, currentSelection, cancellationToken), cancellationToken);
        }

        var targetSelection = await manifests.LoadAsync(app.ManifestPath!, request.TargetRuntime, cancellationToken);
        var next = BuildAppRecord(
            targetSelection,
            app.ManifestPath!,
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

        if (string.Equals(app.RuntimeState, "running", StringComparison.Ordinal))
        {
            return await StartAsync(appId, cancellationToken);
        }

        var document = await apps.GetAppAsync(appId, cancellationToken);
        return new AppLifecycleResponse(document is null ? null : AppSummary.From(document), null, "runtime-switched");
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
            TryDeleteDirectory(Path.Combine(paths.SourcesRoot, appId));
        }

        TryDeleteDirectoryIfEmpty(GetAppRoot(appId));
        return new AppLifecycleResponse(app is null ? null : AppSummary.From(app), null, "removed");
    }

    public async Task<AppBackupsResponse> ListBackupsAsync(string appId, CancellationToken cancellationToken = default)
    {
        _ = await RequireAppAsync(appId, cancellationToken);
        return new AppBackupsResponse(await backups.ListBackupsAsync(appId, cancellationToken));
    }

    public async Task<AppBackupResponse> CreateManualBackupAsync(string appId, AppManualBackupRequest request, CancellationToken cancellationToken = default)
    {
        _ = await RequireAppAsync(appId, cancellationToken);
        var reason = string.IsNullOrWhiteSpace(request.Reason) ? "manual" : request.Reason.Trim();
        if (string.Equals(reason, "pre-update", StringComparison.Ordinal))
        {
            throw new AppLifecycleException("backup_reason_reserved", "pre-update backup reason is reserved for Core update apply.");
        }

        return new AppBackupResponse(await backups.CreateBackupAsync(appId, reason, cancellationToken));
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

    public async Task<AppLogsResponse> GetLogsAsync(string appId, int tail, CancellationToken cancellationToken = default)
    {
        var app = await RequireAppAsync(appId, cancellationToken);
        var selection = await LoadSelectionForAppAsync(app, cancellationToken);
        var logs = await ResolveAdapter(selection.RuntimeProfile.Type).GetLogsAsync(await CreateRuntimeContextAsync(app, selection, cancellationToken), tail, cancellationToken);
        return new AppLogsResponse(appId, logs.Text);
    }

    private AppRecord BuildAppRecord(
        RuntimeAppManifestSelection selection,
        string manifestPath,
        string? selectedChannel,
        bool system,
        AppRecord? existing)
    {
        var manifest = selection.Manifest;
        var settings = manifest.Settings.ToDictionary(
            setting => setting.Key,
            setting =>
            {
                var current = existing?.Settings.GetValueOrDefault(setting.Key);
                return new AppSettingValue(setting.Key, setting.Type, current?.Value ?? setting.Default, setting.Secret);
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
        var endpoints = manifest.Endpoints.Count == 0
            ? selection.Services.SelectMany(service => service.Runtime.Ports.Select(port => new AppEndpointContract(
                Key: $"{service.Key}.{port.Key ?? port.ContainerPort?.ToString(System.Globalization.CultureInfo.InvariantCulture) ?? "port"}",
                Protocol: string.IsNullOrWhiteSpace(port.Protocol) ? "http" : port.Protocol,
                Url: null,
                Public: port.Public ?? false))).ToArray()
            : manifest.Endpoints.Select(endpoint => new AppEndpointContract(
                Key: endpoint.Key,
                Protocol: endpoint.Protocol ?? "http",
                Url: null,
                Public: endpoint.Public)).ToArray();

        return new AppRecord(
            Id: manifest.Id!,
            DisplayName: manifest.Name!,
            Description: manifest.Description,
            Version: manifest.Version!,
            Kind: "runtime",
            System: system,
            Source: manifest.Source?.Repository ?? "manifest",
            ManifestPath: manifestPath,
            ManifestUrl: null,
            SelectedChannel: selectedChannel,
            SelectedRuntime: selection.RuntimeProfile.Key,
            OperationStatus: existing?.OperationStatus ?? "installed",
            RuntimeState: existing?.RuntimeState ?? "stopped",
            LastOperation: existing?.LastOperation,
            LastError: existing?.LastError,
            Capabilities: manifest.Capabilities.Count == 0 ? DefaultCapabilities : manifest.Capabilities,
            Settings: settings,
            StorageMappings: storageMappings,
            Dependencies: dependencies,
            Endpoints: endpoints,
            InstalledAt: existing?.InstalledAt ?? default,
            UpdatedAt: default,
            SourceState: BuildSourceState(selection, existing));
    }

    private AppSourceState? BuildSourceState(RuntimeAppManifestSelection selection, AppRecord? existing)
    {
        var source = selection.Manifest.Source;
        if (source?.Repository is null)
        {
            return existing?.SourceState;
        }

        if (existing?.SourceState is not null &&
            string.Equals(existing.SourceState.Repository, source.Repository, StringComparison.Ordinal))
        {
            return existing.SourceState with
            {
                Type = source.Type,
                Repository = source.Repository,
                ManagedCheckoutPath = existing.SourceState.ManagedCheckoutPath ?? Path.Combine(paths.SourcesRoot, selection.Manifest.Id!),
            };
        }

        var resolvedRef = source.Commit ?? source.Tag ?? source.Branch;
        return new AppSourceState(
            Type: source.Type,
            Repository: source.Repository,
            ResolvedRef: resolvedRef,
            Commit: source.Commit,
            ManagedCheckoutPath: Path.Combine(paths.SourcesRoot, selection.Manifest.Id!),
            LocalOverridePath: null,
            UpdatedAt: null);
    }

    private static IReadOnlyList<AppEndpointContract> MergeEndpointUrls(
        IReadOnlyList<AppEndpointContract> current,
        IReadOnlyList<AppEndpointContract> started)
    {
        var startedByKey = started.ToDictionary(endpoint => endpoint.Key, StringComparer.Ordinal);
        return current.Select(endpoint => startedByKey.TryGetValue(endpoint.Key, out var startedEndpoint)
            ? endpoint with { Url = startedEndpoint.Url, Protocol = startedEndpoint.Protocol, Public = startedEndpoint.Public }
            : endpoint).Concat(started.Where(endpoint => current.All(existing => !string.Equals(existing.Key, endpoint.Key, StringComparison.Ordinal)))).ToArray();
    }

    private async Task<RuntimeLifecycleContext> CreateRuntimeContextAsync(
        AppRecord app,
        RuntimeAppManifestSelection selection,
        CancellationToken cancellationToken)
        => new(app, selection, GetAppRoot(app.Id), GetAppDataPath(app.Id), await ResolveDependencyUrlsAsync(app, cancellationToken));

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
        => Path.Combine(paths.AppsRoot, appId);

    private string GetAppDataPath(string appId)
        => Path.Combine(GetAppRoot(appId), "data");

    private static string HashPlanSeed(object seed)
    {
        var json = JsonSerializer.Serialize(seed, JsonOptions);
        return Convert.ToHexString(SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(json))).ToLowerInvariant();
    }

    private static IReadOnlyList<string> BuildUpdateChanges(AppRecord app, RuntimeAppManifestSelection selection)
    {
        var changes = new List<string>();
        if (!string.Equals(app.Version, selection.Manifest.Version, StringComparison.Ordinal))
        {
            changes.Add($"version:{app.Version}->{selection.Manifest.Version}");
        }

        if (!string.Equals(app.SelectedRuntime, selection.RuntimeProfile.Key, StringComparison.Ordinal))
        {
            changes.Add($"runtime:{app.SelectedRuntime}->{selection.RuntimeProfile.Key}");
        }

        if (changes.Count == 0)
        {
            changes.Add("manifest");
        }

        return changes;
    }

    private static IReadOnlyList<string> BuildRuntimeSwitchChanges(AppRecord app, RuntimeAppManifestSelection selection)
    {
        var changes = new List<string>
        {
            $"runtime:{app.SelectedRuntime}->{selection.RuntimeProfile.Key}",
            $"runtimeType:{selection.RuntimeProfile.Type}",
        };
        if (selection.DataTarget is not null)
        {
            changes.Add("data:compatible");
        }

        return changes;
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
        return await System.Text.Json.JsonSerializer.DeserializeAsync<AppChannelIndex>(stream, JsonStorage.Options, cancellationToken) ??
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

        var manifest = System.Text.Json.JsonSerializer.Deserialize<RuntimeAppManifest>(File.ReadAllText(manifestPath), JsonStorage.Options);
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

        if (Path.IsPathRooted(manifestPath))
        {
            return manifestPath;
        }

        var baseDirectory = string.IsNullOrWhiteSpace(installedManifestPath)
            ? Directory.GetCurrentDirectory()
            : Path.GetDirectoryName(installedManifestPath) ?? Directory.GetCurrentDirectory();
        return Path.GetFullPath(Path.Combine(baseDirectory, manifestPath));
    }

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

    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);

    private static readonly string[] DefaultCapabilities = ["open", "update", "restart", "stop", "remove", "backup", "restore", "logs"];
}

internal sealed record AppInstallRequest(
    string ManifestPath,
    string? SelectedRuntime = null,
    string? SelectedChannel = null,
    bool System = false);

internal sealed record AppConfigureRequest(IReadOnlyDictionary<string, string?> Settings);

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

internal sealed record AppLifecycleResponse(AppSummary? App, AppBackupRecord? Backup, string Status);

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

internal sealed record AppLogsResponse(string AppId, string Text);
