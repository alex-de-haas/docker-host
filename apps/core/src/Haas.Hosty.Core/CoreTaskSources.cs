using System.Collections.Concurrent;
using System.Text.Json;
using HostySdk.App;

namespace Haas.Hosty.Core;

internal sealed record CoreTaskSourceReference(CoreTaskDispatchRef RootDispatch, string ContextId, long ContextRevision, string WorkspaceId);
internal sealed record CoreTaskSourceOperation(string RequestId, string Fingerprint, CoreTaskSourceReference Result);
internal sealed record CoreTaskSourceState(HostyTaskRef RootTaskRef, HostyTaskProviderRef Executor, long RootGeneration,
    CoreTaskSourceReference Reference, CoreTaskSourceOperation[] Operations);
internal sealed record CoreTaskSourceInput(string ContextId, long ExpectedRevision, string SessionId, string? WorkspaceId = null,
    WorkspacePrepare? Prepare = null);

/** Source selection is execution authority, separate from provider-owned task content. */
internal sealed class CoreTaskSources(CoreDataPaths paths, CoreCapabilityAuthorization authorization,
    CoreProviderOperationStore operations, DevelopmentWorkspaceService workspaces, CoreTaskAdapter tasks, AppIdentityService identity)
{
    private readonly ConcurrentDictionary<string, SemaphoreSlim> gates = new(StringComparer.Ordinal);
    private string File(HostyTaskRef root, string owner)
    {
        var key = SandboxValidation.Hash(owner + "\n" + CoreJson.Text(root));
        var file = Path.Combine(paths.CoreRoot, "task-source-contexts", key + ".json");
        if (CoreDataPaths.ContainsSymbolicLink(paths.DataRoot, file)) throw Denied("Source binding storage must not contain symbolic links.");
        return file;
    }
    private async Task RequireSource(CoreCapabilityCaller caller, CoreTaskDispatchRef root, string tool, CancellationToken ct)
    {
        caller.Require(AccessTokenScopes.McpWorkspaces, CoreAppPermissions.Sources);
        var receipt = await operations.TaskDispatchAsync(root, ct);
        var origin = receipt.TaskAuthorization!.Origin;
        if (origin.Kind == "app")
        {
            // A provider-only background scope must never become source authority.
            await identity.RequireOperationHashAsync(origin.IdentityHash!, caller.App!.Id, scope => scope.Kind == "mcp" && scope.TargetAppId == AgentMcpDirectory.CoreId, ct, requireActivity: false);
        }
        await authorization.RevalidateAsync(origin with { InvokedTool = tool }, caller.User.Id, caller.PrincipalId,
            "tasks", receipt.Provider!.AppId, receipt.Provider.Key, tool, ct, retainedTask: true);
    }
    internal async Task<CoreTaskSourceReference?> Observe(AppRecord executor, CoreCapabilityCaller caller,
        CoreTaskWorkflowBinding binding, CancellationToken ct)
    {
        await RequireSource(caller, binding.RootDispatch, "list_workspaces", ct);
        if (!AppManagementAuthorization.HasPermission(executor, CoreAppPermissions.Sources)) throw Denied("The executor needs reviewed source access.");
        var state = await JsonStorage.ReadAsync<CoreTaskSourceState>(File(binding.RootTaskRef, caller.User.Id), ct);
        if (state is null) return null;
        if (state.Executor.AppId != executor.Id || state.Executor.InstallationId != PanelIdentity.Installation(executor))
            throw Denied("This source context belongs to another executor installation.");
        await workspaces.ParticipationAsync(state.Reference.WorkspaceId, caller.User.Id, ct);
        return state.Reference;
    }
    internal async Task<CoreTaskSourceReference> Select(AppRecord executor, CoreCapabilityCaller caller,
        CoreTaskWorkflowBinding binding, HostyTaskRecord parent, CoreTaskWorkflowRequest command, CancellationToken ct)
    {
        var input = command.Payload.Deserialize(CoreJson.TypeInfo<CoreTaskSourceInput>()) ?? throw Invalid();
        if (!Guid.TryParse(input.ContextId, out _) || input.ExpectedRevision < 0
            || parent.Attempts.Last().Receipt?.SessionRef?.Id != input.SessionId
            || (command.Operation == "prepare_source") != (input.Prepare is not null)
            || input.Prepare is null && string.IsNullOrWhiteSpace(input.WorkspaceId)) throw Invalid();
        await RequireSource(caller, binding.RootDispatch, command.Operation == "prepare_source" ? "prepare_workspace" : "acquire_workspace_lease", ct);
        if (!AppManagementAuthorization.HasPermission(executor, CoreAppPermissions.Sources)) throw Denied("The executor needs reviewed source access.");
        var file = File(binding.RootTaskRef, caller.User.Id); var gate = gates.GetOrAdd(file, _ => new(1, 1)); await gate.WaitAsync(ct);
        try
        {
            var current = await JsonStorage.ReadAsync<CoreTaskSourceState>(file, ct);
            var fingerprint = CoreProviderMediation.Hash(System.Text.Encoding.UTF8.GetBytes(command.Operation + CoreJson.Text(input)));
            var previous = current?.Operations.SingleOrDefault(o => o.RequestId == command.RequestId);
            if (previous is not null)
            {
                if (previous.Fingerprint != fingerprint) throw new CoreProviderException("request_conflict", "Recover the original source operation.", 409);
                await workspaces.ParticipationAsync(previous.Result.WorkspaceId, caller.User.Id, ct); return previous.Result;
            }
            if (input.ExpectedRevision != (current?.Reference.ContextRevision ?? 0) || current is not null && current.Reference.ContextId != input.ContextId)
                throw new CoreProviderException("revision_conflict", "Reload this root's source context before changing it.", 409);
            var owner = new WorkspaceOwner(executor.Id, executor.InstalledAt, caller.User.Id, input.SessionId);
            string workspaceId;
            if (input.Prepare is { } preparation)
            {
                if (preparation.RequestId != command.RequestId || preparation.SessionId != input.SessionId || preparation.LeaseId is not null || preparation.ExternalLabel is not null)
                    throw Invalid();
                if (current is not null && (await workspaces.SessionParticipationAsync(owner, ct))?.Id != current.Reference.WorkspaceId)
                    throw new CoreProviderException("source_context_changed", "Attach the existing source context before preparing another repository.", 409);
                workspaceId = (await workspaces.PrepareAsync(owner, preparation, ct)).WorkspaceId;
            }
            else workspaceId = input.WorkspaceId!;
            await workspaces.ParticipationAsync(workspaceId, caller.User.Id, ct);
            if (current is not null && current.Reference.WorkspaceId != workspaceId)
                await RequireStoppedTree(caller, binding.RootTaskRef, current.Reference.WorkspaceId, ct);
            var reference = new CoreTaskSourceReference(binding.RootDispatch, input.ContextId, (current?.Reference.ContextRevision ?? 0) + 1, workspaceId);
            var next = new CoreTaskSourceState(binding.RootTaskRef, parent.Attempts.Last().Executor, binding.RootGeneration, reference,
                [.. current?.Operations ?? [], new(command.RequestId, fingerprint, reference)]);
            await JsonStorage.WriteAsync(file, next, true, ct); return reference;
        }
        finally { gate.Release(); }
    }
    internal async Task<CoreTaskSourceState> Validate(AppRecord executor, CoreTaskSourceReference reference, string tool, CancellationToken ct)
    {
        var (caller, receipt) = await authorization.TaskDispatchCallerAsync(reference.RootDispatch, ct);
        await RequireSource(caller, reference.RootDispatch, tool, ct);
        if (!AppManagementAuthorization.HasPermission(executor, CoreAppPermissions.Sources)) throw Denied("The executor needs reviewed source access.");
        var state = await JsonStorage.ReadAsync<CoreTaskSourceState>(File(receipt.TaskAuthorization!.Scope.TaskRef, caller.User.Id), ct);
        if (state is null || state.Reference != reference || state.Executor.AppId != executor.Id || state.Executor.InstallationId != PanelIdentity.Installation(executor))
            throw Denied("The exact source context is no longer current for this executor.");
        await workspaces.ParticipationAsync(reference.WorkspaceId, caller.User.Id, ct); return state;
    }
    internal async Task BindExecution(AppRecord executor, CoreTaskWorkspaceRequest request, CancellationToken ct)
    {
        var source = request.Source ?? throw Denied("Select the root's exact source context.");
        var context = await Validate(executor, source, "acquire_workspace_lease", ct);
        var (caller, receipt) = await authorization.TaskDispatchCallerAsync(request.Dispatch, ct);
        var scope = receipt.TaskAuthorization!.Scope;
        if (request.Dispatch.UserId != source.RootDispatch.UserId || scope.ExecutionId != request.ExecutionId
            || scope.Executor != context.Executor) throw Denied("This source binding belongs to another execution.");
        var task = (await tasks.GetAsync(caller, new(scope.TaskRef), ct)).Deserialize(CoreJson.TypeInfo<HostyTaskRecord>())!;
        var attempt = task.Attempts.LastOrDefault();
        var root = task.ParentTaskRef is null ? task : (await tasks.GetAsync(caller, new(context.RootTaskRef), ct)).Deserialize(CoreJson.TypeInfo<HostyTaskRecord>())!;
        if (root.CancelRequested || root.Status is "Done" or "Cancelled" || root.Coordination?.RootGeneration != context.RootGeneration)
            throw Denied("The root no longer admits source execution.");
        if (task.RootTaskRef != context.RootTaskRef || task.Coordination?.RootGeneration != context.RootGeneration
            || attempt?.ExecutionId != request.ExecutionId || attempt.Receipt?.SessionRef?.Id != request.SessionId
            || task.CancelRequested || attempt.CancelRequested || task.Status is "Done" or "Cancelled"
            || attempt.Receipt?.StopConfirmed == true) throw Denied("Bind source only to the current admitted task session.");
        if (scope.WorkspaceId is { } previous && previous != source.WorkspaceId)
        {
            if (attempt.Receipt?.NativeStopConfirmed != true) throw Denied("Rebind only after the original native segment is confirmed stopped.");
            await RequireReleased(previous, scope.LeaseId, ct);
        }
        await operations.BindTaskSourceAsync(request.Dispatch, request.ExecutionId, source.WorkspaceId, ct, allowStoppedRebind: true);
    }
    internal async Task<WorkspaceParticipation> AssociateHistory(AppRecord executor, CoreTaskWorkspaceRequest request, CancellationToken ct)
    {
        var source = request.Source ?? throw Denied("Select the retained root source context.");
        var context = await Validate(executor, source, "acquire_workspace_lease", ct);
        var (caller, _) = await authorization.TaskDispatchCallerAsync(source.RootDispatch, ct);
        if (request.TaskRef is null || request.Dispatch != source.RootDispatch) throw Invalid();
        var task = (await tasks.GetAsync(caller, new(request.TaskRef), ct)).Deserialize(CoreJson.TypeInfo<HostyTaskRecord>())!;
        var attempt = task.Attempts.SingleOrDefault(a => a.ExecutionId == request.ExecutionId);
        if (task.RootTaskRef != context.RootTaskRef || task.Owner.UserId != caller.User.Id || attempt?.Executor != context.Executor
            || attempt.Receipt?.SessionRef?.Id != request.SessionId) throw Denied("Associate only an owned historical attempt's retained session.");
        var owner = new WorkspaceOwner(executor.Id, executor.InstalledAt, caller.User.Id, request.SessionId);
        var participation = await workspaces.ParticipationAsync(source.WorkspaceId, caller.User.Id, ct);
        if (request.Kind == "history_observe") return participation;
        var existing = participation.Sessions.SingleOrDefault(s => s.Session.SameIdentity(owner));
        if (existing?.DetachedAt is not null) throw new CoreProviderException("session_detached", "The user detached this session; automatic association cannot undo it.", 409);
        if (existing is not null) return participation;
        if (request.RequestId is null || request.ExpectedRevision is null) throw Invalid();
        return await workspaces.ChangeSessionAsync(source.WorkspaceId, owner, "attach",
            new(request.RequestId, request.ExpectedRevision.Value, request.Title, request.NavigationPath), ct);
    }
    private async Task RequireReleased(string workspaceId, string? leaseId, CancellationToken ct)
    {
        if (leaseId is not null && (await workspaces.ListAsync(null, true, ct)).Workspaces.Any(w => w.WorkspaceId == workspaceId && w.Leases.Contains(leaseId)))
            throw new CoreProviderException("source_boundary_required", "Release the original execution lease after confirmed native stop before rebinding.", 409);
    }
    private async Task RequireStoppedTree(CoreCapabilityCaller caller, HostyTaskRef root, string workspaceId, CancellationToken ct)
    {
        string? cursor = null; var seen = new HashSet<string>(StringComparer.Ordinal);
        do
        {
            var page = (await tasks.ListAsync(caller, new(new(root.AppId, root.InstallationId, root.Key), cursor, 100, RootTaskRef: root), ct))
                .Deserialize(CoreJson.TypeInfo<HostyTaskPage>())!;
            foreach (var task in page.Tasks)
            {
                if (task.RootTaskRef != root || task.Owner.UserId != caller.User.Id) throw Denied("Source observations must stay within the owned task tree.");
                foreach (var attempt in task.Attempts.Where(a => a.Receipt?.SessionRef is not null))
                {
                    if (attempt.Receipt is not { StopConfirmed: true } and not { NativeStopConfirmed: true } && attempt.Receipt?.State != "accepted")
                        throw new CoreProviderException("source_boundary_required", "Pause all affected native attempts before selecting another workspace.", 409);
                    var participation = await workspaces.ParticipationAsync(workspaceId, caller.User.Id, ct);
                    foreach (var session in participation.Sessions.Where(s => s.Session.AppId == attempt.Executor.AppId && s.Session.UserId == caller.User.Id && s.Session.SessionId == attempt.Receipt!.SessionRef!.Id))
                        await RequireReleased(workspaceId, session.LeaseId, ct);
                }
            }
            cursor = page.NextCursor;
            if (cursor is not null && !seen.Add(cursor)) throw Denied("The task provider returned a repeated cursor.");
        } while (cursor is not null);
    }
    private static CoreProviderException Invalid() => new("invalid_input", "Use a bounded, revisioned source selection for the current session.", 400);
    private static CoreProviderException Denied(string message) => new("permission_denied", message, 403);
}
