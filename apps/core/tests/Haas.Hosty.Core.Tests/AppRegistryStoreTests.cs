using System.Text.Json;
using Haas.Hosty.Core;

namespace Haas.Hosty.Core.Tests;

public sealed class AppRegistryStoreTests
{
    [Fact]
    public async Task ListAppsAsync_ReadsAppNativeRecords()
    {
        var root = await CreateTempRootAsync();
        var paths = CreatePaths(root);
        var store = new AppRegistryStore(paths);
        await store.UpsertAppAsync(CreateApp("com.example.notes"));

        var apps = await store.ListAppsAsync();

        var app = Assert.Single(apps);
        Assert.Equal("com.example.notes", app.Id);
        Assert.Equal("Notes", app.DisplayName);
        Assert.Equal("docker", app.SelectedRuntime);
    }

    [Fact]
    public async Task UpsertAppAsync_WritesStateOwnerOnlyWithoutLockingTheAppDirectory()
    {
        if (OperatingSystem.IsWindows())
        {
            return;
        }

        // state.json holds setting values flagged secret, so the file is owner-only — but the app
        // directory must stay traversable for the container uid that mounts apps/<id>/data.
        var root = await CreateTempRootAsync();
        var paths = CreatePaths(root);
        var store = new AppRegistryStore(paths);
        var reference = Path.Combine(root, "reference");
        Directory.CreateDirectory(reference);

        await store.UpsertAppAsync(CreateApp("com.example.notes"));

        var appRoot = Path.Combine(paths.AppsRoot, "com.example.notes");
        Assert.Equal(
            UnixFileMode.UserRead | UnixFileMode.UserWrite,
            File.GetUnixFileMode(Path.Combine(appRoot, "state.json")));
        Assert.Equal(File.GetUnixFileMode(reference), File.GetUnixFileMode(appRoot));
    }

    [Fact]
    public async Task ListAppsAsync_HydratesUiNavigationFromInstalledManifest()
    {
        var root = await CreateTempRootAsync();
        var paths = CreatePaths(root);
        var appRoot = Path.Combine(paths.AppsRoot, "com.example.notes");
        Directory.CreateDirectory(appRoot);
        await File.WriteAllTextAsync(Path.Combine(appRoot, "manifest.json"), """
            {
              "schemaVersion": "app.0.1",
              "id": "com.example.notes",
              "name": "Notes",
              "version": "1.0.0",
              "runtimeProfiles": [{ "key": "docker", "type": "docker", "default": true }],
              "services": [{
                "key": "app",
                "runtimes": {
                  "docker": {
                    "type": "docker",
                    "image": "ghcr.io/example/notes:1.0.0"
                  }
                }
              }],
              "endpoints": [{ "key": "http", "service": "app", "port": "http", "protocol": "http", "public": true }],
              "ui": {
                "entrypoint": { "endpoint": "http", "path": "/" },
                "navigation": [
                  { "label": "Notes", "path": "/" },
                  { "label": "Settings", "path": "/settings" }
                ]
              }
            }
            """);
        var store = new AppRegistryStore(paths);
        await store.UpsertAppAsync(CreateApp("com.example.notes") with
        {
            ManifestPath = Path.Combine(appRoot, "manifest.json"),
            Endpoints =
            [
                new AppEndpointContract("http", "http", "http://localhost:3100", Public: true),
            ],
        });

        var apps = await store.ListAppsAsync();

        var app = Assert.Single(apps);
        Assert.Equal("/", app.EntryPath);
        Assert.Equal("http://localhost:3100/", app.EmbeddedUrl);
        Assert.Collection(
            app.Navigation,
            item =>
            {
                Assert.Equal("Notes", item.Label);
                Assert.Equal("http://localhost:3100/", item.EmbeddedUrl);
            },
            item =>
            {
                Assert.Equal("Settings", item.Label);
                Assert.Equal("/settings", item.Path);
                Assert.Equal("http://localhost:3100/settings", item.EmbeddedUrl);
            });
    }

