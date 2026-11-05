using Microsoft.Extensions.Logging.Abstractions;

namespace Haas.Hosty.Core.Tests;

public sealed partial class CoreLifecycleServiceTests
{
    [Fact]
    public async Task PullRequestStream_UnrelatedWorkspaceObservation_DoesNotInvalidateSelectedWorkspace()
    {
        var f = await PublicationFixture();
        var service = new PullRequestService(f.F.Paths, new(f.F.Apps, f.Users, f.Connections, f.F.Clock),
            f.Connections, f.F.Clock, NullLogger<PullRequestService>.Instance, f.Service, null!);
        var recordPath = Path.Combine(f.F.Paths.CoreRoot, "development/publications", f.W.Id + ".json");
        var record = (await JsonStorage.ReadAsync<PublicationRecord>(recordPath))!;
        await JsonStorage.WriteAsync(recordPath, record with { Number = 1 });
        var actor = new PullRequestActor(f.W.Owner.UserId);
        var ticket = await service.SubscribeAsync(actor, new(Workspaces: [f.W.WorkspaceId]), default);
        using var stream = service.Admit(actor, ticket.Id);
        await service.TickAsync(default);
        Assert.Equal(1, f.Provider.Observed);
        var before = await service.StreamStateAsync(actor, ticket.Id, default);
        var otherOwner = f.W.Owner with { SessionId = "other-session" };
        var other = await f.Workspaces.PrepareAsync(otherOwner, WorkspaceRequest("other-session"), default);
        await JsonStorage.WriteAsync(Path.Combine(f.F.Paths.CoreRoot, "development/publications", other.Id + ".json"), new PublicationRecord {
            WorkspaceId = other.Id, Owner = otherOwner, Repository = "owner/repo", HeadRepository = "owner/repo",
            ConnectionId = "connection", Branch = other.Branch, TargetBranch = "main", Number = 2 });
        f.F.Clock.UtcNow += TimeSpan.FromSeconds(31);
        var ownerRevision = service.CurrentRevision(actor);
        await service.TickAsync(default);
        Assert.Equal(2, f.Provider.Observed);
        Assert.NotEqual(ownerRevision, service.CurrentRevision(actor));
        Assert.Equal(before.Revision, (await service.StreamStateAsync(actor, ticket.Id, default)).Revision);
        f.F.Clock.UtcNow += TimeSpan.FromSeconds(35);
        await service.TickAsync(default);
        Assert.Equal(3, f.Provider.Observed);
        Assert.NotEqual(before.Revision, (await service.StreamStateAsync(actor, ticket.Id, default)).Revision);
    }

    [Fact]
    public async Task PullRequestWorkspace_ManualRefreshQueuesProviderReadAndHonorsCooldownAndAuthority()
    {
        var f = await PublicationFixture();
        var service = new PullRequestService(f.F.Paths, new(f.F.Apps, f.Users, f.Connections, f.F.Clock),
            f.Connections, f.F.Clock, NullLogger<PullRequestService>.Instance, f.Service, null!);
        var path = Path.Combine(f.F.Paths.CoreRoot, "development/publications", f.W.Id + ".json");
        var record = (await JsonStorage.ReadAsync<PublicationRecord>(path))!;
        await JsonStorage.WriteAsync(path, record with { Number = 1, Observation = new(f.F.Clock.UtcNow, "open", Checks: [new("test", "SUCCESS")]) });
        var actor = new PullRequestActor(f.W.Owner.UserId);
        var request = new PullRequestRefresh(Guid.NewGuid().ToString(), Workspaces: [f.W.WorkspaceId]);
        Assert.Equal("queued", (await service.RefreshAsync(actor, request, default)).State);
        Assert.Equal("coalesced", (await service.RefreshAsync(actor, request, default)).State);
        Assert.Equal(0, f.Provider.Observed);
        await service.TickAsync(default);
        Assert.Equal(1, f.Provider.Observed);
        var deferred = await service.RefreshAsync(actor, request with { RequestId = Guid.NewGuid().ToString() }, default);
        Assert.Equal("deferred", deferred.State);
        Assert.Equal(f.F.Clock.UtcNow.AddSeconds(10), deferred.NextAttemptAt);
        await service.TickAsync(default);
        Assert.Equal(1, f.Provider.Observed);
        await Assert.ThrowsAnyAsync<Exception>(() => service.RefreshAsync(new("another-user"), request, default));
        Assert.Equal(1, f.Provider.Observed);
    }

