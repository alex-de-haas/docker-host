using Haas.Hosty.Core;
using Microsoft.Extensions.Logging.Abstractions;

namespace Haas.Hosty.Core.Tests;

// The single ingress controller reads its provider/domain/tunnel from the live CoreSettingsService and
// folds the old "none" behavior in: it must no-op unless the provider is cloudflared and complete.
public sealed class CloudflaredIngressControllerTests : IDisposable
{
    private readonly string root = Path.Combine(Path.GetTempPath(), $"hosty-ingress-controller-tests-{Guid.NewGuid():N}");

    private CoreDataPaths Paths => new(
        DataRoot: root,
        CoreRoot: Path.Combine(root, "core"),
        AppsRoot: Path.Combine(root, "apps"),
        BackupsRoot: Path.Combine(root, "backups"),
        SourcesRoot: Path.Combine(root, "sources"),
        AuthRoot: Path.Combine(root, "core", "auth"),
        AuditLogPath: Path.Combine(root, "core", "audit", "audit.ndjson"));

    private string ConfigPath => Path.Combine(root, "core", "ingress", "config.yml");

    private HostyCoreRuntimeConfig Config => new(
        DataRoot: root,
        RunDirectory: Path.Combine(root, "core", "run"),
        ControlDiscoveryPath: Path.Combine(root, "core", "run", "control.json"),
        CorePort: 7070,
        ListenUrl: "http://127.0.0.1:7070",
        CorePublicOrigin: null,
        RuntimePublicHost: "127.0.0.1",
        ShellSourceOverridePath: null,
        ShellAutostart: false,
        IngressConfigPath: ConfigPath);

    private CoreSettingsService CreateSettings() => new(new CoreSettingsStore(Paths, NullLogger<CoreSettingsStore>.Instance));

    private CloudflaredIngressController CreateController(CoreSettingsService settings)
        => new(settings, Config, NullLogger<CloudflaredIngressController>.Instance);

    // A cloudflared controller with a complete provider configuration, ready to render routes.
    private async Task<CloudflaredIngressController> CreateConfiguredControllerAsync()
    {
        var settings = CreateSettings();
        await settings.UpdateAsync(new Dictionary<string, string?>
        {
            ["HOSTY_INGRESS_PROVIDER"] = "cloudflared",
            ["HOSTY_INGRESS_BASE_DOMAIN"] = "apps.example.test",
            ["HOSTY_INGRESS_TUNNEL_ID"] = "tunnel-abc",
            ["HOSTY_INGRESS_CREDENTIALS_FILE"] = Path.Combine(root, "creds.json"),
        });
        return CreateController(settings);
    }

    private static AppRecord AppWithPublicEndpoint(string appId, string? url, string runtimeState)
        => new(
            Id: appId,
            DisplayName: appId,
            Description: null,
            Version: "1.0.0",
            Kind: "runtime",
            System: false,
            Source: "installed",
            ManifestPath: null,
            ManifestUrl: null,
            SelectedRuntime: "docker",
            OperationStatus: "installed",
            RuntimeState: runtimeState,
            LastOperation: null,
            LastError: null,
            Capabilities: [],
            Settings: new Dictionary<string, AppSettingValue>(),
            StorageMappings: [],
            Dependencies: [],
            Endpoints: [new AppEndpointContract($"{appId}.http", "http", url, Public: true, Service: "app", Port: "http")],
            InstalledAt: DateTimeOffset.UtcNow,
            UpdatedAt: DateTimeOffset.UtcNow);

    [Fact]
    public async Task ProviderNone_DoesNotManageOriginsOrWriteConfig()
    {
        var settings = CreateSettings();
        var controller = CreateController(settings);

        Assert.False(controller.DerivesPublicOrigins);
        Assert.Empty(controller.ResolvePublicOrigins("pm", subdomainOverride: null, ["http"]));

        await controller.ReconcileAsync([]);
        Assert.False(File.Exists(ConfigPath));
    }

