using Haas.Hosty.Core;

namespace Haas.Hosty.Core.Tests;

public sealed class RuntimePortAllocatorTests
{
    [Fact]
    public async Task AssignAsync_InstallWithNoStart_ProjectsEndpointUrlAndAutomaticAssignment()
    {
        var allocator = new RuntimePortAllocator(CreateConfig());
        var record = CreateApp("com.example.notes", [Endpoint("app", "http")]);
        var selection = Selection(Service("app", Port("http", containerPort: 8080)));

        var result = await allocator.AssignAsync(record, selection, []);

        var assignment = Assert.Single(result.PortAssignments!);
        Assert.Equal("app", assignment.Service);
        Assert.Equal("http", assignment.PortKey);
        Assert.Equal(AppPortSources.Automatic, assignment.Source);
        Assert.Equal(AppPortBindScopes.Loopback, assignment.BindScope);
        Assert.True(assignment.Remappable);
        Assert.NotEqual(CorePort, assignment.HostPort);
        Assert.NotEqual(ShellPort, assignment.HostPort);

        var endpoint = Assert.Single(result.Endpoints);
        Assert.Equal($"http://127.0.0.1:{assignment.HostPort}", endpoint.Url);
    }

    [Fact]
    public async Task AssignAsync_MultiServiceRepeatedPortKey_AssignsDistinctPortsAndUrls()
    {
        var allocator = new RuntimePortAllocator(CreateConfig());
        var record = CreateApp("com.example.suite", [Endpoint("api", "http"), Endpoint("web", "http")]);
        var selection = Selection(
            Service("api", Port("http", containerPort: 8080)),
            Service("web", Port("http", containerPort: 8080)));

        var result = await allocator.AssignAsync(record, selection, []);

        Assert.Equal(2, result.PortAssignments!.Count);
        var apiPort = Assert.Single(result.PortAssignments, a => a.Service == "api").HostPort;
        var webPort = Assert.Single(result.PortAssignments, a => a.Service == "web").HostPort;
        Assert.NotEqual(apiPort, webPort);
        Assert.Equal($"http://127.0.0.1:{apiPort}", Assert.Single(result.Endpoints, e => e.Key == "api.http").Url);
        Assert.Equal($"http://127.0.0.1:{webPort}", Assert.Single(result.Endpoints, e => e.Key == "web.http").Url);
    }

    [Fact]
    public async Task AssignAsync_ManifestExplicitPort_UsedAndClassifiedManifest()
    {
        var allocator = new RuntimePortAllocator(CreateConfig());
        var record = CreateApp("com.example.notes", [Endpoint("app", "http")]);
        var selection = Selection(Service("app", Port("http", containerPort: 8080, localPort: 5000)));

        var result = await allocator.AssignAsync(record, selection, []);

        var assignment = Assert.Single(result.PortAssignments!);
        Assert.Equal(5000, assignment.HostPort);
        Assert.Equal(AppPortSources.Manifest, assignment.Source);
        Assert.False(assignment.Remappable);
        Assert.Equal("http://127.0.0.1:5000", Assert.Single(result.Endpoints).Url);
    }

    [Fact]
    public async Task AssignAsync_ServiceScopedOverride_DisambiguatesSharedKeyAndClassifiesOperator()
    {
        var allocator = new RuntimePortAllocator(CreateConfig());
        // Two services share the port key `http`; only `api` is pinned by a service-scoped override, which
        // the app-scoped HOSTY_PORT_HTTP form could not express. `web` still allocates automatically.
        var record = CreateApp("com.example.suite", [Endpoint("api", "http"), Endpoint("web", "http")]) with
        {
            Settings = new Dictionary<string, AppSettingValue>
            {
                ["HOSTY_PORT_API_HTTP"] = new("HOSTY_PORT_API_HTTP", "string", "6000", Secret: false),
            },
        };
        var selection = Selection(
            Service("api", Port("http", containerPort: 8080)),
            Service("web", Port("http", containerPort: 8080)));

        var result = await allocator.AssignAsync(record, selection, []);

        var api = Assert.Single(result.PortAssignments!, a => a.Service == "api");
        Assert.Equal(6000, api.HostPort);
        Assert.Equal(AppPortSources.Operator, api.Source);
        Assert.False(api.Remappable);
        var web = Assert.Single(result.PortAssignments!, a => a.Service == "web");
        Assert.Equal(AppPortSources.Automatic, web.Source);
        Assert.NotEqual(6000, web.HostPort);
    }

