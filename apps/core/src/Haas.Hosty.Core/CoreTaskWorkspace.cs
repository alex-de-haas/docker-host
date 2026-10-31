using System.Text.Json;
using HostySdk.App;

namespace Haas.Hosty.Core;

internal sealed record CoreTaskWorkspaceRequest(CoreTaskDispatchRef Dispatch, string ExecutionId, string SessionId,
    string LeaseId, string Kind, string? RequestId = null, long? ExpectedRevision = null,
    string? Title = null, string? NavigationPath = null, WorkspaceActivityRequest? Activity = null);
internal sealed record CoreTaskWorkspaceView(WorkspaceAssociationView Association, WorkspaceList Sources);

// A service credential can recover only its own already-authorized task attempt and exact source
// allocation. This is not a user credential, general source bridge or authority to create source.
internal sealed class CoreTaskWorkspace(CoreCapabilityAuthorization authorization, CoreProviderOperationStore operations,
    CoreProviderMediation mediation, DevelopmentWorkspaceService workspaces, UserDirectoryStore users, AppRegistryStore apps)
{
    internal async Task<object> Run(AppRecord executor, CoreTaskWorkspaceRequest input, CancellationToken ct)
    {
        if (input.Kind is not ("observe" or "attach" or "lease" or "activity") || !Guid.TryParse(input.ExecutionId, out _)
            || !Guid.TryParse(input.LeaseId, out _) || string.IsNullOrWhiteSpace(input.SessionId) || input.SessionId.Length > 200
            || input.SessionId.Any(char.IsControl))
            throw new CoreProviderException("invalid_input", "Use the bound execution, session and lease with a supported workspace operation.", 400);
        var receipt = await operations.TaskDispatchAsync(input.Dispatch, ct);
        var scope = receipt.TaskAuthorization?.Scope;
        if (scope?.WorkspaceId is null || scope.ExecutionId != input.ExecutionId
            || scope.Executor.AppId != executor.Id || scope.Executor.InstallationId != PanelIdentity.Installation(executor))
            throw new AppIdentityException("permission_denied", "This executor is not bound to the selected task workspace.");
        var release = input.Kind == "activity" && input.Activity is { Stopped: true, Status: "idle" or "failed" };
        if (release)
        {
            // Stop confirmation remains available after origin/user grants are revoked, but only
            // for the installation, session and lease already recorded by an authorized admission.
            if (scope.SessionId != input.SessionId || scope.LeaseId != input.LeaseId || input.Activity!.LeaseId != input.LeaseId)
                throw new AppIdentityException("permission_denied", "Only the recorded execution may release its exact lease.");
        }
        else
        {
            var (caller, _) = await authorization.TaskDispatchCallerAsync(input.Dispatch, ct);
            caller.Require(AccessTokenScopes.McpWorkspaces, CoreAppPermissions.Sources);
            if (!AppManagementAuthorization.HasPermission(executor, CoreAppPermissions.Sources))
                throw new AppIdentityException("app_permission_required", "The executor requires reviewed workspace source access.");
            await mediation.RequireTaskWorkspaceAttemptAsync(executor, input.Dispatch, input.ExecutionId, ct);
            await operations.BindTaskWorkspaceAsync(input.Dispatch, input.SessionId, input.LeaseId, ct);
        }
        var actor = new WorkspaceOwner(executor.Id, executor.InstalledAt, receipt.UserId, input.SessionId);
        if (input.Kind == "activity")
        {
            if (input.Activity is null || input.Activity.LeaseId != input.LeaseId)
                throw new CoreProviderException("invalid_input", "Activity must identify this execution's lease.", 400);
            var associated = await workspaces.SessionParticipationAsync(actor, ct);
            if (associated?.Id != scope.WorkspaceId)
                throw new AppIdentityException("permission_denied", "This execution is no longer associated with its authorized workspace.");
            return await workspaces.SessionActivityAsync(actor, input.Activity, ct);
        }
        var participation = await workspaces.ParticipationAsync(scope.WorkspaceId, actor.UserId, ct);
        if (input.Kind == "attach")
        {
            if (input.RequestId != input.ExecutionId || input.ExpectedRevision is null)
                throw new CoreProviderException("invalid_input", "Attach using the execution UUID and reviewed participation revision.", 400);
            await workspaces.ChangeSessionAsync(scope.WorkspaceId, actor, "attach",
                new(input.RequestId, input.ExpectedRevision.Value, input.Title, input.NavigationPath), ct);
            participation = await workspaces.ParticipationAsync(scope.WorkspaceId, actor.UserId, ct);
        }
        if (input.Kind == "lease" && (await workspaces.SessionParticipationAsync(actor, ct))?.Id != scope.WorkspaceId)
            throw new AppIdentityException("permission_denied", "Attach the bound execution before admitting native source use.");
        var sources = new List<DevelopmentWorkspace>();
        foreach (var tree in (await workspaces.ListAsync(null, true, ct)).Workspaces.Where(t => t.WorkspaceId == scope.WorkspaceId && t.State == "active"))
        {
            var current = input.Kind == "lease"
                ? await workspaces.CommandAsync(tree.Id, actor, "lease", new(input.RequestId!, LeaseId: input.LeaseId), ct)
                : await workspaces.ObserveAsync(tree.Id, actor, ct);
            sources.Add(await workspaces.SessionProjectionAsync(current, actor, ct));
        }
        if (input.Kind == "lease" && sources.Count == 0)
            throw new CoreProviderException("workspace_unavailable", "The selected task workspace has no active source to admit.", 409);
        return new CoreTaskWorkspaceView(new(await WorkspaceParticipationEndpoints.Project(participation, actor.UserId, executor.Id, users, apps, ct)),
            new WorkspaceList(sources.ToArray(), new(true, true, actor.UserId, executor.Id)));
    }
}

