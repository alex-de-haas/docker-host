using System.Diagnostics;
using System.Text;
using Haas.Hosty.Core;

namespace Haas.Hosty.Core.Tests;

public sealed class SourceDocumentWorktreeCacheTests : IDisposable
{
    private readonly string root = Path.Combine(Path.GetTempPath(), "hosty-document-cache-" + Guid.NewGuid().ToString("N"));
    public SourceDocumentWorktreeCacheTests() => Directory.CreateDirectory(root);
    public void Dispose() => Directory.Delete(root, true);
    private static Task<byte[]> Read(SourceDocumentWorktreeCache cache, string path, CancellationToken ct = default)
        => cache.ReadAsync(path, token => File.ReadAllBytesAsync(path, token), ct);
    [Fact]
    public async Task ReusesBytesButDetectsSameSizeRestoredMtimeAndAtomicReplacement()
    {
        var path = Path.Combine(root, "plan.md"); await File.WriteAllTextAsync(path, "first");
        var cache = new SourceDocumentWorktreeCache();
        var stamp = DocumentFileStamp.Read(path);
        if (OperatingSystem.IsLinux() || OperatingSystem.IsMacOS())
        { Assert.NotNull(stamp); Assert.True(stamp.Value.Regular); Assert.Equal(5, stamp.Value.Size); }
        Assert.Equal("first", Encoding.UTF8.GetString(await Read(cache, path)));
        await Read(cache, path);
        Assert.Equal(stamp is null ? 2 : 1, cache.Statistics.Loads);
        var modified = File.GetLastWriteTimeUtc(path);
        await File.WriteAllTextAsync(path, "other"); File.SetLastWriteTimeUtc(path, modified);
        Assert.Equal("other", Encoding.UTF8.GetString(await Read(cache, path)));
        var replacement = Path.Combine(root, "replacement.md");
        await File.WriteAllTextAsync(replacement, "third"); File.SetLastWriteTimeUtc(replacement, modified);
        File.Move(replacement, path, true);
        Assert.Equal("third", Encoding.UTF8.GetString(await Read(cache, path)));
        File.Delete(path);
        await Assert.ThrowsAsync<FileNotFoundException>(() => Read(cache, path));
    }
    [Fact]
    public async Task ConcurrentReadersShareBytesAndCanceledWaitersDoNotPoisonTheCache()
    {
        var path = Path.Combine(root, "plan.md"); await File.WriteAllTextAsync(path, "content");
        var cache = new SourceDocumentWorktreeCache();
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var finish = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var first = cache.ReadAsync(path, async ct => { entered.SetResult(); await finish.Task.WaitAsync(ct); return await File.ReadAllBytesAsync(path, ct); }, default);
        await entered.Task;
        using var cancellation = new CancellationTokenSource();
        var canceled = Read(cache, path, cancellation.Token); cancellation.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => canceled);
        var followers = Enumerable.Range(0, 12).Select(_ => Read(cache, path)).ToArray();
        finish.SetResult(); await first; await Task.WhenAll(followers);
        Assert.Equal(DocumentFileStamp.Read(path) is null ? 13 : 1, cache.Statistics.Loads);
    }
    [Fact]
    public async Task EvictsBytesAtTheBudgetAndRefusesSpecialFilesWithoutOpeningThem()
    {
        var cache = new SourceDocumentWorktreeCache(1024);
        for (var i = 0; i < 12; i++)
        { var path = Path.Combine(root, i + ".md"); await File.WriteAllBytesAsync(path, new byte[200]); await Read(cache, path); }
        Assert.InRange(cache.Statistics.Bytes, 0, 1024);
        if (OperatingSystem.IsWindows()) return;
        var special = Path.Combine(root, "fifo.md");
        var start = new ProcessStartInfo("mkfifo"); start.ArgumentList.Add(special);
        using var process = Process.Start(start)!; await process.WaitForExitAsync(); Assert.Equal(0, process.ExitCode);
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(2));
        var error = await Assert.ThrowsAsync<AppLifecycleException>(() => Read(cache, special, timeout.Token));
        Assert.Equal("source_file_unsupported", error.Code);
    }
}

public sealed partial class CoreLifecycleServiceTests
{
    [Fact]
    public async Task SourceDocuments_WorkspaceRefreshReusesUnchangedFilesAndRevalidatesLinks()
    {
        var (fixture, origin, workspaces, documents) = await DocumentFixtureAsync();
        for (var i = 0; i < 249; i++) await File.WriteAllTextAsync(Path.Combine(origin, "docs", $"page-{i}.md"), "# Cached document\n");
        await RunGitAsync(origin, ["add", "."]); await CommitDocsAsync(origin);
        var tree = await workspaces.PrepareAsync(WorkspaceTestOwner(fixture), WorkspaceRequest(), default);
        var entry = Assert.Single((await documents.ListRepositoriesAsync("admin", default)).Repositories);
        await documents.ListDocumentsAsync(entry.Id, "admin", false, default);
        var timer = Stopwatch.StartNew();
        await documents.ListWorkspacesAsync("admin", entry.Id, default);
        var cold = timer.ElapsedMilliseconds;
        Assert.Equal(250, documents.WorktreeStatistics.Loads);
        timer.Restart();
        await documents.ListWorkspacesAsync("admin", entry.Id, default);
        var warm = timer.ElapsedMilliseconds;
        var cached = DocumentFileStamp.Read(Path.Combine(tree.Path, PlanPath)) is not null;
        Assert.Equal(cached ? 250 : 500, documents.WorktreeStatistics.Loads);
        var loads = documents.WorktreeStatistics.Loads;
        var path = Path.Combine(tree.Path, PlanPath); var modified = File.GetLastWriteTimeUtc(path);
        await File.WriteAllTextAsync(path, PlanText.Replace("Ready", "Draft")); File.SetLastWriteTimeUtc(path, modified);
        var changes = Assert.Single((await documents.ListWorkspacesAsync("admin", entry.Id, default)).Workspaces).Changes!;
        Assert.Equal(PlanPath, Assert.Single(changes).Path);
        Assert.Equal(loads + (cached ? 1 : 250), documents.WorktreeStatistics.Loads);
        if (!OperatingSystem.IsWindows())
        {
            File.Delete(path); File.CreateSymbolicLink(path, Path.Combine(tree.Path, "README.md"));
            Assert.Equal("source_document_path_invalid", (await Assert.ThrowsAsync<AppLifecycleException>(() => documents.ReadContentAsync(entry.Id, "admin",
                new(PlanPath, "worktree", tree.Id, ExpectedSha: "expected"), default))).Code);
        }
        Console.WriteLine($"250-document workspace refresh: cold={cold}ms warm={warm}ms; cached={cached}; one edited document reread.");
    }
}
