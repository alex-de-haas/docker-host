using Haas.Hosty.Core;

namespace Haas.Hosty.Core.Tests;

// Where Shell is publicly reachable now comes from Shell's own app record, the same Public Origins path
// every other app uses — not from Core's launch config, which had no business carrying settings for an
// app that is optional (`defaultEnabled` in distribution-apps, not mandatory).
public sealed class ShellPublicOriginResolverTests : IDisposable
{
    private readonly string root = Path.Combine(Path.GetTempPath(), $"hosty-shell-origin-{Guid.NewGuid():N}");

    [Fact]
    public async Task ResolveAsync_NoShellInstalled_IsNull()
    {
        // The case Core used to paper over with http://localhost:{ShellPort}: a browser sent there lands
        // on nothing. Null makes callers say "no UI client" instead of pointing at a dead origin.
        var resolver = CreateResolver(out _);

        Assert.Null(await resolver.ResolveAsync());
    }

    [Fact]
    public async Task ResolveAsync_PrefersTheConfiguredPublicOrigin()
    {
        var resolver = CreateResolver(out var apps);
        await apps.UpsertAppAsync(CreateShell(
            publicOrigin: "https://shell.example.test",
            endpointUrl: "http://127.0.0.1:7171"));

        Assert.Equal("https://shell.example.test", await resolver.ResolveAsync());
    }

    [Fact]
    public async Task ResolveAsync_FallsBackToTheAssignedLoopbackUrl()
    {
        // Not published anywhere: Shell is still reachable on the port Core assigned it, and that URL is
        // already in the record — no need for Core to keep a ShellPort of its own to rebuild it.
        var resolver = CreateResolver(out var apps);
        await apps.UpsertAppAsync(CreateShell(publicOrigin: null, endpointUrl: "http://127.0.0.1:7171"));

        Assert.Equal("http://127.0.0.1:7171", await resolver.ResolveAsync());
    }

    [Fact]
    public async Task ResolveAsync_IgnoresAnUnusablePublicOrigin()
    {
        // A malformed setting must not win over the loopback URL that does work.
        var resolver = CreateResolver(out var apps);
        await apps.UpsertAppAsync(CreateShell(publicOrigin: "not-an-origin", endpointUrl: "http://127.0.0.1:7171"));

        Assert.Equal("http://127.0.0.1:7171", await resolver.ResolveAsync());
    }

    [Fact]
    public async Task ResolveAsync_PrefersTheWebEndpointOverAnotherPublicOne()
    {
        // The legacy-origin migration stamps the web endpoint's key specifically, so the resolver has to
        // name it too. Taking whichever public endpoint sorts first would read a different setting than
        // the one that was written the moment Shell publishes a second endpoint.
        var resolver = CreateResolver(out var apps);
        var webKey = PublicOriginSettings.BuildSettingKey("web");
        var adminKey = PublicOriginSettings.BuildSettingKey("admin");
        await apps.UpsertAppAsync(CreateShell(publicOrigin: null, endpointUrl: null) with
        {
            Endpoints =
            [
                new AppEndpointContract("admin", "http", "http://127.0.0.1:9001", Public: true),
                new AppEndpointContract("web", "http", "http://127.0.0.1:7171", Public: true),
            ],
            Settings = new Dictionary<string, AppSettingValue>(StringComparer.Ordinal)
            {
                [adminKey] = new(adminKey, "url", "https://admin.example.test", Secret: false),
                [webKey] = new(webKey, "url", "https://shell.example.test", Secret: false),
            },
        });

        Assert.Equal("https://shell.example.test", await resolver.ResolveAsync());
    }

    private ShellPublicOriginResolver CreateResolver(out AppRegistryStore apps)
    {
        Directory.CreateDirectory(root);
        var store = new AppRegistryStore(new CoreDataPaths(
            DataRoot: root,
            CoreRoot: Path.Combine(root, "core"),
            AppsRoot: Path.Combine(root, "apps"),
            BackupsRoot: Path.Combine(root, "backups"),
            SourcesRoot: Path.Combine(root, "sources"),
            AuthRoot: Path.Combine(root, "core", "auth"),
            AuditLogPath: Path.Combine(root, "core", "audit", "audit.ndjson")));
        apps = store;
        return new ShellPublicOriginResolver(store, new TestClock());
    }

    private static AppRecord CreateShell(string? publicOrigin, string? endpointUrl)
    {
        var settings = new Dictionary<string, AppSettingValue>(StringComparer.Ordinal);
        if (publicOrigin is not null)
        {
            var key = PublicOriginSettings.BuildSettingKey("web");
            settings[key] = new AppSettingValue(key, "url", publicOrigin, Secret: false);
        }

        return new AppRecord(
            Id: ShellBootstrap.AppId,
            DisplayName: "Hosty Shell",
            Description: null,
            Version: "1.0.0",
            Kind: "runtime",
            System: true,
            Source: "installed",
            ManifestPath: "apps/hosty.shell/manifest.json",
            ManifestUrl: null,
            SelectedRuntime: "docker",
            OperationStatus: "installed",
            RuntimeState: "running",
            LastOperation: null,
            LastError: null,
            Capabilities: [],
            Settings: settings,
            StorageMappings: [],
            Dependencies: [],
            Endpoints: [new AppEndpointContract("web", "http", endpointUrl, Public: true)],
            InstalledAt: DateTimeOffset.UtcNow,
            UpdatedAt: DateTimeOffset.UtcNow);
    }

    private sealed class TestClock : IClock
    {
        public DateTimeOffset UtcNow => DateTimeOffset.UnixEpoch;
    }

    public void Dispose()
    {
        if (Directory.Exists(root))
        {
            Directory.Delete(root, recursive: true);
        }
    }
}