    [Fact]
    public async Task ProviderCloudflaredComplete_DerivesOriginsAndWritesConfig()
    {
        var settings = CreateSettings();
        await settings.UpdateAsync(new Dictionary<string, string?>
        {
            ["HOSTY_INGRESS_PROVIDER"] = "cloudflared",
            ["HOSTY_INGRESS_BASE_DOMAIN"] = "apps.example.test",
            ["HOSTY_INGRESS_TUNNEL_ID"] = "tunnel-abc",
            ["HOSTY_INGRESS_CREDENTIALS_FILE"] = Path.Combine(root, "creds.json"),
        });
        var controller = CreateController(settings);

        Assert.True(controller.DerivesPublicOrigins);
        var origins = controller.ResolvePublicOrigins("pm", subdomainOverride: null, ["http"]);
        Assert.Equal("https://pm.apps.example.test", origins["HOSTY_PUBLIC_ORIGIN_HTTP"]);

        // Even with no running apps, the Core seed + catch-all produce a config.yml.
        await controller.ReconcileAsync([]);
        Assert.True(File.Exists(ConfigPath));
        var yaml = await File.ReadAllTextAsync(ConfigPath);
        Assert.Contains("core.apps.example.test", yaml);
        Assert.Contains("tunnel-abc", yaml);
    }

    [Theory]
    [InlineData(AppRuntimeStates.Running)]
    [InlineData(AppRuntimeStates.Stopped)]
    public async Task ReconcileAsync_RoutesAnInstalledApp_WhateverItsRuntimeState(string runtimeState)
    {
        // A public origin is a durable property of an endpoint, not of a process: the port is reserved
        // at install and the endpoint URL is projected onto a stopped app. Routing only what was up
        // rewrote this file on every start and stop, and made a stopped app's hostname answer 404 as
        // if it did not exist. It now answers 502 from a route that is always present.
        var controller = await CreateConfiguredControllerAsync();

        await controller.ReconcileAsync([AppWithPublicEndpoint("pm", "http://127.0.0.1:24001", runtimeState)]);

        var yaml = await File.ReadAllTextAsync(ConfigPath);
        Assert.Contains("hostname: pm.apps.example.test", yaml, StringComparison.Ordinal);
        Assert.Contains("http://127.0.0.1:24001", yaml, StringComparison.Ordinal);
    }

    [Fact]
    public async Task ReconcileAsync_StartAndStopOfTheSameApp_ProduceIdenticalConfigs()
    {
        // The churn this removes: two reconciles that differ only in runtime state must render the
        // same bytes, so an ordinary lifecycle change no longer rewrites the file cloudflared watches.
        var controller = await CreateConfiguredControllerAsync();

        await controller.ReconcileAsync([AppWithPublicEndpoint("pm", "http://127.0.0.1:24001", AppRuntimeStates.Running)]);
        var whileRunning = await File.ReadAllTextAsync(ConfigPath);
        await controller.ReconcileAsync([AppWithPublicEndpoint("pm", "http://127.0.0.1:24001", AppRuntimeStates.Stopped)]);

        Assert.Equal(whileRunning, await File.ReadAllTextAsync(ConfigPath));
    }

    [Fact]
    public async Task ReconcileAsync_EndpointWithNoResolvedUrl_IsSkipped()
    {
        // Reachable for a port key that first appears in an update: it gets no install-time
        // reservation, so it carries no URL until the app's next start. There is nothing to route to.
        var controller = await CreateConfiguredControllerAsync();

        await controller.ReconcileAsync([AppWithPublicEndpoint("pm", url: null, AppRuntimeStates.Stopped)]);

        var yaml = await File.ReadAllTextAsync(ConfigPath);
        Assert.DoesNotContain("pm.apps.example.test", yaml, StringComparison.Ordinal);
    }

    [Fact]
    public async Task ProviderCloudflareRemote_NeitherDerivesOriginsNorWritesConfig()
    {
        // The API provider owns origins through publication. If this controller also derived them, the
        // next start of a published app would overwrite the operator's label with {app}.{baseDomain} —
        // the defect the provider split exists to remove. A base domain left over from an earlier
        // local-config setup must not resurrect that.
        var settings = CreateSettings();
        await settings.UpdateAsync(new Dictionary<string, string?>
        {
            ["HOSTY_INGRESS_PROVIDER"] = IngressSettings.ProviderCloudflareRemote,
            ["HOSTY_INGRESS_BASE_DOMAIN"] = "apps.example.test",
            ["HOSTY_INGRESS_TUNNEL_ID"] = "tunnel-abc",
            ["HOSTY_INGRESS_CREDENTIALS_FILE"] = Path.Combine(root, "creds.json"),
        });
        var controller = CreateController(settings);

        Assert.False(controller.DerivesPublicOrigins);
        Assert.Empty(controller.ResolvePublicOrigins("pm", subdomainOverride: null, ["http"]));

        await controller.ReconcileAsync([]);
        Assert.False(File.Exists(ConfigPath));
    }

