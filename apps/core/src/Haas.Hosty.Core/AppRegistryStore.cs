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
        // Owner-only: this document carries setting values, including ones flagged secret.
        await JsonStorage.WriteOwnerFileAsync(GetAppStatePath(app.Id), document, cancellationToken);
        return document;
    }

    private SemaphoreSlim GetAppLock(string appId)
        => appLocks.GetOrAdd(appId, _ => new SemaphoreSlim(1, 1));

    private string GetAppStatePath(string appId)
        => Path.Combine(CoreDataPaths.ResolveContainedPath(paths.AppsRoot, appId), "state.json");

    private static async Task<AppRecord> HydrateAppUiAsync(AppRecord app, string appRoot, CancellationToken cancellationToken)
    {
        // Lazily backfill display metadata from the reviewed manifest copy for records installed before
        // it was persisted. Gate on Ui only (as before CatalogMetadata existed): Ui is set for every app
        // that declares a `ui` block, so the common case skips the manifest read. CatalogMetadata is
        // backfilled opportunistically in that same read — gating on it too would force a manifest re-read
        // on every list/get for the many apps that legitimately declare no catalogMetadata. New/updated
        // records get both set directly by BuildAppRecord (and the live reconcile), so they never reach
        // here. This projection is not persisted, so a flag would not spare legacy records the read.
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
            var ui = app.Ui ?? AppUiContract.FromManifest(manifest?.Ui);
            var catalogMetadata = app.CatalogMetadata ?? AppCatalogMetadataContract.FromManifest(manifest?.CatalogMetadata);
            return ui == app.Ui && catalogMetadata == app.CatalogMetadata
                ? app
                : app with { Ui = ui, CatalogMetadata = catalogMetadata };
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
    string? InstallManifestPath = null,
    // Compiled-artifact run-locks keyed by service key (docker image services only). Resolved at
    // install/update/first-start (tag -> digest) and run on restart so the declared version stays
    // truthful. Null/absent = not yet resolved; lazily backfilled on next start (TOFU). Additive and
    // nullable, so no AppStateDocument.SchemaVersion bump is needed (A3/A9).
    IReadOnlyDictionary<string, ArtifactLock>? ArtifactLocks = null,
    // Pull/lock policy for compiled artifacts: "pinned" (default) runs the locked digest and requires
    // a reviewed update to advance it; "rolling" re-resolves the tag every start and accepts drift.
    // Null = pinned. Operator-set via configure; the single source of truth (pullPolicy is gone, A8).
    string? UpdatePolicy = null,
    // Set when a live source app's operator folder manifest failed validation on the last start (2b):
    // Core kept running the last-good reviewed copy and surfaces the error so the operator sees the
    // broken edit. Null when the live manifest is valid or the app is not a live source app. Additive
    // and nullable, so no AppStateDocument.SchemaVersion bump is needed (R13/R14, A9).
    string? ManifestError = null,
    // The contract changes a live source app adopted at its last start (version/capability/mount/
    // endpoint/settings deltas vs the previous start), for operator awareness — informational, not a
    // gate (2b/R11/R12). Null/empty when nothing changed or the app is not a live source app.
    IReadOnlyList<string>? LiveChanges = null,
    // Per-runtime Development Mode toggles the operator has explicitly set (runtime key -> on/off). A
    // key that is absent falls back to the manifest profile's `development` flag as the default; the
    // operator may flip any source (localCommand) runtime either way. ON runs the runtime live from
    // source (the folder manifest is adopted on restart). OFF uses the reviewed manifest and, for a
    // URL/publisher install, runs the managed checkout pinned to its commit (an honest lock advanced only
    // by a reviewed source-resolve/update); a folder install has no separate reviewed source, so OFF runs
    // its own folder. Additive/nullable, so no AppStateDocument schema bump. See "Development Mode — an
    // operator toggle" in runtime-artifact-model.md.
    IReadOnlyDictionary<string, bool>? DevelopmentModes = null,
    // Snapshot bookkeeping captured when the operator turned Development Mode ON for a runtime, so
    // turning it OFF later can offer to roll the app data back to the reviewed version's last-known-good
    // state. Keyed by runtime; each entry records the reviewed version at enable time and the id of the
    // `pre-development-mode` backup taken then. On disable Core compares the entry's Version to the app's
    // current version (which reflects the version that ran live) to decide whether a rollback is worth
    // recommending — a likely one-way data migration the reviewed version may not read. Cleared on
    // disable. Additive/nullable, so no AppStateDocument schema bump. See "Development Mode — an operator
    // toggle" in runtime-artifact-model.md.
    IReadOnlyDictionary<string, DevelopmentModeBaseline>? DevelopmentModeBaselines = null,
    // Optional marketplace/catalog display metadata (publisher, tags, screenshots, license, links, …),
    // captured from the manifest at install/update and re-read on each start for a live source app.
    // Display-only; never gates anything. Additive/nullable, so no AppStateDocument schema bump. See
    // runtime-app-marketplace.md ("Manifest Metadata Extensions", B5).
    AppCatalogMetadataContract? CatalogMetadata = null,
    // App-owned feeds.json used by generic feed lifecycle operations. Null for direct manifest/folder
    // installs. Stored independently of any discovery provider so updates keep working without it.
    string? FeedsUrl = null,
    // Selected feed id within FeedsUrl. ManifestUrl stores that feed's last resolved manifestRef.
    // Null means no feed is selected (including every direct install). Additive/nullable state.
    string? FollowedFeedId = null,
    // Install provenance: how this record came to exist. "distribution" marks apps installed (or
    // adopted) by the boot bootstrap from the release's distribution list — uninstalling such an app
    // records enabled=false in bootstrap choices so the next boot does not resurrect it. Null means a
    // user/operator install. Ownership bookkeeping, not privilege (see docs/ideas/generic-bootstrap.md);
    // additive/nullable, so no AppStateDocument schema bump.
    string? InstallOrigin = null,
    // Platform capability slots this app fulfills, from the manifest's top-level `provides` (distinct
    // from Capabilities, which is the UI action list, and from per-service Linux `--cap-add`). Core
    // keys start-time provisioning and start ordering off these — e.g. an "otlp-collector" provider is
    // provisioned with its Core-owned config and started before OTLP consumers, regardless of app id
    // or how it was installed (see PlatformCapabilities). Additive/nullable, no schema bump.
    IReadOnlyList<string>? Provides = null,
    // Service-scoped host-port reservations (install-time port reservations). Null on legacy records and
    // backfilled by the boot migration (PortAssignmentMigration); once populated, the reservation — not
    // the endpoint URL — is the durable source of a service's assigned port. Additive/nullable, so no
    // AppStateDocument schema bump. See docs/planning/install-time-runtime-port-reservations.md.
    IReadOnlyList<AppPortAssignment>? PortAssignments = null);

