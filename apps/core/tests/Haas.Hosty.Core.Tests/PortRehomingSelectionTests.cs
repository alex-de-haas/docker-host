using Haas.Hosty.Core;

namespace Haas.Hosty.Core.Tests;

// Which reservations the boot rehoming pass is allowed to move off the OS dynamic range. The pass itself
// (allocation, persistence, running-app skip) is exercised end to end in CoreLifecycleServiceTests.
public sealed class PortRehomingSelectionTests
{
    [Fact]
    public void FindOsAllocatedAssignments_AutomaticPortInDynamicRange_IsSelected()
    {
        // The shape that broke on Windows: an automatic reservation the OS handed out for a port-0 bind,
        // which the OS may hand to another process at any time.
        var app = CreateApp(Assignment(52306));

        var target = Assert.Single(CoreLifecycleService.FindOsAllocatedAssignments(app));

        Assert.Equal(52306, target.HostPort);
    }

    [Fact]
    public void FindOsAllocatedAssignments_PortInsideTheBand_IsLeftAlone()
    {
        // Already rehomed (or allocated by 0.76.0+). Moving it again would churn endpoint URLs on every
        // boot for no reason, so the pass must be idempotent by selection, not just by outcome.
        var app = CreateApp(Assignment(25000));

        Assert.Empty(CoreLifecycleService.FindOsAllocatedAssignments(app));
    }

    [Theory]
    [InlineData(AppPortSources.Operator)]
    [InlineData(AppPortSources.Manifest)]
    public void FindOsAllocatedAssignments_DeliberatePort_IsLeftAlone(string source)
    {
        // An operator pin and a manifest-declared port are somebody's choice. Sitting in the dynamic range
        // does not make either of them Core's to overrule — the operator may have a firewall rule on it.
        var app = CreateApp(Assignment(52306, source: source, remappable: false));

        Assert.Empty(CoreLifecycleService.FindOsAllocatedAssignments(app));
    }

    [Fact]
    public void FindOsAllocatedAssignments_HostNetworkPort_IsLeftAlone()
    {
        // A host-network port binds a fixed container port in another namespace; it was never allocated
        // and there is nothing to move it to.
        var app = CreateApp(Assignment(52306, bindScope: AppPortBindScopes.HostNetwork, source: AppPortSources.HostNetwork, remappable: false));

        Assert.Empty(CoreLifecycleService.FindOsAllocatedAssignments(app));
    }

    [Fact]
    public void FindOsAllocatedAssignments_AssignmentShadowedByAnOverride_IsLeftAlone()
    {
        // The configure path can write a HOSTY_PORT_* value without re-reserving, leaving an assignment
        // still classified `automatic` while start actually resolves the override. Rehoming the assignment
        // would move the record and change nothing about the port the app binds.
        var app = CreateApp(Assignment(52306)) with
        {
            Settings = new Dictionary<string, AppSettingValue>(StringComparer.Ordinal)
            {
                ["HOSTY_PORT_APP_HTTP"] = new("HOSTY_PORT_APP_HTTP", "string", "52306", Secret: false),
            },
        };

        Assert.Empty(CoreLifecycleService.FindOsAllocatedAssignments(app));
    }

    [Fact]
    public void FindOsAllocatedAssignments_SeveralTargets_AreOrderedByServiceThenPortKey()
    {
        // The pass moves one port per round and re-reads between rounds, so a stable order keeps the log
        // (and any partial run) predictable.
        var app = CreateApp(
            Assignment(52306, service: "web"),
            Assignment(52307, service: "api", portKey: "metrics"),
            Assignment(52308, service: "api"));

        var targets = CoreLifecycleService.FindOsAllocatedAssignments(app);

        Assert.Equal(["api", "api", "web"], targets.Select(target => target.Service));
        Assert.Equal(["http", "metrics", "http"], targets.Select(target => target.PortKey));
    }

    private static AppPortAssignment Assignment(
        int hostPort,
        string service = "app",
        string portKey = "http",
        string? bindScope = null,
        string? source = null,
        bool remappable = true)
        => new(
            Service: service,
            PortKey: portKey,
            HostPort: hostPort,
            Transport: AppPortTransports.Tcp,
            BindScope: bindScope ?? AppPortBindScopes.Loopback,
            Source: source ?? AppPortSources.Automatic,
            Remappable: remappable,
            AssignedAt: DateTimeOffset.UnixEpoch);

    private static AppRecord CreateApp(params AppPortAssignment[] assignments)
        => new(
            Id: "com.example.notes",
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
            UpdatedAt: DateTimeOffset.UtcNow)
        {
            PortAssignments = assignments,
        };
}