    [Fact]
    public async Task PullRequestWorkspace_PendingMergeCiWinsOverOlderQuietWorkspaceAndUpdatesWithoutReload()
    {
        var f = await PublicationFixture();
        var service = new PullRequestService(f.F.Paths, new(f.F.Apps, f.Users, f.Connections, f.F.Clock),
            f.Connections, f.F.Clock, NullLogger<PullRequestService>.Instance, f.Service, null!);
        var path = Path.Combine(f.F.Paths.CoreRoot, "development/publications", f.W.Id + ".json");
        var record = (await JsonStorage.ReadAsync<PublicationRecord>(path))!;
        await JsonStorage.WriteAsync(path, record with { Number = 1, Observation = new(f.F.Clock.UtcNow.AddSeconds(-12), "merged",
            Checks: [new("test", "SUCCESS")], CompletionIssue: new("check", "release-ci", "missing", "merge")) });
        var otherOwner = f.W.Owner with { SessionId = "quiet-session" };
        var other = await f.Workspaces.PrepareAsync(otherOwner, WorkspaceRequest("quiet-session"), default);
        await JsonStorage.WriteAsync(Path.Combine(f.F.Paths.CoreRoot, "development/publications", other.Id + ".json"), record with {
            WorkspaceId = other.Id, Owner = otherOwner, Branch = other.Branch, Number = 2,
            Observation = new(f.F.Clock.UtcNow.AddMinutes(-10), "open", Checks: [new("test", "SUCCESS")]) });
        var actor = new PullRequestActor(f.W.Owner.UserId);
        var ticket = await service.SubscribeAsync(actor, new(Workspaces: [f.W.WorkspaceId]), default);
        using var stream = service.Admit(actor, ticket.Id);
        f.Provider.State = "merged"; f.Provider.Complete = true;
        await service.TickAsync(default);
        Assert.NotEmpty(f.Provider.ObservedNumbers);
        Assert.All(f.Provider.ObservedNumbers, number => Assert.Equal(1, number));
        Assert.True((await JsonStorage.ReadAsync<PublicationRecord>(path))!.Observation!.Complete);
    }

    [Fact]
    public async Task PullRequestWorkspace_OpeningStaleDetailsPromotesTheSelectedWorkspace()
    {
        var f = await PublicationFixture();
        var service = new PullRequestService(f.F.Paths, new(f.F.Apps, f.Users, f.Connections, f.F.Clock),
            f.Connections, f.F.Clock, NullLogger<PullRequestService>.Instance, f.Service, null!);
        var path = Path.Combine(f.F.Paths.CoreRoot, "development/publications", f.W.Id + ".json");
        var record = (await JsonStorage.ReadAsync<PublicationRecord>(path))!;
        await JsonStorage.WriteAsync(path, record with { Number = 1, Observation = new(f.F.Clock.UtcNow.AddMinutes(-2), "open", Checks: [new("test", "SUCCESS")]) });
        await service.TickAsync(default);
        Assert.Equal(0, f.Provider.Observed); // No live demand: five-minute baseline.
        var actor = new PullRequestActor(f.W.Owner.UserId);
        var ticket = await service.SubscribeAsync(actor, new(Workspaces: [f.W.WorkspaceId]), default);
        using (service.Admit(actor, ticket.Id)) await service.TickAsync(default);
        Assert.Equal(1, f.Provider.Observed);
        f.F.Clock.UtcNow += TimeSpan.FromSeconds(70);
        await service.TickAsync(default);
        Assert.Equal(1, f.Provider.Observed); // Disposing the stream releases fast demand.
    }
}
