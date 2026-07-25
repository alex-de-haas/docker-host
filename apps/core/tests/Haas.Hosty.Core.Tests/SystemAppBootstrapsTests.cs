namespace Haas.Hosty.Core.Tests;

// How a distribution entry resolves into a descriptor: release defaults and the deprecated legacy env
// layer. Enablement here only decides what a fresh host seeds. Pure unit tests over
// SystemAppBootstraps.FromDistribution.
public sealed class SystemAppBootstrapsTests
{
    private static readonly DistributionAppEntry Shell = new(
        "hosty.shell", "Hosty Shell", null, "/dist/apps/shell/manifest.json", null, DefaultEnabled: true);

    private static readonly DistributionAppEntry Telemetry = new(
        "hosty.telemetry", "Telemetry", null, "/dist/apps/telemetry/manifest.json", null, DefaultEnabled: false);

    private static readonly DistributionAppEntry Marketplace = new(
        "hosty.marketplace", "Marketplace", null, "https://example.test/marketplace/manifest.json", null, DefaultEnabled: true);

    [Fact]
    public void FromDistribution_DefaultEnabledDrivesDescriptors()
    {
        var plan = SystemAppBootstraps.FromDistribution([Shell, Telemetry, Marketplace], CreateConfig());

        Assert.Collection(
            plan.Descriptors,
            shell => Assert.True(shell.Enabled),
            telemetry => Assert.False(telemetry.Enabled),
            marketplace => Assert.True(marketplace.Enabled));
        Assert.Empty(plan.Warnings);
    }

    [Fact]
    public void FromDistribution_LegacyEnablementOverridesDefaults()
    {
        var config = CreateConfig() with
        {
            Legacy = new LegacyBootstrapEnv(
                ShellBootstrapEnabled: false,
                ObservabilityEnabled: true),
        };

        var plan = SystemAppBootstraps.FromDistribution([Shell, Telemetry], config);

        Assert.False(plan.Descriptors.Single(d => d.AppId == "hosty.shell").Enabled);
        Assert.True(plan.Descriptors.Single(d => d.AppId == "hosty.telemetry").Enabled);
    }

    [Fact]
    public void FromDistribution_ExplicitlyEmptyMarketplacePathDisablesEntry()
    {
        var config = CreateConfig() with
        {
            Legacy = new LegacyBootstrapEnv(
                MarketplaceManifestPath: null,
                MarketplaceManifestPathConfigured: true),
        };

        var plan = SystemAppBootstraps.FromDistribution([Marketplace], config);

        Assert.False(plan.Descriptors.Single().Enabled);
    }

    [Fact]
    public void FromDistribution_LegacyManifestOverrideWarnsOnlyWhenDifferent()
    {
        var config = CreateConfig() with
        {
            Legacy = new LegacyBootstrapEnv(
                ShellManifestPath: Shell.ManifestRef,
                CollectorManifestPath: "/elsewhere/collector-manifest.json"),
        };

        var plan = SystemAppBootstraps.FromDistribution([Shell, Telemetry], config);

        // Matching value (the CLI still injects its defaults) is not operator intent: entry wins, silently.
        Assert.Equal(Shell.ManifestRef, plan.Descriptors.Single(d => d.AppId == "hosty.shell").ManifestPath);
        // A differing value is an explicit override: honored, loudly deprecated.
        Assert.Equal("/elsewhere/collector-manifest.json", plan.Descriptors.Single(d => d.AppId == "hosty.telemetry").ManifestPath);
        var warning = Assert.Single(plan.Warnings);
        Assert.Contains("HOSTY_COLLECTOR_MANIFEST_PATH", warning);
        Assert.Contains("deprecated", warning);
    }

    [Fact]
    public void FromDistribution_AttachesShellPolicyAndCollectorProvisioning()
    {
        var config = CreateConfig() with { ShellSourceOverridePath = "/repo" };

        var plan = SystemAppBootstraps.FromDistribution([Shell, Telemetry, Marketplace], config);

        var shell = plan.Descriptors.Single(d => d.AppId == "hosty.shell");
        // Runtime is a normal per-app choice now (manifest default on first install, switch-runtime
        // afterwards): null for every entry, including Shell. Shell still carries the Core-owned
        // autostart, source-override, and settings extras.
        Assert.Null(shell.Runtime);
        Assert.False(shell.Autostart);
        Assert.Equal("/repo", shell.SourceOverridePath);
        // No Core-owned settings any more: Shell's port is declared in its own manifest, and its public
        // origin lives in its app record, like every other app's.
        Assert.Null(shell.Settings);

        var telemetry = plan.Descriptors.Single(d => d.AppId == "hosty.telemetry");
        Assert.Null(telemetry.Runtime);

        var marketplace = plan.Descriptors.Single(d => d.AppId == "hosty.marketplace");
        Assert.Null(marketplace.Runtime);
        Assert.Null(marketplace.Autostart);
    }

    [Fact]
    public void FromDistribution_AmbientRuntimeOverridePinsShellAndCollectorDescriptors()
    {
        // The ambient dev/fork override (HOSTY_SHELL_BOOTSTRAP_RUNTIME / HOSTY_COLLECTOR_BOOTSTRAP_RUNTIME)
        // pins the descriptor runtime; unset (null) leaves the profile to the manifest default.
        var config = CreateConfig() with { ShellBootstrapRuntime = "dev", CollectorBootstrapRuntime = "podman" };

        var plan = SystemAppBootstraps.FromDistribution([Shell, Telemetry, Marketplace], config);

        Assert.Equal("dev", plan.Descriptors.Single(d => d.AppId == "hosty.shell").Runtime);
        Assert.Equal("podman", plan.Descriptors.Single(d => d.AppId == "hosty.telemetry").Runtime);
        // Marketplace carries no Core-owned runtime policy either way.
        Assert.Null(plan.Descriptors.Single(d => d.AppId == "hosty.marketplace").Runtime);
    }

    [Fact]
    public void FromDistribution_FeedsUrlFlowsToDescriptor()
    {
        var entry = Marketplace with { FeedsUrl = "https://example.test/marketplace/feeds.json" };

        var plan = SystemAppBootstraps.FromDistribution([entry], CreateConfig());

        Assert.Equal("https://example.test/marketplace/feeds.json", plan.Descriptors.Single().FeedsUrl);
    }

    private static HostyCoreRuntimeConfig CreateConfig()
        => new(
            DataRoot: "/tmp/hosty-tests",
            RunDirectory: "/tmp/hosty-tests/core/run",
            ControlDiscoveryPath: "/tmp/hosty-tests/core/run/control.json",
            CorePort: 3001,
            ListenUrl: "http://127.0.0.1:3001",
            CorePublicOrigin: "http://127.0.0.1:3001",
            RuntimePublicHost: "localhost",
            ShellSourceOverridePath: null,
            ShellAutostart: false);
}
