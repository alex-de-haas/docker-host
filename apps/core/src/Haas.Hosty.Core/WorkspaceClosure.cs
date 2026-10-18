namespace Haas.Hosty.Core;

internal sealed partial class DevelopmentWorkspaceService
{
    // Called under the source-owner gate. Admission is durable before any assistant cancellation.
    // Closing never deletes files or establishes clean/merged feature completion.
    private async Task<WorkspaceWorkflow> CloseWorkflow(WorkspaceOwner owner, string actor,
        WorkspaceWorkflowCommand input, WorkspaceWorkflow state, DevelopmentWorkspace[] trees,
        bool prepareOnly, CancellationToken ct)
    {
        if (state.Closure == "closed") throw Error("workflow_closed", "This workspace is already closed. Resume it before new work.");
        var operation = new WorkspaceWorkflowOperation(input.RequestId, "close", input.ExpectedRevision, "pending");
        state = state with { Closure = "closing", ChangedBy = actor,
            Operations = [.. (state.Operations ?? []).Where(o => o.Id != input.RequestId), operation] };
        await SaveWorkflow(owner, state);
        if (prepareOnly) return state;
        try
        {
            // The shared worker exposes the whole source area. Never stop another session here;
            // retain a blocker until its owner has acknowledged removal and lease release.
            return await Locked("shared-worker-bindings", async () =>
            {
                if (trees.Any(w => w.Operations.Any(o => o.State is "pending" or "unknown")))
                    throw Error("operation_pending", "Resolve outstanding source operations before confirming closure.");
                if (trees.Any(w => w.Leases.Length > 0))
                    throw Error("in_use", "Execution stop is unconfirmed. Activity leases and all source files are preserved. Stop the owning execution, then retry this close request.");
                await CheckSharedWorkersAsync(ct);
                state = state with { Closure = "closed", Revision = state.Revision + 1,
                    Operations = [.. state.Operations!.Where(o => o.Id != input.RequestId), operation with { State = "succeeded" }] };
                await SaveWorkflow(owner, state);
                return state;
            }, ct);
        }
        catch (Exception ex) when (ex is AppLifecycleException or IOException or OperationCanceledException)
        {
            await SaveWorkflow(owner, state with { Operations = [.. state.Operations!.Where(o => o.Id != input.RequestId), operation with { Error = ex.Message }] });
            throw;
        }
    }
}