internal sealed partial class CoreProviderMediation
{
    internal async Task RequireTaskWorkspaceAttemptAsync(AppRecord executor, CoreTaskDispatchRef reference, string executionId, CancellationToken ct)
    {
        var (caller, receipt) = await authorization.TaskDispatchCallerAsync(reference, ct);
        var scope = receipt.TaskAuthorization!.Scope;
        if (scope.Executor.AppId != executor.Id || scope.Executor.InstallationId != PanelIdentity.Installation(executor)
            || scope.ExecutionId != executionId || scope.WorkspaceId is null)
            throw new AppIdentityException("permission_denied", "Use the executor and workspace of this accepted task attempt.");
        await TaskDispatchAuthorityAsync(executor, reference, ct);
        var sourceCaller = caller with { Authority = new("task-source-read", TaskDispatch: reference) };
        var json = await SendAsync<JsonElement?>(sourceCaller, receipt.Provider!, CoreProviderPolicy.For("tasks", "get"), "GET",
            "/tasks/" + Uri.EscapeDataString(scope.TaskRef.Id), null, [scope.TaskRef.Id], null, ct);
        var task = json.Deserialize(CoreJson.TypeInfo<HostyTaskRecord>());
        var attempt = task?.Attempts?.SingleOrDefault(a => a.ExecutionId == executionId);
        if (task?.Ref != scope.TaskRef || task.Status is not ("Ready" or "InProgress" or "Blocked") || task.CancelRequested || attempt is null || attempt.CancelRequested
            || attempt.Receipt is { StopConfirmed: true }
            || attempt.Executor != scope.Executor || attempt.Request.TaskRef != scope.TaskRef
            || attempt.Request.TaskRevision != scope.InputRevision || CoreTaskExecutionScope.Digest(attempt.Request.Input) != scope.InputHash)
            throw new AppIdentityException("permission_denied", "The current task attempt changed or requested cancellation.");
    }
}
