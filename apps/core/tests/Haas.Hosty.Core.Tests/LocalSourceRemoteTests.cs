using Haas.Hosty.Core;
using Microsoft.Extensions.Configuration;

namespace Haas.Hosty.Core.Tests;

public sealed partial class CoreLifecycleServiceTests
{
    // Real local Git exercises refs and worktree preservation; only authenticated transport is replaced.
    private sealed class RemoteGitFixture(string remote) : ISourceGitAccess
    {
        public const string Url = "https://github.com/owner/repo.git";
        public Func<Task>? BeforeValidate;
        public Task<T> WithConnectionAsync<T>(SourceReadGrant grant, Func<UserProviderConnection, Task<T>> action, CancellationToken ct)
            => Connections is not null ? Connections.UseForSourceAsync(grant.OwnerId, grant.ConnectionId, action, ct)
                : action(new(grant.ConnectionId, grant.OwnerId, grant.Label, grant.Provider, "", "", "42", "owner", "pat", "fixture", null, null, null, DateTimeOffset.UtcNow, null, "connected", "1"));
        public UserConnectionService? Connections;
        public bool Revoked;
        public bool LosePush;
        public bool FailRead;
        public int Pushes;
        public string NormalizeRepository(string value) => value is Url or "https://github.com/owner/repo"
            ? Url : throw PrivateSourceService.Denied();
        public Task<SourceReadGrant> BindAsync(string owner, string id, string url, bool manifest, CancellationToken ct)
            => Task.FromResult(new SourceReadGrant(owner, id, "github", "owner", "Test", NormalizeRepository(url)));
        public async Task ValidateAsync(PrivateSourceAccess? access, CancellationToken ct)
        {
            if (BeforeValidate is not null) await BeforeValidate();
            if (Revoked) throw PrivateSourceService.Denied();
        }
        public async Task<string> GitWithConnectionAsync(SourceReadGrant grant, string repository, string? directory, IReadOnlyList<string> args, UserProviderConnection connection, CancellationToken ct)
        {
            Assert.Equal(grant.OwnerId, connection.UserId); Assert.Equal(grant.ConnectionId, connection.Id);
            if (FailRead && args[0] == "ls-remote") throw new HttpRequestException("Offline");
            if (args[0] == "push") { Assert.Contains("--force-with-lease=refs/heads/qa/base:", args); Pushes++; }
            var result = await DevelopmentWorkspaceService.Git(directory!, args.Select(a => a == Url ? remote : a).ToArray(), ct);
            if (LosePush && args[0] == "push") { LosePush = false; throw new HttpRequestException("Lost push response"); }
            return result.StandardOutput.Trim();
        }
        public async Task<string> GitAsync(SourceReadGrant grant, string repository, string? directory, IReadOnlyList<string> args, CancellationToken ct)
        {
            await ValidateAsync(new(Git: grant), ct);
            Assert.Equal(Url, repository); Assert.Equal(Url, grant.Repository);
            if (FailRead && args[0] == "ls-remote") throw new HttpRequestException("Offline");
            if (args[0] == "push") { Assert.Contains("--force-with-lease=refs/heads/qa/base:", args); Assert.DoesNotContain(args, a => a == "--force" || a.StartsWith('+')); Pushes++; }
            var result = await DevelopmentWorkspaceService.Git(directory!, args.Select(a => a == Url ? remote : a).ToArray(), ct);
            if (LosePush && args[0] == "push") { LosePush = false; throw new HttpRequestException("Lost push response"); }
            return result.StandardOutput.Trim();
        }
    }
    private static async Task<(LifecycleFixture F, DevelopmentWorkspaceService Service, DevelopmentWorkspace W, RemoteGitFixture Git, string Remote, string Source)> LocalRemoteFixture()
    {
        var f = await LifecycleFixture.CreateAsync();
        var owner = WorkspaceTestOwner(f);
        var created = await f.Service.CreateLocalAppAsync(owner, NewApp(), null, default);
        var remote = Path.Combine(f.Root, "remote.git"); Directory.CreateDirectory(remote);
        await DevelopmentWorkspaceService.Git(remote, ["init", "--bare"], default);
        var git = new RemoteGitFixture(remote);
        var service = new DevelopmentWorkspaceService(f.Paths, f.Apps, f.Clock, privateSources: git);
        var w = await service.PrepareAsync(owner, new(Guid.NewGuid().ToString(), owner.SessionId, "test.created", "/assistant"), default);
        return (f, service, w, git, remote, created.Operation.SourcePath);
    }
    private static LocalRemoteCommand RemoteRequest() => new(Guid.NewGuid().ToString(), "test.created", RemoteGitFixture.Url, "connection", "qa/base");