    [Fact]
    public async Task ListAppsAsync_HydratesCatalogMetadataFromInstalledManifest()
    {
        var root = await CreateTempRootAsync();
        var paths = CreatePaths(root);
        var appRoot = Path.Combine(paths.AppsRoot, "com.example.notes");
        Directory.CreateDirectory(appRoot);
        await File.WriteAllTextAsync(Path.Combine(appRoot, "manifest.json"), """
            {
              "schemaVersion": "app.0.1",
              "id": "com.example.notes",
              "name": "Notes",
              "version": "1.0.0",
              "runtimeProfiles": [{ "key": "docker", "type": "docker", "default": true }],
              "services": [{
                "key": "app",
                "runtimes": {
                  "docker": {
                    "type": "docker",
                    "image": "ghcr.io/example/notes:1.0.0"
                  }
                }
              }],
              "catalogMetadata": {
                "publisher": { "name": "Example Co", "url": "https://example.com" },
                "category": "Productivity",
                "tags": ["notes", "sync"],
                "license": "AGPL-3.0-only",
                "summary": "Take notes."
              }
            }
            """);
        var store = new AppRegistryStore(paths);
        // Record installed before the field existed: no CatalogMetadata persisted, hydrated from the manifest.
        await store.UpsertAppAsync(CreateApp("com.example.notes") with
        {
            ManifestPath = Path.Combine(appRoot, "manifest.json"),
        });

        var apps = await store.ListAppsAsync();

        var app = Assert.Single(apps);
        Assert.NotNull(app.CatalogMetadata);
        Assert.Equal("Example Co", app.CatalogMetadata!.Publisher!.Name);
        Assert.Equal("Productivity", app.CatalogMetadata.Category);
        Assert.Equal(new[] { "notes", "sync" }, app.CatalogMetadata.Tags);
        Assert.Equal("AGPL-3.0-only", app.CatalogMetadata.License);
        Assert.Equal("Take notes.", app.CatalogMetadata.Summary);
    }

    [Fact]
    public async Task ListAppsAsync_WithUiAlreadyPersisted_SkipsManifestReadForCatalogMetadata()
    {
        // Perf gate: a record that already has Ui (the common case) short-circuits before the manifest
        // read, so it never re-reads on every list just because catalogMetadata is unset. We prove the
        // short-circuit by leaving catalogMetadata null even though the on-disk manifest declares one.
        var root = await CreateTempRootAsync();
        var paths = CreatePaths(root);
        var appRoot = Path.Combine(paths.AppsRoot, "com.example.notes");
        Directory.CreateDirectory(appRoot);
        await File.WriteAllTextAsync(Path.Combine(appRoot, "manifest.json"), """
            {
              "schemaVersion": "app.0.1",
              "id": "com.example.notes",
              "name": "Notes",
              "version": "1.0.0",
              "runtimeProfiles": [{ "key": "docker", "type": "docker", "default": true }],
              "services": [{ "key": "app", "runtimes": { "docker": { "type": "docker", "image": "ghcr.io/example/notes:1.0.0" } } }],
              "catalogMetadata": { "summary": "Should not be read." }
            }
            """);
        var store = new AppRegistryStore(paths);
        await store.UpsertAppAsync(CreateApp("com.example.notes") with
        {
            ManifestPath = Path.Combine(appRoot, "manifest.json"),
            Ui = new AppUiContract(Category: null, Icon: null, EndpointKey: null, EntryPath: "/", Navigation: []),
        });

        var app = Assert.Single(await store.ListAppsAsync());

        Assert.Null(app.CatalogMetadata); // gate short-circuited on Ui; the manifest was not re-read
    }

