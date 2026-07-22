using System.Text.Json;
using Haas.Hosty.Core;

namespace Haas.Hosty.Core.Tests;

public sealed class AppSecretsStoreTests
{
    private const string AppId = "com.example.notes";

    [Fact]
    public async Task SetAsync_ThenGetAsync_RoundTripsTheValue()
    {
        var fixture = SecretsFixture.Create();

        Assert.Equal(AppSecretsStatus.Ok, await fixture.Store.SetAsync(AppId, "trakt.connection.1.tokens", "token-payload"));

        var result = await fixture.Store.GetAsync(AppId, "trakt.connection.1.tokens");
        Assert.Equal(AppSecretsStatus.Ok, result.Status);
        Assert.Equal("token-payload", result.Value);
    }

    [Fact]
    public async Task SetAsync_WritesAnOwnerOnlyFileBesideStateJson()
    {
        if (OperatingSystem.IsWindows())
        {
            return;
        }

        var fixture = SecretsFixture.Create();

        await fixture.Store.SetAsync(AppId, "key", "value");

        Assert.True(File.Exists(fixture.SecretsPath));
        Assert.Equal(Path.GetDirectoryName(fixture.StatePath), Path.GetDirectoryName(fixture.SecretsPath));
        Assert.Equal(UnixFileMode.UserRead | UnixFileMode.UserWrite, File.GetUnixFileMode(fixture.SecretsPath));
    }

    [Fact]
    public async Task SetAsync_ForMissingApp_ReturnsAppNotFoundAndWritesNothing()
    {
        var fixture = SecretsFixture.Create(createApp: false);

        Assert.Equal(AppSecretsStatus.AppNotFound, await fixture.Store.SetAsync(AppId, "key", "value"));

        Assert.False(File.Exists(fixture.SecretsPath));
        Assert.False(Directory.Exists(Path.GetDirectoryName(fixture.SecretsPath)));
    }

    [Fact]
    public async Task GetAsync_MissingKey_ReturnsKeyNotFound()
    {
        var fixture = SecretsFixture.Create();
        await fixture.Store.SetAsync(AppId, "present", "value");

        var result = await fixture.Store.GetAsync(AppId, "absent");

        Assert.Equal(AppSecretsStatus.KeyNotFound, result.Status);
        Assert.Null(result.Value);
    }

    [Fact]
    public async Task DeleteAsync_IsIdempotent()
    {
        var fixture = SecretsFixture.Create();
        await fixture.Store.SetAsync(AppId, "key", "value");

        Assert.Equal(AppSecretsStatus.Ok, await fixture.Store.DeleteAsync(AppId, "key"));
        Assert.Equal(AppSecretsStatus.Ok, await fixture.Store.DeleteAsync(AppId, "key"));

        Assert.Equal(AppSecretsStatus.KeyNotFound, (await fixture.Store.GetAsync(AppId, "key")).Status);
    }

    [Fact]
    public async Task ListKeysAsync_ReturnsNamesSortedOrdinal_NeverValues()
    {
        var fixture = SecretsFixture.Create();
        await fixture.Store.SetAsync(AppId, "b.key", "value-b");
        await fixture.Store.SetAsync(AppId, "a.key", "value-a");

        var result = await fixture.Store.ListKeysAsync(AppId);

        Assert.Equal(AppSecretsStatus.Ok, result.Status);
        Assert.Equal(["a.key", "b.key"], result.Keys);
    }

    [Fact]
    public async Task SetAsync_EnforcesTheKeyCountBound_ButAllowsReplacingAtTheLimit()
    {
        var fixture = SecretsFixture.Create();
        for (var i = 0; i < AppSecretsStore.MaxKeysPerApp; i++)
        {
            Assert.Equal(AppSecretsStatus.Ok, await fixture.Store.SetAsync(AppId, $"key-{i}", "value"));
        }

        Assert.Equal(AppSecretsStatus.TooManyKeys, await fixture.Store.SetAsync(AppId, "one-more", "value"));
        Assert.Equal(AppSecretsStatus.Ok, await fixture.Store.SetAsync(AppId, "key-0", "replaced"));
    }

    [Fact]
    public async Task ReadingAMalformedFile_FailsLoudInsteadOfReplacingIt()
    {
        var fixture = SecretsFixture.Create();
        await File.WriteAllTextAsync(fixture.SecretsPath, "not-json{");

        await Assert.ThrowsAsync<JsonException>(() => fixture.Store.GetAsync(AppId, "key"));

        Assert.Equal("not-json{", await File.ReadAllTextAsync(fixture.SecretsPath));
    }