    [Fact]
    public async Task LocalRemote_ConnectFetchAndNewSessionPreserveLocalIdentityAndDirtyFiles()
    {
        var f = await LocalRemoteFixture(); var w = f.W;
        Assert.Null((await f.Service.RemoteStatusAsync(w.Id, w.Owner, "test.created", default)).Remote);
        await File.WriteAllTextAsync(Path.Combine(w.Path, "keep.txt"), "unfinished");
        var input = RemoteRequest();
        var connected = await f.Service.RemoteCommandAsync(w.Id, w.Owner, "connect", input, default);
        Assert.Equal("missing", connected.Observation!.State);
        Assert.Equal("succeeded", connected.Operation!.State);
        Assert.Equal(f.Source, (await f.F.Apps.GetAppAsync("test.created"))!.SourceState!.Repository);
        var current = await f.Service.ObserveAsync(w.Id, w.Owner, default);
        Assert.Equal(w.Repository, current.Repository); Assert.Equal(w.Id, current.Id); Assert.Equal(w.Path, current.Path);
        Assert.Equal(w.Observation!.Head, current.Observation!.Head);
        Assert.Equal("unfinished", await File.ReadAllTextAsync(Path.Combine(w.Path, "keep.txt")));
        Assert.Equal("", (await DevelopmentWorkspaceService.Git(f.Source, ["remote"], default)).StandardOutput);
        Assert.Equal("succeeded", (await f.Service.RemoteCommandAsync(w.Id, w.Owner, "connect", input, default)).Operation!.State);
        var owner = w.Owner with { SessionId = "second-session" };
        var second = await f.Service.PrepareAsync(owner, new(Guid.NewGuid().ToString(), owner.SessionId, "test.created", "/assistant"), default);
        Assert.Equal(connected.Remote, (await f.Service.RemoteStatusAsync(second.Id, owner, "test.created", default)).Remote);
        Assert.Equal(w.RepositoryId, second.RepositoryId);
    }

    [Fact]
    public async Task LocalRemote_LostBasePushResponseRecoversOnceAfterServiceRestart()
    {
        var f = await LocalRemoteFixture(); var w = f.W;
        await f.Service.RemoteCommandAsync(w.Id, w.Owner, "connect", RemoteRequest(), default);
        var input = new LocalRemoteCommand(Guid.NewGuid().ToString(), "test.created", ExpectedTargetHead: w.OriginalBase);
        f.Git.LosePush = true;
        await Assert.ThrowsAsync<HttpRequestException>(() => f.Service.RemoteCommandAsync(w.Id, w.Owner, "push-base", input, default));
        Assert.Equal("pending", (await f.Service.Read(w.Id, w.Owner, default)).Operations.Last().State);
        var restarted = new DevelopmentWorkspaceService(f.F.Paths, f.F.Apps, f.F.Clock, privateSources: f.Git);
        var recovered = await restarted.RemoteCommandAsync(w.Id, w.Owner, "push-base", input, default);
        Assert.Equal("succeeded", recovered.Operation!.State); Assert.Equal(1, f.Git.Pushes);
        Assert.Equal(w.OriginalBase, recovered.Observation!.Head);
        Assert.True(recovered.Observation.Related);
        Assert.Equal(w.OriginalBase, (await restarted.ObserveAsync(w.Id, w.Owner, default)).Observation!.TargetHead);
        await Assert.ThrowsAsync<AppLifecycleException>(() => restarted.RemoteCommandAsync(w.Id, w.Owner, "push-base", input with { ExpectedTargetHead = new string('a', 40) }, default));
    }

