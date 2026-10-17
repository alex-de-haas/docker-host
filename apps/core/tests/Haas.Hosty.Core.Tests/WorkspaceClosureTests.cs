using System.Security.Cryptography;
using Haas.Hosty.Core;

namespace Haas.Hosty.Core.Tests;

public sealed partial class CoreLifecycleServiceTests
{
    [Fact]
    public async Task WorkspaceClosure_RestartPreservesDirtySourceAndFencesActivityUntilResume()
    {
        var (f, _) = await SourceFixtureAsync();
        var service = new DevelopmentWorkspaceService(f.Paths, f.Apps, f.Clock);
        var owner = WorkspaceTestOwner(f);
        var lease = Guid.NewGuid().ToString();
        var tree = await service.PrepareAsync(owner, WorkspaceRequest() with { LeaseId = lease }, default);
        var files = new[] { Path.Combine(tree.Path, "README.md"), Path.Combine(tree.Path, "untracked.bin") };
        await File.WriteAllTextAsync(files[0], "unfinished change\n");
        await File.WriteAllBytesAsync(files[1], [0, 1, 255, 8]);
        string[] Hashes() => files.Select(p => Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(p)))).ToArray();
        var hashes = Hashes();
        var close = new WorkspaceWorkflowCommand(Guid.NewGuid().ToString(), 0);
        var heads = new Dictionary<string, string>();
        var pending = await service.ChangeWorkflowAsync(owner, "admin", "close", close, heads, default, prepareOnly: true);
        Assert.Equal("closing", pending.Closure);
        Assert.Equal("in-progress", pending.State);
        Assert.Null(pending.CompletedAt);
        await Assert.ThrowsAsync<AppLifecycleException>(() => service.PrepareAsync(owner, WorkspaceRequest(), default));
        await Assert.ThrowsAsync<AppLifecycleException>(() => service.CommandAsync(tree.Id, owner, "lease", new(Guid.NewGuid().ToString(), LeaseId: Guid.NewGuid().ToString()), default));
        await Assert.ThrowsAsync<AppLifecycleException>(() => service.WorkerLeaseAsync(owner, new(Guid.NewGuid().ToString(), true), default));
        await Assert.ThrowsAsync<AppLifecycleException>(() => service.SetSandboxConsumerAsync(tree.Id, Guid.NewGuid().ToString("N"), true, default));
        await Assert.ThrowsAsync<AppLifecycleException>(() => service.ChangeWorkflowAsync(owner, "admin", "close", close, heads, default));
        service = new DevelopmentWorkspaceService(f.Paths, f.Apps, f.Clock);
        var recovered = await service.WorkflowAsync(owner, default);
        Assert.Equal(close.RequestId, Assert.Single(recovered.Operations!).Id);
        Assert.Contains("lease", recovered.Operations![0].Error, StringComparison.OrdinalIgnoreCase);
        await Assert.ThrowsAsync<AppLifecycleException>(() => service.ChangeWorkflowAsync(owner, "admin", "resume", new(Guid.NewGuid().ToString(), 0), heads, default));
        await service.CommandAsync(tree.Id, owner, "release-lease", new(Guid.NewGuid().ToString(), LeaseId: lease), default);
        var closed = await service.ChangeWorkflowAsync(owner, "admin", "close", close, heads, default);
        Assert.Equal("closed", closed.Closure);
        Assert.Equal("in-progress", closed.State);
        Assert.Equal(1, closed.Revision);
        Assert.Equal(hashes, Hashes());
        await Assert.ThrowsAsync<AppLifecycleException>(() => service.ChangeWorkflowAsync(owner, "admin", "delete", new(Guid.NewGuid().ToString(), 1), heads, default));
        var resumed = await service.ChangeWorkflowAsync(owner, "admin", "resume", new(Guid.NewGuid().ToString(), 1), heads, default);
        Assert.Null(resumed.Closure);
        Assert.Equal(CoreJson.Text(resumed), CoreJson.Text(await service.ChangeWorkflowAsync(owner, "admin", "close", close, heads, default)));
        Assert.Equal(tree.Id, (await service.PrepareAsync(owner, WorkspaceRequest(), default)).Id);
    }

    [Fact]
    public async Task WorkspaceClosure_OtherWorkerBlocksConfirmationAndRetentionCannotRaceClose()
    {
        var (f, _) = await SourceFixtureAsync();
        var service = new DevelopmentWorkspaceService(f.Paths, f.Apps, f.Clock);
        var owner = WorkspaceTestOwner(f);
        var tree = await service.PrepareAsync(owner, WorkspaceRequest(), default);
        var other = owner with { SessionId = "other-session" };
        var lease = Guid.NewGuid().ToString();
        var heads = new Dictionary<string, string>();
        await service.ChangeWorkflowAsync(owner, "admin", "complete", new(Guid.NewGuid().ToString(), 0), heads, default);
        await service.WorkerLeaseAsync(other, new(lease, true), default);
        var close = new WorkspaceWorkflowCommand(Guid.NewGuid().ToString(), 1);
        await Assert.ThrowsAsync<AppLifecycleException>(() => service.ChangeWorkflowAsync(owner, "admin", "close", close, heads, default));
        await Assert.ThrowsAsync<AppLifecycleException>(() => service.WorkerLeaseAsync(owner, new(lease, false), default));
        await Assert.ThrowsAsync<AppLifecycleException>(() => service.ChangeWorkflowAsync(owner, "retention", "delete", new(Guid.NewGuid().ToString(), 1), heads, default));
        Assert.True(Directory.Exists(tree.Path));
        await service.WorkerLeaseAsync(other, new(lease, false), default);
        Assert.Equal("closed", (await service.ChangeWorkflowAsync(owner, "admin", "close", close, heads, default)).Closure);
        await Assert.ThrowsAsync<AppLifecycleException>(() => service.WorkerLeaseAsync(other, new(lease, true), default));
        var resumed = await service.ChangeWorkflowAsync(owner, "admin", "resume", new(Guid.NewGuid().ToString(), 2), heads, default);
        Assert.Null(resumed.CompletedAt);
        Assert.Equal("in-progress", resumed.State);
    }
}
