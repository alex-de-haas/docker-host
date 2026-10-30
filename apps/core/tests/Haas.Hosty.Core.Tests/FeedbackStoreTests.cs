using Haas.Hosty.Core;

namespace Haas.Hosty.Core.Tests;

public sealed class FeedbackStoreTests : IDisposable
{
    private readonly string root = Path.Combine(Path.GetTempPath(), "hosty-feedback-tests-" + Guid.NewGuid().ToString("N"));
    private readonly FeedbackStore store;
    private readonly CoreDataPaths paths;
    private static readonly CancellationToken Ct = CancellationToken.None;
    private static readonly DateTimeOffset Now = DateTimeOffset.Parse("2026-10-30T12:00:00Z");
    private sealed class Clock : IClock { public DateTimeOffset UtcNow => Now; }
    private static string Id() => Guid.NewGuid().ToString();
    private static FeedbackObservation Context(string? workspace = "workspace-a") => new("unrelated.app", "Example", "installation-one", "1.2.3", Now, "workspace", workspace, null);
    private static FeedbackSubmit Input() => new(Id(), "Related observations", [
        new(Id(), "Move this button", "/page", Now, new("element", "Button"), new("image/png", "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1ZkAAAAASUVORK5CYII=")),
        new(Id(), "Align this label", "/page", Now, new("element", "Label"))]);
    public FeedbackStoreTests()
    {
        paths = new(root, Path.Combine(root, "core"), Path.Combine(root, "apps"), Path.Combine(root, "backups"), Path.Combine(root, "sources"), Path.Combine(root, "auth"), Path.Combine(root, "audit.ndjson"));
        store = new(paths, new Clock());
    }
    public void Dispose() { if (Directory.Exists(root)) Directory.Delete(root, true); }
    private async Task<FeedbackReport> Report(string? workspace = "workspace-a")
    {
        var receipt = await store.SubmitAsync("reporter", Context(workspace), Input(), Ct);
        return (await store.ListAsync(Ct)).Reports.Single(r => r.Id == receipt.Id);
    }
    private Task<FeedbackDispatch> Reserve(params FeedbackReport[] reports) => store.ReserveAsync("independent.assistant", "install", "admin",
        new(Id(), "chat", "workspace-a", reports.Select(r => new FeedbackSelection(r.Id, r.Revision)).ToArray(), "Please fix"), Ct);
    private Task<FeedbackDispatch> Deliver(FeedbackDispatch attempt, string state, string? workspace = "workspace-a") => store.DeliverAsync(attempt.Id, "independent.assistant", "install", "admin", new(state, 3, workspace), Ct);
    private Task<FeedbackDispatch> Outcomes(FeedbackDispatch attempt, bool all = true) => store.ResultsAsync(attempt.Id, "independent.assistant", "install", "admin",
        new(attempt.Snapshot.Select(r => new FeedbackOutcome(r.Id, "Checked", all ? r.Annotations.Select(n => n.Id).ToArray() : [], all)).ToArray()), Ct);