    [Fact]
    public async Task UpsertAppAsync_RoundTripsPersistedCatalogMetadata()
    {
        var root = await CreateTempRootAsync();
        var paths = CreatePaths(root);
        var store = new AppRegistryStore(paths);
        await store.UpsertAppAsync(CreateApp("com.example.notes") with
        {
            CatalogMetadata = new AppCatalogMetadataContract(
                Publisher: new AppPublisherContract("Example Co", "https://example.com", null),
                Category: "Productivity",
                Tags: ["notes"],
                Icon: "assets/icon.png",
                Screenshots: ["assets/1.png"],
                License: "AGPL-3.0-only",
                Links: new AppCatalogLinksContract("https://example.com", null, null),
                Summary: "Take notes.",
                Description: null,
                DescriptionFile: "docs/store.md",
                Changelog: null),
        });

        // A fresh store reads the persisted state back from disk (proves AOT serialization of the block).
        var app = Assert.Single(await new AppRegistryStore(paths).ListAppsAsync());

        Assert.NotNull(app.CatalogMetadata);
        Assert.Equal("Example Co", app.CatalogMetadata!.Publisher!.Name);
        Assert.Equal("assets/icon.png", app.CatalogMetadata.Icon);
        Assert.Equal(new[] { "assets/1.png" }, app.CatalogMetadata.Screenshots);
        Assert.Equal("https://example.com", app.CatalogMetadata.Links!.Website);
    }

    [Fact]
    public void From_ResolvesManifestAssetUrlsFromCatalogMetadata()
    {
        var app = CreateApp("com.example.notes") with
        {
            Version = "0.4.3",
            CatalogMetadata = AppCatalogMetadataContract.FromManifest(new RuntimeAppCatalogMetadataManifest
            {
                Icon = "assets/icon.svg",
                DescriptionFile = "docs/store.md",
            }),
        };

        var summary = AppSummary.From(app);

        // Relative assets become Core asset-endpoint URLs, cache-busted by the app version.
        Assert.Equal("/api/apps/com.example.notes/assets/assets/icon.svg?v=0.4.3", summary.IconUrl);
        Assert.Equal("/api/apps/com.example.notes/assets/docs/store.md?v=0.4.3", summary.DescriptionUrl);
    }

    [Fact]
    public void From_PassesThroughAbsoluteIconAndOmitsUndeclaredAssets()
    {
        var app = CreateApp("com.example.notes") with
        {
            CatalogMetadata = AppCatalogMetadataContract.FromManifest(new RuntimeAppCatalogMetadataManifest
            {
                Icon = "https://cdn.example.com/icon.png",
            }),
        };

        var summary = AppSummary.From(app);

        Assert.Equal("https://cdn.example.com/icon.png", summary.IconUrl);
        Assert.Null(summary.DescriptionUrl);
    }

    [Fact]
    public void From_ResolvesNavigationIconAssetUrls()
    {
        var app = CreateApp("com.example.notes") with
        {
            Version = "0.4.3",
            Ui = AppUiContract.FromManifest(new RuntimeAppUiManifest
            {
                Path = "/",
                Navigation =
                [
                    new RuntimeAppUiNavigationItemManifest { Label = "People", Path = "/people", IconAsset = "assets/people.svg" },
                    new RuntimeAppUiNavigationItemManifest { Label = "Plain", Path = "/plain" },
                ],
            }),
        };

        var summary = AppSummary.From(app);

        Assert.Equal("/api/apps/com.example.notes/assets/assets/people.svg?v=0.4.3", summary.Navigation[0].IconUrl);
        Assert.Null(summary.Navigation[1].IconUrl); // no iconAsset declared → no URL, client uses its Lucide fallback
    }

    [Fact]
    public void From_LiveSourceApp_EmitsUnbustedAssetUrls()
    {
        var app = CreateApp("com.example.notes") with
        {
            Version = "0.4.3",
            CatalogMetadata = AppCatalogMetadataContract.FromManifest(new RuntimeAppCatalogMetadataManifest
            {
                Icon = "assets/icon.svg",
                DescriptionFile = "docs/store.md",
            }),
            Ui = AppUiContract.FromManifest(new RuntimeAppUiManifest
            {
                Path = "/",
                Navigation = [new RuntimeAppUiNavigationItemManifest { Label = "People", Path = "/people", IconAsset = "assets/people.svg" }],
            }),
        };

        var summary = AppSummary.From(app, live: true);

        // A live source app re-vendors assets on adopted starts/restarts without a version bump, so its
        // asset URLs carry no ?v= buster — the endpoint serves them no-cache and revalidates by ETag,
        // letting an edited icon reach the browser after a restart.
        Assert.Equal("/api/apps/com.example.notes/assets/assets/icon.svg", summary.IconUrl);
        Assert.Equal("/api/apps/com.example.notes/assets/docs/store.md", summary.DescriptionUrl);
        Assert.Equal("/api/apps/com.example.notes/assets/assets/people.svg", summary.Navigation[0].IconUrl);
    }