    [Fact]
    public async Task ReadingAnUnknownSchemaVersion_FailsLoud()
    {
        var fixture = SecretsFixture.Create();
        await File.WriteAllTextAsync(fixture.SecretsPath, """{"schemaVersion":2,"secrets":{}}""");

        await Assert.ThrowsAsync<InvalidOperationException>(() => fixture.Store.ListKeysAsync(AppId));
    }

    [Fact]
    public async Task DeleteAllAsync_RemovesTheFile_AndToleratesItsAbsence()
    {
        var fixture = SecretsFixture.Create();
        await fixture.Store.SetAsync(AppId, "key", "value");

        await fixture.Store.DeleteAllAsync(AppId);
        Assert.False(File.Exists(fixture.SecretsPath));

        await fixture.Store.DeleteAllAsync(AppId);
    }

    // The removal fence: a write that was already waiting on the shared per-app lock when removal
    // deleted state.json (and the secrets through DeleteAllAsync) must observe the deletion and
    // refuse — not recreate the app root with a stale secrets.json.
    [Fact]
    public async Task SetAsync_LosingTheRaceToRemoval_RefusesInsteadOfResurrectingTheFile()
    {
        var fixture = SecretsFixture.Create();
        await fixture.Store.SetAsync(AppId, "key", "value");

        var mutex = fixture.Registry.GetAppLock(AppId);
        await mutex.WaitAsync();
        Task<AppSecretsStatus> blockedWrite;
        try
        {
            blockedWrite = fixture.Store.SetAsync(AppId, "key", "written-after-removal");
            Assert.False(blockedWrite.IsCompleted);

            // What delete-data removal does while holding its own verb lock: state.json goes first,
            // the secrets file last (here inline, since this test owns the store lock).
            File.Delete(fixture.StatePath);
            File.Delete(fixture.SecretsPath);
        }
        finally
        {
            mutex.Release();
        }

        Assert.Equal(AppSecretsStatus.AppNotFound, await blockedWrite);
        Assert.False(File.Exists(fixture.SecretsPath));
    }

    // `hosty apps remove --delete-data --keep-state` deletes the secrets while state.json survives,
    // so the existence fence cannot catch a straddling write — the data-removal generation must.
    [Fact]
    public async Task SetAsync_LosingTheRaceToRemovalThatKeptRuntimeState_StillRefuses()
    {
        var fixture = SecretsFixture.Create();
        await fixture.Store.SetAsync(AppId, "key", "value");

        var mutex = fixture.Registry.GetAppLock(AppId);
        await mutex.WaitAsync();
        Task<AppSecretsStatus> blockedWrite;
        try
        {
            // Sampled the current generation on entry, now queued behind this lock.
            blockedWrite = fixture.Store.SetAsync(AppId, "key", "written-after-removal");
            Assert.False(blockedWrite.IsCompleted);

            // The removal's critical section, run inline because the waiter would otherwise win the
            // FIFO handoff: delete-data with runtime state kept leaves state.json in place, so the
            // generation bump is the only thing that can fence the queued write.
            fixture.Registry.BumpDataRemovalGeneration(AppId);
            File.Delete(fixture.SecretsPath);
        }
        finally
        {
            mutex.Release();
        }

        Assert.Equal(AppSecretsStatus.AppNotFound, await blockedWrite);
        Assert.True(File.Exists(fixture.StatePath));
        Assert.False(File.Exists(fixture.SecretsPath));
    }

    // The generation fences only writes that straddle a removal: an app whose runtime state was kept is
    // still installed, so a request that starts afterwards must be able to store secrets again.
    [Fact]
    public async Task SetAsync_StartingAfterRemovalThatKeptRuntimeState_Succeeds()
    {
        var fixture = SecretsFixture.Create();
        await fixture.Store.SetAsync(AppId, "key", "value");

        await fixture.Store.DeleteAllAsync(AppId);

        Assert.Equal(AppSecretsStatus.Ok, await fixture.Store.SetAsync(AppId, "key", "fresh"));
        Assert.Equal("fresh", (await fixture.Store.GetAsync(AppId, "key")).Value);
    }

    [Fact]
    public async Task SetAsync_EnforcesBoundsIndependentlyOfTheEndpoint()
    {
        var fixture = SecretsFixture.Create();

        Assert.Equal(AppSecretsStatus.KeyInvalid, await fixture.Store.SetAsync(AppId, "Bad Key", "value"));
        Assert.Equal(AppSecretsStatus.ValueInvalid, await fixture.Store.SetAsync(AppId, "key", ""));
        Assert.Equal(
            AppSecretsStatus.ValueInvalid,
            await fixture.Store.SetAsync(AppId, "key", new string('a', AppSecretsStore.MaxValueBytes + 1)));

        Assert.False(File.Exists(fixture.SecretsPath));
    }