    [Fact]
    public async Task AssignAsync_HostNetworkService_UsesContainerPortAndIsNotRemappable()
    {
        var allocator = new RuntimePortAllocator(CreateConfig());
        var record = CreateApp("com.example.torrent", [Endpoint("app", "torrent")]);
        var selection = Selection(Service("app", host: true, Port("torrent", containerPort: 6881)));

        var result = await allocator.AssignAsync(record, selection, []);

        var assignment = Assert.Single(result.PortAssignments!);
        Assert.Equal(6881, assignment.HostPort);
        Assert.Equal(AppPortBindScopes.HostNetwork, assignment.BindScope);
        Assert.Equal(AppPortSources.HostNetwork, assignment.Source);
        Assert.False(assignment.Remappable);
    }

    [Fact]
    public async Task AssignAsync_PreExistingEndpointUrl_IsNotOverwritten()
    {
        // A URL resolved by a prior start stays authoritative; the allocator fills only missing URLs.
        var allocator = new RuntimePortAllocator(CreateConfig());
        var record = CreateApp("com.example.notes",
            [new AppEndpointContract("app.http", "http", "http://127.0.0.1:4242", Public: true, Service: "app", Port: "http")]);
        var selection = Selection(Service("app", Port("http", containerPort: 8080)));

        var result = await allocator.AssignAsync(record, selection, []);

        Assert.Equal("http://127.0.0.1:4242", Assert.Single(result.Endpoints).Url);
    }

    [Fact]
    public async Task AssignAndPersistAsync_ListsAssignsAndPersistsAtomically()
    {
        // The exclusion-view read, the assignment, and the persist run under one gate so a concurrent
        // install cannot allocate against a stale snapshot. Here we assert the wiring: listInstalled is
        // consulted, persist receives the assigned record (with reservation + projected URL), and the
        // persist result is returned.
        var allocator = new RuntimePortAllocator(CreateConfig());
        var record = CreateApp("com.example.new", [Endpoint("app", "http")]);
        var selection = Selection(Service("app", Port("http", containerPort: 8080)));

        var listed = false;
        AppRecord? persistedArg = null;
        var result = await allocator.AssignAndPersistAsync(
            record,
            selection,
            _ =>
            {
                listed = true;
                return Task.FromResult<IReadOnlyList<AppRecord>>([]);
            },
            (assigned, _) =>
            {
                persistedArg = assigned;
                return Task.FromResult("persisted");
            });

        Assert.True(listed);
        Assert.Equal("persisted", result);
        Assert.NotNull(persistedArg);
        Assert.Single(persistedArg!.PortAssignments!);
        Assert.StartsWith("http://127.0.0.1:", Assert.Single(persistedArg.Endpoints).Url);
    }

    [Fact]
    public async Task AssignAndPersistAsync_ExcludesOwnIdFromExclusionView()
    {
        // A record already present under its own id (a re-list of the app being installed) must not feed
        // its own ports back into the exclusion view; only other apps are excluded.
        var allocator = new RuntimePortAllocator(CreateConfig());
        var record = CreateApp("com.example.new", [Endpoint("app", "http")]);
        var selection = Selection(Service("app", Port("http", containerPort: 8080)));
        var selfWithBogusPort = record with
        {
            PortAssignments =
            [
                new AppPortAssignment("app", "http", 65000, AppPortTransports.Tcp, AppPortBindScopes.Loopback, AppPortSources.Automatic, Remappable: true, AssignedAt: DateTimeOffset.UnixEpoch),
            ],
        };

        var assigned = await allocator.AssignAndPersistAsync(
            record,
            selection,
            _ => Task.FromResult<IReadOnlyList<AppRecord>>([selfWithBogusPort]),
            (result, _) => Task.FromResult(result));

        // A freshly allocated automatic port, not the stale self-listed 65000.
        var assignment = Assert.Single(assigned.PortAssignments!);
        Assert.Equal(AppPortSources.Automatic, assignment.Source);
    }