    [Fact]
    public void From_WithoutCatalogMetadata_HasNoAssetUrls()
    {
        var summary = AppSummary.From(CreateApp("com.example.notes"));

        Assert.Null(summary.IconUrl);
        Assert.Null(summary.DescriptionUrl);
    }

    [Fact]
    public void From_ResolvesInterfaceUrlsFromEndpoints()
    {
        var app = CreateApp("com.example.gateway") with
        {
            Endpoints = [new AppEndpointContract(Key: "app.web", Protocol: "http", Url: "http://127.0.0.1:3200", Public: false, Service: "app")],
            Interfaces = AppInterfaceContract.FromManifest(new Dictionary<string, IReadOnlyList<RuntimeAppInterfaceManifest>>
            {
                ["ai-gateway"] = [new RuntimeAppInterfaceManifest { Endpoint = "web", Path = "/api/ai" }],
            }),
        };

        var summary = AppSummary.From(app);

        var declaration = Assert.Single(summary.Interfaces!["ai-gateway"]);
        Assert.Equal("default", declaration.Key); // omitted key normalizes to "default"
        Assert.Equal("/api/ai", declaration.Path);
        Assert.Equal("http://127.0.0.1:3200/api/ai", declaration.Url);
    }

    [Fact]
    public void From_WithoutInterfaces_LeavesInterfacesNull()
    {
        var summary = AppSummary.From(CreateApp("com.example.notes"));

        Assert.Null(summary.Interfaces);
    }

    [Fact]
    public void From_AssetUrls_AreNormalizedAndRejectUnsafeDeclarations()
    {
        // A messy-but-safe declaration normalizes to the same path the vendor writes / the endpoint serves.
        var normalized = AppSummary.From(CreateApp("com.example.notes") with
        {
            Version = "0.4.3",
            CatalogMetadata = AppCatalogMetadataContract.FromManifest(new RuntimeAppCatalogMetadataManifest { Icon = "./assets//icon.svg" }),
        });
        Assert.Equal("/api/apps/com.example.notes/assets/assets/icon.svg?v=0.4.3", normalized.IconUrl);

        // An unsafe declaration emits no URL, so AppSummary never advertises something the endpoint 404s.
        var unsafeIcon = AppSummary.From(CreateApp("com.example.notes") with
        {
            CatalogMetadata = AppCatalogMetadataContract.FromManifest(new RuntimeAppCatalogMetadataManifest { Icon = "../secret.svg" }),
        });
        Assert.Null(unsafeIcon.IconUrl);
    }

    [Fact]
    public async Task ListAppsAsync_HeadlessAppWithEndpointHasNoUiEntry()
    {
        // A headless app declares no `ui` section but still exposes an endpoint for other apps
        // to drive over its API. It must not be reported as openable: no entry path, no embedded
        // URL, and no navigation, so the Shell never surfaces it in the app sidebar.
        var root = await CreateTempRootAsync();
        var paths = CreatePaths(root);
        var store = new AppRegistryStore(paths);
        await store.UpsertAppAsync(CreateApp("com.example.engine") with
        {
            Endpoints =
            [
                new AppEndpointContract("control", "http", "http://localhost:8080", Public: false),
            ],
        });

        var apps = await store.ListAppsAsync();

        var app = Assert.Single(apps);
        Assert.Null(app.EntryPath);
        Assert.Null(app.EmbeddedUrl);
        Assert.Empty(app.Navigation);
        // The endpoint itself is still surfaced so other apps can resolve it as a dependency.
        Assert.Equal("http://localhost:8080", Assert.Single(app.Endpoints).Url);
    }

