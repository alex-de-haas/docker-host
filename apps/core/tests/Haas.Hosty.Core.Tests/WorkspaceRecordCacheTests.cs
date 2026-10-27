using Haas.Hosty.Core;
using System.Text.Json;

namespace Haas.Hosty.Core.Tests;

public sealed class WorkspaceRecordCacheTests : IDisposable
{
    private readonly string root = Path.Combine(Path.GetTempPath(), "hosty-record-cache-" + Guid.NewGuid().ToString("N"));
    public WorkspaceRecordCacheTests() => Directory.CreateDirectory(root);
    public void Dispose() => Directory.Delete(root, true);

    [Fact]
    public async Task UnchangedReadersShareParsingButReplacementAndDeletionAreVisible()
    {
        var path = Path.Combine(root, "metadata.json");
        await JsonStorage.WriteAsync(path, new WorkspaceMetadata("First"));
        var cache = new WorkspaceRecordCache();
        var values = await Task.WhenAll(Enumerable.Range(0, 12).Select(_ => cache.ReadAsync<WorkspaceMetadata>(path, default)));
        Assert.All(values, value => Assert.Equal("First", value!.Name));
        Assert.Equal(DocumentFileStamp.Read(path) is null ? 12 : 1, cache.Statistics.Reads);
        var modified = File.GetLastWriteTimeUtc(path);
        await File.WriteAllTextAsync(path, (await File.ReadAllTextAsync(path)).Replace("First", "Other"));
        File.SetLastWriteTimeUtc(path, modified);
        Assert.Equal("Other", (await cache.ReadAsync<WorkspaceMetadata>(path, default))!.Name);
        var replacement = Path.Combine(root, "replacement.json");
        await JsonStorage.WriteAsync(replacement, new WorkspaceMetadata("Third"));
        File.SetLastWriteTimeUtc(replacement, modified); File.Move(replacement, path, true);
        Assert.Equal("Third", (await cache.ReadAsync<WorkspaceMetadata>(path, default))!.Name);
        File.Delete(path);
        Assert.Null(await cache.ReadAsync<WorkspaceMetadata>(path, default));
        await File.WriteAllTextAsync(path, "invalid JSON");
        await Assert.ThrowsAsync<JsonException>(() => cache.ReadAsync<WorkspaceMetadata>(path, default));
        await JsonStorage.WriteAsync(path, new WorkspaceMetadata("Recovered"));
        Assert.Equal("Recovered", (await cache.ReadAsync<WorkspaceMetadata>(path, default))!.Name);
    }

    [Fact]
    public async Task BoundedCacheHonorsCancellationEvenOnAWarmRecord()
    {
        var cache = new WorkspaceRecordCache(capacity: 2, byteLimit: 2048);
        for (var i = 0; i < 12; i++)
        {
            var path = Path.Combine(root, i + ".json");
            await JsonStorage.WriteAsync(path, new WorkspaceMetadata("Name"));
            Assert.NotNull(await cache.ReadAsync<WorkspaceMetadata>(path, default));
        }
        Assert.InRange(cache.Statistics.Entries, 0, 2);
        Assert.InRange(cache.Statistics.Bytes, 0, 2048);
        using var cancelled = new CancellationTokenSource(); cancelled.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => cache.ReadAsync<WorkspaceMetadata>(Path.Combine(root, "11.json"), cancelled.Token));
    }
}
