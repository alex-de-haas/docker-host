namespace Haas.Hosty.Core.Tests;

public sealed class AppSignInIntentStoreTests
{
    [Fact]
    public async Task Claim_IsAtomic_AndBadNonceDoesNotRemoveTheAttempt()
    {
        var store = new AppSignInIntentStore(new Clock());
        var created = Create(store)!;
        Assert.NotEqual(created.Nonce, created.Intent.NonceHash);
        Assert.Null(store.Find("app", created.Intent.Id, new string('a', 64)));
        Assert.Null(store.Find("other", created.Intent.Id, created.Nonce));
        Assert.Same(created.Intent, store.Find("app", created.Intent.Id, created.Nonce));
        var results = await Task.WhenAll(Enumerable.Range(0, 16).Select(_ => Task.Run(() => store.TryClaim(created.Intent))));
        Assert.Single(results, result => result);
        Assert.Null(store.Find("app", created.Intent.Id, created.Nonce));
    }

    [Fact]
    public void Capacity_RefusesInsteadOfEvicting_AndExpiredAttemptsReleaseCapacity()
    {
        var clock = new Clock();
        var store = new AppSignInIntentStore(clock);
        var first = Create(store)!;
        for (var index = 1; index < OAuthAuthorizationStore.MaxPendingPerSource; index++) Assert.NotNull(Create(store));
        Assert.Null(Create(store));
        Assert.Same(first.Intent, store.Find("app", first.Intent.Id, first.Nonce));
        Assert.Null(Create(store, "different-source", AppSignInIntentStore.MaxPerBrowser));
        clock.UtcNow = clock.UtcNow.AddMinutes(5);
        Assert.Null(store.Find("app", first.Intent.Id, first.Nonce));
        Assert.Null(store.FindCallback("app", first.Intent.Id));
        Assert.NotNull(Create(store));
    }

    [Fact]
    public void GlobalCapacity_IsBoundedAcrossSources()
    {
        var store = new AppSignInIntentStore(new Clock());
        for (var index = 0; index < AppSignInIntentStore.MaxPending; index++) Assert.NotNull(Create(store, index.ToString()));
        Assert.Null(Create(store, "new-source"));
    }

    private static AppSignInIntentCreated? Create(AppSignInIntentStore store, string source = "source", int cookies = 0)
        => store.Create("app", "https://app.test/callback", new string('a', 64), AuthCodeProof.Challenge, AppSignInMode.Standalone, source, cookies);
    private sealed class Clock : IClock { public DateTimeOffset UtcNow { get; set; } = DateTimeOffset.UtcNow; }
}