    [Fact]
    public async Task ListAppsAsync_AddsPublicOriginToSummariesWithoutReplacingLocalEndpointUrl()
    {
        var root = await CreateTempRootAsync();
        var paths = CreatePaths(root);
        var appRoot = Path.Combine(paths.AppsRoot, "com.example.notes");
        Directory.CreateDirectory(appRoot);
        await File.WriteAllTextAsync(Path.Combine(appRoot, "manifest.json"), """
            {
              "ui": {
                "entrypoint": { "endpoint": "http", "path": "/" }
              }
            }
            """);
        var store = new AppRegistryStore(paths);
        await store.UpsertAppAsync(CreateApp("com.example.notes") with
        {
            ManifestPath = Path.Combine(appRoot, "manifest.json"),
            Settings = new Dictionary<string, AppSettingValue>
            {
                ["HOSTY_PUBLIC_ORIGIN_HTTP"] = new("HOSTY_PUBLIC_ORIGIN_HTTP", "url", "https://notes.example.com", Secret: false),
            },
            Endpoints =
            [
                new AppEndpointContract("http", "http", "http://localhost:3100", Public: true),
            ],
        });

        var apps = await store.ListAppsAsync();

        var app = Assert.Single(apps);
        Assert.Equal("https://notes.example.com/", app.EmbeddedUrl);
        var endpoint = Assert.Single(app.Endpoints);
        Assert.Equal("http", endpoint.Protocol);
        Assert.Equal("http://localhost:3100", endpoint.Url);
        Assert.Equal("https://notes.example.com", endpoint.PublicOrigin);
    }

    [Fact]
    public async Task ListAppsAsync_AddsMissingPublicOriginSettingSummaryForPublicEndpoint()
    {
        var root = await CreateTempRootAsync();
        var paths = CreatePaths(root);
        var store = new AppRegistryStore(paths);
        await store.UpsertAppAsync(CreateApp("com.example.notes") with
        {
            Settings = new Dictionary<string, AppSettingValue>(),
            Endpoints =
            [
                new AppEndpointContract("http", "http", "http://localhost:3100", Public: true),
            ],
        });

        var apps = await store.ListAppsAsync();

        var app = Assert.Single(apps);
        var setting = Assert.Single(app.Settings, setting => setting.Key == "HOSTY_PUBLIC_ORIGIN_HTTP");
        Assert.Equal("url", setting.Type);
        Assert.Null(setting.Value);
        Assert.False(setting.Secret);
    }

    [Fact]
    public async Task UpsertAppAsync_RoundTripsPersistedPortAssignments()
    {
        var root = await CreateTempRootAsync();
        var paths = CreatePaths(root);
        var store = new AppRegistryStore(paths);
        await store.UpsertAppAsync(CreateApp("com.example.notes") with
        {
            PortAssignments =
            [
                new AppPortAssignment("app", "http", 3100, AppPortTransports.Tcp, AppPortBindScopes.Loopback, AppPortSources.Automatic, Remappable: true, AssignedAt: DateTimeOffset.UnixEpoch),
            ],
        });

        // A fresh store reads the persisted state back from disk (proves AOT serialization of the block).
        var record = await new AppRegistryStore(paths).GetAppAsync("com.example.notes");

        Assert.NotNull(record);
        var assignment = Assert.Single(record!.PortAssignments!);
        Assert.Equal("app", assignment.Service);
        Assert.Equal("http", assignment.PortKey);
        Assert.Equal(3100, assignment.HostPort);
        Assert.Equal(AppPortTransports.Tcp, assignment.Transport);
        Assert.Equal(AppPortBindScopes.Loopback, assignment.BindScope);
        Assert.Equal(AppPortSources.Automatic, assignment.Source);
        Assert.True(assignment.Remappable);
        Assert.Equal(DateTimeOffset.UnixEpoch, assignment.AssignedAt);
    }

