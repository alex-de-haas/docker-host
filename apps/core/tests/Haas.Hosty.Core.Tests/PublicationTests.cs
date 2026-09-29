using Haas.Hosty.Core;
using Microsoft.Extensions.Configuration;

namespace Haas.Hosty.Core.Tests;

public sealed partial class CoreLifecycleServiceTests
{
    private sealed class PublicationProviderFixture : IPublicationProvider
    {
        public string Head = "";
        public string State = "open";
        public bool Complete;
        public bool LoseCreate;
        public int Created;
        public int Merged;
        public PublicationReference? Reference;
        public Task<string> DestinationAsync(UserProviderConnection c, string r, bool fork, CancellationToken ct) => Task.FromResult(r);
        public Task PushAsync(UserProviderConnection c, DevelopmentWorkspace w, string destination, string branch, string head, CancellationToken ct) { Head = head; return Task.CompletedTask; }
        public Task<PublicationReference?> FindAsync(UserProviderConnection c, PublicationRecord r, CancellationToken ct) => Task.FromResult(r.History.Any(h => h.Number == Reference?.Number) ? null : Reference);
        public Task<PublicationReference> PublishAsync(UserProviderConnection c, PublicationRecord r, PublicationCommand input, CancellationToken ct)
        {
            if (r.Number is null) { Created++; Reference = new(42, "https://github.com/owner/repo/pull/42", Head, null); }
            if (LoseCreate) { LoseCreate = false; throw new HttpRequestException("Lost provider response"); }
            return Task.FromResult(Reference!);
        }
        public Task<PublicationObservation> ObserveAsync(UserProviderConnection c, PublicationRecord r, CancellationToken ct) => Task.FromResult(new PublicationObservation(DateTimeOffset.UtcNow, State, Head, "main", "merge-sha", MergeState: "CLEAN", ReviewDecision: "APPROVED", Complete: Complete, Checks: [new("CI", "SUCCESS")]));
        public Task MergeAsync(UserProviderConnection c, PublicationRecord r, string head, string method, CancellationToken ct) { Assert.Equal(Head, head); State = "merged"; Merged++; return Task.CompletedTask; }
        public Task ReadyAsync(UserProviderConnection c, PublicationRecord r, CancellationToken ct) => Task.CompletedTask;
        public Task ResolveReviewAsync(UserProviderConnection c, PublicationRecord r, string threadId, string head, CancellationToken ct) => Task.CompletedTask;
        public Task<PublicationIdentity> IdentityAsync(UserProviderConnection c, CancellationToken ct) => Task.FromResult(new PublicationIdentity("Verified Author", "verified@example.test"));
    }
    private static async Task<(LifecycleFixture F, DevelopmentWorkspaceService Workspaces, PublicationService Service, PublicationProviderFixture Provider, DevelopmentWorkspace W, UserDirectoryStore Users)> PublicationFixture()
    {
        var (f, _) = await SourceFixtureAsync();
        var owner = WorkspaceTestOwner(f);
        var workspaces = new DevelopmentWorkspaceService(f.Paths, f.Apps, f.Clock);
        var w = await workspaces.PrepareAsync(owner, WorkspaceRequest(), default);
        var app = (await f.Apps.GetAppAsync(SourceTestApp))!;
        await f.Apps.UpsertAppAsync(app with { Id = owner.AppId, InstalledAt = owner.Installation, GrantedCorePermissions = [CoreAppPermissions.Publication, CoreAppPermissions.Workspaces] });
        var users = new UserDirectoryStore(f.Paths);
        await users.WriteAsync(new(1, [new(owner.UserId, "admin@example.test", "Admin", "host.admin", false, f.Clock.UtcNow, f.Clock.UtcNow)], [], [], [],
            ProviderConnections: [new("connection", owner.UserId, "GitHub", "github", "", "", "42", "owner", "pat", "secret-for-fixture", null, null, null, f.Clock.UtcNow, null, "connected", "r1")]));
        var connections = new UserConnectionService(users, new UserConnectionProvider(new HttpClient(), new ConfigurationBuilder().Build(), f.Clock), f.Clock, new AuditStore(f.Paths), f.CoreSettings);
        var provider = new PublicationProviderFixture { Head = w.Observation!.Head! };
        var service = new PublicationService(f.Paths, workspaces, connections, provider, f.Apps, users, f.Clock, new AuditStore(f.Paths));
        // Seed the configured provider binding; local Git fixtures intentionally use an offline origin.
        await JsonStorage.WriteAsync(Path.Combine(f.Paths.CoreRoot, "development", "publications", w.Id + ".json"), new PublicationRecord {
            WorkspaceId = w.Id, Owner = owner, Repository = "owner/repo", HeadRepository = "owner/repo", ConnectionId = "connection", Branch = w.Branch, TargetBranch = "main" });
        return (f, workspaces, service, provider, w, users);
    }
    [Fact]
    public async Task Publication_LostCreateResponseRecoversWithoutAnotherPrAndRejectsChangedRequest()
    {
        var f = await PublicationFixture();
        f.Provider.LoseCreate = true;
        var input = new PublicationCommand(Guid.NewGuid().ToString(), f.W.Observation!.Head, Title: "Feature", Body: "Changes");
        await Assert.ThrowsAsync<HttpRequestException>(() => f.Service.CommandAsync(f.W.Id, f.W.Owner, "publish", input, default));
        Assert.Equal("pending", Assert.Single((await f.Service.ListAsync(f.W.Owner, default)).Publications).Operations.Last().State);
        await Assert.ThrowsAsync<PublicationException>(() => f.Service.CommandAsync(f.W.Id, f.W.Owner, "publish", input with { Title = "Changed" }, default));
        var result = await f.Service.CommandAsync(f.W.Id, f.W.Owner, "publish", input, default);
        Assert.Equal(1, f.Provider.Created); Assert.Equal(42, result.Number);
        Assert.Equal("succeeded", result.Operations.Last().State);
        Assert.Contains(result.Url!, (await f.Workspaces.ObserveAsync(f.W.Id, f.W.Owner, default)).PullRequests);
        Assert.DoesNotContain("secret-for-fixture", CoreJson.Text(result));
    }
    [Fact]
    public async Task Publication_CompleteWaitsForMergeEvidenceThenRetainsFactsAfterCleanup()
    {
        var f = await PublicationFixture();
        var head = f.W.Observation!.Head;
        await f.Service.CommandAsync(f.W.Id, f.W.Owner, "publish", new(Guid.NewGuid().ToString(), head, Title: "Feature"), default);
        await f.Service.CommandAsync(f.W.Id, f.W.Owner, "merge", new(Guid.NewGuid().ToString(), head), default);
        Assert.Equal(1, f.Provider.Merged);
        var complete = new PublicationCommand(Guid.NewGuid().ToString(), head, Outcome: "merged", Cleanup: true);
        await Assert.ThrowsAsync<PublicationException>(() => f.Service.CommandAsync(f.W.Id, f.W.Owner, "complete", complete, default));
        f.Provider.Complete = true;
        await f.Service.CommandAsync(f.W.Id, f.W.Owner, "complete", complete, default);
        await f.Service.CleanupAsync(f.W.Id, default);
        Assert.False(Directory.Exists(f.W.Path));
        Assert.Equal("released", (await f.Workspaces.ObserveAsync(f.W.Id, f.W.Owner, default)).State);
        var retained = await f.Service.ObserveAsync(f.W.Id, f.W.Owner, default);
        Assert.Equal(42, retained.Number); Assert.Equal("merged", retained.Outcome);
    }
    [Fact]
    public async Task Publication_SubmittedCleanupRefusesDirtyFilesAndActiveLease()
    {
        var f = await PublicationFixture(); var head = f.W.Observation!.Head;
        await f.Service.CommandAsync(f.W.Id, f.W.Owner, "publish", new(Guid.NewGuid().ToString(), head, Title: "Contribution"), default);
        await f.Service.CommandAsync(f.W.Id, f.W.Owner, "complete", new(Guid.NewGuid().ToString(), head, Outcome: "submitted", Cleanup: true), default);
        var lease = Guid.NewGuid().ToString();
        await f.Workspaces.CommandAsync(f.W.Id, f.W.Owner, "lease", new(Guid.NewGuid().ToString(), LeaseId: lease), default);
        await Assert.ThrowsAsync<AppLifecycleException>(() => f.Service.CleanupAsync(f.W.Id, default));
        await f.Workspaces.CommandAsync(f.W.Id, f.W.Owner, "release-lease", new(Guid.NewGuid().ToString(), LeaseId: lease), default);
        await File.WriteAllTextAsync(Path.Combine(f.W.Path, "pending.txt"), "preserve");
        await Assert.ThrowsAsync<AppLifecycleException>(() => f.Service.CleanupAsync(f.W.Id, default));
        File.Delete(Path.Combine(f.W.Path, "pending.txt"));
        await f.Service.CleanupAsync(f.W.Id, default);
        Assert.Equal("submitted", (await f.Service.ObserveAsync(f.W.Id, f.W.Owner, default)).Outcome);
        Assert.Equal(0, f.Provider.Merged);
    }
    [Fact]
    public async Task Publication_RevokedConnectionAndDifferentSessionCannotObserveOrMutate()
    {
        var f = await PublicationFixture();
        await Assert.ThrowsAsync<PublicationException>(() => f.Service.ObserveAsync(f.W.Id, f.W.Owner with { SessionId = "other" }, default));
        await f.Users.UpdateAsync(s => s with { ProviderConnections = [] });
        var unavailable = await f.Service.ObserveAsync(f.W.Id, f.W.Owner, default);
        Assert.Equal("unavailable", unavailable.Observation!.State);
        await Assert.ThrowsAsync<UserConnectionException>(() => f.Service.CommandAsync(f.W.Id, f.W.Owner, "publish", new(Guid.NewGuid().ToString(), f.W.Observation!.Head, Title: "Feature"), default));
        Assert.Equal(0, f.Provider.Created);
    }
    [Fact]
    public async Task Publication_RevokedInstallationGrantStopsCommandsAndBackgroundReads()
    {
        var f = await PublicationFixture();
        var assistant = (await f.F.Apps.GetAppAsync(f.W.Owner.AppId))!;
        await f.F.Apps.UpsertAppAsync(assistant with { GrantedCorePermissions = [CoreAppPermissions.Workspaces] });
        var error = await Assert.ThrowsAsync<PublicationException>(() => f.Service.CommandAsync(f.W.Id, f.W.Owner, "publish", new(Guid.NewGuid().ToString(), f.W.Observation!.Head, Title: "Feature"), default));
        Assert.Equal("publication_forbidden", error.Code);
        Assert.Equal("unavailable", (await f.Service.ObserveAsync(f.W.Id, null, default)).Observation!.State);
        Assert.Equal(0, f.Provider.Created);
    }
    [Fact]
    public async Task Publication_CommitUsesVerifiedIdentityAndRecordsContributors()
    {
        var f = await PublicationFixture();
        await File.WriteAllTextAsync(Path.Combine(f.W.Path, "README.md"), "implemented");
        var input = new PublicationCommand(Guid.NewGuid().ToString(), f.W.Observation!.Head, Message: "feat: implement feature", Paths: ["README.md"], Contributors: ["Codex <noreply@openai.com>"]);
        var committed = await f.Service.CommandAsync(f.W.Id, f.W.Owner, "commit", input, default);
        var log = await RunGitAsync(f.W.Path, ["log", "-1", "--format=%an <%ae>%n%B"]);
        Assert.Contains("Verified Author <verified@example.test>", log);
        Assert.Contains("Co-Authored-By: Codex <noreply@openai.com>", log);
        Assert.Single(committed.Contributors);
        var repeated = await f.Service.CommandAsync(f.W.Id, f.W.Owner, "commit", input, default);
        Assert.Single(repeated.Operations);
    }
    [Fact]
    public async Task Publication_CorrectiveCycleKeepsPriorPrAndChangesRemoteBranch()
    {
        var f = await PublicationFixture(); var head = f.W.Observation!.Head;
        await f.Service.CommandAsync(f.W.Id, f.W.Owner, "publish", new(Guid.NewGuid().ToString(), head, Title: "Feature"), default);
        f.Provider.State = "merged";
        var corrective = await f.Service.CommandAsync(f.W.Id, f.W.Owner, "corrective", new(Guid.NewGuid().ToString(), head), default);
        Assert.Null(corrective.Number); Assert.Null(corrective.PublishedHead);
        Assert.Equal(42, Assert.Single(corrective.History).Number);
        Assert.NotEqual(f.W.Branch, corrective.Branch);
    }
    [Fact]
    public async Task Publication_RejectsCyclesAndMissingOtherWorkspaceDisposition()
    {
        var f = await PublicationFixture();
        await Assert.ThrowsAsync<PublicationException>(() => f.Service.CommandAsync(f.W.Id, f.W.Owner, "configure", new(Guid.NewGuid().ToString(), Dependencies: [f.W.Id]), default));
        var otherRepo = await CreateGitRepositoryAsync(Path.Combine(f.F.Root, "other-repo"));
        var app = (await f.F.Apps.GetAppAsync(SourceTestApp))!;
        await f.F.Apps.UpsertAppAsync(app with { Id = "other-app", SourceState = app.SourceState! with { Repository = otherRepo, LocalOverridePath = otherRepo } });
        await f.Workspaces.PrepareAsync(f.W.Owner, WorkspaceRequest() with { AppId = "other-app" }, default);
        await f.Service.CommandAsync(f.W.Id, f.W.Owner, "publish", new(Guid.NewGuid().ToString(), f.W.Observation!.Head, Title: "Feature"), default);
        var error = await Assert.ThrowsAsync<PublicationException>(() => f.Service.CommandAsync(f.W.Id, f.W.Owner, "complete", new(Guid.NewGuid().ToString(), f.W.Observation.Head, Outcome: "submitted"), default));
        Assert.Equal("publication_session_unpublished", error.Code);
    }
    [Fact]
    public async Task Publication_UnpublishedAbandonmentIsExplicitAndPreservesWork()
    {
        var f = await PublicationFixture();
        var input = new PublicationCommand(Guid.NewGuid().ToString(), f.W.Observation!.Head, Outcome: "abandoned", Cleanup: true);
        await Assert.ThrowsAsync<PublicationException>(() => f.Service.CommandAsync(f.W.Id, f.W.Owner, "complete", input, default));
        var result = await f.Service.CommandAsync(f.W.Id, f.W.Owner, "complete", input with { RequestId = Guid.NewGuid().ToString(), Cleanup = false }, default);
        Assert.Equal("abandoned", result.Outcome);
        Assert.Null(result.Number);
        Assert.True(Directory.Exists(f.W.Path));
        Assert.Equal(0, f.Provider.Created);
    }
    [Fact]
    public void Publication_MergeRequiresFreshMatchingSuccessfulEvidence()
    {
        var good = new PublicationObservation(DateTimeOffset.UtcNow, "open", "head", MergeState: "CLEAN", ReviewDecision: "APPROVED", Checks: [new("test", "SUCCESS")]);
        PublicationService.RequireMerge(good, "head");
        foreach (var bad in new[] { good with { Head = "old" }, good with { Draft = true }, good with { MergeState = "UNKNOWN" }, good with { UnresolvedThreads = 1 }, good with { ReviewDecision = "CHANGES_REQUESTED" }, good with { Checks = [new("test", "PENDING")] }, good with { Checks = null } })
            Assert.Throws<PublicationException>(() => PublicationService.RequireMerge(bad, "head"));
    }
}