// Well-known InstallOrigin values. Null on the record means a user/operator install; only the
// distribution bootstrap stamps an explicit origin today.
internal static class AppInstallOrigins
{
    public const string Distribution = "distribution";
}

// Persistent, service-scoped host-port reservation (install-time port reservations, phase 1). The
// reservation — not the endpoint URL — is the durable source of an assigned host port;
// AppEndpointContract.Url becomes a projection of it. Identity is (Service, PortKey, Transport,
// BindScope): the numeric HostPort alone is insufficient because tcp and udp are distinct collision
// domains and a host / host-network bind is broader than a loopback one. Additive/nullable on AppRecord,
// so older state.json deserializes with PortAssignments = null and is migrated before first lifecycle use
// (no AppStateDocument schema bump). See docs/planning/install-time-runtime-port-reservations.md.
internal sealed record AppPortAssignment(
    string Service,
    string PortKey,
    int HostPort,
    string Transport,
    string BindScope,
    string Source,
    bool Remappable,
    DateTimeOffset AssignedAt);

// Network transport of a port assignment. TCP and UDP occupy distinct collision domains and may share a
// number, so the transport is part of the assignment identity.
internal static class AppPortTransports
{
    public const string Tcp = "tcp";
    public const string Udp = "udp";
}

// Bind scope of a port assignment. `loopback` is an ordinary published HTTP port; `host` binds the host
// interface more broadly (raw L4); `host-network` is a fixed container port in the host network namespace
// that cannot be remapped. A broader scope conflicts with any narrower assignment on the same transport/port.
internal static class AppPortBindScopes
{
    public const string Loopback = "loopback";
    public const string Host = "host";
    public const string HostNetwork = "host-network";
}