    [Fact]
    public void From_ProjectsEndpointAvailabilityFromAssignmentAndRuntimeState()
    {
        var app = CreateApp("com.example.notes") with
        {
            RuntimeState = "stopped",
            PortAssignments =
            [
                new AppPortAssignment("app", "http", 3100, AppPortTransports.Tcp, AppPortBindScopes.Loopback, AppPortSources.Automatic, Remappable: true, AssignedAt: DateTimeOffset.UnixEpoch),
            ],
            Endpoints =
            [
                new AppEndpointContract("app.http", "http", "http://localhost:3100", Public: true, Service: "app", Port: "http"),
                // No assignment and no resolved URL → availability stays null (legacy/never-started).
                new AppEndpointContract("app.metrics", "http", Url: null, Public: false, Service: "app", Port: "metrics"),
            ],
        };

        var stopped = AppSummary.From(app);
        Assert.Equal(EndpointAvailability.Assigned, Assert.Single(stopped.Endpoints, e => e.Key == "app.http").Availability);
        Assert.Null(Assert.Single(stopped.Endpoints, e => e.Key == "app.metrics").Availability);

        // The same assigned endpoint reads `running` once the owning app is running.
        var running = AppSummary.From(app with { RuntimeState = "running" });
        Assert.Equal(EndpointAvailability.Running, Assert.Single(running.Endpoints, e => e.Key == "app.http").Availability);
    }

    [Fact]
    public async Task ListAppsAsync_SkipsInvalidAppDirectories()
    {
        var root = await CreateTempRootAsync();
        var paths = CreatePaths(root);
        Directory.CreateDirectory(Path.Combine(paths.AppsRoot, "broken"));
        await File.WriteAllTextAsync(Path.Combine(paths.AppsRoot, "broken", "state.json"), "{}");

        var apps = await new AppRegistryStore(paths).ListAppsAsync();

        Assert.Empty(apps);
    }

    [Fact]
    public async Task ListAppsAsync_SkipsCorruptedStateAndContinuesListingHealthyApps()
    {
        var root = await CreateTempRootAsync();
        var paths = CreatePaths(root);
        var store = new AppRegistryStore(paths);
        await store.UpsertAppAsync(CreateApp("com.example.notes"));
        var brokenRoot = Path.Combine(paths.AppsRoot, "broken");
        Directory.CreateDirectory(brokenRoot);
        await File.WriteAllTextAsync(Path.Combine(brokenRoot, "state.json"), "{not-json");

        var apps = await store.ListAppsAsync();

        var app = Assert.Single(apps);
        Assert.Equal("com.example.notes", app.Id);
    }

    [Fact]
    public async Task UpdateAppAsync_SerializesConcurrentReadModifyWrites()
    {
        var root = await CreateTempRootAsync();
        var store = new AppRegistryStore(CreatePaths(root));
        await store.UpsertAppAsync(CreateApp("com.example.notes") with { Capabilities = [] });

        await Task.WhenAll(Enumerable.Range(0, 25).Select(index =>
            store.UpdateAppAsync(
                "com.example.notes",
                app => app with { Capabilities = app.Capabilities.Append($"capability-{index}").ToArray() })));

        var app = await store.GetAppAsync("com.example.notes");
        Assert.NotNull(app);
        Assert.Equal(25, app.Capabilities.Count);
    }

    [Fact]
    public async Task UserDirectoryStore_ReadAsync_ReturnsEmptyFinalStateWhenMissing()
    {
        var root = await CreateTempRootAsync();
        var store = new UserDirectoryStore(CreatePaths(root));

        var state = await store.ReadAsync();

        Assert.Equal(1, state.SchemaVersion);
        Assert.Empty(state.Users);
        Assert.Empty(state.Invitations);
        Assert.Empty(state.Assignments);
        Assert.Empty(state.Sessions);
    }

    [Fact]
    public async Task UserDirectoryStore_UpdateAsync_ConcurrentAppends_NoLostWrites()
    {
        var root = await CreateTempRootAsync();
        var store = new UserDirectoryStore(CreatePaths(root));
        var now = DateTimeOffset.UtcNow;

        // Fire many overlapping read-modify-write appends. A bare Read+Write races last-writer-wins and
        // drops records; the serialized UpdateAsync must preserve every one.
        var appends = Enumerable.Range(0, 50).Select(index => Task.Run(() =>
            store.UpdateAsync(state => state with
            {
                Sessions = state.Sessions
                    .Append(new AuthSessionRecord($"session-{index}", $"user-{index}", now, now.AddHours(1), null))
                    .ToArray(),
            })));
        await Task.WhenAll(appends);

        var state = await store.ReadAsync();
        Assert.Equal(50, state.Sessions.Count);
        Assert.Equal(50, state.Sessions.Select(session => session.Id).Distinct(StringComparer.Ordinal).Count());
    }