    // The hard-delete path: AppRegistryStore.RemoveAppAsync deletes the whole subtree under the same
    // shared lock, so a later write finds no state.json and must not recreate the app root.
    [Fact]
    public async Task SetAsync_AfterRemoveAppAsync_ReturnsAppNotFoundAndLeavesTheRootDeleted()
    {
        var fixture = SecretsFixture.Create();
        await fixture.Store.SetAsync(AppId, "key", "value");

        await fixture.Registry.RemoveAppAsync(AppId);

        Assert.Equal(AppSecretsStatus.AppNotFound, await fixture.Store.SetAsync(AppId, "key", "value"));
        Assert.False(Directory.Exists(Path.GetDirectoryName(fixture.SecretsPath)));
    }

    [Fact]
    public async Task AnUnsafeAppIdSegment_ReadsAsAppNotFound()
    {
        var fixture = SecretsFixture.Create();

        Assert.Equal(AppSecretsStatus.AppNotFound, (await fixture.Store.GetAsync("../escape", "key")).Status);
        Assert.Equal(AppSecretsStatus.AppNotFound, await fixture.Store.SetAsync("../escape", "key", "value"));
    }

    [Theory]
    [InlineData("trakt.connection.1.tokens", true)]
    [InlineData("a", true)]
    [InlineData("0-key_name.v2", true)]
    [InlineData("", false)]
    [InlineData(null, false)]
    [InlineData("Uppercase", false)]
    [InlineData(".leading-dot", false)]
    [InlineData("has/slash", false)]
    [InlineData("has space", false)]
    public void IsValidKey_MatchesTheDocumentedPattern(string? key, bool expected)
        => Assert.Equal(expected, AppSecretsStore.IsValidKey(key));

    [Fact]
    public void IsValidKey_RejectsKeysOver128Characters()
    {
        Assert.True(AppSecretsStore.IsValidKey(new string('a', 128)));
        Assert.False(AppSecretsStore.IsValidKey(new string('a', 129)));
    }

    [Fact]
    public void IsValidValue_BoundsTheUtf8ByteCount_NotTheCharCount()
    {
        Assert.False(AppSecretsStore.IsValidValue(null));
        Assert.False(AppSecretsStore.IsValidValue(""));
        Assert.True(AppSecretsStore.IsValidValue(new string('a', AppSecretsStore.MaxValueBytes)));
        Assert.False(AppSecretsStore.IsValidValue(new string('a', AppSecretsStore.MaxValueBytes + 1)));
        // 'я' is two UTF-8 bytes, so half the limit in characters is exactly the limit in bytes.
        Assert.True(AppSecretsStore.IsValidValue(new string('я', AppSecretsStore.MaxValueBytes / 2)));
        Assert.False(AppSecretsStore.IsValidValue(new string('я', AppSecretsStore.MaxValueBytes / 2 + 1)));
    }

    private sealed class SecretsFixture
    {
        private SecretsFixture(AppRegistryStore registry, AppSecretsStore store, string statePath, string secretsPath)
        {
            Registry = registry;
            Store = store;
            StatePath = statePath;
            SecretsPath = secretsPath;
        }

        public AppRegistryStore Registry { get; }

        public AppSecretsStore Store { get; }

        public string StatePath { get; }

        public string SecretsPath { get; }

        public static SecretsFixture Create(bool createApp = true)
        {
            var root = Path.Combine(Path.GetTempPath(), $"hosty-core-secrets-tests-{Guid.NewGuid():N}");
            var paths = new CoreDataPaths(
                DataRoot: root,
                CoreRoot: Path.Combine(root, "core"),
                AppsRoot: Path.Combine(root, "apps"),
                BackupsRoot: Path.Combine(root, "backups"),
                SourcesRoot: Path.Combine(root, "sources"),
                AuthRoot: Path.Combine(root, "core", "auth"),
                AuditLogPath: Path.Combine(root, "core", "audit", "audit.ndjson"));
            var appRoot = Path.Combine(paths.AppsRoot, AppId);
            var statePath = Path.Combine(appRoot, "state.json");
            if (createApp)
            {
                // The store's existence fence only checks for the file, so a minimal document is enough.
                Directory.CreateDirectory(appRoot);
                File.WriteAllText(statePath, """{"schemaVersion":1}""");
            }

            var registry = new AppRegistryStore(paths);
            return new SecretsFixture(registry, new AppSecretsStore(registry, paths), statePath, Path.Combine(appRoot, "secrets.json"));
        }
    }
}
