using Haas.Hosty.Core;

namespace Haas.Hosty.Core.Tests;

public sealed class AppSessionGrantStoreTests
{
    [Fact]
    public async Task TouchAsync_IsThrottledThenAdvancesLastSeen()
    {
        var (store, now) = await CreateAsync();
        var created = now;
        await store.AppendAsync(Grant("hash_1", created, absolute: created.AddDays(30)), created);

        // Within the throttle window: no advance.
        await store.TouchAsync("hash_1", created.AddMinutes(1), TimeSpan.FromMinutes(5));
        Assert.Equal(created, (await store.TryResolveAsync("hash_1"))!.LastSeenAt);

        // Past the throttle window: LastSeenAt advances.
        var later = created.AddMinutes(10);
        await store.TouchAsync("hash_1", later, TimeSpan.FromMinutes(5));
        Assert.Equal(later, (await store.TryResolveAsync("hash_1"))!.LastSeenAt);
    }

    [Fact]
    public async Task TouchAsync_DoesNotReviveRevokedOrExpiredGrant()
    {
        var (store, now) = await CreateAsync();
        await store.AppendAsync(Grant("revoked", now, absolute: now.AddDays(30)) with { RevokedAt = now }, now);

        await store.TouchAsync("revoked", now.AddHours(1), TimeSpan.FromMinutes(5));

        Assert.Equal(now, (await store.TryResolveAsync("revoked"))!.LastSeenAt);
    }

    [Fact]
    public async Task AppendAsync_PrunesAbsolutelyExpiredAndLongRevokedGrants()
    {
        var (store, now) = await CreateAsync();
        // Absolutely expired, and revoked long ago: both should be pruned on the next write.
        await store.AppendAsync(Grant("expired", now.AddDays(-40), absolute: now.AddDays(-10)), now.AddDays(-40));
        await store.AppendAsync(Grant("stale-revoked", now.AddDays(-20), absolute: now.AddDays(30)) with { RevokedAt = now.AddDays(-8) }, now.AddDays(-20));
        // Recently revoked: retained briefly for diagnostics.
        await store.AppendAsync(Grant("fresh-revoked", now, absolute: now.AddDays(30)) with { RevokedAt = now }, now);

        // A subsequent append triggers the prune.
        await store.AppendAsync(Grant("live", now, absolute: now.AddDays(30)), now);

        var state = await store.ReadAsync();
        var hashes = state.Grants.Select(grant => grant.TokenHash).ToHashSet();
        Assert.Contains("live", hashes);
        Assert.Contains("fresh-revoked", hashes);
        Assert.DoesNotContain("expired", hashes);
        Assert.DoesNotContain("stale-revoked", hashes);
    }

    [Fact]
    public async Task RevokeByAuthorizingSessionAsync_RevokesOnlyThatSessionsGrants()
    {
        var (store, now) = await CreateAsync();
        await store.AppendAsync(Grant("a", now, absolute: now.AddDays(30)) with { AuthorizingSessionId = "session_1" }, now);
        await store.AppendAsync(Grant("b", now, absolute: now.AddDays(30)) with { AuthorizingSessionId = "session_2" }, now);

        await store.RevokeByAuthorizingSessionAsync("session_1", now.AddMinutes(1));

        Assert.NotNull((await store.TryResolveAsync("a"))!.RevokedAt);
        Assert.Null((await store.TryResolveAsync("b"))!.RevokedAt);
    }

    private static AppSessionGrantRecord Grant(string hash, DateTimeOffset created, DateTimeOffset absolute)
        => new(
            Id: hash,
            AppId: "com.example.notes",
            UserId: "user_1",
            TokenHash: hash,
            IssuedVia: AppGrantIssuedVia.Code,
            CreatedAt: created,
            LastSeenAt: created,
            AbsoluteExpiresAt: absolute,
            RevokedAt: null,
            AuthorizingSessionId: null);

    private static async Task<(AppSessionGrantStore Store, DateTimeOffset Now)> CreateAsync()
    {
        var root = Path.Combine(Path.GetTempPath(), $"hosty-core-grant-store-tests-{Guid.NewGuid():N}");
        Directory.CreateDirectory(root);
        var paths = new CoreDataPaths(
            DataRoot: root,
            CoreRoot: Path.Combine(root, "core"),
            AppsRoot: Path.Combine(root, "apps"),
            BackupsRoot: Path.Combine(root, "backups"),
            SourcesRoot: Path.Combine(root, "sources"),
            AuthRoot: Path.Combine(root, "core", "auth"),
            AuditLogPath: Path.Combine(root, "core", "audit", "audit.ndjson"));
        return (new AppSessionGrantStore(paths), DateTimeOffset.Parse("2026-07-13T10:00:00Z"));
    }
}
