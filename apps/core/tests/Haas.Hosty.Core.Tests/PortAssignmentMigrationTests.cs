using Haas.Hosty.Core;

namespace Haas.Hosty.Core.Tests;

public sealed class PortAssignmentMigrationTests
{
    [Fact]
    public void DeriveAssignments_FromStartedEndpointUrl_CreatesLoopbackTcpAutomaticAssignment()
    {
        var app = CreateApp("com.example.notes") with
        {
            Endpoints = [new AppEndpointContract("app.http", "http", "http://localhost:3100", Public: true, Service: "app", Port: "http")],
        };

        var migrated = PortAssignmentMigration.DeriveAssignments(app);

        Assert.NotNull(migrated);
        var assignment = Assert.Single(migrated!.PortAssignments!);
        Assert.Equal("app", assignment.Service);
        Assert.Equal("http", assignment.PortKey);
        Assert.Equal(3100, assignment.HostPort);
        Assert.Equal(AppPortTransports.Tcp, assignment.Transport);
        Assert.Equal(AppPortBindScopes.Loopback, assignment.BindScope);
        Assert.Equal(AppPortSources.Automatic, assignment.Source);
        Assert.True(assignment.Remappable);
    }

    [Fact]
    public void DeriveAssignments_MultiServiceRepeatedPortKey_CreatesDistinctAssignments()
    {
        // Two services both declaring the service-local key `http` — the exact case the app-scoped
        // HOSTY_PORT_HTTP override cannot represent. They must resolve to distinct service-scoped
        // assignments keyed by (service, portKey), each preserving its own started port.
        var app = CreateApp("com.example.suite") with
        {
            Endpoints =
            [
                new AppEndpointContract("api.http", "http", "http://localhost:4001", Public: false, Service: "api", Port: "http"),
                new AppEndpointContract("web.http", "http", "http://localhost:4002", Public: true, Service: "web", Port: "http"),
            ],
        };

        var migrated = PortAssignmentMigration.DeriveAssignments(app);

        Assert.NotNull(migrated);
        Assert.Equal(2, migrated!.PortAssignments!.Count);
        Assert.Equal(4001, Assert.Single(migrated.PortAssignments, a => a.Service == "api").HostPort);
        Assert.Equal(4002, Assert.Single(migrated.PortAssignments, a => a.Service == "web").HostPort);
    }

    [Fact]
    public void DeriveAssignments_NeverStartedApp_ReturnsNull()
    {
        // Endpoints with no resolved URL have never been started; phase 1 does not allocate, so there is
        // nothing to migrate and the record is left untouched (no state.json rewrite on boot).
        var app = CreateApp("com.example.notes") with
        {
            Endpoints = [new AppEndpointContract("app.http", "http", Url: null, Public: true, Service: "app", Port: "http")],
        };

        Assert.Null(PortAssignmentMigration.DeriveAssignments(app));
    }

    [Fact]
    public void DeriveAssignments_IsIdempotent()
    {
        var app = CreateApp("com.example.notes") with
        {
            Endpoints = [new AppEndpointContract("app.http", "http", "http://localhost:3100", Public: true, Service: "app", Port: "http")],
        };

        var first = PortAssignmentMigration.DeriveAssignments(app);
        Assert.NotNull(first);

        // A second pass over the already-migrated record yields no delta.
        Assert.Null(PortAssignmentMigration.DeriveAssignments(first!));
    }

    [Fact]
    public void DeriveAssignments_OperatorOverride_ClassifiesSourceAsOperatorAndNotRemappable()
    {
        var app = CreateApp("com.example.notes") with
        {
            Settings = new Dictionary<string, AppSettingValue>
            {
                ["HOSTY_PORT_HTTP"] = new("HOSTY_PORT_HTTP", "string", "3100", Secret: false),
            },
            Endpoints = [new AppEndpointContract("app.http", "http", "http://localhost:3100", Public: true, Service: "app", Port: "http")],
        };

        var assignment = Assert.Single(PortAssignmentMigration.DeriveAssignments(app)!.PortAssignments!);
        Assert.Equal(AppPortSources.Operator, assignment.Source);
        Assert.False(assignment.Remappable);
    }

    [Fact]
    public void DeriveAssignments_PreservesExistingAssignmentsAndAddsMissing()
    {
        var existing = new AppPortAssignment("api", "http", 4001, AppPortTransports.Tcp, AppPortBindScopes.Loopback, AppPortSources.Automatic, Remappable: true, AssignedAt: DateTimeOffset.UnixEpoch);
        var app = CreateApp("com.example.suite") with
        {
            PortAssignments = [existing],
            Endpoints =
            [
                new AppEndpointContract("api.http", "http", "http://localhost:4001", Public: false, Service: "api", Port: "http"),
                new AppEndpointContract("web.http", "http", "http://localhost:4002", Public: true, Service: "web", Port: "http"),
            ],
        };

        var migrated = PortAssignmentMigration.DeriveAssignments(app);

        Assert.NotNull(migrated);
        Assert.Equal(2, migrated!.PortAssignments!.Count);
        // The pre-existing assignment is preserved verbatim, including its original timestamp.
        var preserved = Assert.Single(migrated.PortAssignments, a => a.Service == "api");
        Assert.Equal(DateTimeOffset.UnixEpoch, preserved.AssignedAt);
        Assert.Equal(4002, Assert.Single(migrated.PortAssignments, a => a.Service == "web").HostPort);
    }

    [Fact]
    public void DeriveAssignments_EndpointWithoutServiceOrPortKey_IsSkipped()
    {
        // A very old endpoint record predates the service/port keys; it keeps working via its URL but
        // cannot be keyed into a service-scoped reservation, so it is left for a later rebuild.
        var app = CreateApp("com.example.legacy") with
        {
            Endpoints = [new AppEndpointContract("http", "http", "http://localhost:3100", Public: true)],
        };

        Assert.Null(PortAssignmentMigration.DeriveAssignments(app));
    }

    private static AppRecord CreateApp(string id)
        => new(
            Id: id,
            DisplayName: "Notes",
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
            Endpoints: [],
            InstalledAt: DateTimeOffset.UtcNow,
            UpdatedAt: DateTimeOffset.UtcNow);
}
