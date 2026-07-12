namespace Haas.Hosty.Core.Tests;

// Merge semantics of the generic bootstrap: distribution defaults, operator choices, and the
// deprecated legacy env layer. Pure unit tests over SystemAppBootstraps.FromDistribution.
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
        var plan = SystemAppBootstraps.FromDistribution([Shell, Telemetry, Marketplace], choices: null, CreateConfig());

        Assert.Collection(
            plan.Descriptors,
            shell => Assert.True(shell.Enabled),
            telemetry => Assert.False(telemetry.Enabled),
            marketplace => Assert.True(marketplace.Enabled));
        Assert.Empty(plan.Warnings);
    }

    [Fact]
    public void FromDistribution_ChoicesOutrankDefaultsAndLegacy()
    {
        var choices = new BootstrapChoicesDocument
        {
            SchemaVersion = BootstrapChoicesSchema.Version,
            Apps = new Dictionary<string, BootstrapChoiceEntry>(StringComparer.Ordinal)
            {
                ["hosty.telemetry"] = new() { Enabled = true },
                ["hosty.marketplace"] = new() { Enabled = false },
            },
        };
        var config = CreateConfig() with
        {
            // Legacy says telemetry off; the explicit choice must still win.
            Legacy = new LegacyBootstrapEnv(ObservabilityEnabled: false),
        };

        var plan = SystemAppBootstraps.FromDistribution([Shell, Telemetry, Marketplace], choices, config);

        Assert.True(plan.Descriptors.Single(d => d.AppId == "hosty.telemetry").Enabled);
        Assert.False(plan.Descriptors.Single(d => d.AppId == "hosty.marketplace").Enabled);
    }

    [Fact]
    public void FromDistribution_LegacyEnablementFillsBetweenChoicesAndDefaults()
    {
        var config = CreateConfig() with
        {
            Legacy = new LegacyBootstrapEnv(
                ShellBootstrapEnabled: false,
                ObservabilityEnabled: true),
        };

        var plan = SystemAppBootstraps.FromDistribution([Shell, Telemetry], choices: null, config);

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

        var plan = SystemAppBootstraps.FromDistribution([Marketplace], choices: null, config);

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

        var plan = SystemAppBootstraps.FromDistribution([Shell, Telemetry], choices: null, config);

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

        var plan = SystemAppBootstraps.FromDistribution([Shell, Telemetry, Marketplace], choices: null, config);

        var shell = plan.Descriptors.Single(d => d.AppId == "hosty.shell");
        Assert.Equal("docker", shell.Runtime);
        Assert.False(shell.Autostart);
        Assert.Equal("/repo", shell.SourceOverridePath);
        Assert.NotNull(shell.Settings);
        Assert.Equal("3000", shell.Settings!["HOSTY_PORT_HTTP"]);

        var telemetry = plan.Descriptors.Single(d => d.AppId == "hosty.telemetry");
        Assert.NotNull(telemetry.ProvisionAsync);
        Assert.Equal("docker", telemetry.Runtime);

        // Policy-free entry: manifest defaults on first install, installed choices preserved later.
        var marketplace = plan.Descriptors.Single(d => d.AppId == "hosty.marketplace");
        Assert.Null(marketplace.Runtime);
        Assert.Null(marketplace.Autostart);
        Assert.Null(marketplace.ProvisionAsync);
    }

    [Fact]
    public void FromDistribution_FeedsUrlFlowsToDescriptor()
    {
        var entry = Marketplace with { FeedsUrl = "https://example.test/marketplace/feeds.json" };

        var plan = SystemAppBootstraps.FromDistribution([entry], choices: null, CreateConfig());

        Assert.Equal("https://example.test/marketplace/feeds.json", plan.Descriptors.Single().FeedsUrl);
    }

    [Fact]
    public void FromDistribution_UnknownChoiceIsInertWithWarning()
    {
        var choices = new BootstrapChoicesDocument
        {
            SchemaVersion = BootstrapChoicesSchema.Version,
            Apps = new Dictionary<string, BootstrapChoiceEntry>(StringComparer.Ordinal)
            {
                ["hosty.retired-app"] = new() { Enabled = true },
            },
        };

        var plan = SystemAppBootstraps.FromDistribution([Shell], choices, CreateConfig());

        Assert.Single(plan.Descriptors);
        var warning = Assert.Single(plan.Warnings);
        Assert.Contains("hosty.retired-app", warning);
        Assert.Contains("inert", warning);
    }

    private static HostyCoreRuntimeConfig CreateConfig()
        => new(
            DataRoot: "/tmp/hosty-tests",
            RunDirectory: "/tmp/hosty-tests/core/run",
            ControlDiscoveryPath: "/tmp/hosty-tests/core/run/control.json",
            CorePort: 3001,
            ShellPort: 3000,
            ListenUrl: "http://127.0.0.1:3001",
            CorePublicOrigin: "http://127.0.0.1:3001",
            ShellPublicOrigin: "http://127.0.0.1:3000",
            RuntimePublicHost: "localhost",
            ShellBootstrapRuntime: "docker",
            ShellSourceOverridePath: null,
            ShellAutostart: false);
}
