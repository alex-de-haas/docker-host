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
            .Select(index => JsonStorage.WriteAsync(path, new SampleDocument(index, new string('x', 4096)))));

        var document = await JsonStorage.ReadAsync<SampleDocument>(path);
        Assert.NotNull(document);
        Assert.InRange(document.Value, 0, 31);
        Assert.Equal(4096, document.Payload.Length);
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

        await JsonStorage.WriteAsync(path, new SampleDocument(1, "secret"), restrictToOwner: true);

        Assert.Equal(UnixFileMode.UserRead | UnixFileMode.UserWrite, File.GetUnixFileMode(path));
        Assert.Equal(
            UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute,
            File.GetUnixFileMode(Path.Combine(root, "auth")));
    }

    private sealed record SampleDocument(int Value, string Payload);

    private sealed class ThrowingDocument
    {
        public string Value => throw new InvalidOperationException("Serialization failure.");
    }
}