// Origin of a port assignment. `automatic` is an OS-selected dynamic port; `manifest` is an explicit
// localPort/hostPort; `operator` is a HOSTY_PORT_* override; `host-network` is a fixed host-namespace port.
// Only `automatic` assignments are remappable.
internal static class AppPortSources
{
    public const string Automatic = "automatic";
    public const string Manifest = "manifest";
    public const string Operator = "operator";
    public const string HostNetwork = "host-network";
}

// Endpoint availability, projected onto AppSummary endpoints only (never persisted, like PublicOrigin).
// `assigned` — a durable target (a port assignment or an already-resolved URL) exists but the owning
// service is stopped; `running` — the service is up; `unavailable` — the persisted target failed
// preflight/binding (phase 2). Null only when the endpoint has neither an assignment nor a resolved URL.
// A non-null Url alone no longer implies reachability.
internal static class EndpointAvailability
{
    public const string Assigned = "assigned";
    public const string Running = "running";
    public const string Unavailable = "unavailable";
}

// The resolved immutable identity of a compiled artifact (per service), advanced only by a reviewed
// update for a pinned app. `Kind` is "image" (registry image) in v1; the bundle/source fields are
// reserved for prebuilt/source kinds (out of phase 2a). For an image: `ImageDigest` is the locked
// `sha256:...` and `ResolvedFromRef` the `repository:tag` it was resolved from. See A3.
internal sealed record ArtifactLock(
    string Kind,
    string? ImageDigest,
    string? ResolvedFromRef,
    string? BundleHash,
    string? Commit,
    DateTimeOffset ResolvedAt);

// Per-runtime snapshot bookkeeping for a Development-Mode enable (see AppRecord.DevelopmentModeBaselines).
// Version = the reviewed version in effect when the operator turned dev mode ON; BackupId = the
// `pre-development-mode` backup taken at that moment (null when the app has no data directory to snapshot).
internal sealed record DevelopmentModeBaseline(string Version, string? BackupId);

// Label/Description are optional manifest-derived presentation metadata (like Type/Secret/Required),
// denormalized here and refreshed from the manifest on each BuildAppRecord. Additive and nullable, so
// old persisted state deserializes fine (missing => null) with no AppStateDocument schema bump.
internal sealed record AppSettingValue(string Key, string Type, string? Value, bool Secret, bool Required = false, string? Label = null, string? Description = null);

internal sealed record AppStorageMapping(string Key, string HostPath, string TargetPath, bool ReadOnly);

// External host-path mount slot declared by the manifest, denormalized onto the app record
// (like AppRuntimeProfileSummary) so the API can describe slots without re-loading the manifest.
internal sealed record AppMountSlot(string Key, string Mode, bool Multiple, bool Required, string? Service);

// Operator-configured binding of a host path into a declared mount slot. The container path
// is derived deterministically from the operator-chosen Label (`/mnt/{Key}/{Label}`) so it is
// stable across sibling add/remove. Read-only/-write comes from the slot's Mode, not stored here.
// When GlobalMountName is set the binding references a shared-mounts library entry: Label equals the
// entry name and HostPath is a display cache re-resolved live from the library at start (see
// GlobalMountStore). Additive/nullable, so no AppStateDocument schema bump (cf. ArtifactLocks).
internal sealed record AppMountBinding(string Key, string Label, string HostPath, string? GlobalMountName = null);

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
    string? PublicOrigin = null,
    // Availability projected on summaries only (assigned/running/unavailable); left null in the persisted
    // record and attached in AppSummary.From, exactly like PublicOrigin. See EndpointAvailability.
    string? Availability = null);

