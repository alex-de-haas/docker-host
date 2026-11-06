using Haas.Hosty.Core;

namespace Haas.Hosty.Core.Tests;

public sealed partial class CoreLifecycleServiceTests
{
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task CanonicalPublication_CurrentUserCanContinueAcrossCreatorClients(bool external)
    {
        var f = await PublicationFixture();
        var actor = external ? WorkspaceOwner.ForExternal(f.W.Owner.UserId, "manual:reviewed", "independent-task", "Independent client")
            : f.W.Owner with { AppId = "independent.editor", SessionId = "opaque-allocation" };
        if (!external) await f.F.Apps.UpsertAppAsync((await f.F.Apps.GetAppAsync(f.W.Owner.AppId))! with { Id = actor.AppId });
        Assert.Empty((await f.Service.ListAsync(actor, default)).Publications);
        Assert.Single((await f.Service.ListAsync(actor, default, canonical: true)).Publications);
        await f.F.Apps.RemoveAppAsync(f.W.Owner.AppId);
        var input = new PublicationCommand(Guid.NewGuid().ToString(), f.W.Observation!.Head, Title: "Independent publication");
        var result = await f.Service.CommandAsync(f.W.Id, actor, "publish", input, default, canonical: true);
        Assert.Equal(1, f.Provider.Created);
        Assert.Equal(f.W.Owner, result.Owner); // Creator attribution is immutable.
        Assert.Equal(actor, Assert.Single(result.Operations).Actor);
        Assert.Equal("open", result.Observation!.State);
        await f.Service.CommandAsync(f.W.Id, actor, "publish", input, default, canonical: true);
        Assert.Equal(1, f.Provider.Created);
        Assert.Equal("open", (await f.Service.ObserveAsync(f.W.Id, actor, default, canonical: true)).Observation!.State);
        var otherUser = actor with { UserId = "another-admin" };
        await f.Users.UpdateAsync(s => s with { Users = [.. s.Users, s.Users[0] with { Id = otherUser.UserId }] });
        Assert.Empty((await f.Service.ListAsync(otherUser, default, canonical: true)).Publications);
        await Assert.ThrowsAsync<PublicationException>(() => f.Service.CommandAsync(f.W.Id, otherUser, "publish", input, default, canonical: true));
    }

    [Fact]
    public async Task CanonicalPublication_RevokedOriginPreventsRemoteAdmission()
    {
        var f = await PublicationFixture();
        var actor = WorkspaceOwner.ForExternal(f.W.Owner.UserId, "manual:reviewed", "task", "Independent client");
        await Assert.ThrowsAsync<AppIdentityException>(() => f.Service.CommandAsync(f.W.Id, actor, "publish",
            new(Guid.NewGuid().ToString(), f.W.Observation!.Head, Title: "Blocked"), default, canonical: true,
            validateCaller: _ => throw new AppIdentityException("scope_required", "Publication grant revoked.")));
        Assert.Equal(0, f.Provider.Created); Assert.Equal(0, f.Provider.Pushed);
    }
    [Fact]
    public async Task CanonicalPublication_NativeCommitAndExternalPullRequestRequireVerifiedLinkBeforeCompletion()
    {
        var f = await PublicationFixture();
        var actor = WorkspaceOwner.ForExternal(f.W.Owner.UserId, "manual:independent", "native-source", "Independent editor");
        await File.WriteAllTextAsync(Path.Combine(f.W.Path, "native-addition.txt"), "Native edit and commit");
        await RunGitAsync(f.W.Path, ["add", "native-addition.txt"]);
        await RunGitAsync(f.W.Path, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "Native source edit"]);
        var current = await f.Workspaces.ObserveAsync(f.W.Id, actor, default);
        var head = current.Observation!.Head!;
        Assert.NotEqual(f.W.Observation!.Head, head);
        f.Provider.Head = head; f.Provider.ExpectedBranch = f.W.Branch;
        f.Provider.Reference = new(42, "https://github.com/owner/repo/pull/42", head, null);
        var observed = await f.Service.ObserveAsync(f.W.Id, actor, default, canonical: true);
        Assert.Equal(42, observed.Number); Assert.Equal(head, observed.Observation!.Head);
        Assert.Null(observed.PublishedHead); // Discovery is evidence, not an implicit publication decision.
        var input = new PublicationCommand(Guid.NewGuid().ToString(), head, Number: 42);
        var linked = await f.Service.CommandAsync(f.W.Id, actor, "link", input, default, canonical: true);
        Assert.Equal(head, linked.PublishedHead);
        Assert.Equal(actor, Assert.Single(linked.Operations).Actor);
        await f.Service.CommandAsync(f.W.Id, actor, "link", input, default, canonical: true);
        Assert.Equal(0, f.Provider.Pushed); Assert.Equal(0, f.Provider.Created); Assert.Equal(0, f.Provider.Merged);
        await f.Users.UpdateAsync(state => state with { ProviderConnections = [] });
        var unavailable = await f.Service.ObserveAsync(f.W.Id, actor, default, canonical: true);
        Assert.Equal("unavailable", unavailable.Observation!.State);
        Assert.Null(unavailable.Observation.Head);
    }

}
