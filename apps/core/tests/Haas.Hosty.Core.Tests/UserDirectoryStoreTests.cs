using System.Text.Json;

namespace Haas.Hosty.Core.Tests;

public sealed class UserDirectoryStoreTests
{
    [Fact]
    public async Task ReadAsync_ServesTheCachedStateUntilTheFileChanges()
    {
        var paths = await CreatePathsAsync();
        var store = new UserDirectoryStore(paths);
        await store.WriteAsync(new UserDirectoryState(1, [CreateUser("user-1")], [], [], []));

        var first = await store.ReadAsync();
        var second = await store.ReadAsync();

        // Reference equality is the point: the second read must be the cache, not a re-parse.
        Assert.Same(first, second);
    }

    [Fact]
    public async Task ReadAsync_ObservesAnOutOfBandRewrite()
    {
        // The store is the only writer inside Core, but an operator can edit state.json out of band;
        // the file stamp must turn that into a re-read instead of serving the cached copy forever.
        var paths = await CreatePathsAsync();
        var store = new UserDirectoryStore(paths);
        await store.WriteAsync(new UserDirectoryState(1, [CreateUser("user-1")], [], [], []));
        Assert.Single((await store.ReadAsync()).Users);

        await JsonStorage.WriteAsync(
            Path.Combine(paths.AuthRoot, "state.json"),
            new UserDirectoryState(1, [CreateUser("user-1"), CreateUser("user-2")], [], [], []),
            restrictToOwner: true);

        Assert.Equal(2, (await store.ReadAsync()).Users.Count);
    }

    [Fact]
    public async Task UpdateAsync_IsVisibleToTheNextRead()
    {
        var paths = await CreatePathsAsync();
        var store = new UserDirectoryStore(paths);
        await store.WriteAsync(new UserDirectoryState(1, [CreateUser("user-1")], [], [], []));

        await store.UpdateAsync(state => state with { Users = [.. state.Users, CreateUser("user-2")] });

        Assert.Equal(2, (await store.ReadAsync()).Users.Count);
    }

    private static HostUserRecord CreateUser(string id)
        => new(
            Id: id,
            Email: $"{id}@example.test",
            DisplayName: id,
            Role: "host.member",
            Disabled: false,
            CreatedAt: DateTimeOffset.UtcNow,
            UpdatedAt: DateTimeOffset.UtcNow);

    private static async Task<CoreDataPaths> CreatePathsAsync()
    {
        var root = Path.Combine(Path.GetTempPath(), $"hosty-core-tests-{Guid.NewGuid():N}");
        Directory.CreateDirectory(root);
        await File.WriteAllTextAsync(Path.Combine(root, ".keep"), JsonSerializer.Serialize(new { created = DateTimeOffset.UtcNow }));
        return new CoreDataPaths(
            DataRoot: root,
            CoreRoot: Path.Combine(root, "core"),
            AppsRoot: Path.Combine(root, "apps"),
            BackupsRoot: Path.Combine(root, "backups"),
            SourcesRoot: Path.Combine(root, "sources"),
            AuthRoot: Path.Combine(root, "core", "auth"),
            AuditLogPath: Path.Combine(root, "core", "audit", "audit.ndjson"));
    }
}
