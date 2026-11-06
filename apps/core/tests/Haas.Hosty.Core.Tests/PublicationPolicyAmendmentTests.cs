using System.Text.Json.Nodes;
using Haas.Hosty.Core;

namespace Haas.Hosty.Core.Tests;

public sealed partial class CoreLifecycleServiceTests
{
    private static PublicationCommand AmendPolicy(string head, PublicationPolicy previous) => new(Guid.NewGuid().ToString(), head,
        Policy: new(["Main CI"], [17], []), PolicyAmendment: new(previous, "The Docker check runs on PRs only; verify the merge-bound release workflow."));

    [Fact]
    public async Task Publication_AmendmentAfterSourceCompletionPreservesBindingsAndRequiresSeparateCompletion()
    {
        var f = await PublicationFixture(); var head = f.W.Observation!.Head!;
        var before = await f.Service.CommandAsync(f.W.Id, f.W.Owner, "publish", new(Guid.NewGuid().ToString(), head, Title: "Feature"), default);
        f.Provider.State = "merged";
        await f.Workspaces.ChangeWorkflowAsync(f.W.Owner, "admin", "complete", new(Guid.NewGuid().ToString(), 0), new Dictionary<string, string>(), default);
        var command = AmendPolicy(head, before.Policy);
        var actor = WorkspaceOwner.ForExternal(f.W.Owner.UserId, "manual:operator", "repair", "Independent editor");
        var result = await f.Service.CommandAsync(f.W.Id, actor, "configure", command, default, canonical: true);
        Assert.Equal(CoreJson.Text(command.Policy!), CoreJson.Text(result.Policy));
        Assert.Equal(before.ConnectionId, result.ConnectionId); Assert.Equal(before.HeadRepository, result.HeadRepository);
        Assert.Equal(before.Dependencies, result.Dependencies); Assert.Equal(before.PublishedHead, result.PublishedHead);
        Assert.Null(result.Outcome); Assert.Null(result.CompletedAt); Assert.False(result.CleanupRequested);
        Assert.False(result.Observation!.Complete); Assert.Equal(1, f.Provider.Pushed); Assert.Equal(1, f.Provider.Created);
        var op = Assert.Single(result.Operations); Assert.Equal(actor, op.Actor); Assert.Equal(command, op.Input);
        Assert.Equal("succeeded", op.State);
        await f.Service.CommandAsync(f.W.Id, actor, "configure", command, default, canonical: true);
        Assert.Equal("publication_request_conflict", (await Assert.ThrowsAsync<PublicationException>(() => f.Service.CommandAsync(f.W.Id, actor,
            "configure", command with { PolicyAmendment = command.PolicyAmendment! with { Reason = "Changed" } }, default, canonical: true))).Code);
        await Assert.ThrowsAsync<PublicationException>(() => f.Service.CommandAsync(f.W.Id, actor, "complete",
            new(Guid.NewGuid().ToString(), head, Outcome: "merged"), default, canonical: true));
        f.Provider.Complete = true;
        var completed = await f.Service.CommandAsync(f.W.Id, actor, "complete", new(Guid.NewGuid().ToString(), head, Outcome: "merged"), default, canonical: true);
        Assert.Equal("merged", completed.Outcome); Assert.False(completed.CleanupRequested);
        Assert.Equal("completed", (await f.Workspaces.WorkflowAsync(f.W.Owner, default)).State);
        Assert.True(Directory.Exists(f.W.Path));
    }

    [Theory]
    [InlineData("ordinary", "publication_policy_locked")]
    [InlineData("previous", "publication_policy_changed")]
    [InlineData("reason", "publication_policy_amendment_invalid")]
    [InlineData("policy", "publication_policy_amendment_invalid")]
    [InlineData("fork", "publication_policy_amendment_invalid")]
    [InlineData("dependencies", "publication_policy_amendment_invalid")]
    [InlineData("cleanup", "publication_policy_amendment_invalid")]
    [InlineData("head", "publication_policy_amendment_invalid")]
    [InlineData("open", "publication_policy_amendment_invalid")]
    [InlineData("closed", "publication_policy_amendment_invalid")]
    [InlineData("remote-head", "publication_policy_amendment_invalid")]
    [InlineData("dirty", "publication_workspace_changed")]
    [InlineData("completed", "publication_completed")]
    public async Task Publication_AmendmentRejectsUnreviewedOrStaleChanges(string variation, string code)
    {
        var f = await PublicationFixture(); var head = f.W.Observation!.Head!;
        var before = await f.Service.CommandAsync(f.W.Id, f.W.Owner, "publish", new(Guid.NewGuid().ToString(), head, Title: "Feature"), default);
        f.Provider.State = "merged";
        var command = AmendPolicy(head, before.Policy);
        command = variation switch {
            "ordinary" => command with { PolicyAmendment = null },
            "previous" => command with { PolicyAmendment = new(new(["wrong"], [], []), "Correction") },
            "reason" => command with { PolicyAmendment = new(before.Policy, " ") },
            "policy" => command with { Policy = null },
            "fork" => command with { Fork = true },
            "dependencies" => command with { Dependencies = [] },
            "cleanup" => command with { Cleanup = true },
            "head" => command with { ExpectedHead = "stale" },
            _ => command
        };
        if (variation is "open" or "closed") f.Provider.State = variation;
        if (variation == "remote-head") f.Provider.Head = "different";
        if (variation == "dirty") await File.WriteAllTextAsync(Path.Combine(f.W.Path, "unsaved.txt"), "preserve");
        if (variation == "completed") {
            f.Provider.Complete = true;
            await f.Service.CommandAsync(f.W.Id, f.W.Owner, "complete", new(Guid.NewGuid().ToString(), head, Outcome: "merged"), default);
        }
        Assert.Equal(code, (await Assert.ThrowsAsync<PublicationException>(() => f.Service.CommandAsync(f.W.Id, f.W.Owner, "configure", command, default))).Code);
        var after = await f.Service.ObserveAsync(f.W.Id, f.W.Owner, default);
        Assert.Equal(CoreJson.Text(before.Policy), CoreJson.Text(after.Policy));
        Assert.Equal(1, f.Provider.Created); Assert.Equal(1, f.Provider.Pushed);
    }

