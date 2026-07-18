using System.Globalization;
using Haas.Hosty.Core;

namespace Haas.Hosty.Core.Tests;

public sealed class JsonStorageTests
{
    [Fact]
    public async Task WriteAsync_ConcurrentWritersPublishAValidDocument()
    {
        var root = Path.Combine(Path.GetTempPath(), $"hosty-core-json-tests-{Guid.NewGuid():N}");
        var path = Path.Combine(root, "state.json");

        await Task.WhenAll(Enumerable.Range(0, 32)
            .Select(index => JsonStorage.WriteAsync(path, CreateSampleRecord(index, new string('x', 4096)))));

        var document = await JsonStorage.ReadAsync<AuditRecord>(path);
        Assert.NotNull(document);
        Assert.InRange(int.Parse(document.Action, CultureInfo.InvariantCulture), 0, 31);
        Assert.Equal(4096, document.Details["payload"].Length);
        Assert.Empty(Directory.EnumerateFiles(root, "*.tmp"));
    }

    [Fact]
    public async Task WriteAsync_RemovesTempFileWhenSerializationFails()
    {
        var root = Path.Combine(Path.GetTempPath(), $"hosty-core-json-tests-{Guid.NewGuid():N}");
        var path = Path.Combine(root, "state.json");

        await Assert.ThrowsAnyAsync<Exception>(() => JsonStorage.WriteAsync(path, new ThrowingDocument()));

        Assert.False(File.Exists(path));
        Assert.Empty(Directory.EnumerateFiles(root, "*.tmp"));
    }

    [Fact]
    public async Task WriteAsync_RestrictToOwnerLimitsFileAndDirectoryModes()
    {
        if (OperatingSystem.IsWindows())
        {
            return;
        }

        var root = Path.Combine(Path.GetTempPath(), $"hosty-core-json-tests-{Guid.NewGuid():N}");
        var path = Path.Combine(root, "auth", "state.json");

        await JsonStorage.WriteAsync(path, CreateSampleRecord(1, "secret"), restrictToOwner: true);

        Assert.Equal(UnixFileMode.UserRead | UnixFileMode.UserWrite, File.GetUnixFileMode(path));
        Assert.Equal(
            UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute,
            File.GetUnixFileMode(Path.Combine(root, "auth")));
    }

    [Fact]
    public async Task WriteOwnerFileAsync_RestrictsTheFileButLeavesTheDirectoryTraversable()
    {
        if (OperatingSystem.IsWindows())
        {
            return;
        }

        // App state sits next to the bind-mounted data/ directory, so locking the containing
        // directory would cut off a container running as another uid.
        var root = Path.Combine(Path.GetTempPath(), $"hosty-core-json-tests-{Guid.NewGuid():N}");
        var directory = Path.Combine(root, "com.example.notes");
        var path = Path.Combine(directory, "state.json");

        // Compared against a plainly created sibling rather than a literal mode, so the assertion
        // holds whatever umask the test host runs under.
        var reference = Path.Combine(root, "reference");
        Directory.CreateDirectory(reference);

        await JsonStorage.WriteOwnerFileAsync(path, CreateSampleRecord(1, "secret"));

        Assert.Equal(UnixFileMode.UserRead | UnixFileMode.UserWrite, File.GetUnixFileMode(path));
        Assert.Equal(File.GetUnixFileMode(reference), File.GetUnixFileMode(directory));
    }

    // Uses a production storage type registered in CoreJsonSerializerContext so the storage
    // round-trip exercises the same source-generated path that Native AOT requires.
    private static AuditRecord CreateSampleRecord(int index, string payload) => new(
        Id: $"audit_{index.ToString(CultureInfo.InvariantCulture)}",
        Action: index.ToString(CultureInfo.InvariantCulture),
        ResourceType: "test",
        ResourceId: null,
        Outcome: "ok",
        ActorUserId: null,
        CreatedAt: DateTimeOffset.UnixEpoch,
        Details: new Dictionary<string, string> { ["payload"] = payload });

    private sealed class ThrowingDocument
    {
        public string Value => throw new InvalidOperationException("Serialization failure.");
    }
}
