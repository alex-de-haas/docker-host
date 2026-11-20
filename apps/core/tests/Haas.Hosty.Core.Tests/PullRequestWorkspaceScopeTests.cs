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

    [Fact]
    public async Task Publication_ObservationScopeUsesTheSameUsersConfiguringProviderAcrossSessions()
    {
        var creator = new WorkspaceOwner("example.creator", DateTimeOffset.UnixEpoch, "admin", "session-a");
        var f = await ExternalPublicationFixture(creator);
        var template = (await f.F.Apps.GetAppAsync(SourceTestApp))!;
        var creatorApp = template with { Id = creator.AppId, InstalledAt = creator.Installation, GrantedCorePermissions = [] };
        var publisherApp = template with { Id = "example.publisher", GrantedCorePermissions = [] };
        var consumer = template with { Id = "example.consumer", GrantedCorePermissions = [CoreAppPermissions.AgentProviders, CoreAppPermissions.Sources, CoreAppPermissions.PublicationWrite] };
        await f.F.Apps.UpsertAppAsync(creatorApp);
        await f.F.Apps.UpsertAppAsync(publisherApp);
        await f.F.Apps.UpsertAppAsync(consumer);
        var publisher = new WorkspaceOwner(publisherApp.Id, publisherApp.InstalledAt, creator.UserId, "session-b");
        var source = new CoreAppPermissionSource(consumer.Id, consumer.InstalledAt);
        var configured = await f.Service.CommandAsync(f.W.Id, publisher, "configure",
            new(Guid.NewGuid().ToString(), ConnectionId: "connection"), default, canonical: true, permissionSource: source);
        Assert.Equal(publisher, configured.Owner);
        await f.Service.CommandAsync(f.W.Id, publisher, "link", new(Guid.NewGuid().ToString(), Number: 42),
            default, canonical: true, permissionSource: source);

        var actor = new PullRequestActor(creator.UserId);
        await f.Service.ValidateObservationScopesAsync(actor, [f.W.WorkspaceId], default);
        var inspection = new WorkspaceInspectionService(f.Workspaces, f.F.Apps, f.F.Clock, f.Service, f.Users, f.Connections);
        var displayed = Assert.Single(await inspection.PullRequestsAsync(f.W, creator.UserId, default));
        Assert.Equal(f.Provider.Head, displayed.Observation?.Head);
        await f.Users.UpdateAsync(state => state with { Users = [.. state.Users, state.Users[0] with { Id = "another-admin" }] });
        var other = await Assert.ThrowsAsync<PullRequestException>(() =>
            f.Service.ValidateObservationScopesAsync(new("another-admin"), [f.W.WorkspaceId], default));
        Assert.Equal("pr_scope_forbidden", other.Code);
        Assert.Null(Assert.Single(await inspection.PullRequestsAsync(f.W, "another-admin", default)).Observation);

        await f.F.Apps.UpsertAppAsync(creatorApp with { GrantedCorePermissions = [CoreAppPermissions.Sources] });
        await f.F.Apps.RemoveAppAsync(publisherApp.Id);
        var denied = await Assert.ThrowsAsync<PublicationException>(() =>
            f.Service.ValidateObservationScopesAsync(actor, [f.W.WorkspaceId], default));
        Assert.Equal("publication_forbidden", denied.Code);
        Assert.Null(Assert.Single(await inspection.PullRequestsAsync(f.W, creator.UserId, default)).Observation);
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