// `Development` (additive/defaulted for back-compat) is the manifest author's declared default for
// Development Mode on this runtime — the intent marker. `DevelopmentMode` is the *effective* per-runtime
// state after the operator's toggle is applied (override else the `Development` default, and always
// false for a non-source runtime); it is what actually drives liveness, the Source tab, and the
// Live/Locked badge. Computed on summaries via AppSummary.ResolveDevelopmentMode; the persisted record's
// profiles leave it false. See "Development Mode — an operator toggle" in runtime-artifact-model.md.
internal sealed record AppRuntimeProfileSummary(string Key, string Type, bool Default, bool Development = false, bool DevelopmentMode = false);

internal sealed record AppSourceState(
    string? Type,
    string? Repository,
    string? ResolvedRef,
    string? Commit,
    string? ManagedCheckoutPath,
    string? LocalOverridePath,
    DateTimeOffset? UpdatedAt,
    // The manifest's directory relative to the source repository root (e.g. "apps/shell"), or null when
    // the manifest sits at the root. The source root — an override folder or the managed checkout — is
    // the repo root by convention (the runtime resolves each service's workingDirectory against it), so
    // Core reads the live manifest from <sourceRoot>/<ManifestSubpath>/manifest.json for a monorepo app.
    // Captured at install; additive/nullable so older records read back as null (manifest-at-root).
    string? ManifestSubpath = null);

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
                return new AppNavigationContract(label, path, endpointKey, NullIfBlank(item.IconAsset));
            })
            .ToArray();

        return new AppUiContract(
            Category: NullIfBlank(ui.Category),
            Icon: NullIfBlank(ui.Icon),
            EndpointKey: entry.EndpointKey,
            EntryPath: entry.Path,
            Navigation: navigation);
    }

    // Raw declared entrypoint (endpoint key + un-normalized path) shared with the strict system-app
    // manifest validation, which must see exactly what the author wrote before any normalization.
    internal static (string? EndpointKey, string? Path) ReadDeclaredEntrypoint(RuntimeAppUiManifest ui)
    {
        var endpointKey = NullIfBlank(ui.PortKey);
        var path = NullIfBlank(ui.Path);
        if (ui.Entrypoint is { } entrypoint)
        {
            if (entrypoint.ValueKind == System.Text.Json.JsonValueKind.String)
            {
                path ??= NullIfBlank(entrypoint.GetString());
            }
            else if (entrypoint.ValueKind == System.Text.Json.JsonValueKind.Object)
            {
                endpointKey ??= ReadString(entrypoint, "endpoint") ?? ReadString(entrypoint, "portKey");
                path ??= ReadString(entrypoint, "path");
            }
        }

        return (endpointKey, path);
    }

    private static UiEntrypoint ResolveEntrypoint(RuntimeAppUiManifest ui)
    {
        var (endpointKey, path) = ReadDeclaredEntrypoint(ui);
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

internal sealed record AppNavigationContract(string Label, string Path, string? EndpointKey, string? IconAsset = null);

// Normalized marketplace/catalog display metadata, denormalized onto the app record and surfaced on
// the summary (like AppUiContract). Normalization is best-effort and applied *after* the manifest
// deserializes — blanks are dropped and an all-empty block collapses to null. The block's *content*
// never fails runtime validation (it is outside it; see runtime-app-marketplace.md, B5), though the
// manifest as a whole must still be well-formed, deserializable JSON. Strict content checks (SPDX,
// category enum, shape) live in the catalog CI.
internal sealed record AppCatalogMetadataContract(
    AppPublisherContract? Publisher,
    string? Category,
    IReadOnlyList<string> Tags,
    string? Icon,
    IReadOnlyList<string> Screenshots,
    string? License,
    AppCatalogLinksContract? Links,
    string? Summary,
    string? Description,
    string? DescriptionFile,
    string? Changelog)
{
    public static AppCatalogMetadataContract? FromManifest(RuntimeAppCatalogMetadataManifest? metadata)
    {
        if (metadata is null)
        {
            return null;
        }

        var publisher = AppPublisherContract.FromManifest(metadata.Publisher);
        var links = AppCatalogLinksContract.FromManifest(metadata.Links);
        var contract = new AppCatalogMetadataContract(
            Publisher: publisher,
            Category: NullIfBlank(metadata.Category),
            Tags: NormalizeList(metadata.Tags),
            Icon: NullIfBlank(metadata.Icon),
            Screenshots: NormalizeList(metadata.Screenshots),
            License: NullIfBlank(metadata.License),
            Links: links,
            Summary: NullIfBlank(metadata.Summary),
            Description: NullIfBlank(metadata.Description),
            DescriptionFile: NullIfBlank(metadata.DescriptionFile),
            Changelog: NullIfBlank(metadata.Changelog));

        // A `catalogMetadata: {}` (or all-blank) block carries no information; collapse it to null so
        // summaries and persisted records do not accumulate empty noise.
        var isEmpty = contract.Publisher is null
            && contract.Category is null
            && contract.Tags.Count == 0
            && contract.Icon is null
            && contract.Screenshots.Count == 0
            && contract.License is null
            && contract.Links is null
            && contract.Summary is null
            && contract.Description is null
            && contract.DescriptionFile is null
            && contract.Changelog is null;
        return isEmpty ? null : contract;
    }

    internal static string? NullIfBlank(string? value)
        => string.IsNullOrWhiteSpace(value) ? null : value.Trim();

    // Trim, drop blanks, and de-duplicate (ordinal) while preserving first-seen order.
    internal static IReadOnlyList<string> NormalizeList(IReadOnlyList<string>? values)
    {
        if (values is null || values.Count == 0)
        {
            return [];
        }

        var seen = new HashSet<string>(StringComparer.Ordinal);
        var result = new List<string>(values.Count);
        foreach (var value in values)
        {
            var trimmed = NullIfBlank(value);
            if (trimmed is not null && seen.Add(trimmed))
            {
                result.Add(trimmed);
            }
        }

        return result;
    }
}

internal sealed record AppPublisherContract(string? Name, string? Url, string? Email)
{
    public static AppPublisherContract? FromManifest(RuntimeAppPublisherManifest? publisher)
    {
        if (publisher is null)
        {
            return null;
        }

        var name = AppCatalogMetadataContract.NullIfBlank(publisher.Name);
        var url = AppCatalogMetadataContract.NullIfBlank(publisher.Url);
        var email = AppCatalogMetadataContract.NullIfBlank(publisher.Email);
        return name is null && url is null && email is null ? null : new AppPublisherContract(name, url, email);
    }
}

internal sealed record AppCatalogLinksContract(string? Website, string? Docs, string? Support)
{
    public static AppCatalogLinksContract? FromManifest(RuntimeAppCatalogLinksManifest? links)
    {
        if (links is null)
        {
            return null;
        }

        var website = AppCatalogMetadataContract.NullIfBlank(links.Website);
        var docs = AppCatalogMetadataContract.NullIfBlank(links.Docs);
        var support = AppCatalogMetadataContract.NullIfBlank(links.Support);
        return website is null && docs is null && support is null
            ? null
            : new AppCatalogLinksContract(website, docs, support);
    }
}

internal sealed record AppSummary(
    string Id,
    string DisplayName,
    string? Description,
    string Version,
    string Kind,
    bool System,
    string Source,
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
    IReadOnlyList<AppMountSummary> Mounts,
    // Compiled-artifact run-locks per service (the running/locked image digest) and the effective
    // pull/lock policy ("pinned"/"rolling"), for version legibility and drift badges on clients.
    string UpdatePolicy,
    IReadOnlyDictionary<string, ArtifactLock>? ArtifactLocks,
    // Set when the live source folder manifest was invalid on the last start and Core fell back to
    // the last-good copy; clients surface it as a non-blocking banner (2b, R14). Null otherwise.
    string? ManifestError,
    // Contract deltas a live source app adopted at its last start, for an informational "adopted"
    // breadcrumb on clients (2b/R11). Null/empty when nothing changed or the app is not live source.
    IReadOnlyList<string>? LiveChanges,
    // True when the selected runtime is a live source artifact owned by the operator (a source-kind
    // runtime - localCommand in v1 - re-read live from the operator's own folder). For these the
    // contract is adopted on restart and there is no reviewed-update path, so clients mark the runtime
    // "Live" and hide the Update affordance (runtime-app-marketplace.md). False for compiled runtimes
    // and for publisher/URL installs (whose contract is reviewed even when the code runs live).
    bool Live = false,
    // True when the app can run from a local source folder: a non-URL install that declares a
    // localCommand runtime profile. Broader than Live (which also requires a source to already exist) -
    // it gates the Shell's "Source" tab so an operator can point the app at a source before one is set.
    bool SupportsSource = false,
    // The operator-configured local source override folder (AppSourceState.LocalOverridePath), and the
    // Hosty-managed checkout folder for this app (AppSourceState.ManagedCheckoutPath). Null when not
    // configured. Surfaced so the Shell's Source tab can show/edit the current source without a
    // second round-trip. Additive/nullable; older clients ignore them.
    string? SourceOverridePath = null,
    string? SourceManagedPath = null,
    // The folder a live source app actually runs from (the override folder, else the original external
    // folder install), or null when not live. Computed by the lifecycle service (needs the internal-path
    // guard), so it is passed in rather than derived here. Clients show it in the "Live" badge tooltip.
    string? SourceLivePath = null,
    // Optional marketplace/catalog display metadata (publisher, tags, screenshots, license, links, …)
    // for storefront cards and the app-detail view. Null when the manifest declares none. Additive.
    AppCatalogMetadataContract? CatalogMetadata = null,
    // Resolved, ready-to-render URLs for the app's manifest-declared display assets (manifest-level app
    // assets). A relative icon/descriptionFile becomes a Core asset-endpoint URL served from the app's
    // folder (`/api/apps/{id}/assets/{path}?v=<version>`); an absolute https icon passes through. Null
    // when the manifest declares none. Clients render `<img src=iconUrl>` (fallback to the Lucide
    // `ui.icon`) and fetch the markdown description from descriptionUrl. Additive/nullable.
    string? IconUrl = null,
    string? DescriptionUrl = null,
    // Generic app-owned feed source and selected feed. Null for direct installs.
    string? FeedsUrl = null,
    string? FollowedFeedId = null,
    // Last-known update-availability verdict (plan-first updates): written by the fleet sweep and by
    // any successful plan build, reset by a successful apply. Null until a check has run for this
    // app. Attached by the lifecycle service, which owns the projection. Additive/nullable.
    AppUpdateAvailability? UpdateCheck = null)
{
    // The effective Development Mode for a runtime: the operator's explicit toggle if set, else the
    // manifest profile's `development` flag as the default. Always false for a non-source runtime
    // (image/prebuilt have no working copy to bind). Single source of truth shared by the summary
    // projection here and the lifecycle service's liveness gate, so they never disagree.
    public static bool ResolveDevelopmentMode(AppRecord app, AppRuntimeProfileSummary profile)
    {
        if (!string.Equals(profile.Type, "localCommand", StringComparison.Ordinal))
        {
            return false;
        }

        return app.DevelopmentModes is not null && app.DevelopmentModes.TryGetValue(profile.Key, out var mode)
            ? mode
            : profile.Development;
    }

    public static AppSummary From(
        AppRecord app,
        IReadOnlyList<AppRuntimeProfileSummary>? runtimeProfiles = null,
        bool live = false,
        string? liveSourcePath = null)
    {
        var ui = app.Ui;
        var endpoints = AttachAvailability(AttachPublicOrigins(app.Endpoints, app.Settings), app);
        // Overlay each runtime's *effective* Development Mode (operator toggle over the manifest default)
        // so clients render the Live/Locked badge and the toggle switch from what actually governs
        // liveness, not the raw manifest flag.
        var profiles = (runtimeProfiles ?? app.RuntimeProfiles ?? [])
            .Select(profile => profile with { DevelopmentMode = ResolveDevelopmentMode(app, profile) })
            .ToArray();
        // The UI entry URL is only meaningful when the app declares a `ui` section. A headless
        // app (e.g. a backend service that exposes only a control endpoint for other apps to
        // consume) must not be treated as openable just because it has an HTTP endpoint, so we
        // never fall back to an arbitrary endpoint here.
        var entryUrl = ui is null
            ? null
            : BuildUiUrl(ResolveEndpointUrl(endpoints, ui.EndpointKey), ui.EntryPath);
        // A live source app re-vendors display assets on every adopted start/restart without a version
        // bump, so its asset URLs carry no version buster: an un-busted URL is served no-cache and
        // revalidated against the ETag, so an edited icon reaches the browser after a restart. A locked
        // app keeps the immutable version-busted URL.
        var assetVersion = live ? null : app.Version;
        var navigation = ui?.Navigation
            .Select(item => new AppNavigationSummary(
                Label: item.Label,
                Path: item.Path,
                EntryPath: item.Path,
                EmbeddedUrl: BuildUiUrl(ResolveEndpointUrl(endpoints, item.EndpointKey ?? ui.EndpointKey), item.Path),
                IconUrl: ResolveAssetUrl(item.IconAsset, app.Id, assetVersion)))
            .ToArray() ?? [];

        // Source-capable when it declares any source (localCommand) runtime, regardless of install
        // channel. Under the Development Mode operator toggle, the operator may point any source runtime
        // at a local folder and flip it live — so the Source tab appears whenever a source runtime exists,
        // not only when a runtime is flagged development in the manifest. See runtime-artifact-model.md.
        var supportsSource = profiles.Any(profile => string.Equals(profile.Type, "localCommand", StringComparison.Ordinal));

        return new(
            app.Id,
            app.DisplayName,
            app.Description,
            app.Version,
            app.Kind,
            app.System,
            app.Source,
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
            BuildMountSummaries(app.MountSlots, app.Mounts),
            DockerRuntimeAdapter.ResolveUpdatePolicy(app.UpdatePolicy),
            app.ArtifactLocks,
            app.ManifestError,
            app.LiveChanges,
            live,
            supportsSource,
            app.SourceState?.LocalOverridePath,
            app.SourceState?.ManagedCheckoutPath,
            liveSourcePath,
            app.CatalogMetadata,
            ResolveIconUrl(app.CatalogMetadata?.Icon, app.Id, assetVersion),
            ResolveAssetUrl(app.CatalogMetadata?.DescriptionFile, app.Id, assetVersion),
            app.FeedsUrl,
            app.FollowedFeedId);
    }

    // A manifest-declared icon is either an absolute https URL (passed through) or a manifest-relative
    // path served from the app's folder by the asset endpoint. Returns null when no icon is declared.
    private static string? ResolveIconUrl(string? icon, string appId, string? version)
        => string.IsNullOrWhiteSpace(icon) || IsAbsoluteHttpUrl(icon)
            ? AppCatalogMetadataContract.NullIfBlank(icon)
            : ResolveAssetUrl(icon, appId, version);

    // Build the Core asset-endpoint URL for a manifest-relative asset path, per-segment escaped and
    // cache-busted by the app version (which bumps whenever the vendored assets change). A null version
    // omits the buster — the endpoint serves un-busted URLs no-cache with an ETag, which a live source
    // app needs so re-vendored edits reach the browser without a version bump. Returns null for a blank,
    // absolute, or otherwise unclean ref (empty/./.././':'/'%' segment) so AppSummary only ever emits a
    // URL the endpoint can actually serve — the same normalization the vendor uses, so the emitted URL
    // matches the path the asset was written to.
    private static string? ResolveAssetUrl(string? relativePath, string appId, string? version)
    {
        var path = CoreDataPaths.NormalizeRelativeAssetPath("", relativePath);
        if (path is null)
        {
            return null;
        }

        var escaped = string.Join('/', path.Split('/').Select(Uri.EscapeDataString));
        var url = $"/api/apps/{Uri.EscapeDataString(appId)}/assets/{escaped}";
        return version is null ? url : $"{url}?v={Uri.EscapeDataString(version)}";
    }

    private static bool IsAbsoluteHttpUrl(string value)
        => Uri.TryCreate(value, UriKind.Absolute, out var uri) &&
            (uri.Scheme == Uri.UriSchemeHttp || uri.Scheme == Uri.UriSchemeHttps);

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
                        RuntimeMountPlanner.BuildContainerPath(binding.Key, binding.Label),
                        binding.GlobalMountName is null ? "local" : "global",
                        binding.GlobalMountName))
                    .ToArray()))
            .ToArray();
    }

    private static IReadOnlyList<AppSettingSummary> BuildSettingSummaries(
        IReadOnlyDictionary<string, AppSettingValue> settings,
        IReadOnlyList<AppEndpointContract> endpoints)
    {
        var summaries = settings.Values
            .ToDictionary(setting => setting.Key, setting => new AppSettingSummary(setting.Key, setting.Type, setting.Secret ? null : setting.Value, setting.Secret, setting.Required, setting.Label, setting.Description), StringComparer.Ordinal);
        foreach (var endpoint in endpoints.Where(endpoint => endpoint.Public))
        {
            var key = PublicOriginSettings.BuildSettingKey(endpoint.Key);
            summaries.TryAdd(key, new AppSettingSummary(key, "url", null, Secret: false));
        }

        return summaries.Values.OrderBy(setting => setting.Key, StringComparer.Ordinal).ToArray();
    }

    // Project endpoint availability (assigned/running) onto the summary without persisting it — the same
    // null-in-record, attach-on-summary shape as AttachPublicOrigins. An endpoint has a durable target when
    // it carries a matching port assignment or an already-resolved URL; it reads `running` only while the
    // owning app is running, otherwise `assigned`. A legacy endpoint with neither stays null. `unavailable`
    // is a phase-2 preflight outcome not produced here.
    private static IReadOnlyList<AppEndpointContract> AttachAvailability(
        IReadOnlyList<AppEndpointContract> endpoints,
        AppRecord app)
    {
        var running = string.Equals(app.RuntimeState, "running", StringComparison.Ordinal);
        // Pre-index assignment identities by (service, port key) so the projection stays O(endpoints)
        // rather than scanning every assignment per endpoint.
        var assigned = new HashSet<(string?, string?)>(
            (app.PortAssignments ?? []).Select(assignment => ((string?)assignment.Service, (string?)assignment.PortKey)));
        return endpoints
            .Select(endpoint =>
            {
                var hasAssignment = assigned.Contains((endpoint.Service, endpoint.Port));
                if (!hasAssignment && string.IsNullOrWhiteSpace(endpoint.Url))
                {
                    return endpoint;
                }

                return endpoint with
                {
                    Availability = running ? EndpointAvailability.Running : EndpointAvailability.Assigned,
                };
            })
            .ToArray();
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

internal sealed record AppSettingSummary(string Key, string Type, string? Value, bool Secret, bool Required = false, string? Label = null, string? Description = null);

internal sealed record AppNavigationSummary(string Label, string Path, string? EntryPath, string? EmbeddedUrl, string? IconUrl = null);

internal sealed record AppMountSummary(
    string Key,
    string Mode,
    bool Multiple,
    bool Required,
    string? Service,
    IReadOnlyList<AppMountBindingSummary> Bindings);

// Source is "global" (HostPath resolved from the shared-mounts library entry named GlobalMountName)
// or "local" (inline operator path). HostPath for a global binding is the last-resolved display cache.
internal sealed record AppMountBindingSummary(string Label, string HostPath, string ContainerPath, string Source, string? GlobalMountName);
