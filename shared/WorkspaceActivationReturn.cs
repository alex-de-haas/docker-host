namespace Haas.Hosty.Launch;

// Return has its own immutable request selection. Retired requests remain replayable observations,
// while successful participants release only their own ownership. Snapshots are never restored here.
internal sealed class WorkspaceActivationReturn(string root, IWorkspaceActivationRuntime runtime)
{
    internal static WorkspaceRuntimeActivation Prepare(string root, string id, WorkspaceReturnRequest input, WorkspaceActivationActor? actor = null)
    {
        _ = WorkspaceRuntimeFiles.PathFor(root, input.RequestId);
        if (input.Apps is null) throw new ArgumentException("Supply an explicit apps selection, including an empty array for Core-only Return.");
        var a = WorkspaceRuntimeFiles.Read(root, id);
        var prior = a.Returns?.FirstOrDefault(r => r.Request.RequestId == input.RequestId);
        if (prior is not null)
        {
            if (prior.Request.Core != input.Core || prior.Request.AcceptDataChanges != input.AcceptDataChanges ||
                !prior.Request.Apps.SequenceEqual(input.Apps))
                throw new InvalidOperationException("Preserve the original Return request ID and selection.");
            return a;
        }
        var helper = WorkspaceActivationSupervisor.Read(root, id);
        if (WorkspaceActivationSupervisor.Pending(helper) && WorkspaceActivationSupervisor.Alive(helper!))
            throw new InvalidOperationException("Pause the active helper at a retained boundary before Return.");
        if (a.Phase is "returned" or "cancelled" || a.Phase.StartsWith("return-core-", StringComparison.Ordinal))
            throw new InvalidOperationException("This request is terminal or has an unfinished Core Return. Resume its original request.");
        if (input.Apps.Distinct(StringComparer.Ordinal).Count() != input.Apps.Length ||
            input.Apps.Any(app => !a.Apps.Contains(app) || (a.ReturnedApps ?? []).Contains(app)) ||
            input.Core && (a.CoreProject is null || a.CoreReturned) || input.Apps.Length == 0 && !input.Core)
            throw new InvalidOperationException("Select unreturned participants from this activation.");
        if (input.Core && !input.AcceptDataChanges)
            throw new InvalidOperationException("Explicitly accept compatibility of current Core data with the captured previous executable. Return never restores the snapshot.");
        if (input.Core && a.PreviousExecutable is null && a.Phase is not ("preparing" or "prepared"))
            throw new IOException("The previous executable was not captured. Retain the stopped-state diagnostics and recover that target explicitly.");
        a = a with { Phase = "return-apps", Error = null, Authority = actor,
            Returns = [.. (a.Returns ?? []).Select(r => r.State == "pending" ? r with { State = "superseded" } : r), new(input, "pending")] };
        WorkspaceRuntimeFiles.Save(root, a);
        WorkspaceActivationSupervisor.ClearCancellation(root, id);
        return a;
    }

    internal async Task RunAsync(string id)
    {
        var a = WorkspaceRuntimeFiles.Read(root, id);
        var receipt = a.Returns?.LastOrDefault() ?? throw new InvalidOperationException("Return selection is unavailable.");
        if (receipt.State != "pending") return;
        WorkspaceActivationSupervisor.CheckCancellation(root, id);
        if (a.Phase == "return-apps")
        {
            if (receipt.Request.Apps.Any(app => !(a.ReturnedApps ?? []).Contains(app)))
            {
                var current = await runtime.ObserveAsync();
                if (current is null)
                {
                    using (StoppedLock()) { }
                    // The exact candidate is safe to resume against its own current state. Starting
                    // the previous executable instead requires the separate compatibility decision.
                    if (a.PreparedExecutable is not null && a.Snapshot is not null) await runtime.StartAsync(a);
                    else if (receipt.Request.AcceptDataChanges) await runtime.RestorePreviousAsync(a);
                    else throw new IOException("Core is unavailable. Recover its captured target before returning apps.");
                }
                await runtime.ReturnAppsAsync(id);
                a = WorkspaceRuntimeFiles.Read(root, id);
            }
            if (!receipt.Request.Core) { Complete(a); return; }
            var observed = await runtime.ObserveAsync();
            if (observed is not null && WorkspaceActivationHandover.SameTarget(a.PreviousCore, observed.Launch))
            { Complete(a with { CoreReturned = true }); return; }
            if (observed is not null && !WorkspaceActivationHandover.IsCandidate(a, observed.Launch))
                throw new InvalidOperationException("A different Core owns the data root. Return did not stop it.");
            VerifyPrevious(a);
            if (!File.Exists(a.PreviousExecutable)) throw new IOException("The captured previous executable is unavailable. Current Core remains running.");
            a = Save(a with { Phase = "return-core-stopping" });
        }
        if (a.Phase == "return-core-stopping")
        {
            WorkspaceActivationSupervisor.CheckCancellation(root, id);
            var current = await runtime.ObserveAsync();
            if (current is not null)
            {
                if (WorkspaceActivationHandover.SameTarget(a.PreviousCore, current.Launch))
                { Complete(a with { CoreReturned = true }); return; }
                if (!WorkspaceActivationHandover.IsCandidate(a, current.Launch))
                    throw new InvalidOperationException("Core changed during Return. No unrelated process was stopped.");
                await runtime.ValidateAuthorityAsync(id);
                await runtime.StopAsync();
            }
            using (StoppedLock()) { }
            a = Save(a with { Phase = "return-core-starting" });
        }
        if (a.Phase == "return-core-starting")
        {
            WorkspaceActivationSupervisor.CheckCancellation(root, id);
            var current = await runtime.ObserveAsync();
            if (current is null)
            {
                using (StoppedLock()) { }
                VerifyPrevious(a);
                await runtime.RestorePreviousAsync(a);
                current = await runtime.ObserveAsync();
            }
            if (current is null || !WorkspaceActivationHandover.SameTarget(a.PreviousCore, current.Launch))
                throw new IOException("The captured previous Core has not confirmed readiness. Current data and recovery records are retained.");
            Complete(a with { CoreReturned = true });
        }
    }

    internal static string? ExecutableHash(string? path) => path is not null && File.Exists(path)
        ? Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(File.ReadAllBytes(path))) : null;
    internal static void VerifyPrevious(WorkspaceRuntimeActivation a)
    {
        if (a.PreviousExecutableHash is { } expected && ExecutableHash(a.PreviousExecutable) != expected)
            throw new IOException("The captured previous executable changed. Recover the retained build before Return; no alternate binary was started.");
    }

    private WorkspaceRuntimeActivation Save(WorkspaceRuntimeActivation a) { WorkspaceRuntimeFiles.Save(root, a); return a; }
    private void Complete(WorkspaceRuntimeActivation a) => Save(a with
    {
        Phase = (a.CoreProject is null || a.CoreReturned) && a.Apps.All(app => (a.ReturnedApps ?? []).Contains(app)) ? "returned" : "active",
        Error = null, Returns = a.Returns!.Select((r, i) => i == a.Returns!.Length - 1 ? r with { State = "succeeded" } : r).ToArray()
    });
    private FileStream StoppedLock()
    {
        var directory = Path.Combine(root, "core", "run");
        Directory.CreateDirectory(directory);
        return new(Path.Combine(directory, "core.lock"), FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None);
    }
}
