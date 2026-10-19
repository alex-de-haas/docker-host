namespace Haas.Hosty.Launch;

internal sealed record WorkspaceCoreObservation(CoreLaunchIdentity Launch, string ListenUrl, string? Executable = null);
internal sealed record WorkspaceCoreOutput(string Executable, string Generation);

// Implemented by the existing CLI build, control-client and process lifecycle paths. Keeping the
// boundary explicit lets fault tests interrupt real receipt writes at every process transition.
internal interface IWorkspaceActivationRuntime
{
    Task<WorkspaceCoreObservation?> ObserveAsync();
    Task<WorkspaceCoreOutput> BuildAsync(string project);
    Task ApplyAppsAsync(string id);
    Task VerifyAppsAsync(string id);
    Task StopAsync();
    Task StartAsync(WorkspaceRuntimeActivation activation);
    Task ReleasePreparationAsync(string id);
    Task RestorePreviousAsync(WorkspaceRuntimeActivation activation);
    Task ValidateAuthorityAsync(string id) => Task.CompletedTask;
    Task ReturnAppsAsync(string id) => throw new NotSupportedException("Workspace Return is unavailable.");
}

internal sealed class WorkspaceActivationHandover(string root, IWorkspaceActivationRuntime runtime)
{
    internal async Task RunAsync(string id)
    {
        var a = WorkspaceRuntimeFiles.Read(root, id);
        if (a.Phase.StartsWith("return-", StringComparison.Ordinal))
        {
            await new WorkspaceActivationReturn(root, runtime).RunAsync(id);
            return;
        }
        if (a.Phase is "active" or "returned" or "cancelled") return;
        if (a.Phase is "preparing") throw new InvalidOperationException("Prepare the original request before activation.");
        try
        {
            WorkspaceActivationSupervisor.CheckCancellation(root, id);
            if (a.Phase is "prepared" or "applying" or "apps-active")
            {
                var current = await runtime.ObserveAsync();
                if (current is null && a.Phase is ("applying" or "apps-active") && a.PreviousExecutable is not null)
                {
                    using (StoppedLock()) { }
                    if (CoreBuildRetention.IsAlive(a.PreviousCore.ProcessId, a.PreviousCore.StartedAt))
                        throw new IOException("The previous Core is still alive but unresponsive. It was not replaced.");
                    await runtime.RestorePreviousAsync(a);
                    current = await runtime.ObserveAsync();
                }
                if (current is null) throw new IOException("The previous Core is unavailable. Restore its captured launch before resuming this request.");
                if (!SameTarget(a.PreviousCore, current.Launch) ||
                    a.Phase == "prepared" && a.PreviousCore != current.Launch)
                    throw new InvalidOperationException("The current Core is not the reviewed previous target. Nothing was stopped.");
                a = Save(a with { ListenUrl = current.ListenUrl, PreviousExecutable = a.PreviousExecutable ?? current.Executable,
                    PreviousExecutableHash = a.PreviousExecutableHash ?? WorkspaceActivationReturn.ExecutableHash(a.PreviousExecutable ?? current.Executable), Error = null });
                if (a.CoreProject is not null && a.PreparedExecutable is null)
                {
                    CoreStateSnapshot.Preflight(root);
                    var prepared = await runtime.BuildAsync(a.CoreProject);
                    a = Save(a with { PreparedExecutable = prepared.Executable, Generation = prepared.Generation });
                }
                WorkspaceActivationSupervisor.CheckCancellation(root, id);
                await runtime.ApplyAppsAsync(id);
                a = WorkspaceRuntimeFiles.Read(root, id);
                if (a.CoreProject is null) return;
                WorkspaceActivationSupervisor.CheckCancellation(root, id);
                await runtime.VerifyAppsAsync(id);
                a = Save(a with { Phase = "core-stopping", Error = null });
            }
            if (a.Phase == "core-stopping")
            {
                WorkspaceActivationSupervisor.CheckCancellation(root, id);
                var current = await runtime.ObserveAsync();
                if (current is not null)
                {
                    if (!SameTarget(a.PreviousCore, current.Launch))
                        throw new InvalidOperationException("A different Core owns this data root. Recovery did not stop it.");
                    await runtime.ValidateAuthorityAsync(id);
                    await runtime.StopAsync();
                }
                // The lifetime lock proves exit even after the stop response or helper was lost.
                using (StoppedLock()) { }
                a = Save(a with { Phase = "core-stopped" });
            }
            if (a.Phase == "core-stopped")
            {
                WorkspaceActivationSupervisor.CheckCancellation(root, id);
                var snapshot = CoreStateSnapshot.Create(root, id);
                a = Save(a with { Phase = "core-starting", Snapshot = snapshot.Archive });
            }
            if (a.Phase == "verifying" && await runtime.ObserveAsync() is null)
            {
                // A candidate can die after its ready identity was receipted but before the group
                // completed. Resume the retained generation; a live unresponsive owner still refuses.
                using (StoppedLock()) { }
                a = Save(a with { Phase = "core-starting" });
            }
            if (a.Phase == "core-starting")
            {
                WorkspaceActivationSupervisor.CheckCancellation(root, id);
                var current = await runtime.ObserveAsync();
                if (current is null)
                {
                    // Refuse a process that owns the root but cannot serve status. A retry must not
                    // spawn over a slow or broken candidate; retain that process for diagnostics.
                    using (StoppedLock()) { }
                    if (a.PreparedExecutable is null || !File.Exists(a.PreparedExecutable) || a.Snapshot is null)
                        throw new IOException("The prepared executable or snapshot receipt is unavailable. No fallback was started.");
                    await runtime.StartAsync(a);
                    current = await runtime.ObserveAsync();
                }
                if (current is null || !IsCandidate(a, current.Launch))
                    throw new IOException("The exact candidate Core has not confirmed readiness. No fallback was started.");
                a = Save(a with { Phase = "verifying", ActivatedCore = current.Launch });
            }
            if (a.Phase == "verifying")
            {
                WorkspaceActivationSupervisor.CheckCancellation(root, id);
                var current = await runtime.ObserveAsync();
                if (current is null || !IsCandidate(a, current.Launch))
                    throw new IOException("The candidate Core is unavailable or has changed. Retain the operation for recovery.");
                await runtime.VerifyAppsAsync(id);
                Save(a with { Phase = "active", ActivatedCore = current.Launch, Error = null });
            }
            else if (a.Phase != "active") throw new InvalidOperationException("The retained phase requires explicit recovery: " + a.Phase);
        }
        catch (OperationCanceledException)
        {
            var latest = WorkspaceRuntimeFiles.Read(root, id);
            if (latest.Phase == "prepared")
            {
                await runtime.ReleasePreparationAsync(id);
                Save(WorkspaceRuntimeFiles.Read(root, id) with { Phase = "cancelled", Error = null });
            }
            throw;
        }
        catch
        {
            var latest = WorkspaceRuntimeFiles.Read(root, id);
            if (latest.Phase == "prepared")
            {
                // The old processes are untouched. Release reservations so source repairs can use
                // an activity lease; the caller must prepare the same request again before retry.
                try { await runtime.ReleasePreparationAsync(id); }
                catch (Exception ex) when (ex is IOException or InvalidOperationException) { }
                latest = WorkspaceRuntimeFiles.Read(root, id);
            }
            // The Core request may still be completing after an HTTP timeout. Never overwrite
            // its group receipt here; the separate helper receipt retains this failed attempt.
            throw;
        }
    }
    private FileStream StoppedLock()
    {
        var directory = Path.Combine(root, "core", "run");
        Directory.CreateDirectory(directory);
        return new(Path.Combine(directory, "core.lock"), FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None);
    }
    private WorkspaceRuntimeActivation Save(WorkspaceRuntimeActivation a) { WorkspaceRuntimeFiles.Save(root, a); return a; }
    internal static bool SameTarget(CoreLaunchIdentity expected, CoreLaunchIdentity actual) =>
        expected.Mode == actual.Mode && expected.ProjectPath == actual.ProjectPath && expected.GenerationPath == actual.GenerationPath;
    internal static bool IsCandidate(WorkspaceRuntimeActivation a, CoreLaunchIdentity launch) =>
        launch.Mode == "dev" && launch.ProjectPath == a.CoreProject && launch.GenerationPath == a.Generation &&
        launch != a.PreviousCore;
}