    [Fact]
    public async Task ConcurrentIntakeReplayKeepsOneReportAndFirstObservation()
    {
        var input = Input(); var first = await store.SubmitAsync("reporter", Context(), input, Ct);
        var again = await Task.WhenAll(Enumerable.Range(0, 12).Select(_ => new FeedbackStore(paths, new Clock()).SubmitAsync("reporter", Context("workspace-b") with { Version = "9.0.0" }, input, Ct)));
        Assert.All(again, receipt => Assert.Equal(first, receipt));
        var report = Assert.Single((await store.ListAsync(Ct)).Reports); Assert.Equal("1.2.3", report.Context.Version); Assert.Equal("workspace-a", report.WorkspaceId);
        Assert.Equal(input.Annotations[0].Image, await store.ImageAsync(first.Id, input.Annotations[0].Id, Ct));
        var conflict = await Assert.ThrowsAsync<FeedbackException>(() => store.SubmitAsync("reporter", Context(), input with { Comment = "Changed" }, Ct)); Assert.Equal("feedback_request_conflict", conflict.Code);
        await store.SubmitAsync("another-user", Context(), input, Ct); Assert.Equal(2, (await store.ListAsync(Ct)).Reports.Length);
    }
    [Fact]
    public async Task InvalidBatchLeavesEveryReportUnreservedAndReplayIsActorBound()
    {
        var first = await Report(); var second = await Report();
        await Assert.ThrowsAsync<FeedbackException>(() => Reserve(first, second with { Revision = 44 }));
        Assert.All((await store.ListAsync(Ct)).Reports, r => Assert.Equal("unprocessed", r.Status));
        var attempt = await Reserve(first, second);
        Assert.Equal(attempt.Id, (await store.ReserveAsync(attempt.CallerAppId, attempt.CallerInstallation, attempt.ActorId, attempt.Input, Ct)).Id);
        var forbidden = await Assert.ThrowsAsync<FeedbackException>(() => store.ReserveAsync("another-client", "install", "admin", attempt.Input, Ct)); Assert.Equal(403, forbidden.Status);
        await Assert.ThrowsAsync<FeedbackException>(() => Reserve(first));
    }
    [Fact]
    public async Task StructuredOutcomeAndSuccessfulExactPromptAreBothRequired()
    {
        var report = await Report(); var attempt = await Reserve(report);
        await Outcomes(attempt); Assert.Equal("pending", Assert.Single((await store.ListAsync(Ct)).Reports).Status);
        await Deliver(attempt, "accepted");
        await Assert.ThrowsAsync<FeedbackException>(() => store.DeliverAsync(attempt.Id, attempt.CallerAppId, attempt.CallerInstallation, attempt.ActorId, new("succeeded", 99, "workspace-a"), Ct));
        await Deliver(attempt, "succeeded"); Assert.Equal("processed", Assert.Single((await store.ListAsync(Ct)).Reports).Status);
    }
    [Fact]
    public async Task MissingOrPartialOutcomeDoesNotProcessReport()
    {
        var report = await Report(); var attempt = await Reserve(report); await Outcomes(attempt, false); await Deliver(attempt, "succeeded");
        Assert.Equal("partial", Assert.Single((await store.ListAsync(Ct)).Reports).Status);
        await store.DeleteWorkspaceAsync("workspace-a", Ct);
        var surviving = Assert.Single((await store.ListAsync(Ct)).Reports); Assert.Null(surviving.WorkspaceId); Assert.NotNull(await store.ImageAsync(report.Id, report.Annotations[0].Id, Ct));
    }
    [Fact]
    public async Task RejectedFollowupRestoresProcessedButAcceptedFailureSurvivesDeletion()
    {
        var report = await Report(); var first = await Reserve(report); await Outcomes(first); await Deliver(first, "succeeded");
        report = Assert.Single((await store.ListAsync(Ct)).Reports); var refused = await Reserve(report); await Deliver(refused, "rejected");
        report = Assert.Single((await store.ListAsync(Ct)).Reports); Assert.Equal("processed", report.Status);
        var followup = await Reserve(report); await Deliver(followup, "accepted"); await Deliver(followup, "failed");
        await Deliver(first, "succeeded"); Assert.Equal("failed", Assert.Single((await store.ListAsync(Ct)).Reports).Status);
        await store.DeleteWorkspaceAsync("workspace-a", Ct);
        var list = await store.ListAsync(Ct); Assert.Null(Assert.Single(list.Reports).WorkspaceId); Assert.Equal(3, list.Dispatches.Length);
        Assert.NotNull(await store.ImageAsync(report.Id, report.Annotations[0].Id, Ct));
    }
    [Fact]
    public async Task WorkspaceDeletionRemovesOnlyCurrentlyProcessedAndFencesStaleReplay()
    {
        var input = Input(); var receipt = await store.SubmitAsync("reporter", Context(), input, Ct);
        var processed = Assert.Single((await store.ListAsync(Ct)).Reports); var attempt = await Reserve(processed); await Outcomes(attempt); await Deliver(attempt, "succeeded");
        var pending = await Report(); var untouched = await Report();
        await store.ChangeAsync(untouched.Id, new(untouched.Revision, "workspace-b"), Ct);
        await store.DeleteWorkspaceAsync("workspace-a", Ct); await new FeedbackStore(paths, new Clock()).DeleteWorkspaceAsync("workspace-a", Ct);
        var list = await store.ListAsync(Ct); Assert.Equal(2, list.Reports.Length);
        Assert.Null(list.Reports.Single(r => r.Id == pending.Id).WorkspaceId);
        Assert.Equal("workspace-b", list.Reports.Single(r => r.Id == untouched.Id).WorkspaceId);
        Assert.Empty(Assert.Single(list.Dispatches).Snapshot);
        Assert.False(Directory.Exists(Path.Combine(paths.CoreRoot, "feedback", "evidence", processed.Id)));
        Assert.Equal("deleted", (await store.SubmitAsync("reporter", Context(), input, Ct)).Status);
        await Assert.ThrowsAsync<FeedbackException>(() => store.ImageAsync(receipt.Id, input.Annotations[0].Id, Ct));
        await Assert.ThrowsAsync<FeedbackException>(() => store.ChangeAsync(pending.Id, new(list.Reports.Single(r => r.Id == pending.Id).Revision, "workspace-a"), Ct));
        var late = await Report(); Assert.Null(late.WorkspaceId); Assert.Equal("workspace-a", late.Context.WorkspaceId);
    }
    [Fact]
    public async Task DeletionCancelsActiveAttemptAndLateCompletionCannotReattachOrProcess()
    {
        var report = await Report(); var attempt = await Reserve(report); await Deliver(attempt, "accepted"); await Outcomes(attempt);
        await store.DeleteWorkspaceAsync("workspace-a", Ct); await Deliver(attempt, "succeeded");
        var survivor = Assert.Single((await store.ListAsync(Ct)).Reports); Assert.Null(survivor.WorkspaceId); Assert.Equal("cancelled", survivor.Status);
        Assert.NotNull(await store.ImageAsync(survivor.Id, survivor.Annotations[0].Id, Ct));
    }
    [Fact]
    public async Task OldUncertainAttemptCannotOverwriteNewAttempt()
    {
        var report = await Report(); var old = await Reserve(report); await Deliver(old, "unknown");
        var next = await Reserve(Assert.Single((await store.ListAsync(Ct)).Reports));
        await Outcomes(old); await Deliver(old, "succeeded");
        report = Assert.Single((await store.ListAsync(Ct)).Reports); Assert.Equal(next.Id, report.CurrentAttemptId); Assert.Equal("pending", report.Status);
    }
    [Fact]
    public async Task IntakeCleansOnlyOrphanEvidenceAndRejectsNullAndOversizedInput()
    {
        var report = await Report(); var orphan = Path.Combine(paths.CoreRoot, "feedback", "evidence", new string('a', 64)); Directory.CreateDirectory(orphan); await File.WriteAllTextAsync(Path.Combine(orphan, "partial.json"), "{}");
        await Report(); Assert.False(Directory.Exists(orphan)); Assert.NotNull(await store.ImageAsync(report.Id, report.Annotations[0].Id, Ct));
        Assert.Throws<FeedbackException>(() => FeedbackStore.Validate(Input() with { Annotations = [null!] }));
        Assert.Throws<FeedbackException>(() => FeedbackStore.Validate(Input() with { Comment = new string('x', 5001) }));
        Assert.Throws<FeedbackException>(() => FeedbackStore.Validate(Input() with { Annotations = [Input().Annotations[0] with { Image = new("image/svg+xml", "PHN2Zz4=") }] }));
    }
    [Fact]
    public async Task IdenticalDeliveryDoesNotChurnRevisionsAndUncertainCannotBeReassigned()
    {
        var report = await Report(); var attempt = await Reserve(report);
        await Deliver(attempt, "accepted");
        var revision = Assert.Single((await store.ListAsync(Ct)).Reports).Revision;
        await Deliver(attempt, "accepted");
        Assert.Equal(revision, Assert.Single((await store.ListAsync(Ct)).Reports).Revision);
        await Deliver(attempt, "unknown"); report = Assert.Single((await store.ListAsync(Ct)).Reports);
        await Assert.ThrowsAsync<FeedbackException>(() => store.ChangeAsync(report.Id, new(report.Revision, "workspace-b"), Ct));
    }

}
