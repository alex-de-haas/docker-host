using System.Collections.Concurrent;
using System.Text.Json;

namespace Haas.Hosty.Core;

internal sealed class AppRegistryStore(CoreDataPaths paths)
{
    private readonly ConcurrentDictionary<string, SemaphoreSlim> appLocks = new(StringComparer.Ordinal);

    public async Task<IReadOnlyList<AppSummary>> ListAppsAsync(CancellationToken cancellationToken = default)
        => (await ListAppRecordsAsync(cancellationToken))
            .Select(app => AppSummary.From(app))
            .ToArray();

    public async Task<IReadOnlyList<AppRecord>> ListAppRecordsAsync(CancellationToken cancellationToken = default)
    {
        if (!Directory.Exists(paths.AppsRoot))
        {
            return [];
        }

        var apps = new List<AppRecord>();
        foreach (var appDirectory in Directory.EnumerateDirectories(paths.AppsRoot).Order(StringComparer.Ordinal))
        {
            cancellationToken.ThrowIfCancellationRequested();
            var statePath = Path.Combine(appDirectory, "state.json");
            try
            {
                var state = await JsonStorage.ReadAsync<AppStateDocument>(statePath, cancellationToken);
                if (state?.App is null || string.IsNullOrWhiteSpace(state.App.Id))
                {
                    continue;
                }

                apps.Add(await HydrateAppUiAsync(state.App, appDirectory, cancellationToken));
            }
            catch (Exception ex) when (ex is IOException or JsonException or UnauthorizedAccessException)
            {
                continue;
            }
        }

        return apps;
    }

    public async Task<AppStateDocument> UpsertAppAsync(AppRecord app, CancellationToken cancellationToken = default)
    {
        var mutex = GetAppLock(app.Id);
        await mutex.WaitAsync(cancellationToken);
        try
        {
            return await UpsertAppCoreAsync(app, cancellationToken);
        }
        finally
        {
            mutex.Release();
        }
    }

    public async Task<AppRecord?> GetAppAsync(string appId, CancellationToken cancellationToken = default)
    {
        if (!CoreDataPaths.TryResolveContainedPath(paths.AppsRoot, appId, out var appRoot))
        {
            return null;
        }

        var app = (await JsonStorage.ReadAsync<AppStateDocument>(Path.Combine(appRoot, "state.json"), cancellationToken))?.App;
        return app is null
            ? null
            : await HydrateAppUiAsync(app, appRoot, cancellationToken);
    }

    public async Task<AppStateDocument> UpdateAppAsync(
        string appId,
        Func<AppRecord, AppRecord> update,
        CancellationToken cancellationToken = default)
    {
        var mutex = GetAppLock(appId);
        await mutex.WaitAsync(cancellationToken);
        try
        {
            var current = await GetAppAsync(appId, cancellationToken) ??
                throw new InvalidOperationException($"Runtime app '{appId}' was not found.");
            return await UpsertAppCoreAsync(update(current), cancellationToken);
        }
        finally
        {
            mutex.Release();
        }
    }

    public async Task RemoveAppAsync(string appId, CancellationToken cancellationToken = default)
    {
        var mutex = GetAppLock(appId);
        await mutex.WaitAsync(cancellationToken);
        try
        {
            var appRoot = CoreDataPaths.ResolveContainedPath(paths.AppsRoot, appId);
            if (Directory.Exists(appRoot))
            {
                Directory.Delete(appRoot, recursive: true);
            }
        }
        finally
        {
            mutex.Release();
        }
    }

    private async Task<AppStateDocument> UpsertAppCoreAsync(AppRecord app, CancellationToken cancellationToken)
    {
        var now = DateTimeOffset.UtcNow;
        var normalized = app with
        {
            UpdatedAt = now,
            InstalledAt = app.InstalledAt == default ? now : app.InstalledAt,
        };
        var document = new AppStateDocument(1, normalized);
        await JsonStorage.WriteAsync(GetAppStatePath(app.Id), document, cancellationToken);
        return document;
    }