    [Fact]
    public async Task LocalRemote_RefusalsAndReadFailurePreserveSourceAndAllowExactRetry()
    {
        var f = await LocalRemoteFixture(); var w = f.W;
        var input = RemoteRequest();
        f.Git.FailRead = true;
        await Assert.ThrowsAsync<HttpRequestException>(() => f.Service.RemoteCommandAsync(w.Id, w.Owner, "connect", input, default));
        Assert.Null((await f.F.Apps.GetAppAsync("test.created"))!.SourceState!.Remote);
        f.Git.FailRead = false;
        await f.Service.RemoteCommandAsync(w.Id, w.Owner, "connect", input, default);
        await Assert.ThrowsAsync<AppLifecycleException>(() => f.Service.RemoteCommandAsync(w.Id, w.Owner, "connect", RemoteRequest() with { TargetBranch = "another" }, default));
        await Assert.ThrowsAsync<AppLifecycleException>(() => f.Service.RemoteStatusAsync(w.Id, w.Owner with { UserId = "other" }, "test.created", default));
        f.Git.Revoked = true;
        await Assert.ThrowsAsync<AppLifecycleException>(() => f.Service.RemoteCommandAsync(w.Id, w.Owner, "connect", input, default));
        f.Git.Revoked = false;
        await f.F.Apps.UpdateAppAsync("test.created", a => a with { SourceState = a.SourceState! with { LocalOverridePath = Path.Combine(f.F.Root, "other-source") } });
        await Assert.ThrowsAsync<AppLifecycleException>(() => f.Service.RemoteCommandAsync(w.Id, w.Owner, "fetch", new(Guid.NewGuid().ToString(), "test.created"), default));
        Assert.True(File.Exists(Path.Combine(f.Source, "manifest.json"))); Assert.True(Directory.Exists(w.Path));
    }

    [Fact]
    public async Task LocalRemote_NonemptyUnrelatedHistoryIsObservedWithoutPullAndCannotBeOverwritten()
    {
        var f = await LocalRemoteFixture(); var w = f.W;
        var unrelated = await CreateGitRepositoryAsync(f.F.Root);
        await DevelopmentWorkspaceService.Git(unrelated, ["push", f.Remote, "HEAD:refs/heads/qa/base"], default);
        var connected = await f.Service.RemoteCommandAsync(w.Id, w.Owner, "connect", RemoteRequest(), default);
        Assert.False(connected.Observation!.Related);
        Assert.NotEqual(w.OriginalBase, connected.Observation.Head);
        await Assert.ThrowsAsync<AppLifecycleException>(() => f.Service.RemoteCommandAsync(w.Id, w.Owner, "push-base",
            new(Guid.NewGuid().ToString(), "test.created", ExpectedTargetHead: w.OriginalBase), default));
        await Assert.ThrowsAsync<AppLifecycleException>(() => f.Service.RequireRemotePublicationAsync(w, "owner/repo", "qa/base", "connection", GitHubPublicationProvider.Repository, default));
        Assert.Equal(w.OriginalBase, (await f.Service.ObserveAsync(w.Id, w.Owner, default)).Observation!.Head);
        Assert.Equal(0, f.Git.Pushes);
        var merge = WorkspaceCommit(w.OriginalBase, "Merge reviewed upstream") with { ExpectedRemoteHead = connected.Observation.Head, AllowUnrelatedHistories = true };
        var integrated = await f.Service.CommandAsync(w.Id, w.Owner, "merge-upstream", merge, default);
        Assert.Equal("succeeded", integrated.Operations.Last().State);
        Assert.Equal(w.IntegrationBase, integrated.IntegrationBase);
        Assert.Equal(w.OriginalBase, integrated.Observation!.TargetHead);
        await f.Service.RequireRemotePublicationAsync(integrated, "owner/repo", "qa/base", "connection", GitHubPublicationProvider.Repository, default);
    }

