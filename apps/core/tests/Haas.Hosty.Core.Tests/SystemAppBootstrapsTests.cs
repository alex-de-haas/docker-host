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
        // Runtime is a normal per-app choice now (manifest default on first install, switch-runtime
        // afterwards): null for every entry, including Shell. Shell still carries the Core-owned
        // autostart, source-override, and settings extras.
        Assert.Null(shell.Runtime);
        Assert.False(shell.Autostart);
        Assert.Equal("/repo", shell.SourceOverridePath);
        Assert.NotNull(shell.Settings);
        Assert.Equal("3000", shell.Settings!["HOSTY_PORT_HTTP"]);

        var telemetry = plan.Descriptors.Single(d => d.AppId == "hosty.telemetry");
        Assert.Null(telemetry.Runtime);

        var marketplace = plan.Descriptors.Single(d => d.AppId == "hosty.marketplace");
        Assert.Null(marketplace.Runtime);
        Assert.Null(marketplace.Autostart);
    }

    [Fact]
    public void FromDistribution_ShellDescriptorRetiresHostnameInsteadOfStampingIt()
    {
        // HOSTNAME was stamped from the Shell public origin's host but never reached the container: the
        // manifest declares HOSTNAME=0.0.0.0 as the Next.js bind address and its environment is appended
        // after the settings, so docker's last-wins duplicate handling always kept the bind address. It
        // only ever showed up as a settings row that looked like it controlled the public origin.
        var config = CreateConfig() with { ShellPublicOrigin = "https://shell.example.test" };

        var plan = SystemAppBootstraps.FromDistribution([Shell], choices: null, config);

        var shell = plan.Descriptors.Single(d => d.AppId == "hosty.shell");
        Assert.DoesNotContain("HOSTNAME", shell.Settings!.Keys);
        Assert.Contains("HOSTNAME", shell.RetiredSettings!);
    }

    [Fact]
    public void FromDistribution_CarriesTheLegacyShellOriginIntoThePublicOriginSetting()
    {
        // HOSTY_SHELL_PUBLIC_ORIGIN used to be read straight by Core's auth flow, which made it a second,
        // invisible source of truth beside the Public Origins the operator can actually see and edit.
        // Core resolves Shell's origin from the app record now, so the legacy value is carried into that
        // record — existing hosts keep behaving identically and the effective value finally shows in the UI.
        var config = CreateConfig() with { ShellPublicOrigin = "https://shell.example.test" };

        var plan = SystemAppBootstraps.FromDistribution([Shell], choices: null, config);

        var shell = plan.Descriptors.Single(d => d.AppId == "hosty.shell");
        Assert.Equal("https://shell.example.test", shell.Settings!["HOSTY_PUBLIC_ORIGIN_WEB"]);
    }

    [Fact]
    public void FromDistribution_WithoutTheLegacyShellOriginStampsNoPublicOrigin()
    {
        // Nothing to carry: the setting stays the operator's own, resolved from the record (or absent, in
        // which case Core falls back to the loopback URL it assigned Shell).
        var plan = SystemAppBootstraps.FromDistribution([Shell], choices: null, CreateConfig() with { ShellPublicOrigin = null });

        var shell = plan.Descriptors.Single(d => d.AppId == "hosty.shell");
        Assert.DoesNotContain("HOSTY_PUBLIC_ORIGIN_WEB", shell.Settings!.Keys);
    }

    [Fact]
    public void FromDistribution_AmbientRuntimeOverridePinsShellAndCollectorDescriptors()
    {
        // The ambient dev/fork override (HOSTY_SHELL_BOOTSTRAP_RUNTIME / HOSTY_COLLECTOR_BOOTSTRAP_RUNTIME)
        // pins the descriptor runtime; unset (null) leaves the profile to the manifest default.
        var config = CreateConfig() with { ShellBootstrapRuntime = "dev", CollectorBootstrapRuntime = "podman" };

        var plan = SystemAppBootstraps.FromDistribution([Shell, Telemetry, Marketplace], choices: null, config);

        Assert.Equal("dev", plan.Descriptors.Single(d => d.AppId == "hosty.shell").Runtime);
        Assert.Equal("podman", plan.Descriptors.Single(d => d.AppId == "hosty.telemetry").Runtime);
        // Marketplace carries no Core-owned runtime policy either way.
        Assert.Null(plan.Descriptors.Single(d => d.AppId == "hosty.marketplace").Runtime);
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
            ShellSourceOverridePath: null,
            ShellAutostart: false);
}