    private SemaphoreSlim GetAppLock(string appId)
        => appLocks.GetOrAdd(appId, _ => new SemaphoreSlim(1, 1));

    private string GetAppStatePath(string appId)
        => Path.Combine(CoreDataPaths.ResolveContainedPath(paths.AppsRoot, appId), "state.json");

    private static async Task<AppRecord> HydrateAppUiAsync(AppRecord app, string appRoot, CancellationToken cancellationToken)
    {
        if (app.Ui is not null)
        {
            return app;
        }

        var manifestPath = ResolveExistingManifestPath(app.ManifestPath, appRoot);
        if (manifestPath is null)
        {
            return app;
        }

        try
        {
            var manifest = await JsonStorage.ReadAsync<RuntimeAppManifest>(manifestPath, cancellationToken);
            var ui = AppUiContract.FromManifest(manifest?.Ui);
            return ui is null ? app : app with { Ui = ui };
        }
        catch (IOException)
        {
            return app;
        }
        catch (System.Text.Json.JsonException)
        {
            return app;
        }
        catch (UnauthorizedAccessException)
        {
            return app;
        }
    }

    private static string? ResolveExistingManifestPath(string? manifestPath, string appRoot)
    {
        if (!string.IsNullOrWhiteSpace(manifestPath) && File.Exists(manifestPath))
        {
            return manifestPath;
        }

        var localCopy = Path.Combine(appRoot, "manifest.json");
        return File.Exists(localCopy) ? localCopy : null;
    }
}

internal sealed record AppStateDocument(int SchemaVersion, AppRecord App);

// Operator-configured state retained across an uninstall that keeps app data, so a later reinstall
// restores it instead of resetting to manifest defaults. Written to apps/<id>/retained-config.json
// by RemoveAsync (when data is kept) and consumed by InstallAsync. Holds setting values (including
// secrets), external mount bindings, and the autostart toggle.
internal sealed record RetainedAppConfig(
    int SchemaVersion,
    IReadOnlyDictionary<string, AppSettingValue> Settings,
    IReadOnlyList<AppMountBinding> Mounts,
    bool? Autostart);

internal sealed record AppRecord(
    string Id,
    string DisplayName,
    string? Description,
    string Version,
    string Kind,
    bool System,
    string Source,
    string? ManifestPath,
    string? ManifestUrl,
    string? SelectedChannel,
    string? SelectedRuntime,
    string OperationStatus,
    string RuntimeState,
    string? LastOperation,
    string? LastError,
    IReadOnlyList<string> Capabilities,
    IReadOnlyDictionary<string, AppSettingValue> Settings,
    IReadOnlyList<AppStorageMapping> StorageMappings,
    IReadOnlyList<AppDependencyContract> Dependencies,
    IReadOnlyList<AppEndpointContract> Endpoints,
    DateTimeOffset InstalledAt,
    DateTimeOffset UpdatedAt,
    AppSourceState? SourceState = null,
    AppUiContract? Ui = null,
    bool? Autostart = null,
    IReadOnlyList<AppRuntimeProfileSummary>? RuntimeProfiles = null,
    IReadOnlyList<AppMountSlot>? MountSlots = null,
    IReadOnlyList<AppMountBinding>? Mounts = null,
    // The operator's original local manifest source (file or directory) captured at install,
    // set only for non-URL installs. Lets a folder-installed app re-read its source folder on
    // update instead of the stale internal copy (app.ManifestPath). See CreateUpdatePlanAsync.
    string? InstallManifestPath = null);

internal sealed record AppSettingValue(string Key, string Type, string? Value, bool Secret, bool Required = false);

internal sealed record AppStorageMapping(string Key, string HostPath, string TargetPath, bool ReadOnly);

// External host-path mount slot declared by the manifest, denormalized onto the app record
// (like AppRuntimeProfileSummary) so the API can describe slots without re-loading the manifest.
internal sealed record AppMountSlot(string Key, string Mode, bool Multiple, bool Required, string? Service);