    [Fact]
    public void TryResolvePinnedHostPort_ConsumesPersistedAssignment()
    {
        var app = CreateApp("com.example.notes", []) with
        {
            PortAssignments =
            [
                new AppPortAssignment("app", "http", 4242, AppPortTransports.Tcp, AppPortBindScopes.Loopback, AppPortSources.Automatic, Remappable: true, AssignedAt: DateTimeOffset.UnixEpoch),
            ],
        };

        Assert.True(RuntimePortHelper.TryResolvePinnedHostPort(app, "app", Port("http", containerPort: 8080), "http", out var port));
        Assert.Equal(4242, port);
    }

    [Fact]
    public void TryResolvePinnedHostPort_ServiceScopedOverride_BeatsAppScoped()
    {
        var app = CreateApp("com.example.notes", []) with
        {
            Settings = new Dictionary<string, AppSettingValue>
            {
                ["HOSTY_PORT_HTTP"] = new("HOSTY_PORT_HTTP", "string", "1000", Secret: false),
                ["HOSTY_PORT_APP_HTTP"] = new("HOSTY_PORT_APP_HTTP", "string", "2000", Secret: false),
            },
        };

        Assert.True(RuntimePortHelper.TryResolvePinnedHostPort(app, "app", Port("http", containerPort: 8080), "http", out var port));
        Assert.Equal(2000, port);
    }

    [Fact]
    public async Task ReassignAsync_AllocatesNewPort_UpdatesAssignmentAndEndpointUrl()
    {
        var allocator = new RuntimePortAllocator(CreateConfig());
        var record = CreateApp("com.example.notes",
            [new AppEndpointContract("app.http", "http", "http://127.0.0.1:5000", Public: true, Service: "app", Port: "http")]) with
        {
            PortAssignments =
            [
                new AppPortAssignment("app", "http", 5000, AppPortTransports.Tcp, AppPortBindScopes.Loopback, AppPortSources.Automatic, Remappable: true, AssignedAt: DateTimeOffset.UnixEpoch),
            ],
        };

        AppRecord? persisted = null;
        var (result, oldPort, newPort) = await allocator.ReassignAsync(
            record,
            "app",
            "http",
            _ => Task.FromResult<IReadOnlyList<AppRecord>>([]),
            (updated, _) =>
            {
                persisted = updated;
                return Task.FromResult(updated);
            });

        Assert.Equal(5000, oldPort);
        Assert.NotEqual(5000, newPort);
        Assert.Equal(newPort, Assert.Single(result.PortAssignments!).HostPort);
        Assert.Equal($"http://127.0.0.1:{newPort}", Assert.Single(result.Endpoints).Url);
        Assert.NotNull(persisted);
    }

    [Fact]
    public async Task ReassignAsync_ManualPort_PinsAndWritesOverride()
    {
        var allocator = new RuntimePortAllocator(CreateConfig());
        var record = PinnableApp();

        var (result, oldPort, newPort) = await allocator.ReassignAsync(
            record,
            "app",
            "http",
            _ => Task.FromResult<IReadOnlyList<AppRecord>>([]),
            (updated, _) => Task.FromResult(updated),
            desiredPort: 8123);

        Assert.Equal(5000, oldPort);
        Assert.Equal(8123, newPort);

        // The assignment must stop being remappable, or a later automatic pass could move the port the
        // operator deliberately chose.
        var assignment = Assert.Single(result.PortAssignments!);
        Assert.Equal(8123, assignment.HostPort);
        Assert.Equal(AppPortSources.Operator, assignment.Source);
        Assert.False(assignment.Remappable);

        Assert.Equal("http://127.0.0.1:8123", Assert.Single(result.Endpoints).Url);
        // Written under the service-scoped key, which is what TryResolvePinnedHostPort reads first.
        Assert.Equal("8123", result.Settings[RuntimePortHelper.ServiceScopedOverrideSettingKey("app", "http")].Value);
    }

