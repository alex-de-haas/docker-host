using System.Collections.Concurrent;

namespace Haas.Hosty.Core;

// A single atomic metadata transaction covers a complete batch. Immutable evidence is stored
// separately, so lists and mutation transactions do not read or rewrite image bytes.
internal sealed class FeedbackStore(CoreDataPaths paths, IClock clock)
{
    private static readonly ConcurrentDictionary<string, SemaphoreSlim> Gates = new(StringComparer.Ordinal);
    private string Root => Path.Combine(paths.CoreRoot, "feedback");
    private string StatePath => Path.Combine(Root, "state.json");
    private string ImagePath(string report, string note) => Path.Combine(Root, "evidence", report, note + ".json");
    private async Task<T> Locked<T>(Func<FeedbackState, Task<T>> action, CancellationToken ct)
    {
        var gate = Gates.GetOrAdd(StatePath, _ => new(1, 1));
        await gate.WaitAsync(ct);
        try { return await action(await JsonStorage.ReadAsync<FeedbackState>(StatePath, ct) ?? new([], [], [], [])); }
        finally { gate.Release(); }
    }
    private Task Save(FeedbackState state, CancellationToken ct) => JsonStorage.WriteAsync(StatePath, state, true, ct);
    internal static string Key(string appId, string installation, string userId, string requestId)
        => DevelopmentWorkspaceService.Hash(CoreJson.Text(new[] { appId, installation, userId, requestId }));
    internal static void Uuid(string value)
    {
        if (!Guid.TryParseExact(value, "D", out _)) throw new FeedbackException("feedback_invalid", "Use a UUID request/annotation ID.", 400);
    }
    private static void Text(string? value, int max, string label, bool required = false)
    {
        if (value is null || value.Length > max || required && string.IsNullOrWhiteSpace(value))
            throw new FeedbackException("feedback_invalid", $"Invalid {label}. Maximum {max} characters.", 400);
    }
    internal static void Validate(FeedbackSubmit input)
    {
        Uuid(input.RequestId); Text(input.Comment, 5000, "report comment");
        if (input.Annotations is not { Length: > 0 and <= 20 } ||
            input.Annotations.Any(a => a is null) ||
            input.Annotations.Select(a => a.Id).Distinct(StringComparer.Ordinal).Count() != input.Annotations.Length)
            throw new FeedbackException("feedback_invalid", "Include 1–20 distinct annotations.", 400);
        long size = 0;
        foreach (var note in input.Annotations)
        {
            Uuid(note.Id); Text(note.Text, 2000, "annotation comment", true); Text(note.Route, 2048, "route");
            if (note.Target is { } target)
            {
                if (target.Kind is not ("element" or "region" or "page")) throw new FeedbackException("feedback_invalid", "Unknown annotation kind.", 400);
                Text(target.Label ?? "", 200, "element label"); Text(target.Selector ?? "", 500, "element selector");
                if (target.Bounds is { } b && (!double.IsFinite(b.X) || !double.IsFinite(b.Y) || !double.IsFinite(b.Width) ||
                    !double.IsFinite(b.Height) || b.Width < 0 || b.Height < 0))
                    throw new FeedbackException("feedback_invalid", "Invalid element bounds.", 400);
                if (target.Viewport is { } v && (!double.IsFinite(v.Width) || !double.IsFinite(v.Height) ||
                    !double.IsFinite(v.Scale) || v.Width <= 0 || v.Height <= 0 || v.Scale <= 0))
                    throw new FeedbackException("feedback_invalid", "Invalid viewport.", 400);
            }
            if (note.Image is not { } image) continue;
            if (image.Data is null || image.Data.Length > 2_796_204) throw new FeedbackException("feedback_image_too_large", "Each image may be at most 2 MiB.", 413);
            byte[] bytes;
            try { bytes = Convert.FromBase64String(image.Data); }
            catch (FormatException) { throw new FeedbackException("feedback_image_invalid", "Invalid image encoding.", 400); }
            size += bytes.Length;
            if (bytes.Length > 2_097_152 || size > 8_388_608) throw new FeedbackException("feedback_image_too_large", "Images may total at most 8 MiB.", 413);
            var valid = image.MediaType switch
            {
                "image/png" => bytes.Length >= 24 && bytes.AsSpan(0, 8).SequenceEqual(new byte[] {137,80,78,71,13,10,26,10}),
                "image/jpeg" => bytes.Length >= 4 && bytes[0] == 255 && bytes[1] == 216 && bytes[2] == 255 && bytes[^2] == 255 && bytes[^1] == 217,
                _ => false,
            };
            if (!valid) throw new FeedbackException("feedback_image_invalid", "Use a PNG or JPEG still image.", 400);
        }
    }
    internal Task<FeedbackSubmissionReceipt> SubmitAsync(string reporter, FeedbackObservation observation, FeedbackSubmit input, CancellationToken ct)
    {
        Validate(input);
        if (input.Scope is { } scope && (scope.CoreId != DevelopmentWorkspaceService.Hash(paths.CoreRoot) || scope.AppId != observation.AppId ||
            scope.Installation != observation.Installation || scope.UserId != reporter))
            throw new FeedbackException("feedback_identity_changed", "The account or application installation changed. Reopen your own saved draft.", 403);
        var id = Key(observation.AppId, observation.Installation, reporter, input.RequestId);
        var fingerprint = DevelopmentWorkspaceService.Hash(CoreJson.Text(input));
        return Locked(async state =>
        {
            var receipt = state.Receipts.FirstOrDefault(r => r.Id == id);
            if (receipt is not null)
            {
                if (receipt.Fingerprint != fingerprint) throw new FeedbackException("feedback_request_conflict", "Retry the same report with the original request ID.");
                return new FeedbackSubmissionReceipt(id, receipt.Deleted ? "deleted" : "submitted");
            }
            CleanupEvidence(state);
            foreach (var note in input.Annotations)
                if (note.Image is not null) await JsonStorage.WriteAsync(ImagePath(id, note.Id), note.Image, true, ct);
            var report = new FeedbackReport(id, reporter, observation, input.Comment,
                input.Annotations.Select(n => new FeedbackNote(n.Id, n.Text, n.Route, n.CapturedAt, n.Target, n.Image?.MediaType)).ToArray(),
                observation.WorkspaceId is { } workspace && !state.DeletedWorkspaces.Contains(workspace) ? workspace : null);
            await Save(state with { Reports = [.. state.Reports, report], Receipts = [.. state.Receipts, new(id, fingerprint)] }, ct);
            return new FeedbackSubmissionReceipt(id, "submitted");
        }, ct);
    }
    private void CleanupEvidence(FeedbackState state)
    {
        var evidence = Path.Combine(Root, "evidence");
        if (!Directory.Exists(evidence)) return;
        var live = state.Reports.Select(r => r.Id).ToHashSet(StringComparer.Ordinal);
        // Runs under the metadata gate: a partially written intake cannot be mistaken for a
        // live writer. A crash before commit leaves only an unreferenced, safely removable folder.
        foreach (var directory in Directory.EnumerateDirectories(evidence))
        {
            var name = Path.GetFileName(directory);
            if (name.Length == 64 && name.All(c => c is >= '0' and <= '9' or >= 'a' and <= 'f') && !live.Contains(name))
                Directory.Delete(directory, true);
        }
    }
    internal Task<FeedbackCollection> ListAsync(CancellationToken ct) =>
        Locked(state => Task.FromResult(new FeedbackCollection(state.Reports.OrderByDescending(r => r.Context.ObservedAt).ToArray(), state.Dispatches)), ct);
    internal Task<FeedbackImage> ImageAsync(string reportId, string noteId, CancellationToken ct) => Locked(async state =>
    {
        var report = state.Reports.FirstOrDefault(r => r.Id == reportId);
        if (report?.Annotations.Any(n => n.Id == noteId && n.MediaType is not null) != true)
            throw new FeedbackException("feedback_not_found", "The feedback image is no longer available.", 404);
        return await JsonStorage.ReadAsync<FeedbackImage>(ImagePath(reportId, noteId), ct)
            ?? throw new FeedbackException("feedback_evidence_unavailable", "The feedback image could not be read.", 503);
    }, ct);
    internal Task<FeedbackReport> ChangeAsync(string id, FeedbackChange change, CancellationToken ct) => Locked(async state =>
    {
        var report = state.Reports.FirstOrDefault(r => r.Id == id) ?? throw new FeedbackException("feedback_not_found", "Feedback not found.", 404);
        if (report.Revision != change.ExpectedRevision) throw new FeedbackException("feedback_revision_conflict", "Feedback changed; refresh before continuing.");
        if (report.Status is "pending" or "uncertain") throw new FeedbackException("feedback_busy", "Resolve the active or uncertain attempt before reassigning feedback.");
        if (change.Disposition is not (null or "dismissed" or "duplicate")) throw new FeedbackException("feedback_invalid", "Unknown disposition.", 400);
        RequireWorkspace(state, change.WorkspaceId);
        report = report with { WorkspaceId = change.WorkspaceId, Disposition = change.Disposition, Revision = report.Revision + 1,
            CurrentAttemptId = report.Status == "uncertain" && report.WorkspaceId != change.WorkspaceId ? null : report.CurrentAttemptId };
        await Save(state with { Reports = state.Reports.Select(r => r.Id == id ? report : r).ToArray() }, ct);
        return report;
    }, ct);
    private static void RequireWorkspace(FeedbackState state, string? id)
    {
        if (id is not null && state.DeletedWorkspaces.Contains(id)) throw new FeedbackException("workspace_deleted", "This workspace was deleted.");
    }
    internal Task<FeedbackDispatch> ReserveAsync(string caller, string installation, string actor, FeedbackDispatchInput input, CancellationToken ct)
    {
        Uuid(input.RequestId); Text(input.SessionId, 128, "session", true); Text(input.Instruction, 5000, "instruction");
        if (input.Reports is not { Length: > 0 and <= 50 } || input.Reports.Any(r => r is null) || input.AppContextRevision < 0 || input.SelectionRevision < 0 || input.Reports.Select(r => r.Id).Distinct().Count() != input.Reports.Length)
            throw new FeedbackException("feedback_invalid", "Select 1–50 distinct reports.", 400);
        return Locked(async state =>
        {
            var prior = state.Dispatches.FirstOrDefault(d => d.Id == input.RequestId);
            if (prior is not null)
            {
                RequireOwner(prior, caller, installation, actor);
                if (CoreJson.Text(prior.Input) != CoreJson.Text(input)) throw new FeedbackException("feedback_dispatch_conflict", "Retry the exact reviewed batch.");
                return prior;
            }
            RequireWorkspace(state, input.WorkspaceId);
            var selected = input.Reports.Select(selection =>
            {
                var report = state.Reports.FirstOrDefault(r => r.Id == selection.Id) ?? throw new FeedbackException("feedback_not_found", "A selected report was removed.", 404);
                if (report.Revision != selection.Revision) throw new FeedbackException("feedback_revision_conflict", "A selected report changed. Review it again.");
                if (report.Status == "pending") throw new FeedbackException("feedback_busy", "A report already has an active or uncertain attempt.");
                if (report.Disposition is not null) throw new FeedbackException("feedback_dismissed", "Restore dismissed/duplicate feedback before sending.");
                return report;
            }).ToArray();
            var dispatch = new FeedbackDispatch(input.RequestId, caller, installation, actor, input, selected, clock.UtcNow);
            await Save(state with
            {
                Dispatches = [.. state.Dispatches, dispatch],
                Reports = state.Reports.Select(r => selected.Any(s => s.Id == r.Id)
                    ? r with { Status = "pending", CurrentAttemptId = dispatch.Id, Revision = r.Revision + 1 } : r).ToArray(),
            }, ct);
            return dispatch;
        }, ct);
    }
    private static void RequireOwner(FeedbackDispatch dispatch, string caller, string installation, string actor)
    {
        if (dispatch.CallerAppId != caller || dispatch.CallerInstallation != installation || dispatch.ActorId != actor)
            throw new FeedbackException("feedback_dispatch_forbidden", "This dispatch belongs to another client or actor.", 403);
    }
    internal Task<FeedbackDispatch> DeliverAsync(string id, string caller, string installation, string actor, FeedbackDelivery input, CancellationToken ct) =>
        Locked(async state =>
        {
            var dispatch = state.Dispatches.FirstOrDefault(d => d.Id == id) ?? throw new FeedbackException("feedback_not_found", "Dispatch not found.", 404);
            RequireOwner(dispatch, caller, installation, actor);
            if (input.State is not ("accepted" or "rejected" or "succeeded" or "failed" or "cancelled" or "unknown"))
                throw new FeedbackException("feedback_invalid", "Invalid delivery outcome.", 400);
            if (dispatch.State is "succeeded" or "failed" or "cancelled" or "rejected") return dispatch;
            if (input.State is not ("rejected" or "unknown") && input.MessageSequence is not > 0)
                throw new FeedbackException("feedback_invalid", "An exact accepted message sequence is required.", 400);
            if (dispatch.MessageSequence is { } sequence && input.MessageSequence is { } supplied && sequence != supplied)
                throw new FeedbackException("feedback_dispatch_conflict", "The accepted prompt cannot change.");
            RequireWorkspace(state, input.WorkspaceId);
            var previous = dispatch;
            dispatch = dispatch with { State = input.State, MessageSequence = input.MessageSequence ?? dispatch.MessageSequence,
                WorkspaceId = input.WorkspaceId ?? dispatch.WorkspaceId, Error = input.Error is { Length: <= 2000 } ? input.Error : null };
            if (dispatch == previous) return dispatch;
            var reports = state.Reports.Select(report =>
            {
                if (report.CurrentAttemptId != id) return report;
                if (input.State == "rejected")
                {
                    var old = dispatch.Snapshot.Single(s => s.Id == report.Id);
                    return old with { Revision = report.Revision + 1,
                        WorkspaceId = old.WorkspaceId is { } wid && state.DeletedWorkspaces.Contains(wid) ? null : old.WorkspaceId };
                }
                var outcome = dispatch.Outcomes?.FirstOrDefault(o => o.ReportId == report.Id);
                var status = input.State == "unknown" ? "uncertain" : input.State == "accepted" ? "pending" : input.State == "succeeded"
                    ? outcome is { Handled: true } && report.Annotations.All(n => outcome.HandledAnnotationIds.Contains(n.Id)) ? "processed" : "partial"
                    : input.State;
                return report with { Status = status, Revision = report.Revision + 1,
                    WorkspaceId = input.WorkspaceId ?? report.WorkspaceId };
            }).ToArray();
            await Save(state with { Reports = reports, Dispatches = state.Dispatches.Select(d => d.Id == id ? dispatch : d).ToArray() }, ct);
            return dispatch;
        }, ct);
    internal Task<FeedbackDispatch> ResultsAsync(string id, string caller, string installation, string actor, FeedbackResults input, CancellationToken ct) =>
        Locked(async state =>
        {
            var dispatch = state.Dispatches.FirstOrDefault(d => d.Id == id) ?? throw new FeedbackException("feedback_not_found", "Dispatch not found.", 404);
            RequireOwner(dispatch, caller, installation, actor);
            if (dispatch.State is not ("reserved" or "accepted" or "unknown")) throw new FeedbackException("feedback_attempt_finished", "This attempt has already ended.");
            if (input.Outcomes is null || input.Outcomes.Length != dispatch.Snapshot.Length ||
                input.Outcomes.Any(o => o is null) ||
                input.Outcomes.Select(o => o.ReportId).Distinct().Count() != input.Outcomes.Length)
                throw new FeedbackException("feedback_invalid", "Report the outcome for every selected feedback.", 400);
            foreach (var outcome in input.Outcomes)
            {
                var report = dispatch.Snapshot.FirstOrDefault(r => r.Id == outcome.ReportId);
                Text(outcome.Summary, 2000, "outcome summary", true);
                if (report is null || outcome.HandledAnnotationIds is null ||
                    outcome.HandledAnnotationIds.Any(id => !report.Annotations.Any(n => n.Id == id)))
                    throw new FeedbackException("feedback_invalid", "Outcome contains an unknown report or annotation.", 400);
            }
            dispatch = dispatch with { Outcomes = input.Outcomes };
            await Save(state with { Dispatches = state.Dispatches.Select(d => d.Id == id ? dispatch : d).ToArray() }, ct);
            return dispatch;
        }, ct);
    internal Task<bool> DeleteWorkspaceAsync(string workspaceId, CancellationToken ct) => Locked(async state =>
    {
        var cancelled = state.Dispatches.Where(d => d.State is "reserved" or "accepted" or "unknown")
            .Where(d => (d.WorkspaceId ?? d.Input.WorkspaceId) == workspaceId).Select(d => d.Id).ToHashSet();
        var removed = state.Reports.Where(r => r.WorkspaceId == workspaceId && r.Status == "processed").Select(r => r.Id).ToHashSet();
        // Keep receipts but redact every retained batch snapshot/outcome referencing deleted content.
        var receipts = state.Receipts.Select(r => removed.Contains(r.Id) ? r with { Deleted = true } : r).ToArray();
        await Save(state with
        {
            DeletedWorkspaces = state.DeletedWorkspaces.Contains(workspaceId) ? state.DeletedWorkspaces : [.. state.DeletedWorkspaces, workspaceId],
            Reports = state.Reports.Where(r => !removed.Contains(r.Id)).Select(r => r.WorkspaceId == workspaceId || r.CurrentAttemptId is { } attempt && cancelled.Contains(attempt)
                ? r with { WorkspaceId = r.WorkspaceId == workspaceId ? null : r.WorkspaceId, Revision = r.Revision + 1,
                    Status = r.CurrentAttemptId is { } active && cancelled.Contains(active) ? "cancelled" : r.Status } : r).ToArray(),
            Receipts = receipts,
            Dispatches = state.Dispatches.Select(d => d with {
                State = cancelled.Contains(d.Id) ? "cancelled" : d.State,
                Error = cancelled.Contains(d.Id) ? "The processing workspace was deleted. Unprocessed feedback was retained." : d.Error,
                Snapshot = d.Snapshot.Where(r => !removed.Contains(r.Id)).ToArray(),
                Outcomes = d.Outcomes?.Where(o => !removed.Contains(o.ReportId)).ToArray(),
                Input = removed.Overlaps(d.Input.Reports.Select(r => r.Id)) ? d.Input with { Instruction = "" } : d.Input,
            }).ToArray(),
        }, ct);
        // Tombstones survive a failed filesystem deletion, so retry removes the same evidence.
        foreach (var receipt in receipts.Where(r => r.Deleted))
        {
            var directory = Path.Combine(Root, "evidence", receipt.Id);
            if (Directory.Exists(directory)) Directory.Delete(directory, true);
        }
        return true;
    }, ct);
}