    [Fact]
    public async Task SwitchingFromCloudflaredToCloudflareRemote_RemovesTheManagedConfig()
    {
        // Switching provider must actually stop the local tunnel serving its routes, not just stop
        // updating the file an operator-run cloudflared is still reading.
        var settings = CreateSettings();
        await settings.UpdateAsync(new Dictionary<string, string?>
        {
            ["HOSTY_INGRESS_PROVIDER"] = "cloudflared",
            ["HOSTY_INGRESS_BASE_DOMAIN"] = "apps.example.test",
            ["HOSTY_INGRESS_TUNNEL_ID"] = "tunnel-abc",
            ["HOSTY_INGRESS_CREDENTIALS_FILE"] = Path.Combine(root, "creds.json"),
        });
        var controller = CreateController(settings);
        await controller.ReconcileAsync([]);
        Assert.True(File.Exists(ConfigPath));

        await settings.UpdateAsync(new Dictionary<string, string?>
        {
            ["HOSTY_INGRESS_PROVIDER"] = IngressSettings.ProviderCloudflareRemote,
        });
        await controller.ReconcileAsync([]);

        Assert.False(File.Exists(ConfigPath));
    }

    [Fact]
    public async Task ProviderCloudflaredMissingTunnel_DoesNotWriteConfig()
    {
        var settings = CreateSettings();
        await settings.UpdateAsync(new Dictionary<string, string?>
        {
            ["HOSTY_INGRESS_PROVIDER"] = "cloudflared",
            ["HOSTY_INGRESS_BASE_DOMAIN"] = "apps.example.test",
            // No tunnel ID / credentials file: incomplete config must not emit a broken file.
        });
        var controller = CreateController(settings);

        Assert.True(controller.DerivesPublicOrigins); // derives origins, but won't render a half config
        await controller.ReconcileAsync([]);
        Assert.False(File.Exists(ConfigPath));
    }

    [Fact]
    public async Task DisablingProvider_RemovesManagedConfig()
    {
        var settings = CreateSettings();
        await settings.UpdateAsync(new Dictionary<string, string?>
        {
            ["HOSTY_INGRESS_PROVIDER"] = "cloudflared",
            ["HOSTY_INGRESS_BASE_DOMAIN"] = "apps.example.test",
            ["HOSTY_INGRESS_TUNNEL_ID"] = "tunnel-abc",
            ["HOSTY_INGRESS_CREDENTIALS_FILE"] = Path.Combine(root, "creds.json"),
        });
        var controller = CreateController(settings);
        await controller.ReconcileAsync([]);
        Assert.True(File.Exists(ConfigPath));

        // Switching back to none must take the stale routes offline, not just stop updating them.
        await settings.UpdateAsync(new Dictionary<string, string?> { ["HOSTY_INGRESS_PROVIDER"] = "none" });
        await controller.ReconcileAsync([]);
        Assert.False(File.Exists(ConfigPath));
    }

    [Fact]
    public async Task DisablingProvider_KeepsOperatorAuthoredConfig()
    {
        // A custom HOSTY_INGRESS_CONFIG_PATH may point at a file Hosty did not write; disabling ingress
        // must never delete it (no managed header ⇒ leave it alone).
        Directory.CreateDirectory(Path.GetDirectoryName(ConfigPath)!);
        await File.WriteAllTextAsync(ConfigPath, "tunnel: operator-owned\ningress:\n  - service: http_status:404\n");

        var settings = CreateSettings(); // provider defaults to none
        var controller = CreateController(settings);
        await controller.ReconcileAsync([]);

        Assert.True(File.Exists(ConfigPath));
    }

    public void Dispose()
    {
        if (Directory.Exists(root))
        {
            Directory.Delete(root, recursive: true);
        }
    }
}