    [Fact]
    public async Task GetAppAsync_MovesAV1OverrideCommitOutOfTheReviewedPin()
    {
        // A v1 record's SourceState.Commit may be the override folder's HEAD (SetLocalOverrideAsync used
        // to write it there), and the locked start path now trusts the pin — so the value cannot be taken
        // at face value for a record that had an override.
        var root = await CreateTempRootAsync();
        var paths = CreatePaths(root);
        var store = new AppRegistryStore(paths);
        var appRoot = Path.Combine(paths.AppsRoot, "com.example.notes");
        Directory.CreateDirectory(appRoot);
        var v1 = new AppStateDocument(1, CreateApp("com.example.notes") with
        {
            SourceState = new AppSourceState(
                Type: "git",
                Repository: "https://example.test/notes.git",
                ResolvedRef: "main",
                Commit: "1111111111111111111111111111111111111111",
                ManagedCheckoutPath: Path.Combine(appRoot, "source"),
                LocalOverridePath: Path.Combine(root, "worktree"),
                UpdatedAt: DateTimeOffset.UtcNow),
        });
        await File.WriteAllTextAsync(
            Path.Combine(appRoot, "state.json"),
            JsonSerializer.Serialize(v1, CoreJsonSerializerContext.Default.AppStateDocument));

        var migrated = await store.GetAppAsync("com.example.notes");

        Assert.Null(migrated?.SourceState?.Commit);
        Assert.Equal("1111111111111111111111111111111111111111", migrated?.SourceState?.OverrideCommit);

        // Once written back at the current schema version, a reviewed pin recorded later is left alone —
        // the migration is one-shot, not a standing distrust of every override record.
        _ = await store.UpsertAppAsync(migrated! with
        {
            SourceState = migrated.SourceState! with { Commit = "2222222222222222222222222222222222222222" },
        });

        var reread = await store.GetAppAsync("com.example.notes");
        Assert.Equal("2222222222222222222222222222222222222222", reread?.SourceState?.Commit);
        Assert.Equal("1111111111111111111111111111111111111111", reread?.SourceState?.OverrideCommit);
    }

    private static AppRecord CreateApp(string id)
        => new(
            Id: id,
            DisplayName: "Notes",
            Description: "Personal notes app.",
            Version: "1.0.0",
            Kind: "runtime",
            System: false,
            Source: "installed",
            ManifestPath: "apps/com.example.notes/manifest.json",
            ManifestUrl: null,
            SelectedRuntime: "docker",
            OperationStatus: "installed",
            RuntimeState: "stopped",
            LastOperation: null,
            LastError: null,
            Capabilities: ["open", "update", "restart", "stop", "remove"],
            Settings: new Dictionary<string, AppSettingValue>(),
            StorageMappings: [],
            Dependencies: [],
            Endpoints: [],
            InstalledAt: DateTimeOffset.UtcNow,
            UpdatedAt: DateTimeOffset.UtcNow);

    private static CoreDataPaths CreatePaths(string root)
        => new(
            DataRoot: root,
            CoreRoot: Path.Combine(root, "core"),
            AppsRoot: Path.Combine(root, "apps"),
            BackupsRoot: Path.Combine(root, "backups"),
            SourcesRoot: Path.Combine(root, "sources"),
            AuthRoot: Path.Combine(root, "core", "auth"),
            AuditLogPath: Path.Combine(root, "core", "audit", "audit.ndjson"));

    private static async Task<string> CreateTempRootAsync()
    {
        var root = Path.Combine(Path.GetTempPath(), $"hosty-core-tests-{Guid.NewGuid():N}");
        Directory.CreateDirectory(root);
        await File.WriteAllTextAsync(Path.Combine(root, ".keep"), JsonSerializer.Serialize(new { created = DateTimeOffset.UtcNow }));
        return root;
    }
}
