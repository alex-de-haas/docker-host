using System.Text.Json;

namespace Haas.Hosty.Core;

internal sealed class AppRegistryStore(CoreDataPaths paths)
{
    public async Task<IReadOnlyList<AppSummary>> ListAppsAsync(CancellationToken cancellationToken = default)
        => (await ListAppRecordsAsync(cancellationToken))
            .Select(AppSummary.From)
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

    public async Task<AppRecord?> GetAppAsync(string appId, CancellationToken cancellationToken = default)
    {
        var app = (await JsonStorage.ReadAsync<AppStateDocument>(GetAppStatePath(appId), cancellationToken))?.App;
        return app is null
            ? null
            : await HydrateAppUiAsync(app, Path.Combine(paths.AppsRoot, appId), cancellationToken);
    }

    public async Task<AppStateDocument> UpdateAppAsync(
        string appId,
        Func<AppRecord, AppRecord> update,
        CancellationToken cancellationToken = default)
    {
        var current = await GetAppAsync(appId, cancellationToken) ??
            throw new InvalidOperationException($"Runtime app '{appId}' was not found.");
        return await UpsertAppAsync(update(current), cancellationToken);
    }

    public Task RemoveAppAsync(string appId, CancellationToken cancellationToken = default)
    {
        var appRoot = Path.Combine(paths.AppsRoot, appId);
        if (Directory.Exists(appRoot))
        {
            Directory.Delete(appRoot, recursive: true);
        }

        return Task.CompletedTask;
    }

    private string GetAppStatePath(string appId)
        => Path.Combine(paths.AppsRoot, appId, "state.json");

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
    bool? Autostart = null);

internal sealed record AppSettingValue(string Key, string Type, string? Value, bool Secret);

internal sealed record AppStorageMapping(string Key, string HostPath, string TargetPath, bool ReadOnly);

internal sealed record AppDependencyContract(string Key, string AppId, string Endpoint);

internal sealed record AppEndpointContract(string Key, string Protocol, string? Url, bool Public);

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
    string? EntryPath,
    string? EmbeddedUrl,
    IReadOnlyList<AppNavigationSummary> Navigation)
{
    public static AppSummary From(AppRecord app)
    {
        var ui = app.Ui;
        var entryUrl = BuildUiUrl(ResolveEndpointUrl(app.Endpoints, ui?.EndpointKey), ui?.EntryPath);
        var navigation = ui?.Navigation
            .Select(item => new AppNavigationSummary(
                Label: item.Label,
                Path: item.Path,
                EntryPath: item.Path,
                EmbeddedUrl: BuildUiUrl(ResolveEndpointUrl(app.Endpoints, item.EndpointKey ?? ui.EndpointKey), item.Path)))
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
            app.Settings.Values
                .OrderBy(setting => setting.Key, StringComparer.Ordinal)
                .Select(setting => new AppSettingSummary(setting.Key, setting.Type, setting.Secret ? null : setting.Value, setting.Secret))
                .ToArray(),
            app.Endpoints,
            ui?.EntryPath,
            entryUrl,
            navigation);
    }

    private static string? ResolveEndpointUrl(IReadOnlyList<AppEndpointContract> endpoints, string? endpointKey)
    {
        if (!string.IsNullOrWhiteSpace(endpointKey))
        {
            var exact = endpoints.FirstOrDefault(endpoint =>
                string.Equals(endpoint.Key, endpointKey, StringComparison.Ordinal) &&
                !string.IsNullOrWhiteSpace(endpoint.Url));
            if (exact?.Url is not null)
            {
                return exact.Url;
            }

            var suffix = $".{endpointKey}";
            var compatible = endpoints.FirstOrDefault(endpoint =>
                endpoint.Key.EndsWith(suffix, StringComparison.Ordinal) &&
                !string.IsNullOrWhiteSpace(endpoint.Url));
            if (compatible?.Url is not null)
            {
                return compatible.Url;
            }
        }

        return endpoints.FirstOrDefault(endpoint => endpoint.Public && !string.IsNullOrWhiteSpace(endpoint.Url))?.Url ??
            endpoints.FirstOrDefault(endpoint => !string.IsNullOrWhiteSpace(endpoint.Url))?.Url;
    }

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

internal sealed record AppSettingSummary(string Key, string Type, string? Value, bool Secret);

internal sealed record AppNavigationSummary(string Label, string Path, string? EntryPath, string? EmbeddedUrl);
