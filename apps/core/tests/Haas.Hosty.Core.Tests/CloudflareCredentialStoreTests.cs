using Haas.Hosty.Core;

namespace Haas.Hosty.Core.Tests;

public sealed class CloudflareCredentialStoreTests : IDisposable
{
    private readonly string root = Path.Combine(Path.GetTempPath(), $"hosty-cf-cred-{Guid.NewGuid():N}");

    [Fact]
    public async Task SaveThenLoad_RoundTripsTheRawToken()
    {
        var store = CreateStore();
        await store.SaveAsync(new CloudflareCredential("cf-token-abcdef", "tok-id", "Hosty test", null));

        var loaded = await store.LoadAsync();
        Assert.NotNull(loaded);
        Assert.Equal("cf-token-abcdef", loaded!.Token);
        Assert.Equal("tok-id", loaded.TokenId);
    }

    [Fact]
    public async Task GetSummaryAsync_MasksTheTokenAndNeverReturnsTheRawValue()
    {
        var store = CreateStore();
        await store.SaveAsync(new CloudflareCredential("abcd12345678wxyz", "tok-id", "Hosty test", DateTimeOffset.UnixEpoch));

        var summary = await store.GetSummaryAsync();

        Assert.True(summary.Present);
        Assert.Equal("tok-id", summary.TokenId);
        Assert.Equal("Hosty test", summary.TokenName);
        Assert.NotNull(summary.Masked);
        Assert.DoesNotContain("12345678", summary.Masked); // the middle is hidden
        Assert.NotEqual("abcd12345678wxyz", summary.Masked);
        Assert.StartsWith("abcd", summary.Masked);
        Assert.EndsWith("wxyz", summary.Masked);
    }

    [Fact]
    public async Task GetSummaryAsync_ReportsAbsentWhenNoTokenStored()
    {
        var summary = await CreateStore().GetSummaryAsync();
        Assert.False(summary.Present);
        Assert.Null(summary.Masked);
    }

    [Fact]
    public async Task DeleteAsync_RemovesTheStoredToken()
    {
        var store = CreateStore();
        await store.SaveAsync(new CloudflareCredential("cf-token", null, null, null));
        await store.DeleteAsync();

        Assert.Null(await store.LoadAsync());
        Assert.False((await store.GetSummaryAsync()).Present);
    }

    [Fact]
    public void Mask_FullyHidesShortValues()
    {
        Assert.DoesNotContain("secret", CloudflareCredentialStore.Mask("secret"));
        Assert.Equal("", CloudflareCredentialStore.Mask(""));
    }

    private CloudflareCredentialStore CreateStore()
    {
        Directory.CreateDirectory(root);
        var paths = new CoreDataPaths(
            DataRoot: root,
            CoreRoot: Path.Combine(root, "core"),
            AppsRoot: Path.Combine(root, "apps"),
            BackupsRoot: Path.Combine(root, "backups"),
            SourcesRoot: Path.Combine(root, "sources"),
            AuthRoot: Path.Combine(root, "core", "auth"),
            AuditLogPath: Path.Combine(root, "core", "audit", "audit.ndjson"));
        return new CloudflareCredentialStore(paths);
    }

    public void Dispose()
    {
        try
        {
            if (Directory.Exists(root))
            {
                Directory.Delete(root, recursive: true);
            }
        }
        catch (IOException)
        {
        }
    }
}