    [Fact]
    public async Task ReassignAsync_AutomaticAfterPin_ClearsOverrideAndRestoresAutomaticSource()
    {
        var allocator = new RuntimePortAllocator(CreateConfig());
        var scopedKey = RuntimePortHelper.ServiceScopedOverrideSettingKey("app", "http");
        var record = PinnableApp() with
        {
            PortAssignments =
            [
                new AppPortAssignment("app", "http", 8123, AppPortTransports.Tcp, AppPortBindScopes.Loopback, AppPortSources.Operator, Remappable: false, AssignedAt: DateTimeOffset.UnixEpoch),
            ],
            Settings = new Dictionary<string, AppSettingValue>(StringComparer.Ordinal)
            {
                [scopedKey] = new(scopedKey, "string", "8123", Secret: false),
            },
        };

        var (result, oldPort, newPort) = await allocator.ReassignAsync(
            record,
            "app",
            "http",
            _ => Task.FromResult<IReadOnlyList<AppRecord>>([]),
            (updated, _) => Task.FromResult(updated));

        Assert.Equal(8123, oldPort);
        Assert.NotEqual(8123, newPort);

        var assignment = Assert.Single(result.PortAssignments!);
        Assert.Equal(AppPortSources.Automatic, assignment.Source);
        Assert.True(assignment.Remappable);
        // A leftover override would silently re-pin the old port at the next start.
        Assert.False(result.Settings.ContainsKey(scopedKey));
    }

    [Fact]
    public async Task ReassignAsync_ManualPort_MayRePinThePortItAlreadyHolds()
    {
        // Re-pinning the current port must not be judged "in use" by its own listener, so this case skips
        // the bind probe. Bind the port for real to prove the probe is genuinely bypassed.
        using var listener = new System.Net.Sockets.TcpListener(System.Net.IPAddress.Loopback, 0);
        listener.Start();
        var held = ((System.Net.IPEndPoint)listener.LocalEndpoint).Port;

        var allocator = new RuntimePortAllocator(CreateConfig());
        var record = PinnableApp(held);

        var (result, _, newPort) = await allocator.ReassignAsync(
            record,
            "app",
            "http",
            _ => Task.FromResult<IReadOnlyList<AppRecord>>([]),
            (updated, _) => Task.FromResult(updated),
            desiredPort: held);

        Assert.Equal(held, newPort);
        Assert.Equal(AppPortSources.Operator, Assert.Single(result.PortAssignments!).Source);
    }

    [Theory]
    [InlineData(0, "port_out_of_range")]
    [InlineData(70000, "port_out_of_range")]
    [InlineData(80, "port_privileged")]
    [InlineData(1023, "port_privileged")]
    public async Task ReassignAsync_ManualPort_RejectsInvalidPort(int port, string expectedCode)
    {
        var allocator = new RuntimePortAllocator(CreateConfig());

        var error = await Assert.ThrowsAsync<AppLifecycleException>(() => allocator.ReassignAsync(
            PinnableApp(),
            "app",
            "http",
            _ => Task.FromResult<IReadOnlyList<AppRecord>>([]),
            (updated, _) => Task.FromResult(updated),
            desiredPort: port));

        Assert.Equal(expectedCode, error.Code);
    }