    [Fact]
    public async Task LocalRemote_PublicationKeepsCanonicalTargetAndTracksSeparatePushPrCiAndReview()
    {
        var f = await LocalRemoteFixture(); var w = f.W;
        await f.Service.RemoteCommandAsync(w.Id, w.Owner, "connect", RemoteRequest(), default);
        await f.Service.RemoteCommandAsync(w.Id, w.Owner, "push-base", new(Guid.NewGuid().ToString(), "test.created", ExpectedTargetHead: w.OriginalBase), default);
        var app = (await f.F.Apps.GetAppAsync("test.created"))!;
        await f.F.Apps.UpsertAppAsync(app with { Id = w.Owner.AppId, InstalledAt = w.Owner.Installation, GrantedCorePermissions = [CoreAppPermissions.Sources] });
        var users = new UserDirectoryStore(f.F.Paths);
        await users.WriteAsync(new(1, [new(w.Owner.UserId, "admin@example.test", "Admin", "host.admin", false, f.F.Clock.UtcNow, f.F.Clock.UtcNow)], [], [], [],
            ProviderConnections: [new("connection", w.Owner.UserId, "GitHub", "github", "", "", "42", "owner", "pat", "secret-for-fixture", null, null, null, f.F.Clock.UtcNow, null, "connected", "r1")]));
        var provider = new PublicationProviderFixture { Head = w.OriginalBase };
        var connections = new UserConnectionService(users, new SourceProviderRegistry([new GitHubSourceProvider(new HttpClient(), new ConfigurationBuilder().Build(), f.F.Clock, provider)]), f.F.Clock, new AuditStore(f.F.Paths), f.F.CoreSettings);
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(40));
        f.Git.Connections = connections;
        f.Git.BeforeValidate = async () => { await connections.UseForSourceAsync(w.Owner.UserId, "connection", _ => Task.FromResult(true), deadline.Token); };
        var publications = new PublicationService(f.F.Paths, f.Service, connections, f.F.Apps, users, f.F.Clock, new AuditStore(f.F.Paths));
        var configured = await publications.CommandAsync(w.Id, w.Owner, "configure", new(Guid.NewGuid().ToString(), ConnectionId: "connection"), default);
        Assert.Equal("owner/repo", configured.Repository); Assert.Equal("qa/base", configured.TargetBranch);
        await File.WriteAllTextAsync(Path.Combine(w.Path, "feature.txt"), "local feature");
        var committed = await f.Service.CommandAsync(w.Id, w.Owner, "commit", WorkspaceCommit(w.OriginalBase, "feat: local feature", "feature.txt"), default);
        var head = committed.Observation!.Head!;
        var push = new PublicationCommand(Guid.NewGuid().ToString(), head);
        provider.PushFailure = "lost";
        await Assert.ThrowsAsync<HttpRequestException>(() => publications.CommandAsync(w.Id, w.Owner, "push", push, default));
        provider.PushFailure = null;
        var pushed = await publications.CommandAsync(w.Id, w.Owner, "push", push, default);
        Assert.Null(pushed.Number); Assert.Equal(head, pushed.PublishedHead); Assert.Equal(0, provider.Created);
        provider.LoseCreate = true;
        var publish = new PublicationCommand(Guid.NewGuid().ToString(), head, Title: "Feature", Body: "Review local work");
        await Assert.ThrowsAsync<HttpRequestException>(() => publications.CommandAsync(w.Id, w.Owner, "publish", publish, default));
        var result = await publications.CommandAsync(w.Id, w.Owner, "publish", publish, default);
        await Task.WhenAll(
            publications.CommandAsync(w.Id, w.Owner, "push", new(Guid.NewGuid().ToString(), head), deadline.Token),
            f.Service.RemoteCommandAsync(w.Id, w.Owner, "fetch", new(Guid.NewGuid().ToString(), "test.created"), deadline.Token),
            f.Service.RemoteStatusAsync(w.Id, w.Owner, "test.created", deadline.Token));
        Assert.Equal(1, provider.Created); Assert.Equal(42, result.Number);
        Assert.Equal("SUCCESS", Assert.Single(result.Observation!.Checks!).State); Assert.NotEmpty(result.Observation.Reviews!);
        var inspection = new WorkspaceInspectionService(f.Service, f.F.Apps, f.F.Clock, publications, users, connections);
        var detail = await inspection.ReadAsync(w.WorkspaceId, w.Id, w.Owner.UserId, default);
        var shown = Assert.Single(detail.PullRequests);
        Assert.Equal("SUCCESS", Assert.Single(shown.Observation!.Checks!).State);
        Assert.Null(shown.Observation.Reviews);
        f.Git.Revoked = true;
        Assert.Null(Assert.Single((await inspection.ReadAsync(w.WorkspaceId, w.Id, w.Owner.UserId, default)).PullRequests).Observation);
        f.Git.Revoked = false;
        Assert.Equal("main", (await f.Service.Read(w.Id, w.Owner, default)).TargetBranch);
        Assert.Equal(w.OriginalBase, (await f.Service.ObserveAsync(w.Id, w.Owner, default)).Observation!.TargetHead);
        Assert.True(File.Exists(Path.Combine(w.Path, "feature.txt")));
        Assert.False(File.Exists(Path.Combine(f.Source, "feature.txt")));
    }
}
