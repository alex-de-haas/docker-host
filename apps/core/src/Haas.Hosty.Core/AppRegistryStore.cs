namespace Haas.Hosty.Core;

internal sealed class AppRegistryStore(CoreDataPaths paths)
{
    public async Task<IReadOnlyList<AppSummary>> ListAppsAsync(CancellationToken cancellationToken = default)
    {
        if (!Directory.Exists(paths.AppsRoot))
        {
            return [];
        }

        var apps = new List<AppSummary>();
        foreach (var appDirectory in Directory.EnumerateDirectories(paths.AppsRoot).Order(StringComparer.Ordinal))
        {
            cancellationToken.ThrowIfCancellationRequested();
            var statePath = Path.Combine(appDirectory, "state.json");
            var state = await JsonStorage.ReadAsync<AppStateDocument>(statePath, cancellationToken);
            if (state?.App is null || string.IsNullOrWhiteSpace(state.App.Id))
            {
                continue;
            }

            apps.Add(AppSummary.From(state.App));
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
        => (await JsonStorage.ReadAsync<AppStateDocument>(GetAppStatePath(appId), cancellationToken))?.App;

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
    AppSourceState? SourceState = null);

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
    string OperationStatus,
    string RuntimeState,
    string? LastOperation,
    string? LastError,
    IReadOnlyList<string> Capabilities,
    IReadOnlyList<AppEndpointContract> Endpoints)
{
    public static AppSummary From(AppRecord app)
        => new(
            app.Id,
            app.DisplayName,
            app.Description,
            app.Version,
            app.Kind,
            app.System,
            app.Source,
            app.SelectedChannel,
            app.SelectedRuntime,
            app.OperationStatus,
            app.RuntimeState,
            app.LastOperation,
            app.LastError,
            app.Capabilities,
            app.Endpoints);
}