    [Fact]
    public async Task Publication_AmendmentRechecksAuthorityAfterProviderRead()
    {
        var f = await PublicationFixture(); var head = f.W.Observation!.Head!;
        var before = await f.Service.CommandAsync(f.W.Id, f.W.Owner, "publish", new(Guid.NewGuid().ToString(), head, Title: "Feature"), default);
        f.Provider.State = "merged"; var revoked = false;
        f.Provider.BeforeObserve = (_, _) => { revoked = true; return Task.CompletedTask; };
        await Assert.ThrowsAsync<AppIdentityException>(() => f.Service.CommandAsync(f.W.Id, f.W.Owner, "configure", AmendPolicy(head, before.Policy), default,
            validateCaller: _ => revoked ? throw new AppIdentityException("scope_required", "Revoked") : Task.CompletedTask));
        f.Provider.BeforeObserve = null;
        Assert.Equal(CoreJson.Text(before.Policy), CoreJson.Text((await f.Service.ObserveAsync(f.W.Id, f.W.Owner, default)).Policy));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Publication_AmendmentRefusesPausedWorkspaceAndPauseDuringObservation(bool duringObservation)
    {
        var f = await PublicationFixture(); var head = f.W.Observation!.Head!;
        var before = await f.Service.CommandAsync(f.W.Id, f.W.Owner, "publish", new(Guid.NewGuid().ToString(), head, Title: "Feature"), default);
        f.Provider.State = "merged";
        async Task Pause() => await f.Workspaces.ChangeWorkflowAsync(f.W.Owner, "admin", "close",
            new(Guid.NewGuid().ToString(), 0), new Dictionary<string, string>(), default);
        if (duringObservation) f.Provider.BeforeObserve = async (_, _) => { f.Provider.BeforeObserve = null; await Pause(); };
        else await Pause();
        Assert.Equal("publication_workspace_closed", (await Assert.ThrowsAsync<PublicationException>(() => f.Service.CommandAsync(f.W.Id, f.W.Owner,
            "configure", AmendPolicy(head, before.Policy), default))).Code);
        var after = await f.Service.ObserveAsync(f.W.Id, f.W.Owner, default);
        Assert.Equal(CoreJson.Text(before.Policy), CoreJson.Text(after.Policy));
        Assert.Null(after.Outcome);
    }

    [Fact]
    public async Task Publication_AmendmentRechecksNativeEditsAfterProviderObservation()
    {
        var f = await PublicationFixture(); var head = f.W.Observation!.Head!;
        var before = await f.Service.CommandAsync(f.W.Id, f.W.Owner, "publish", new(Guid.NewGuid().ToString(), head, Title: "Feature"), default);
        f.Provider.State = "merged";
        f.Provider.BeforeObserve = async (_, _) => { f.Provider.BeforeObserve = null; await File.WriteAllTextAsync(Path.Combine(f.W.Path, "unsaved.txt"), "preserve"); };
        Assert.Equal("publication_workspace_changed", (await Assert.ThrowsAsync<PublicationException>(() => f.Service.CommandAsync(f.W.Id, f.W.Owner,
            "configure", AmendPolicy(head, before.Policy), default))).Code);
        Assert.Equal(CoreJson.Text(before.Policy), CoreJson.Text((await f.Service.ObserveAsync(f.W.Id, f.W.Owner, default)).Policy));
        Assert.Equal("preserve", await File.ReadAllTextAsync(Path.Combine(f.W.Path, "unsaved.txt")));
    }

    [Fact]
    public void Publication_AbsentAmendmentPreservesLegacyReplayFingerprintShape()
    {
        var command = new PublicationCommand("request", "head", Policy: new([], [], []));
        var json = CoreJson.Text(command);
        Assert.False(JsonNode.Parse(json)!.AsObject().ContainsKey("policyAmendment"));
        Assert.Equal(json, CoreJson.Text(System.Text.Json.JsonSerializer.Deserialize(json, CoreJsonSerializerContext.Default.PublicationCommand)!));
    }
}