// Operator-configured binding of a host path into a declared mount slot. The container path
// is derived deterministically from the operator-chosen Label (`/mnt/{Key}/{Label}`) so it is
// stable across sibling add/remove. Read-only/-write comes from the slot's Mode, not stored here.
internal sealed record AppMountBinding(string Key, string Label, string HostPath);

internal sealed record AppDependencyContract(
    string AppId,
    string? Version,
    bool Required,
    IReadOnlyList<AppDependencyEndpointContract> Endpoints);

// A wired endpoint of a cross-app dependency: the dependency app's endpoint key, and the env alias
// it is injected under (HOSTY_DEPENDENCY_{ALIAS}_URL) in the dependent app.
internal sealed record AppDependencyEndpointContract(string EndpointKey, string Alias);

internal sealed record AppEndpointContract(
    string Key,
    string Protocol,
    string? Url,
    bool Public,
    string? Service = null,
    string? Port = null,
    string? PublicOrigin = null);

internal sealed record AppRuntimeProfileSummary(string Key, string Type, bool Default);

internal sealed record AppSourceState(
    string? Type,
    string? Repository,
    string? ResolvedRef,
    string? Commit,
    string? ManagedCheckoutPath,
    string? LocalOverridePath,
    DateTimeOffset? UpdatedAt);

internal sealed record AppUiContract(
    string? Category,
    string? Icon,
    string? EndpointKey,
    string EntryPath,
    IReadOnlyList<AppNavigationContract> Navigation)
{
    public static AppUiContract? FromManifest(RuntimeAppUiManifest? ui)
    {
        if (ui is null)
        {
            return null;
        }

        var entry = ResolveEntrypoint(ui);
        var navigation = ui.Navigation
            .Select(item =>
            {
                var path = NormalizePath(string.IsNullOrWhiteSpace(item.Path) ? entry.Path : item.Path);
                var label = string.IsNullOrWhiteSpace(item.Label) ? path : item.Label.Trim();
                var endpointKey = FirstNonBlank(item.Endpoint, item.PortKey, entry.EndpointKey);
                return new AppNavigationContract(label, path, endpointKey);
            })
            .ToArray();

        return new AppUiContract(
            Category: NullIfBlank(ui.Category),
            Icon: NullIfBlank(ui.Icon),
            EndpointKey: entry.EndpointKey,
            EntryPath: entry.Path,
            Navigation: navigation);
    }

    private static UiEntrypoint ResolveEntrypoint(RuntimeAppUiManifest ui)
    {
        var endpointKey = NullIfBlank(ui.PortKey);
        var path = NullIfBlank(ui.Path);
        if (ui.Entrypoint is { } entrypoint)
        {
            if (entrypoint.ValueKind == System.Text.Json.JsonValueKind.String)
            {
                path ??= entrypoint.GetString();
            }
            else if (entrypoint.ValueKind == System.Text.Json.JsonValueKind.Object)
            {
                endpointKey ??= ReadString(entrypoint, "endpoint") ?? ReadString(entrypoint, "portKey");
                path ??= ReadString(entrypoint, "path");
            }
        }

        return new UiEntrypoint(endpointKey, NormalizePath(path));
    }

    private static string? ReadString(System.Text.Json.JsonElement element, string propertyName)
        => element.TryGetProperty(propertyName, out var value) && value.ValueKind == System.Text.Json.JsonValueKind.String
            ? NullIfBlank(value.GetString())
            : null;

    private static string NormalizePath(string? path)
    {
        var trimmed = path?.Trim();
        if (string.IsNullOrWhiteSpace(trimmed))
        {
            return "/";
        }

        return trimmed.StartsWith("/", StringComparison.Ordinal) ? trimmed : $"/{trimmed}";
    }

    private static string? FirstNonBlank(params string?[] values)
        => values.Select(NullIfBlank).FirstOrDefault(value => value is not null);

    private static string? NullIfBlank(string? value)
        => string.IsNullOrWhiteSpace(value) ? null : value.Trim();

    private sealed record UiEntrypoint(string? EndpointKey, string Path);
}

