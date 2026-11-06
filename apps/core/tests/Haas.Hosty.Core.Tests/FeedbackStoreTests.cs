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
    public async Task MissingOrPartialOutcomeDoesNotProcessReportAndWorkspaceDeletionRemovesIt()
    {
        var report = await Report(); var attempt = await Reserve(report); await Outcomes(attempt, false); await Deliver(attempt, "succeeded");
        Assert.Equal("partial", Assert.Single((await store.ListAsync(Ct)).Reports).Status);
        await store.DeleteWorkspaceAsync("workspace-a", Ct);
        Assert.Empty((await store.ListAsync(Ct)).Reports);
        Assert.Equal("feedback_not_found", (await Assert.ThrowsAsync<FeedbackException>(() => store.ImageAsync(report.Id, report.Annotations[0].Id, Ct))).Code);
    }
    [Fact]
    public async Task RejectedFollowupRestoresProcessedAndWorkspaceDeletionRemovesAcceptedFailure()
    {
        var report = await Report(); var first = await Reserve(report); await Outcomes(first); await Deliver(first, "succeeded");
        report = Assert.Single((await store.ListAsync(Ct)).Reports); var refused = await Reserve(report); await Deliver(refused, "rejected");
        report = Assert.Single((await store.ListAsync(Ct)).Reports); Assert.Equal("processed", report.Status);
        var followup = await Reserve(report); await Deliver(followup, "accepted"); await Deliver(followup, "failed");
        await Deliver(first, "succeeded"); Assert.Equal("failed", Assert.Single((await store.ListAsync(Ct)).Reports).Status);
        await store.DeleteWorkspaceAsync("workspace-a", Ct);
        var list = await store.ListAsync(Ct); Assert.Empty(list.Reports); Assert.Equal(3, list.Dispatches.Length);
        Assert.All(list.Dispatches, dispatch => Assert.Empty(dispatch.Snapshot));
        Assert.Equal("feedback_not_found", (await Assert.ThrowsAsync<FeedbackException>(() => store.ImageAsync(report.Id, report.Annotations[0].Id, Ct))).Code);
    }
    [Fact]
    public async Task WorkspaceDeletionRemovesAllCurrentBindingsAndFencesStaleReplayAndLateIntake()
    {
        var input = Input(); var receipt = await store.SubmitAsync("reporter", Context(), input, Ct);
        var processed = Assert.Single((await store.ListAsync(Ct)).Reports); var attempt = await Reserve(processed); await Outcomes(attempt); await Deliver(attempt, "succeeded");
        var pending = await Report(); var untouched = await Report();
        await store.ChangeAsync(untouched.Id, new(untouched.Revision, "workspace-b"), Ct);
        await store.DeleteWorkspaceAsync("workspace-a", Ct); await new FeedbackStore(paths, new Clock()).DeleteWorkspaceAsync("workspace-a", Ct);
        var list = await store.ListAsync(Ct); Assert.Equal(untouched.Id, Assert.Single(list.Reports).Id);
        Assert.Equal("workspace-b", list.Reports.Single().WorkspaceId);
        Assert.Empty(Assert.Single(list.Dispatches).Snapshot);
        Assert.False(Directory.Exists(Path.Combine(paths.CoreRoot, "feedback", "evidence", processed.Id)));
        Assert.Equal("deleted", (await store.SubmitAsync("reporter", Context(), input, Ct)).Status);
        await Assert.ThrowsAsync<FeedbackException>(() => store.ImageAsync(receipt.Id, input.Annotations[0].Id, Ct));
        Assert.False(Directory.Exists(Path.Combine(paths.CoreRoot, "feedback", "evidence", pending.Id)));
        Assert.Equal("workspace_deleted", (await Assert.ThrowsAsync<FeedbackException>(() => store.ChangeAsync(untouched.Id, new(list.Reports.Single().Revision, "workspace-a"), Ct))).Code);
        var lateInput = Input(); var late = await store.SubmitAsync("reporter", Context(), lateInput, Ct);
        Assert.Equal("deleted", late.Status);
        Assert.Equal(late, await new FeedbackStore(paths, new Clock()).SubmitAsync("reporter", Context(), lateInput, Ct));
        Assert.Equal(untouched.Id, Assert.Single((await store.ListAsync(Ct)).Reports).Id);
        Assert.False(Directory.Exists(Path.Combine(paths.CoreRoot, "feedback", "evidence", late.Id)));
    }
    [Fact]
    public async Task DeletionCancelsActiveAttemptAndLateCompletionCannotReattachOrProcess()
    {
        var report = await Report(); var attempt = await Reserve(report); await Deliver(attempt, "accepted"); await Outcomes(attempt);
        await store.DeleteWorkspaceAsync("workspace-a", Ct); await Deliver(attempt, "succeeded");
        var list = await store.ListAsync(Ct); Assert.Empty(list.Reports);
        var cancelled = Assert.Single(list.Dispatches); Assert.Equal("cancelled", cancelled.State); Assert.Empty(cancelled.Snapshot); Assert.Empty(cancelled.Outcomes!);
        Assert.Equal("feedback_attempt_finished", (await Assert.ThrowsAsync<FeedbackException>(() => Outcomes(attempt))).Code);
        Assert.Equal("feedback_not_found", (await Assert.ThrowsAsync<FeedbackException>(() => store.ImageAsync(report.Id, report.Annotations[0].Id, Ct))).Code);
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

    private static FeedbackEdit Edit(FeedbackReport report) => new(Id(), report.Revision, "Updated explanation",
        report.Annotations.Reverse().Select(n => new FeedbackAnnotationEdit(n.Id, "Updated " + n.Text)).ToArray());

    [Fact]
    public async Task EditingPreservesEvidenceAndHistoryResetsHandlingAndExactRetriesDoNotOverwriteLaterChanges()
    {
        var original = await Report(); var attempt = await Reserve(original); await Outcomes(attempt); await Deliver(attempt, "succeeded");
        var before = Assert.Single((await store.ListAsync(Ct)).Reports); var input = Edit(before);
        var edited = await store.EditAsync(before.Id, input, Ct);
        Assert.Equal(before.Revision + 1, edited.Revision); Assert.Equal(input.Comment, edited.Comment);
        Assert.Equal("unprocessed", edited.Status); Assert.Null(edited.CurrentAttemptId);
        Assert.Equal(before with { Comment = edited.Comment, Annotations = edited.Annotations, Revision = edited.Revision,
            Status = "unprocessed", CurrentAttemptId = null }, edited);
        for (var i = 0; i < before.Annotations.Length; i++)
            Assert.Equal(before.Annotations[i] with { Text = "Updated " + before.Annotations[i].Text }, edited.Annotations[i]);
        Assert.NotNull(await store.ImageAsync(before.Id, before.Annotations[0].Id, Ct));
        Assert.Equal(CoreJson.Text(original), CoreJson.Text(Assert.Single((await store.ListAsync(Ct)).Dispatches).Snapshot.Single()));
        var replays = await Task.WhenAll(Enumerable.Range(0, 6).Select(_ => new FeedbackStore(paths, new Clock()).EditAsync(before.Id, input, Ct)));
        Assert.All(replays, replay => Assert.Equal(edited.Revision, replay.Revision));
        var later = await store.EditAsync(edited.Id, Edit(edited) with { Comment = "Newer operator edit" }, Ct);
        Assert.Equal(CoreJson.Text(later), CoreJson.Text(await store.EditAsync(before.Id, input, Ct)));
        var conflict = await Assert.ThrowsAsync<FeedbackException>(() => store.EditAsync(before.Id, input with { Comment = "Changed retry" }, Ct));
        Assert.Equal("feedback_request_conflict", conflict.Code);
        conflict = await Assert.ThrowsAsync<FeedbackException>(() => store.EditAsync(before.Id, input with { RequestId = Id() }, Ct));
        Assert.Equal("feedback_revision_conflict", conflict.Code);
        conflict = await Assert.ThrowsAsync<FeedbackException>(() => Reserve(before));
        Assert.Equal("feedback_revision_conflict", conflict.Code);
    }

    [Fact]
    public async Task InvalidTextOrAnnotationSetsLeaveFeedbackUnchanged()
    {
        var report = await Report(); var edit = Edit(report);
        FeedbackEdit[] invalid = [
            edit with { Comment = new string('x', 5001) },
            edit with { Annotations = [edit.Annotations[0] with { Text = " " }, edit.Annotations[1]] },
            edit with { Annotations = [edit.Annotations[0] with { Text = new string('x', 2001) }, edit.Annotations[1]] },
            edit with { Annotations = [edit.Annotations[0]] },
            edit with { Annotations = [edit.Annotations[0], edit.Annotations[0]] },
            edit with { Annotations = [edit.Annotations[0], edit.Annotations[1] with { Id = Id() }] },
            edit with { Annotations = [null!] },
        ];
        foreach (var input in invalid)
            Assert.Equal("feedback_invalid", (await Assert.ThrowsAsync<FeedbackException>(() => store.EditAsync(report.Id, input, Ct))).Code);
        var unchanged = Assert.Single((await store.ListAsync(Ct)).Reports);
        Assert.Equal(report.Revision, unchanged.Revision); Assert.Equal(report.Comment, unchanged.Comment);
        Assert.Equal(report.Annotations, unchanged.Annotations);
    }

    [Theory]
    [InlineData("pending")]
    [InlineData("uncertain")]
    public async Task ActiveAndUncertainFeedbackCannotBeEditedOrDeleted(string status)
    {
        var report = await Report(); var attempt = await Reserve(report);
        if (status == "uncertain") await Deliver(attempt, "unknown");
        report = Assert.Single((await store.ListAsync(Ct)).Reports);
        Assert.Equal(status, report.Status);
        Assert.Equal("feedback_busy", (await Assert.ThrowsAsync<FeedbackException>(() => store.EditAsync(report.Id, Edit(report), Ct))).Code);
        Assert.Equal("feedback_busy", (await Assert.ThrowsAsync<FeedbackException>(() => store.DeleteAsync(report.Id, new(Id(), report.Revision), Ct))).Code);
        Assert.NotNull(await store.ImageAsync(report.Id, report.Annotations[0].Id, Ct));
    }

    [Fact]
    public async Task DeletingRedactsBatchContentRemovesEvidenceAndRetainsIntakeAndMutationTombstones()
    {
        var input = Input() with { Comment = "Report to delete" };
        var receipt = await store.SubmitAsync("reporter", Context(), input, Ct);
        var removed = Assert.Single((await store.ListAsync(Ct)).Reports); var retained = await Report();
        var attempt = await Reserve(removed, retained); await Outcomes(attempt); await Deliver(attempt, "succeeded");
        removed = (await store.ListAsync(Ct)).Reports.Single(r => r.Id == removed.Id);
        var deletion = new FeedbackDelete(Id(), removed.Revision);
        var stale = await Assert.ThrowsAsync<FeedbackException>(() => store.DeleteAsync(removed.Id, deletion with { ExpectedRevision = 1 }, Ct));
        Assert.Equal("feedback_revision_conflict", stale.Code);
        Assert.Equal("deleted", (await store.DeleteAsync(removed.Id, deletion, Ct)).Status);
        var list = await store.ListAsync(Ct); Assert.Equal(retained.Id, Assert.Single(list.Reports).Id);
        var history = Assert.Single(list.Dispatches);
        Assert.Equal(retained.Id, Assert.Single(history.Snapshot).Id);
        Assert.Equal(retained.Id, Assert.Single(history.Outcomes!).ReportId); Assert.Equal("", history.Input.Instruction);
        Assert.False(Directory.Exists(Path.Combine(paths.CoreRoot, "feedback", "evidence", removed.Id)));
        Assert.Equal("deleted", (await store.SubmitAsync("reporter", Context(), input, Ct)).Status);
        Assert.Equal("feedback_not_found", (await Assert.ThrowsAsync<FeedbackException>(() => store.ImageAsync(receipt.Id, input.Annotations[0].Id, Ct))).Code);
        Assert.NotNull(await store.ImageAsync(retained.Id, retained.Annotations[0].Id, Ct));
        // Reconstruct a committed deletion whose filesystem cleanup was interrupted.
        var leftover = Path.Combine(paths.CoreRoot, "feedback", "evidence", removed.Id);
        Directory.CreateDirectory(leftover); await File.WriteAllTextAsync(Path.Combine(leftover, "partial.json"), "{}");
        Assert.Equal("deleted", (await new FeedbackStore(paths, new Clock()).DeleteAsync(removed.Id, deletion, Ct)).Status);
        Assert.False(Directory.Exists(leftover));
        var conflict = await Assert.ThrowsAsync<FeedbackException>(() => store.DeleteAsync(removed.Id, deletion with { ExpectedRevision = 2 }, Ct));
        Assert.Equal("feedback_request_conflict", conflict.Code);
    }

    private Task<FeedbackDispatch> ReserveIn(string workspace, params FeedbackReport[] reports) => store.ReserveAsync("independent.assistant", "install", "admin",
        new(Id(), "chat", workspace, reports.Select(r => new FeedbackSelection(r.Id, r.Revision)).ToArray(), "Please fix"), Ct);

    [Theory]
    [InlineData("unprocessed")]
    [InlineData("processed")]
    [InlineData("partial")]
    [InlineData("failed")]
    [InlineData("cancelled")]
    [InlineData("pending")]
    [InlineData("uncertain")]
    [InlineData("dismissed")]
    [InlineData("duplicate")]
    public async Task WorkspaceDeletionRemovesEveryBoundStatusAndDisposition(string status)
    {
        var input = Input(); var receipt = await store.SubmitAsync("reporter", Context(), input, Ct);
        var report = Assert.Single((await store.ListAsync(Ct)).Reports);
        if (status is "dismissed" or "duplicate") await store.ChangeAsync(report.Id, new(report.Revision, "workspace-a", status), Ct);
        else if (status != "unprocessed")
        {
            var attempt = await Reserve(report);
            if (status is "processed" or "partial") { await Outcomes(attempt, status == "processed"); await Deliver(attempt, "succeeded"); }
            else if (status != "pending") await Deliver(attempt, status == "uncertain" ? "unknown" : status);
        }
        Assert.True(Directory.Exists(Path.Combine(paths.CoreRoot, "feedback", "evidence", report.Id)));
        await store.DeleteWorkspaceAsync("workspace-a", Ct);
        var list = await store.ListAsync(Ct); Assert.Empty(list.Reports);
        Assert.All(list.Dispatches, dispatch => {
            Assert.Empty(dispatch.Snapshot); Assert.Empty(dispatch.Outcomes ?? []); Assert.Equal("", dispatch.Input.Instruction);
            if (status is "pending" or "uncertain") Assert.Equal("cancelled", dispatch.State);
        });
        Assert.False(Directory.Exists(Path.Combine(paths.CoreRoot, "feedback", "evidence", report.Id)));
        Assert.Equal("deleted", (await new FeedbackStore(paths, new Clock()).SubmitAsync("reporter", Context(), input, Ct)).Status);
        Assert.Equal("feedback_not_found", (await Assert.ThrowsAsync<FeedbackException>(() => store.ImageAsync(receipt.Id, input.Annotations[0].Id, Ct))).Code);
    }

    [Fact]
    public async Task DeletionCancelsBatchReservedForAnotherDestinationAndRetainsItsOtherBoundReports()
    {
        var removed = await Report(); var retained = await Report("workspace-b");
        var attempt = await ReserveIn("workspace-b", removed, retained); await Outcomes(attempt);
        var before = (await store.ListAsync(Ct)).Reports.Single(r => r.Id == retained.Id);
        await store.DeleteWorkspaceAsync("workspace-a", Ct);
        var list = await store.ListAsync(Ct); var survivor = Assert.Single(list.Reports);
        Assert.Equal(retained.Id, survivor.Id); Assert.Equal("workspace-b", survivor.WorkspaceId);
        Assert.Equal("cancelled", survivor.Status); Assert.Equal(before.Revision + 1, survivor.Revision);
        var cancelled = Assert.Single(list.Dispatches); Assert.Equal("cancelled", cancelled.State);
        Assert.Equal(retained.Id, Assert.Single(cancelled.Snapshot).Id);
        Assert.Equal(retained.Id, Assert.Single(cancelled.Outcomes!).ReportId); Assert.Equal("", cancelled.Input.Instruction);
        await Deliver(attempt, "accepted", "workspace-b"); await Deliver(attempt, "succeeded", "workspace-b");
        Assert.Equal("cancelled", Assert.Single((await store.ListAsync(Ct)).Reports).Status);
        Assert.Equal("feedback_attempt_finished", (await Assert.ThrowsAsync<FeedbackException>(() => Outcomes(attempt))).Code);
        Assert.NotNull(await store.ImageAsync(retained.Id, retained.Annotations[0].Id, Ct));
        Assert.False(Directory.Exists(Path.Combine(paths.CoreRoot, "feedback", "evidence", removed.Id)));
    }

    [Fact]
    public async Task DeletingProcessingDestinationDoesNotRemoveFeedbackBoundElsewhere()
    {
        var report = await Report(); var attempt = await ReserveIn("workspace-b", report);
        await store.DeleteWorkspaceAsync("workspace-b", Ct);
        var list = await store.ListAsync(Ct); var survivor = Assert.Single(list.Reports);
        Assert.Equal(report.Id, survivor.Id); Assert.Equal("workspace-a", survivor.WorkspaceId); Assert.Equal("cancelled", survivor.Status);
        Assert.Equal("cancelled", Assert.Single(list.Dispatches).State); Assert.Single(list.Dispatches[0].Snapshot);
        Assert.NotNull(await store.ImageAsync(report.Id, report.Annotations[0].Id, Ct));
        await Deliver(attempt, "succeeded", "workspace-b");
        Assert.Equal("workspace-a", Assert.Single((await store.ListAsync(Ct)).Reports).WorkspaceId);
    }

    [Fact]
    public async Task ReassignedFeedbackSurvivesDeletionOfItsObservationAndHistoricalAttemptWorkspace()
    {
        var input = Input(); await store.SubmitAsync("reporter", Context(), input, Ct);
        var report = Assert.Single((await store.ListAsync(Ct)).Reports);
        var attempt = await Reserve(report); await Outcomes(attempt); await Deliver(attempt, "succeeded");
        report = Assert.Single((await store.ListAsync(Ct)).Reports);
        var reassigned = await store.ChangeAsync(report.Id, new(report.Revision, "workspace-b"), Ct);
        await store.DeleteWorkspaceAsync("workspace-a", Ct);
        var list = await store.ListAsync(Ct); var survivor = Assert.Single(list.Reports);
        Assert.Equal(CoreJson.Text(reassigned), CoreJson.Text(survivor)); Assert.Equal("workspace-a", survivor.Context.WorkspaceId);
        Assert.Equal("succeeded", Assert.Single(list.Dispatches).State); Assert.Single(list.Dispatches[0].Snapshot);
        Assert.Equal("Please fix", list.Dispatches[0].Input.Instruction);
        Assert.Equal("submitted", (await store.SubmitAsync("reporter", Context(), input, Ct)).Status);
        Assert.NotNull(await store.ImageAsync(report.Id, report.Annotations[0].Id, Ct));
    }

    private async Task LegacyDeletedWorkspace(string reportId, string? currentBinding)
    {
        // Reproduce the old deletion policy only in this test's isolated persisted store.
        var file = Path.Combine(paths.CoreRoot, "feedback", "state.json");
        var state = (await JsonStorage.ReadAsync<FeedbackState>(file, Ct))!;
        await JsonStorage.WriteAsync(file, state with {
            DeletedWorkspaces = [.. state.DeletedWorkspaces, "workspace-a"],
            Reports = state.Reports.Select(r => r.Id == reportId ? r with { WorkspaceId = currentBinding, Revision = r.Revision + 1 } : r).ToArray(),
        }, true, Ct);
    }

    [Theory]
    [InlineData("partial", null)]
    [InlineData("failed", null)]
    [InlineData("cancelled", null)]
    [InlineData("unprocessed", "workspace-a")]
    public async Task LegacyLeftoversRemainManuallyDeletableWithoutALiveWorkspace(string status, string? binding)
    {
        var input = Input(); await store.SubmitAsync("reporter", Context(), input, Ct);
        var report = Assert.Single((await store.ListAsync(Ct)).Reports);
        if (status != "unprocessed")
        {
            var attempt = await Reserve(report);
            if (status == "partial") { await Outcomes(attempt, false); await Deliver(attempt, "succeeded"); }
            else await Deliver(attempt, status);
        }
        await LegacyDeletedWorkspace(report.Id, binding);
        report = Assert.Single((await store.ListAsync(Ct)).Reports);
        var deletion = new FeedbackDelete(Id(), report.Revision);
        Assert.Equal("deleted", (await store.DeleteAsync(report.Id, deletion, Ct)).Status);
        Assert.Equal("deleted", (await new FeedbackStore(paths, new Clock()).DeleteAsync(report.Id, deletion, Ct)).Status);
        Assert.Empty((await store.ListAsync(Ct)).Reports);
        Assert.False(Directory.Exists(Path.Combine(paths.CoreRoot, "feedback", "evidence", report.Id)));
        Assert.Equal("deleted", (await store.SubmitAsync("reporter", Context(), input, Ct)).Status);
        Assert.All((await store.ListAsync(Ct)).Dispatches, dispatch => { Assert.Empty(dispatch.Snapshot); Assert.Empty(dispatch.Outcomes ?? []); });
    }

    [Theory]
    [InlineData("pending")]
    [InlineData("uncertain")]
    public async Task DeletedObservationDoesNotPermitManualRemovalOfActiveWorkElsewhere(string status)
    {
        var report = await Report(); var attempt = await ReserveIn("workspace-b", report);
        if (status == "uncertain") await Deliver(attempt, "unknown", "workspace-b");
        await LegacyDeletedWorkspace(report.Id, status == "pending" ? null : "workspace-b");
        report = Assert.Single((await store.ListAsync(Ct)).Reports);
        Assert.Equal("feedback_busy", (await Assert.ThrowsAsync<FeedbackException>(() => store.DeleteAsync(report.Id, new(Id(), report.Revision), Ct))).Code);
        Assert.Equal("feedback_busy", (await Assert.ThrowsAsync<FeedbackException>(() => store.EditAsync(report.Id, Edit(report), Ct))).Code);
        Assert.NotNull(await store.ImageAsync(report.Id, report.Annotations[0].Id, Ct));
    }

    [Fact]
    public async Task ConcurrentIntakeAndWorkspaceDeletionCannotRecreateBoundReports()
    {
        var input = Input();
        Task intake = store.SubmitAsync("reporter", Context(), input, Ct);
        Task deletion = new FeedbackStore(paths, new Clock()).DeleteWorkspaceAsync("workspace-a", Ct);
        await Task.WhenAll(intake, deletion);
        Assert.Empty((await store.ListAsync(Ct)).Reports);
        var replay = await new FeedbackStore(paths, new Clock()).SubmitAsync("reporter", Context(), input, Ct);
        Assert.Equal("deleted", replay.Status);
        Assert.False(Directory.Exists(Path.Combine(paths.CoreRoot, "feedback", "evidence", replay.Id)));
    }

}
