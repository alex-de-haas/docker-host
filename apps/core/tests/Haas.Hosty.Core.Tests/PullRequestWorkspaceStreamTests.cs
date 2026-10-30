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
}
