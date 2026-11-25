using Haas.Hosty.Launch;

namespace Haas.Hosty.Core;

internal sealed record WorkspaceDeleteReturn(string Key, string Kind, string Name, string Operation, string Replacement, DateTimeOffset? Installation = null);

internal sealed class WorkspaceDeletionReturns(CoreDataPaths paths, AppRegistryStore apps, DevelopmentWorkspaceService workspaces,
    AppExecutionTargetService targets, WorkspaceActivationService activations, WorkspaceActivationRecovery supervisor,
    WorkspaceActivationAccess access)
{
    internal async Task<WorkspaceDeleteReturn[]> InventoryAsync(string workspaceId, string user, CancellationToken ct)
    {
        var trees = (await workspaces.ListAsync(null, true, ct)).Workspaces.Where(t => t.WorkspaceId == workspaceId).ToArray();
        var result = new List<WorkspaceDeleteReturn>();
        foreach (var app in await apps.ListAppRecordsAsync(ct))
        {
            var current = await AppDevStore.ReadAsync(paths, app, ct);
            if (current is not { Active: true } || !trees.Any(t => t.Id == current.WorktreeId)) continue;
            var choices = await targets.ChoicesAsync(app.Id, user, ct);
            if (choices.PackageRuntime is not { } package || !choices.Choices.Any(c => c.Kind == "package" && c.Runtime == package && c.Available)) continue;
            result.Add(new(DevelopmentWorkspaceService.Hash(app.Id + "\n" + current.Id + "\n" + app.InstalledAt.ToString("O") + "\n" + package),
                "app", app.Id, current.Id, package, app.InstalledAt));
        }
        foreach (var active in trees.SelectMany(workspaces.CoreActivationConsumers).DistinctBy(a => a.Id))
        {
            if (active.UserId != user || active.WorkspaceId != workspaceId || !trees.Any(t => t.Id == active.CoreWorktreeId)) continue;
            var target = active.CoreReturnTarget ?? WorkspaceActivationReturn.ImmediateTarget(active);
            if (active.PreviousExecutable is null || target.Executable is null || target.ExecutableHash is null || WorkspaceActivationReturn.ExecutableHash(target.Executable) != target.ExecutableHash ||
                target.Launch.ProjectPath is { } project && trees.Any(t => DevelopmentWorkspaceService.IsUnder(t.Path, project))) continue;
            result.Add(new(DevelopmentWorkspaceService.Hash(active.Id + "\n" + CoreJson.Text(target)), "core", "Core", active.Id,
                target.Launch.ProjectPath ?? "installed release"));
        }
        return result.OrderBy(r => r.Key, StringComparer.Ordinal).ToArray();
    }

    internal Task RequireAuthorityAsync(WorkspaceActivationActor actor, WorkspaceDeleteReturn[] selected, CancellationToken ct) =>
        access.ValidateAsync(actor, selected.Any(s => s.Kind == "core"), ct);

    internal async Task AdvanceAsync(string workspace, string request, WorkspaceActivationActor actor, WorkspaceDeleteReturn[] selected, CancellationToken ct)
    {
        // Complete application returns first. A Core handover can interrupt this very coordinator.
        foreach (var target in selected.OrderBy(t => t.Kind == "core"))
        {
            var child = WorkspaceRuntimeFiles.ChildId(request, target.Key);
            var returnActor = actor.Mcp is null && (actor.AppId is not null || actor.Principal?.StartsWith("browser:", StringComparison.Ordinal) == true)
                ? actor with { Deletion = new(workspace, request, target.Key) } : actor;
            await access.ValidateReturnAsync(returnActor, target.Kind, target.Kind == "app" ? target.Name : target.Operation,
                child, ct, target.Operation, target.Replacement);
            if (target.Kind == "app")
            {
                var job = await AppExecutionStore.ReadAsync(paths, target.Name, child, ct);
                if (job?.State == "completed") continue;
                var app = await apps.GetAppAsync(target.Name, ct);
                if (app is null || app.InstalledAt != target.Installation) continue;
                var active = await AppDevStore.ReadAsync(paths, app, ct);
                if (job is null && (active is not { Active: true } || active.Id != target.Operation)) continue;
                var status = await targets.SubmitAsync(target.Name, new(child, "package", target.Replacement), returnActor, ct, workspace, target.Operation);
                if (status.State != "completed") throw Pending(status.Error ?? "Waiting for " + target.Name + " to return to " + target.Replacement + ".");
            }
            else
            {
                var a = WorkspaceRuntimeFiles.Read(paths.DataRoot, target.Operation);
                if (a.UserId != actor.UserId || a.WorkspaceId != workspace) throw WorkspaceActivationAccess.Denied();
                if (a.CoreReturned || a.Phase is "returned" or "cancelled") continue;
                var returning = await activations.PrepareReturnAsync(a.Id, new(child, [], true, true), ct, returnActor);
                if (returning.CoreReturned) continue;
                supervisor.Dispatch(a.Id);
                throw Pending("Waiting for Core to return to " + target.Replacement + ".");
            }
        }
    }

    private static AppLifecycleException Pending(string message) => DevelopmentWorkspaceService.Error("cleanup_pending", message);
}
