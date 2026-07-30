using Haas.Hosty.Core;
using Microsoft.Extensions.Logging.Abstractions;

namespace Haas.Hosty.Core.Tests;

// Exactly one surface owns HOSTY_PUBLIC_ORIGIN_<endpoint> at a time, and which one is decided by the
// ingress provider. This is the authority the `configure` guard consults, so the per-provider answer is
// pinned here rather than only through the endpoint.
public sealed class PublicOriginOwnershipTests : IDisposable
{
    private readonly string root = Path.Combine(Path.GetTempPath(), $"hosty-origin-ownership-{Guid.NewGuid():N}");

    private CoreDataPaths Paths => new(
        DataRoot: root,
        CoreRoot: Path.Combine(root, "core"),
        AppsRoot: Path.Combine(root, "apps"),
        BackupsRoot: Path.Combine(root, "backups"),
        SourcesRoot: Path.Combine(root, "sources"),
        AuthRoot: Path.Combine(root, "core", "auth"),
        AuditLogPath: Path.Combine(root, "core", "audit", "audit.ndjson"));

    private static readonly string[] SubmittedKeys =
    [
        PublicOriginSettings.BuildSettingKey("web.http"),
        PublicOriginSettings.BuildSettingKey("api.http"),
        "HOSTY_SOMETHING_ELSE",
    ];

    [Fact]
    public async Task ProviderNone_LeavesEveryOriginToTheOperator()
    {
        var (ownership, _) = await CreateAsync(IngressSettings.ProviderNone);

        Assert.Empty(await ownership.FindManagedKeysAsync("com.example.media", SubmittedKeys));
    }

    [Fact]
    public async Task ProviderCloudflared_OwnsEveryPublicOrigin()
    {
        // The local provider re-derives every public endpoint on each start, so an operator-typed value
        // would silently disappear; it owns all of them, published or not.
        var (ownership, _) = await CreateAsync(IngressSettings.ProviderCloudflared);

        var managed = await ownership.FindManagedKeysAsync("com.example.media", SubmittedKeys);

        Assert.Equal(2, managed.Count);
        Assert.DoesNotContain("HOSTY_SOMETHING_ELSE", managed);
    }

    [Fact]
    public async Task ProviderCloudflareRemote_OwnsOnlyPublishedEndpoints()
    {
        // Fronting one endpoint with your own proxy while publishing another is a legitimate
        // arrangement, so an endpoint with no publication stays the operator's.
        var (ownership, publications) = await CreateAsync(IngressSettings.ProviderCloudflareRemote);
        await publications.UpsertAsync(new CloudflarePublication(
            "com.example.media", "web.http", "media", "media.example.test", "dns-1", "http://127.0.0.1:3000",
            CloudflareOwnershipStates.Owned, DateTimeOffset.UnixEpoch));

        var managed = await ownership.FindManagedKeysAsync("com.example.media", SubmittedKeys);

        Assert.Equal([PublicOriginSettings.BuildSettingKey("web.http")], managed);
    }

    [Fact]
    public async Task ProviderCloudflareRemote_IgnoresAnotherAppsPublication()
    {
        var (ownership, publications) = await CreateAsync(IngressSettings.ProviderCloudflareRemote);
        await publications.UpsertAsync(new CloudflarePublication(
            "com.example.other", "web.http", "other", "other.example.test", "dns-2", "http://127.0.0.1:3001",
            CloudflareOwnershipStates.Owned, DateTimeOffset.UnixEpoch));

        Assert.Empty(await ownership.FindManagedKeysAsync("com.example.media", SubmittedKeys));
    }

    private async Task<(PublicOriginOwnership, CloudflarePublicationStore)> CreateAsync(string provider)
    {
        Directory.CreateDirectory(root);
        var settings = new CoreSettingsService(new CoreSettingsStore(Paths, NullLogger<CoreSettingsStore>.Instance));
        await settings.UpdateAsync(new Dictionary<string, string?> { ["HOSTY_INGRESS_PROVIDER"] = provider });
        var publications = new CloudflarePublicationStore(Paths);
        return (new PublicOriginOwnership(settings, publications), publications);
    }

    public void Dispose()
    {
        if (Directory.Exists(root))
        {
            Directory.Delete(root, recursive: true);
        }
    }
}
