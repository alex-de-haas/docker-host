using System.Diagnostics;
using System.Text.Json.Serialization;

namespace Haas.Hosty.Launch;

internal sealed record WorkspaceActivationHelper(string Id, string Attempt, string State, DateTimeOffset AcceptedAt,
    string LogPath, int? Pid = null, DateTimeOffset? StartedAt = null, string? Error = null);
internal sealed record WorkspaceActivationStatus(WorkspaceRuntimeActivation Activation, WorkspaceActivationHelper? Helper,
    bool CancellationRequested);

// Launch lock serializes admission with Core restart/source changes. Each helper takes it for its
// entire run. Separate helper/cancellation files avoid lost updates while Core writes group phases.
internal static class WorkspaceActivationSupervisor
{
    private static string HelperPath(string root, string id)
    {
        _ = WorkspaceRuntimeFiles.PathFor(root, id);
        return Path.Combine(WorkspaceRuntimeFiles.Root(root), "helpers", id + ".json");
    }
    private static string CancelPath(string root, string id) => HelperPath(root, id) + ".cancel";
    internal static WorkspaceActivationHelper? Read(string root, string id) =>
        CoreLaunchFiles.Read(HelperPath(root, id), WorkspaceSupervisorJson.Default.WorkspaceActivationHelper);
    internal static void Save(string root, WorkspaceActivationHelper helper) =>
        CoreLaunchFiles.Write(HelperPath(root, helper.Id), helper, WorkspaceSupervisorJson.Default.WorkspaceActivationHelper);
    internal static bool Pending(WorkspaceActivationHelper? helper) => helper?.State is "accepted" or "running";
    internal static bool Alive(WorkspaceActivationHelper helper) => helper.Pid is { } pid && helper.StartedAt is { } start
        ? CoreBuildRetention.IsAlive(pid, start) : DateTimeOffset.UtcNow - helper.AcceptedAt < TimeSpan.FromSeconds(30);
    internal static bool CancellationRequested(string root, string id) => File.Exists(CancelPath(root, id));
    internal static void ClearCancellation(string root, string id)
    {
        if (File.Exists(CancelPath(root, id))) File.Delete(CancelPath(root, id));
    }
    internal static void CheckCancellation(string root, string id)
    {
        if (CancellationRequested(root, id)) throw new OperationCanceledException("Activation paused at a retained boundary. Resume the original request or Return; no data or source was restored.");
    }
    internal static WorkspaceActivationStatus Status(string root, string id)
    {
        var helper = Read(root, id);
        // Observation never changes durable state and never diagnoses a live helper as abandoned.
        var activation = WorkspaceRuntimeFiles.Read(root, id);
        var terminal = activation.Phase is "active" or "returned" or "cancelled";
        if (terminal && helper is not null) helper = helper with { State = activation.Phase == "cancelled" ? "cancelled" : "completed", Error = null };
        else if (Pending(helper) && !Alive(helper!)) helper = helper! with { State = "interrupted", Error = "Helper exited. Resume this request to reconcile the retained phase." };
        return new(activation, helper, !terminal && CancellationRequested(root, id));
    }
    internal static WorkspaceActivationStatus Cancel(string root, string id)
    {
        var state = Status(root, id);
        if (state.Activation.Phase is "active" or "returned" or "cancelled") return state;
        Directory.CreateDirectory(Path.GetDirectoryName(CancelPath(root, id))!);
        // Immutable marker, separate from the writer's receipt; cancellation never kills a process.
        using (new FileStream(CancelPath(root, id), FileMode.OpenOrCreate, FileAccess.Write, FileShare.ReadWrite)) { }
        return Status(root, id);
    }
    internal static WorkspaceActivationHelper Dispatch(string root, string id, bool resume,
        Action<WorkspaceActivationHelper> spawn)
    {
        var existing = Read(root, id);
        if (Pending(existing) && Alive(existing!)) return existing!;
        using var lease = CoreLaunchFiles.Lock(root);
        existing = Read(root, id);
        if (Pending(existing) && Alive(existing!)) return existing!;
        var activation = WorkspaceRuntimeFiles.Read(root, id);
        if (activation.Phase == "active") WorkspaceActivationHandover.CompleteReplacement(root, activation);
        if (activation.Phase is "active" or "returned" or "cancelled")
            return (existing ?? new(id, "", "completed", DateTimeOffset.UtcNow, "")) with
                { State = activation.Phase == "cancelled" ? "cancelled" : "completed", Error = null };
        if (activation.Phase == "preparing") throw new InvalidOperationException("Prepare the original selection before dispatch.");
        CoreLaunchFiles.AssertNoPendingOperations(root, ownWorkspaceId: id);
        if (CancellationRequested(root, id))
        {
            if (!resume) throw new InvalidOperationException("Cancellation is retained. Use --resume on the original request to continue.");
            File.Delete(CancelPath(root, id));
        }
        var attempt = Guid.NewGuid().ToString("N");
        var helper = new WorkspaceActivationHelper(id, attempt, "accepted", DateTimeOffset.UtcNow,
            Path.Combine(root, "core", "logs", $"workspace-{id}-{attempt}.log"));
        Save(root, helper);
        try { spawn(helper); }
        catch
        {
            Save(root, helper with { State = "failed", Error = "Helper dispatch failed before acknowledgement. Inspect its log and retry the original request." });
            throw;
        }
        return helper;
    }
    // Caller holds launch.lock. An obsolete delayed spawn must never resume a newer attempt.
    internal static WorkspaceActivationHelper Claim(string root, string id, string attempt)
    {
        var helper = Read(root, id) ?? throw new InvalidOperationException("Activation was not admitted.");
        if (helper.Attempt != attempt || helper.State != "accepted")
            throw new InvalidOperationException("This helper attempt is retired or already claimed.");
        using var process = Process.GetCurrentProcess();
        helper = helper with { State = "running", Pid = process.Id, StartedAt = process.StartTime.ToUniversalTime() };
        Save(root, helper);
        return helper;
    }
    internal static void AssertNoPending(string root, string? ownId)
    {
        foreach (var activation in WorkspaceRuntimeFiles.List(root))
        {
            if (activation.Id == ownId || activation.Phase is "active" or "returned" or "cancelled") continue;
            var helper = Read(root, activation.Id);
            if (activation.Phase.StartsWith("return-", StringComparison.Ordinal) || Pending(helper) || activation.Phase is "applying" or "apps-active" or "core-stopping" or "core-stopped" or "core-starting" or "verifying")
                throw new InvalidOperationException($"Workspace activation {activation.Id} needs reconciliation. Resume or Return that operation first.");
        }
    }
}

[JsonSourceGenerationOptions(PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase)]
[JsonSerializable(typeof(WorkspaceActivationHelper))]
[JsonSerializable(typeof(WorkspaceActivationStatus))]
internal partial class WorkspaceSupervisorJson : JsonSerializerContext;