internal sealed record AppNavigationContract(string Label, string Path, string? EndpointKey);

internal sealed record AppSummary(
    string Id,
    string DisplayName,
    string? Description,
    string Version,
    string Kind,
    bool System,
    string Source,
    string? SelectedChannel,
    string? SelectedRuntime,
    bool Autostart,
    string OperationStatus,
    string RuntimeState,
    string? LastOperation,
    string? LastError,
    IReadOnlyList<string> Capabilities,
    IReadOnlyList<AppSettingSummary> Settings,
    IReadOnlyList<AppEndpointContract> Endpoints,
    IReadOnlyList<AppRuntimeProfileSummary> RuntimeProfiles,
    string? EntryPath,
    string? EmbeddedUrl,
    IReadOnlyList<AppNavigationSummary> Navigation,
    IReadOnlyList<AppMountSummary> Mounts)
{
    public static AppSummary From(AppRecord app, IReadOnlyList<AppRuntimeProfileSummary>? runtimeProfiles = null)
    {
        var ui = app.Ui;
        var endpoints = AttachPublicOrigins(app.Endpoints, app.Settings);
        var profiles = runtimeProfiles ?? app.RuntimeProfiles ?? [];
        var entryUrl = BuildUiUrl(ResolveEndpointUrl(endpoints, ui?.EndpointKey), ui?.EntryPath);
        var navigation = ui?.Navigation
            .Select(item => new AppNavigationSummary(
                Label: item.Label,
                Path: item.Path,
                EntryPath: item.Path,
                EmbeddedUrl: BuildUiUrl(ResolveEndpointUrl(endpoints, item.EndpointKey ?? ui.EndpointKey), item.Path)))
            .ToArray() ?? [];

        return new(
            app.Id,
            app.DisplayName,
            app.Description,
            app.Version,
            app.Kind,
            app.System,
            app.Source,
            app.SelectedChannel,
            app.SelectedRuntime,
            app.Autostart ?? true,
            app.OperationStatus,
            app.RuntimeState,
            app.LastOperation,
            app.LastError,
            app.Capabilities,
            BuildSettingSummaries(app.Settings, app.Endpoints),
            endpoints,
            profiles,
            ui?.EntryPath,
            entryUrl,
            navigation,
            BuildMountSummaries(app.MountSlots, app.Mounts));
    }

    private static IReadOnlyList<AppMountSummary> BuildMountSummaries(
        IReadOnlyList<AppMountSlot>? slots,
        IReadOnlyList<AppMountBinding>? bindings)
    {
        if (slots is null || slots.Count == 0)
        {
            return [];
        }

        return slots
            .OrderBy(slot => slot.Key, StringComparer.Ordinal)
            .Select(slot => new AppMountSummary(
                slot.Key,
                slot.Mode,
                slot.Multiple,
                slot.Required,
                slot.Service,
                (bindings ?? [])
                    .Where(binding => string.Equals(binding.Key, slot.Key, StringComparison.Ordinal))
                    .OrderBy(binding => binding.Label, StringComparer.Ordinal)
                    .Select(binding => new AppMountBindingSummary(
                        binding.Label,
                        binding.HostPath,
                        RuntimeMountPlanner.BuildContainerPath(binding.Key, binding.Label)))
                    .ToArray()))
            .ToArray();
    }

    private static IReadOnlyList<AppSettingSummary> BuildSettingSummaries(
        IReadOnlyDictionary<string, AppSettingValue> settings,
        IReadOnlyList<AppEndpointContract> endpoints)
    {
        var summaries = settings.Values
            .ToDictionary(setting => setting.Key, setting => new AppSettingSummary(setting.Key, setting.Type, setting.Secret ? null : setting.Value, setting.Secret, setting.Required), StringComparer.Ordinal);
        foreach (var endpoint in endpoints.Where(endpoint => endpoint.Public))
        {
            var key = PublicOriginSettings.BuildSettingKey(endpoint.Key);
            summaries.TryAdd(key, new AppSettingSummary(key, "url", null, Secret: false));
        }

        return summaries.Values.OrderBy(setting => setting.Key, StringComparer.Ordinal).ToArray();
    }

    private static IReadOnlyList<AppEndpointContract> AttachPublicOrigins(
        IReadOnlyList<AppEndpointContract> endpoints,
        IReadOnlyDictionary<string, AppSettingValue> settings)
        => endpoints
            .Select(endpoint =>
            {
                if (!endpoint.Public ||
                    string.IsNullOrWhiteSpace(endpoint.Url) ||
                    !settings.TryGetValue(PublicOriginSettings.BuildSettingKey(endpoint.Key), out var setting) ||
                    string.IsNullOrWhiteSpace(setting.Value) ||
                    !PublicOriginSettings.TryNormalizeOrigin(setting.Value, out var publicOrigin))
                {
                    return endpoint;
                }

                return endpoint with { PublicOrigin = publicOrigin };
            })
            .ToArray();

    private static string? ResolveEndpointUrl(IReadOnlyList<AppEndpointContract> endpoints, string? endpointKey)
    {
        if (!string.IsNullOrWhiteSpace(endpointKey))
        {
            var exact = endpoints.FirstOrDefault(endpoint =>
                string.Equals(endpoint.Key, endpointKey, StringComparison.Ordinal) &&
                !string.IsNullOrWhiteSpace(endpoint.Url));
            var exactUrl = ResolveEndpointOpenUrl(exact);
            if (exactUrl is not null)
            {
                return exactUrl;
            }

            var suffix = $".{endpointKey}";
            var compatible = endpoints.FirstOrDefault(endpoint =>
                endpoint.Key.EndsWith(suffix, StringComparison.Ordinal) &&
                HasEndpointOpenUrl(endpoint));
            var compatibleUrl = ResolveEndpointOpenUrl(compatible);
            if (compatibleUrl is not null)
            {
                return compatibleUrl;
            }
        }

        return ResolveEndpointOpenUrl(endpoints.FirstOrDefault(endpoint => endpoint.Public && HasEndpointOpenUrl(endpoint))) ??
            ResolveEndpointOpenUrl(endpoints.FirstOrDefault(HasEndpointOpenUrl));
    }

    private static bool HasEndpointOpenUrl(AppEndpointContract endpoint)
        => !string.IsNullOrWhiteSpace(endpoint.PublicOrigin) || !string.IsNullOrWhiteSpace(endpoint.Url);

    private static string? ResolveEndpointOpenUrl(AppEndpointContract? endpoint)
        => string.IsNullOrWhiteSpace(endpoint?.PublicOrigin) ? endpoint?.Url : endpoint.PublicOrigin;

    private static string? BuildUiUrl(string? baseUrl, string? path)
    {
        if (string.IsNullOrWhiteSpace(baseUrl))
        {
            return null;
        }

        var normalizedPath = string.IsNullOrWhiteSpace(path)
            ? "/"
            : path.Trim().StartsWith("/", StringComparison.Ordinal) ? path.Trim() : $"/{path.Trim()}";

        if (Uri.TryCreate(baseUrl, UriKind.Absolute, out var uri))
        {
            var builder = new UriBuilder(uri)
            {
                Path = normalizedPath,
                Query = "",
                Fragment = "",
            };
            return builder.Uri.ToString();
        }

        return $"{baseUrl.TrimEnd('/')}{normalizedPath}";
    }
}

internal sealed record AppSettingSummary(string Key, string Type, string? Value, bool Secret, bool Required = false);

internal sealed record AppNavigationSummary(string Label, string Path, string? EntryPath, string? EmbeddedUrl);

internal sealed record AppMountSummary(
    string Key,
    string Mode,
    bool Multiple,
    bool Required,
    string? Service,
    IReadOnlyList<AppMountBindingSummary> Bindings);

internal sealed record AppMountBindingSummary(string Label, string HostPath, string ContainerPath);
