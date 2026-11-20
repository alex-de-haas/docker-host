namespace Haas.Hosty.Core.Tests;

public sealed partial class CoreLifecycleServiceTests
{
    [Fact]
    public async Task Publication_ObservationScopeCountsExplicitAndWorkspaceReferencesTogether()
    {
        var f = await PublicationFixture();
        await JsonStorage.WriteAsync(Path.Combine(f.F.Paths.CoreRoot, "development/workspaces", f.W.Id + ".json"),
            f.W with { PullRequests = Enumerable.Range(1, 101).Select(number => $"https://github.com/owner/repo/pull/{number}").ToArray() });
        var actor = new PullRequestActor(f.W.Owner.UserId);
        await f.Service.ValidateObservationScopesAsync(actor, [f.W.WorkspaceId, f.W.WorkspaceId], default, 99);
        var error = await Assert.ThrowsAsync<PullRequestException>(() =>
            f.Service.ValidateObservationScopesAsync(actor, [f.W.WorkspaceId], default, 100));
        Assert.Equal("pr_scope_limit", error.Code);
        Assert.Equal(0, f.Provider.Observed);
    }
    [Fact]
    public async Task Publication_DelegatedObservationScopeAllowsAnUnpublishedSiblingAndRechecksThePublisher()
    {
        var f = await PublicationFixture();
        var provider = (await f.F.Apps.GetAppAsync(f.W.Owner.AppId))!;
        var consumer = provider with { Id = "example.consumer", GrantedCorePermissions = [CoreAppPermissions.AgentProviders, CoreAppPermissions.Sources] };
        await f.F.Apps.UpsertAppAsync(consumer);
        await f.F.Apps.UpsertAppAsync(provider with { GrantedCorePermissions = [] });
        var record = (await f.Service.ReadInspectionRecordAsync(f.W.Id, default))!;
        await JsonStorage.WriteAsync(Path.Combine(f.F.Paths.CoreRoot, "development/publications", f.W.Id + ".json"),
            record with { PermissionSource = new(consumer.Id, consumer.InstalledAt) });
        await f.Workspaces.AddPublicationReferenceAsync(f.W.Id, f.W.Owner, "https://github.com/owner/repo/pull/1", default);

        var repository = await CreateGitRepositoryAsync(Path.Combine(f.F.Root, "sibling"));
        var app = (await f.F.Apps.GetAppAsync(SourceTestApp))!;
        await f.F.Apps.UpsertAppAsync(app with { Id = "example.sibling", SourceState = app.SourceState! with { Repository = repository, LocalOverridePath = repository } });
        var sibling = await f.Workspaces.PrepareAsync(f.W.Owner, WorkspaceRequest() with { AppId = "example.sibling" }, default);
        Assert.NotEqual(f.W.Id, sibling.Id);
        Assert.Equal(f.W.WorkspaceId, sibling.WorkspaceId);
        Assert.Empty(sibling.PullRequests);

        var actor = new PullRequestActor(f.W.Owner.UserId);
        await f.Service.ValidateObservationScopesAsync(actor, [f.W.WorkspaceId], default);
        await f.F.Apps.UpsertAppAsync(consumer with { GrantedCorePermissions = [CoreAppPermissions.AgentProviders] });
        var denied = await Assert.ThrowsAsync<PublicationException>(() =>
            f.Service.ValidateObservationScopesAsync(actor, [f.W.WorkspaceId], default));
        Assert.Equal("publication_forbidden", denied.Code);
    }

    [Theory]
    [InlineData("owner/repo", "main", true)]
    [InlineData("foreign/fork", "main", false)]
    [InlineData("owner/repo", "other-target", false)]
    public void Publication_CompactWorkspaceFactsPreserveReferenceRepositoryAndTargetGuards(string repository, string target, bool allowed)
    {
        var summary = new PullRequestSummary("repo-id", 42, "pr-id", "Another task", "https://github.com/owner/repo/pull/42",
            "author", false, false, "open", DateTimeOffset.UnixEpoch, "head", "base", "different-task", target,
            "APPROVED", "CLEAN", 0, new([], 0, "complete"), new("revision"), repository);
        if (allowed)
        {
            var observation = PublicationService.DisplayReferenceObservation(summary, "owner/repo", "main");
            Assert.Equal("head", observation.Head);
            Assert.False(observation.Complete);
            Assert.Null(observation.Reviews);
        }
        else Assert.Equal("publication_pr_mismatch", Assert.Throws<PublicationException>(() =>
            PublicationService.DisplayReferenceObservation(summary, "owner/repo", "main")).Code);
    }
}
