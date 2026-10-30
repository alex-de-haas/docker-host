namespace Haas.Hosty.Core;

internal sealed partial class PullRequestService
{
    private readonly Dictionary<string, (WorkspacePrObservationJob Job, DateTimeOffset Last, DateTimeOffset? Retry)> workspaceJobs = new(StringComparer.Ordinal);
    private DateTimeOffset workspaceReconciled;
    private async Task ReconcileWorkspaceJobsAsync(CancellationToken ct)
    {
        if (clock.UtcNow - workspaceReconciled < TimeSpan.FromSeconds(30)) return;
        var jobs = await publications.BackgroundObservationJobsAsync(ct);
        lock (sync)
        {
            var ids = jobs.Select(j => j.Id).ToHashSet(StringComparer.Ordinal);
            foreach (var old in workspaceJobs.Keys.Where(k => !ids.Contains(k)).ToArray()) workspaceJobs.Remove(old);
            foreach (var job in jobs)
            {
                var prior = workspaceJobs.GetValueOrDefault(job.Id);
                workspaceJobs[job.Id] = (job, prior.Job is null ? job.Observation?.At ?? DateTimeOffset.MinValue : prior.Last, prior.Retry);
            }
            workspaceReconciled = clock.UtcNow;
        }
    }
    private bool WorkspaceDemand(WorkspacePrObservationJob job) => activeScopes.Values.Any(s => s.Actor.UserId == job.UserId &&
        s.Scope.Workspaces?.Contains(job.WorkspaceId, StringComparer.Ordinal) == true);
    private (WorkspacePrObservationJob Job, DateTimeOffset Due, int Priority)? NextWorkspaceJob()
    {
        var due = workspaceJobs.Values.Where(v => v.Retry is null || v.Retry <= clock.UtcNow).Select(v =>
        {
            var demand = WorkspaceDemand(v.Job);
            var active = v.Job.Observation?.Checks?.Any(c => PullRequestPolicy.CheckState(c.State, c.State) is "pending" or "running") == true ||
                v.Job.Observation is null;
            return (v.Job, Due: v.Last + PullRequestPolicy.Jitter(PullRequestPolicy.Interval(demand, false, active), v.Job.Id), Priority: active && demand ? 0 : 2);
        }).Where(v => v.Due <= clock.UtcNow).OrderBy(v => v.Due).ToArray();
        return due.Length == 0 ? null : due[0];
    }
    private async Task RunWorkspaceJobAsync(WorkspacePrObservationJob job, CancellationToken ct)
    {
        DateTimeOffset? retry = null;
        try
        {
            using var automatic = PullRequestProviderBudget.AutomaticScope();
            using var deadline = CancellationTokenSource.CreateLinkedTokenSource(ct);
            deadline.CancelAfter(TimeSpan.FromSeconds(45));
            await job.Run(deadline.Token);
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested) { throw; }
        catch (Exception ex)
        {
            retry = ex is PullRequestException { RetryAt: { } at } ? at : clock.UtcNow.AddMinutes(5);
            logger.LogWarning("Workspace PR observation will retry ({Kind}).", ex.GetType().Name);
        }
        lock (sync) { if (workspaceJobs.ContainsKey(job.Id)) workspaceJobs[job.Id] = (job, clock.UtcNow, retry); workspaceReconciled = DateTimeOffset.MinValue; if (owners.TryGetValue(job.UserId, out var owner)) Changed(owner); }
    }
}