    [Fact]
    public async Task ReassignAsync_ManualPort_RejectsPortReservedByAnotherApp_NamingTheHolder()
    {
        var allocator = new RuntimePortAllocator(CreateConfig());
        var other = CreateApp("com.example.other", [Endpoint("app", "http")]) with
        {
            PortAssignments =
            [
                new AppPortAssignment("app", "http", 8200, AppPortTransports.Tcp, AppPortBindScopes.Loopback, AppPortSources.Automatic, Remappable: true, AssignedAt: DateTimeOffset.UnixEpoch),
            ],
        };

        var error = await Assert.ThrowsAsync<AppLifecycleException>(() => allocator.ReassignAsync(
            PinnableApp(),
            "app",
            "http",
            _ => Task.FromResult<IReadOnlyList<AppRecord>>([other]),
            (updated, _) => Task.FromResult(updated),
            desiredPort: 8200));

        Assert.Equal("port_reserved", error.Code);
        // The operator has to know which app to act on, not just that something took the port.
        Assert.Contains("com.example.other", error.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task ReassignAsync_ManualPort_RejectsPortHeldByAnotherProcess()
    {
        using var listener = new System.Net.Sockets.TcpListener(System.Net.IPAddress.Loopback, 0);
        listener.Start();
        var held = ((System.Net.IPEndPoint)listener.LocalEndpoint).Port;

        var allocator = new RuntimePortAllocator(CreateConfig());

        var error = await Assert.ThrowsAsync<AppLifecycleException>(() => allocator.ReassignAsync(
            PinnableApp(),
            "app",
            "http",
            _ => Task.FromResult<IReadOnlyList<AppRecord>>([]),
            (updated, _) => Task.FromResult(updated),
            desiredPort: held));

        Assert.Equal("port_in_use", error.Code);
    }

    private static AppRecord PinnableApp(int currentPort = 5000)
        => CreateApp("com.example.notes",
            [new AppEndpointContract("app.http", "http", $"http://127.0.0.1:{currentPort}", Public: true, Service: "app", Port: "http")]) with
        {
            PortAssignments =
            [
                new AppPortAssignment("app", "http", currentPort, AppPortTransports.Tcp, AppPortBindScopes.Loopback, AppPortSources.Automatic, Remappable: true, AssignedAt: DateTimeOffset.UnixEpoch),
            ],
        };

    [Fact]
    public async Task ReassignAsync_ExcludesAppOwnHostScopeAssignment()
    {
        // A raw-L4 (host-scope) assignment occupies a real host port; the reassigned loopback port must
        // never land on it. Force the automatic pool to a single candidate by reserving everything else so
        // the collision would be guaranteed if the host-scope port were not excluded.
        var allocator = new RuntimePortAllocator(CreateConfig());
        var record = CreateApp("com.example.suite",
            [new AppEndpointContract("api.http", "http", "http://127.0.0.1:5000", Public: true, Service: "api", Port: "http")]) with
        {
            PortAssignments =
            [
                new AppPortAssignment("api", "http", 5000, AppPortTransports.Tcp, AppPortBindScopes.Loopback, AppPortSources.Automatic, Remappable: true, AssignedAt: DateTimeOffset.UnixEpoch),
                new AppPortAssignment("raw", "torrent", 6881, AppPortTransports.Tcp, AppPortBindScopes.Host, AppPortSources.Manifest, Remappable: false, AssignedAt: DateTimeOffset.UnixEpoch),
            ],
        };

        var (result, _, newPort) = await allocator.ReassignAsync(
            record,
            "api",
            "http",
            _ => Task.FromResult<IReadOnlyList<AppRecord>>([]),
            (updated, _) => Task.FromResult(updated));

        Assert.NotEqual(6881, newPort);
        Assert.DoesNotContain(result.PortAssignments!, assignment => assignment.Service == "api" && assignment.HostPort == 6881);
    }

    [Fact]
    public async Task ReassignAsync_ToleratesNullEndpoints()
    {
        // A record deserialized from older/hand-edited state could carry a null Endpoints collection.
        var allocator = new RuntimePortAllocator(CreateConfig());
        var record = CreateApp("com.example.notes", []) with
        {
            Endpoints = null!,
            PortAssignments =
            [
                new AppPortAssignment("app", "http", 5000, AppPortTransports.Tcp, AppPortBindScopes.Loopback, AppPortSources.Automatic, Remappable: true, AssignedAt: DateTimeOffset.UnixEpoch),
            ],
        };

        var (result, oldPort, newPort) = await allocator.ReassignAsync(
            record,
            "app",
            "http",
            _ => Task.FromResult<IReadOnlyList<AppRecord>>([]),
            (updated, _) => Task.FromResult(updated));

        Assert.Equal(5000, oldPort);
        Assert.NotEqual(5000, newPort);
        Assert.Empty(result.Endpoints);
    }

    [Fact]
    public async Task ReassignAsync_UnknownAssignment_Throws()
    {
        var allocator = new RuntimePortAllocator(CreateConfig());
        var record = CreateApp("com.example.notes", []);

        var error = await Assert.ThrowsAsync<AppLifecycleException>(() => allocator.ReassignAsync(
            record,
            "app",
            "http",
            _ => Task.FromResult<IReadOnlyList<AppRecord>>([]),
            (updated, _) => Task.FromResult(updated)));
        Assert.Equal("reassign_not_found", error.Code);
    }

    [Fact]
    public void AllocateLoopbackPort_ExcludesProvidedPorts()
    {
        var first = RuntimePortHelper.AllocateLoopbackPort();
        var second = RuntimePortHelper.AllocateLoopbackPort(new HashSet<int> { first });
        Assert.NotEqual(first, second);
    }

    private const int CorePort = 7070;
    private const int ShellPort = 7171;

    private static HostyCoreRuntimeConfig CreateConfig()
        => new(
            DataRoot: "/tmp/hosty",
            RunDirectory: "/tmp/hosty/core/run",
            ControlDiscoveryPath: "/tmp/hosty/core/run/control.json",
            CorePort: CorePort,
            ListenUrl: $"http://localhost:{CorePort}",
            CorePublicOrigin: null,
            RuntimePublicHost: "127.0.0.1",
            ShellSourceOverridePath: null,
            ShellAutostart: false);

    private static RuntimePortManifest Port(string key, int containerPort, int? localPort = null)
        => new() { Key = key, ContainerPort = containerPort, LocalPort = localPort };

    private static RuntimeSelectedService Service(string key, params RuntimePortManifest[] ports)
        => Service(key, host: false, ports);

    private static RuntimeSelectedService Service(string key, bool host, params RuntimePortManifest[] ports)
        => new(key, [], new RuntimeServiceProfileManifest { Type = "docker", Network = host ? "host" : null, Ports = ports }, null, "image");

    private static RuntimeAppManifestSelection Selection(params RuntimeSelectedService[] services)
    {
        var manifest = new RuntimeAppManifest { SchemaVersion = "app.0.1", Id = "com.example.app", Name = "App", Version = "1.0.0" };
        var profile = new RuntimeProfileManifest { Key = "docker", Type = "docker", Default = true };
        return new RuntimeAppManifestSelection(manifest, "/tmp/manifest.json", "digest", profile, services, null, "{}", null);
    }

    private static AppRecord CreateApp(string id, IReadOnlyList<AppEndpointContract> endpoints)
        => new(
            Id: id,
            DisplayName: "App",
            Description: null,
            Version: "1.0.0",
            Kind: "runtime",
            System: false,
            Source: "installed",
            ManifestPath: null,
            ManifestUrl: null,
            SelectedRuntime: "docker",
            OperationStatus: "installed",
            RuntimeState: "stopped",
            LastOperation: null,
            LastError: null,
            Capabilities: [],
            Settings: new Dictionary<string, AppSettingValue>(),
            StorageMappings: [],
            Dependencies: [],
            Endpoints: endpoints,
            InstalledAt: DateTimeOffset.UtcNow,
            UpdatedAt: DateTimeOffset.UtcNow);

    private static AppEndpointContract Endpoint(string service, string port)
        => new($"{service}.{port}", "http", Url: null, Public: true, Service: service, Port: port);
}
