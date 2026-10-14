using System.Diagnostics;
using System.Text;
using System.Text.Json;

namespace Haas.Hosty.Core;

internal sealed record SandboxBrowserAction(string Kind, string? Selector = null, string? Value = null, string? Path = null);
internal sealed record SandboxBrowserRequest(string RequestId, long ExpectedRevision, string UserId, SandboxBrowserAction[] Actions);
internal sealed record SandboxBrowserCancelRequest(string RequestId, long ExpectedRevision, string JobId);
internal sealed record SandboxBrowserPayload(string Target, string AuthOrigin, string[] Endpoints, string Proxy,
    string LoginId, string Password, SandboxBrowserAction[] Actions);
internal sealed record SandboxBrowserReport(string Id, string InstanceId, string Generation, string DataRevision, string InputDigest,
    string UserId, string State, DateTimeOffset StartedAt, DateTimeOffset? FinishedAt = null, JsonElement? Result = null, string? ErrorCode = null, string? SourceRevision = null, long UserRevision = 0, bool Stale = false);
internal sealed record SandboxBrowserJournal(string Fingerprint, SandboxBrowserReport Report);

internal sealed class SandboxBrowser(SandboxStore store, SandboxService service, SandboxRealm realm,
    SandboxDockerRuntime runtime, IClock clock)
{
    private readonly SemaphoreSlim capacity = new(1, 1);
    private readonly System.Collections.Concurrent.ConcurrentDictionary<string, CancellationTokenSource> activeJobs = new(StringComparer.Ordinal);

    public async Task<SandboxBrowserReport> RunAsync(SandboxActor actor, string id, SandboxBrowserRequest input, CancellationToken ct)
    {
        SandboxValidation.Request(input.RequestId);
        Validate(input.Actions);
        var jobId = Guid.Parse(input.RequestId).ToString("N");
        var hash = SandboxValidation.Hash(CoreJson.Text(input));
        if (!await capacity.WaitAsync(0, ct)) throw new SandboxException("sandbox_browser_busy", "One private browser job is allowed at a time; there is no queue.");
        SandboxInstance? instance = null;
        SandboxResource? worker = null;
        SandboxBrowserReport? report = null;
        var gate = store.Gate(id);
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(ct);
        deadline.CancelAfter(TimeSpan.FromMinutes(5));
        activeJobs[id + ":" + jobId] = deadline;
        try
        {
            await gate.WaitAsync(ct);
            try
            {
                instance = await service.RequireAsync(actor, id, ct);
                var old = await JsonStorage.ReadAsync<SandboxBrowserJournal>(JobPath(id, jobId), ct);
                if (old is not null)
                {
                    if (old.Fingerprint != hash) throw new SandboxException("sandbox_replay_conflict", "Keep the original browser request arguments.");
                    return old.Report.State == "running" ? old.Report with { State = "unknown", ErrorCode = "sandbox_browser_interrupted" } : old.Report;
                }
                if (instance.Revision != input.ExpectedRevision) throw new SandboxException("sandbox_revision_stale", "Read the current sandbox before starting a browser job.");
                if (instance.State != "ready" || instance.AccessRevoked || !instance.Users.Any(u => u.Id == input.UserId && u.Enabled))
                    throw new SandboxException("sandbox_browser_unavailable", "Select an enabled sandbox user in a ready instance.");
                if (Directory.EnumerateFiles(store.DataPath(id, "evidence"), "*.json").Count() >= 3)
                    throw new SandboxException("sandbox_evidence_quota", "Three browser runs are retained. Clear exported runs explicitly or finish the sandbox.");
                report = new(jobId, id, instance.Generation, instance.DataRevision, instance.Input.Digest, input.UserId, "running", clock.UtcNow, SourceRevision: await SandboxEvidence.SourceRevisionAsync(instance, ct),
                    UserRevision: instance.Users.Single(u => u.Id == input.UserId).Revision);
                await Save(report, hash, ct);
                worker = await runtime.CreateBrowserAsync(instance, jobId, async resource =>
                {
                    instance = instance with { Resources = instance.Resources.Where(r => r.Id != resource.Id || r.Kind != resource.Kind).Append(resource).ToArray() };
                    await store.WriteAsync(instance, default);
                }, deadline.Token);
            }
            finally { gate.Release(); }
            var login = await realm.ProvisionAsync(actor, id, input.UserId, jobId, deadline.Token);
            var payload = new SandboxBrowserPayload(instance.PreviewUrl!, instance.AuthOrigin!, instance.Endpoints.Select(e => e.Url).ToArray(),
                instance.BrowserProxy!, login.LoginId, login.Password, input.Actions);
            var result = await ControlAsync(worker.Id, payload, deadline.Token);
            var state = result.GetProperty("state").GetString();
            if (state is not ("passed" or "failed")) throw new SandboxException("sandbox_browser_result_invalid", "The trusted worker returned an invalid result.");
            var changed = report.SourceRevision != await SandboxEvidence.SourceRevisionAsync(instance, deadline.Token);
            report = report with { State = changed ? "unknown" : state, FinishedAt = clock.UtcNow, Result = result,
                Stale = changed, ErrorCode = changed ? "sandbox_source_changed_during_verification" : null };
        }
        catch (Exception ex) when (report is not null && ex is SandboxException or IOException or OperationCanceledException or DockerUnavailableException or JsonException)
        {
            report = report with { State = "failed", FinishedAt = clock.UtcNow,
                ErrorCode = ex is SandboxException sandbox ? sandbox.Code : ex is OperationCanceledException ? "sandbox_browser_cancelled" : "sandbox_browser_failed" };
        }
        finally
        {
            try
            {
                if (instance is not null && report is not null)
                {
                    // Revocation is independent of process shutdown. A generation change already
                    // revokes the entire old realm; never restore it while cleaning up this job.
                    try { await realm.RevokeJobAsync(id, jobId, default); } catch (SandboxException) { }
                    await gate.WaitAsync(CancellationToken.None);
                    try
                    {
                        if (worker is not null) await runtime.RemoveBrowserAsync(instance, worker, default);
                        var current = await store.ReadAsync(id, default);
                        if (current is not null && current.Generation == instance.Generation && current.DataRevision == instance.DataRevision)
                        {
                            await Save(report, hash, default);
                            if (worker is not null) await store.WriteAsync(current with { Resources = current.Resources.Where(r => r.Id != worker.Id).ToArray() }, default);
                        }
                    }
                    finally { gate.Release(); }
                }
            }
            finally { activeJobs.TryRemove(id + ":" + jobId, out _); capacity.Release(); }
        }
        return report!;
    }

    public Task<SandboxView> CancelAsync(SandboxActor actor, string id, SandboxBrowserCancelRequest request, CancellationToken ct)
        => service.Mutate(actor, id, "browser-cancel", request.RequestId, request.ExpectedRevision, CoreJson.Text(request), async instance =>
        {
            SandboxValidation.Id(request.JobId);
            if (activeJobs.TryGetValue(id + ":" + request.JobId, out var job))
            {
                await realm.RevokeJobLockedAsync(instance, request.JobId, ct);
                job.Cancel();
                return instance;
            }
            return await RecoverLockedAsync(instance, ct);
        }, ct);

    internal async Task<SandboxInstance> RecoverLockedAsync(SandboxInstance instance, CancellationToken ct)
    {
        // The journal precedes the resource intent. Recovery must also cover a crash
        // between those writes, when no browser container exists yet.
        var evidence = store.DataPath(instance.Id, "evidence");
        var jobs = Directory.Exists(evidence)
            ? Directory.EnumerateFiles(evidence, "*.json").Select(Path.GetFileNameWithoutExtension).OfType<string>()
            : [];
        var workers = instance.Resources.Where(r => r.Kind == "container" && r.Service?.StartsWith("browser-", StringComparison.Ordinal) == true).ToArray();
        foreach (var jobId in jobs.Concat(workers.Select(w => w.Service!["browser-".Length..])).Distinct(StringComparer.Ordinal).ToArray())
        {
            if (activeJobs.ContainsKey(instance.Id + ":" + jobId)) continue;
            SandboxValidation.Id(jobId);
            var owned = workers.Where(w => w.Service == "browser-" + jobId).ToArray();
            var journal = await JsonStorage.ReadAsync<SandboxBrowserJournal>(JobPath(instance.Id, jobId), ct);
            if (owned.Length == 0 && journal?.Report.State != "running") continue;
            await realm.RevokeJobLockedAsync(instance, jobId, ct);
            foreach (var worker in owned) await runtime.RemoveBrowserAsync(instance, worker, ct);
            if (journal is not null && journal.Report.State == "running")
                await Save(journal.Report with { State = "unknown", FinishedAt = clock.UtcNow, ErrorCode = "sandbox_browser_interrupted" }, journal.Fingerprint, ct);
            if (owned.Length > 0)
            {
                instance = instance with { Resources = instance.Resources.Where(r => !owned.Any(w => w.Id == r.Id)).ToArray() };
                await store.WriteAsync(instance, ct);
            }
        }
        return instance;
    }

    public async Task<SandboxBrowserReport> ExportAsync(SandboxActor actor, string id, string jobId, CancellationToken ct)
    {
        var instance = await service.RequireAsync(actor, id, ct);
        var journal = await JsonStorage.ReadAsync<SandboxBrowserJournal>(JobPath(id, jobId), ct)
            ?? throw new SandboxException("sandbox_evidence_not_found", "This verification report is unavailable.", 404);
        var report = journal.Report;
        var stale = report.Generation != instance.Generation || report.DataRevision != instance.DataRevision
            || !instance.Users.Any(u => u.Id == report.UserId && u.Enabled && u.Revision == report.UserRevision)
            || report.SourceRevision != await SandboxEvidence.SourceRevisionAsync(instance, ct);
        return report with { Stale = stale || report.Stale };
    }

    private Task Save(SandboxBrowserReport report, string fingerprint, CancellationToken ct)
        => JsonStorage.WriteAsync(JobPath(report.InstanceId, report.Id), new SandboxBrowserJournal(fingerprint, report), true, ct);
    private string JobPath(string id, string jobId)
    { SandboxValidation.Id(jobId); return Path.Combine(store.DataPath(id, "evidence"), jobId + ".json"); }

    internal static void Validate(SandboxBrowserAction[]? actions)
    {
        if (actions is null || actions.Length is < 1 or > 50) throw new SandboxException("sandbox_actions_invalid", "Supply between one and fifty declarative browser actions.", 400);
        foreach (var action in actions)
        {
            if (action is null || action.Kind is not ("navigate" or "click" or "fill" or "assert-visible" or "assert-text" or "screenshot")
                || action.Selector?.Length > 1000 || action.Value?.Length > 4096 || action.Path?.Length > 2000
                || action.Kind is "click" or "fill" or "assert-visible" or "assert-text" && string.IsNullOrWhiteSpace(action.Selector)
                || action.Kind is "fill" or "assert-text" && action.Value is null
                || action.Kind == "navigate" && (action.Path is null || !action.Path.StartsWith('/') || action.Path.StartsWith("//", StringComparison.Ordinal) || action.Path.Contains('\\')))
                throw new SandboxException("sandbox_actions_invalid", "Use bounded navigation, locator actions, assertions and screenshots only.", 400);
        }
        if (actions.Count(a => a.Kind == "screenshot") > 3) throw new SandboxException("sandbox_capture_quota", "A browser run permits up to three viewport screenshots.", 400);
    }

    private static async Task<JsonElement> ControlAsync(string container, SandboxBrowserPayload payload, CancellationToken ct)
    {
        var start = new ProcessStartInfo("docker") { RedirectStandardInput = true, RedirectStandardOutput = true,
            RedirectStandardError = true, UseShellExecute = false };
        foreach (var arg in new[] { "start", "--attach", "--interactive", container }) start.ArgumentList.Add(arg);
        using var process = new Process { StartInfo = start };
        if (!process.Start()) throw new SandboxException("sandbox_browser_unavailable", "The private worker channel could not be opened.");
        using var cancel = ct.Register(() => { try { process.Kill(entireProcessTree: true); } catch (InvalidOperationException) { } });
        var stdout = ReadBounded(process.StandardOutput, 24 * 1024 * 1024, ct);
        // Errors are discarded: browser launch diagnostics can contain login URLs or user data.
        var stderr = ReadBounded(process.StandardError, 65536, ct);
        await process.StandardInput.WriteAsync(CoreJson.Text(payload).AsMemory(), ct);
        process.StandardInput.Close();
        await process.WaitForExitAsync(ct);
        var output = await stdout; await stderr;
        if (process.ExitCode != 0) throw new SandboxException("sandbox_browser_worker_failed", "The private browser worker failed; its credential has been revoked.");
        using var document = JsonDocument.Parse(output);
        return document.RootElement.Clone();
    }
    private static async Task<string> ReadBounded(StreamReader reader, int max, CancellationToken ct)
    {
        var text = new StringBuilder(); var buffer = new char[8192];
        while (true)
        {
            var count = await reader.ReadAsync(buffer.AsMemory(), ct); if (count == 0) return text.ToString();
            if (text.Length + count > max) throw new SandboxException("sandbox_browser_output_quota", "The browser worker exceeded its output budget.");
            text.Append(buffer, 0, count);
        }
    }
}
