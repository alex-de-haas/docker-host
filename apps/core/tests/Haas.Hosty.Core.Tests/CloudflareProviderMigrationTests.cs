using Haas.Hosty.Core;
using Microsoft.Extensions.Logging.Abstractions;

namespace Haas.Hosty.Core.Tests;

// A host that connected a Cloudflare token before the API path was a provider sits on provider "none"
// with a connection that can publish nothing. The migration moves exactly that host and nothing else.
public sealed class CloudflareProviderMigrationTests : IDisposable
{
    private readonly string root = Path.Combine(Path.GetTempPath(), $"hosty-cf-provider-migration-{Guid.NewGuid():N}");

    private CoreDataPaths Paths => new(
        DataRoot: root,
        CoreRoot: Path.Combine(root, "core"),
        AppsRoot: Path.Combine(root, "apps"),
        BackupsRoot: Path.Combine(root, "backups"),
        SourcesRoot: Path.Combine(root, "sources"),
        AuthRoot: Path.Combine(root, "core", "auth"),
        AuditLogPath: Path.Combine(root, "core", "audit", "audit.ndjson"));

    [Fact]
    public async Task ConnectedWithProviderNone_SelectsCloudflareRemote()
    {
        var (migration, settings) = await CreateAsync(IngressSettings.ProviderNone, connected: true);

        await migration.StartAsync(CancellationToken.None);

        Assert.Equal(IngressSettings.ProviderCloudflareRemote, settings.Ingress.Provider);
        // Persisted, not just live: the next boot must not have to migrate again.
        Assert.Equal(
            IngressSettings.ProviderCloudflareRemote,
            new CoreSettingsService(new CoreSettingsStore(Paths, NullLogger<CoreSettingsStore>.Instance)).Ingress.Provider);
    }

    [Fact]
    public async Task NotConnected_LeavesProviderAlone()
    {
        var (migration, settings) = await CreateAsync(IngressSettings.ProviderNone, connected: false);

        await migration.StartAsync(CancellationToken.None);

        Assert.Equal(IngressSettings.ProviderNone, settings.Ingress.Provider);
    }

    [Fact]
    public async Task ConnectedWithLocalConfigProvider_LeavesProviderAlone()
    {
        // An operator running the local config file has made a different choice; a stored token does not
        // override it.
        var (migration, settings) = await CreateAsync(IngressSettings.ProviderCloudflared, connected: true);

        await migration.StartAsync(CancellationToken.None);

        Assert.Equal(IngressSettings.ProviderCloudflared, settings.Ingress.Provider);
    }

    private async Task<(CloudflareProviderMigration, CoreSettingsService)> CreateAsync(string provider, bool connected)
    {
        Directory.CreateDirectory(root);
        var settings = new CoreSettingsService(new CoreSettingsStore(Paths, NullLogger<CoreSettingsStore>.Instance));
        await settings.UpdateAsync(new Dictionary<string, string?> { ["HOSTY_INGRESS_PROVIDER"] = provider });
        var integration = new CloudflareIntegrationStore(Paths);
        if (connected)
        {
            await integration.SaveAsync(new CloudflareIntegrationState(
                CloudflareConnectionStatuses.Connected, null, "acc", "Acct", "zone", "example.test", "example.test",
                "tunnel-123", "NL", "healthy", ConnectorLocality.Local, DateTimeOffset.UnixEpoch, DateTimeOffset.UnixEpoch));
        }

        return (
            new CloudflareProviderMigration(settings, integration, NullLogger<CloudflareProviderMigration>.Instance),
            settings);
    }

    public void Dispose()
    {
        if (Directory.Exists(root))
        {
            Directory.Delete(root, recursive: true);
        }
    }
}
