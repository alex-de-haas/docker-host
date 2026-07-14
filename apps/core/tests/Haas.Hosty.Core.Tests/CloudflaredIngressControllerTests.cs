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
        ShellPort: 7171,
        ListenUrl: "http://127.0.0.1:7070",
        CorePublicOrigin: null,
        ShellPublicOrigin: null,
        RuntimePublicHost: "127.0.0.1",
        ShellSourceOverridePath: null,
        ShellAutostart: false,
        IngressConfigPath: ConfigPath);

    private CoreSettingsService CreateSettings() => new(new CoreSettingsStore(Paths, NullLogger<CoreSettingsStore>.Instance));

    private CloudflaredIngressController CreateController(CoreSettingsService settings)
        => new(settings, Config, NullLogger<CloudflaredIngressController>.Instance);

    [Fact]
    public async Task ProviderNone_DoesNotManageOriginsOrWriteConfig()
    {
        var settings = CreateSettings();
        var controller = CreateController(settings);

        Assert.False(controller.ManagesPublicOrigins);
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

        Assert.True(controller.ManagesPublicOrigins);
        var origins = controller.ResolvePublicOrigins("pm", subdomainOverride: null, ["http"]);
        Assert.Equal("https://pm.apps.example.test", origins["HOSTY_PUBLIC_ORIGIN_HTTP"]);

        // Even with no running apps, the Core seed + catch-all produce a config.yml.
        await controller.ReconcileAsync([]);
        Assert.True(File.Exists(ConfigPath));
        var yaml = await File.ReadAllTextAsync(ConfigPath);
        Assert.Contains("core.apps.example.test", yaml);
        Assert.Contains("tunnel-abc", yaml);
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

        Assert.True(controller.ManagesPublicOrigins); // derives origins, but won't render a half config
        await controller.ReconcileAsync([]);
        Assert.False(File.Exists(ConfigPath));
    }

    public void Dispose()
    {
        if (Directory.Exists(root))
        {
            Directory.Delete(root, recursive: true);
        }
    }
}
