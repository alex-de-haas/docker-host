using System.Collections.Concurrent;
using System.Threading.Channels;
using Haas.Hosty.Launch;

namespace Haas.Hosty.Core;

// Core owns admitted work; a lost Shell/Harness request does not own the app's process lifetime.
internal sealed class AppExecutionTargetService(CoreDataPaths paths, AppRegistryStore apps,
    CoreLifecycleService lifecycle, DevelopmentWorkspaceService workspaces, WorkspaceInspectionService inspection,
    WorkspaceActivationAccess access, ILogger<AppExecutionTargetService> logger) : BackgroundService
{
    private readonly Channel<(string Id, string Request, bool Group)> queue =
        Channel.CreateUnbounded<(string, string, bool)>(new UnboundedChannelOptions { SingleReader = true });
    private readonly ConcurrentDictionary<string, SemaphoreSlim> gates = new(StringComparer.Ordinal);

    internal async Task<AppExecutionInventory> InventoryAsync(string userId, CancellationToken ct)
    {
        var inventory = await inspection.ListAsync(userId, ct);
        var selectable = await SelectableWorktreesAsync(userId, null, ct);
        var targets = new List<AppExecutionTargets>();
        foreach (var app in await apps.ListAppRecordsAsync(ct))
        {
            try { targets.Add(await lifecycle.ReadExecutionTargetsAsync(app.Id, inventory, ct, selectable)); }
            catch (AppManifestException) { /* A broken unrelated app does not hide the remaining choices. */ }
        }
        return new(targets.ToArray());
    }

    internal async Task<AppExecutionTargets> ChoicesAsync(string appId, string userId, CancellationToken ct, string? principal = null) =>
        await lifecycle.ReadExecutionTargetsAsync(appId, await inspection.ListAsync(userId, ct), ct,
            await SelectableWorktreesAsync(userId, principal, ct));

    private async Task<HashSet<string>> SelectableWorktreesAsync(string userId, string? principal, CancellationToken ct)
    {
        var direct = principal is not null && (principal.StartsWith("oauth:", StringComparison.Ordinal) ||
            principal.StartsWith("manual:", StringComparison.Ordinal));
        return (await workspaces.ListAsync(null, false, ct)).Workspaces
            .Where(tree => tree.Owner.UserId == userId && (!direct || tree.Owner.External?.PrincipalId == principal))
            .Select(tree => tree.Id).ToHashSet(StringComparer.Ordinal);
    }

    internal async Task<AppExecutionStatus> SubmitAsync(string appId, AppExecutionTargetRequest input,
        WorkspaceActivationActor actor, CancellationToken ct, string? onlyWorkspaceId = null)
    {
        AppExecutionStore.Validate(input);
        await ValidateAsync(actor, ct, input.Kind == "workspace");
        var path = AppExecutionStore.FileFor(paths, appId, input.RequestId);
        var gate = gates.GetOrAdd(path, _ => new(1, 1));
        await gate.WaitAsync(ct);
        try
        {
            var fingerprint = AppExecutionStore.Fingerprint(input, actor, onlyWorkspaceId);
            var existing = await AppExecutionStore.ReadAsync(paths, appId, input.RequestId, ct);
            if (existing is not null)
            {
                if (existing.Fingerprint != fingerprint) throw new AppLifecycleException("execution_request_conflict", "This requestId belongs to a different selection or authority.");
                if (existing.State == "completed") return await StatusAsync(appId, input.RequestId, actor.UserId, ct);
                await AppExecutionStore.SaveAsync(paths, existing with { State = "running", Code = null, Error = null, Review = null }, ct);
            }
            else
            {
                var app = await apps.GetAppAsync(appId, ct) ?? throw new AppLifecycleException("app_not_found", "The application is no longer installed.");
                await AppExecutionStore.SaveAsync(paths, new(appId, input, actor, app.InstalledAt, AppExecutionStore.Binding(app),
                    fingerprint, OnlyWorkspaceId: onlyWorkspaceId,
                    PreviousRequestId: (await JsonStorage.ReadAsync<AppExecutionOwner>(Path.Combine(AppExecutionStore.DirectoryFor(paths, appId), "owner.json"), ct))?.RequestId), ct);
            }
            queue.Writer.TryWrite((appId, input.RequestId, false));
            return new(input.RequestId, "running");
        }
        finally { gate.Release(); }
    }

    internal async Task<AppExecutionStatus> StatusAsync(string appId, string requestId, string userId, CancellationToken ct)
    {
        var operation = await AppExecutionStore.ReadAsync(paths, appId, requestId, ct)
            ?? throw new AppLifecycleException("execution_not_found", "Execution selection not found.");
        if (operation.Actor.UserId != userId) throw new AppIdentityException("workspace_forbidden", "This operation belongs to another user.");
        var summaries = await lifecycle.ListAppsAsync(ct);
        return new(requestId, operation.State, summaries.FirstOrDefault(a => a.Id == appId), operation.Code, operation.Error, operation.Review);
    }

    internal async Task<WorkspaceExecutionStatus> SubmitWorkspaceAsync(string workspaceId, AppExecutionTargetRequest input,
        WorkspaceActivationActor actor, CancellationToken ct)
    {
        if (input.Kind is not ("workspace" or "package")) throw new AppLifecycleException("execution_target_invalid", "Choose workspace or package.");
        await ValidateAsync(actor, ct, input.Kind == "workspace");
        // Returning already admitted apps needs ownership metadata, not Git access. A revoked
        // provider connection or unavailable worktree must not prevent restoring their packages.
        var recorded = input.Kind == "package"
            ? (await workspaces.ListAsync(null, true, ct)).Workspaces.Where(t => t.WorkspaceId == workspaceId).ToArray()
            : null;
        var owner = recorded is null ? await inspection.WorkflowOwnerAsync(workspaceId, actor.UserId, ct)
            : recorded.FirstOrDefault()?.Owner ?? throw DevelopmentWorkspaceService.Error("not_found", "Workspace not found.");
        if (owner.UserId != actor.UserId || recorded?.Any(t => !t.Owner.SameIdentity(owner)) == true)
            throw DevelopmentWorkspaceService.Error("forbidden", "Only the workspace owner can manage its lifecycle.");
        if (actor.Principal is { } principal && (principal.StartsWith("oauth:", StringComparison.Ordinal) || principal.StartsWith("manual:", StringComparison.Ordinal))
            && owner.External?.PrincipalId != principal) throw new AppIdentityException("workspace_forbidden", "This credential does not own the workspace.");
        var path = AppExecutionStore.GroupFile(paths, workspaceId, input.RequestId);
        var gate = gates.GetOrAdd(path, _ => new(1, 1));
        await gate.WaitAsync(ct);
        try
        {
            var fingerprint = DevelopmentWorkspaceService.Hash(CoreJson.Text(input) + "\n" + CoreJson.Text(actor) + "\n" + workspaceId);
            var prior = await JsonStorage.ReadAsync<WorkspaceExecutionOperation>(path, ct);
            if (prior is not null && prior.Fingerprint != fingerprint)
                throw new AppLifecycleException("execution_request_conflict", "Keep the original workspace selection and requestId.");
            if (prior?.State == "completed") return await WorkspaceStatusAsync(workspaceId, input.RequestId, actor.UserId, ct);
            var trees = recorded ?? (await workspaces.ListAsync(owner, false, ct)).Workspaces;
            var installed = recorded is null ? null : await apps.ListAppRecordsAsync(ct);
            var bound = trees.SelectMany(t => t.Apps)
                .Where(binding => installed is null || installed.Any(app => app.Id == binding.AppId && app.InstalledAt == binding.Installation))
                .Select(a => a.AppId).Distinct(StringComparer.Ordinal).Order(StringComparer.Ordinal).ToArray();
            var operation = prior is null ? new(workspaceId, input, actor, bound, fingerprint) : prior with { State = "running" };
            if (operation.Apps.Length == 0) throw new AppLifecycleException("execution_empty", "No applications are bound to this workspace.");
            await AppExecutionStore.SaveGroupAsync(paths, operation, ct);
            queue.Writer.TryWrite((workspaceId, input.RequestId, true));
            return new(input.RequestId, "running", operation.Apps.Select(a => new WorkspaceExecutionResult(a, "running")).ToArray());
        }
        finally { gate.Release(); }
    }

    internal async Task<WorkspaceExecutionStatus> WorkspaceStatusAsync(string workspaceId, string requestId, string userId, CancellationToken ct)
    {
        var group = await JsonStorage.ReadAsync<WorkspaceExecutionOperation>(AppExecutionStore.GroupFile(paths, workspaceId, requestId), ct)
            ?? throw new AppLifecycleException("execution_not_found", "Workspace selection not found.");
        if (group.Actor.UserId != userId) throw new AppIdentityException("workspace_forbidden", "This operation belongs to another user.");
        var results = new List<WorkspaceExecutionResult>();
        foreach (var id in group.Apps)
        {
            var op = await AppExecutionStore.ReadAsync(paths, id, WorkspaceRuntimeFiles.ChildId(requestId, id), ct);
            results.Add(new(id, op?.State ?? "running", op?.Code, op?.Error, op?.Review));
        }
        return new(requestId, group.State, results.ToArray());
    }

    private Task ValidateAsync(WorkspaceActivationActor actor, CancellationToken ct, bool source = true) =>
        actor is { Via: "local-control", Principal: "local-control" } ? Task.CompletedTask : access.ValidateAsync(actor, false, ct, source);

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        var root = AppExecutionStore.Root(paths);
        if (Directory.Exists(root))
            foreach (var directory in Directory.EnumerateDirectories(root))
                foreach (var file in Directory.EnumerateFiles(directory, "*.json"))
                {
                    var id = Path.GetFileNameWithoutExtension(file);
                    if (!Guid.TryParseExact(id, "D", out _)) continue;
                    try
                    {
                        var name = Path.GetFileName(directory);
                        var group = name.StartsWith("workspace-", StringComparison.Ordinal);
                        var pending = group
                            ? (await JsonStorage.ReadAsync<WorkspaceExecutionOperation>(file, stoppingToken))?.State == "running"
                            : (await JsonStorage.ReadAsync<AppExecutionOperation>(file, stoppingToken))?.State == "running";
                        if (pending) queue.Writer.TryWrite((group ? name[10..] : name, id, group));
                    }
                    catch (Exception ex) when (ex is IOException or System.Text.Json.JsonException)
                    { logger.LogWarning(ex, "Cannot read retained execution request {RequestId}", id); }
                }
        await foreach (var item in queue.Reader.ReadAllAsync(stoppingToken))
        {
            try
            {
                if (item.Group) await RunGroupAsync(item.Id, item.Request, stoppingToken);
                else await RunAsync(item.Id, item.Request, stoppingToken);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { break; }
            catch (Exception ex) { logger.LogError(ex, "Execution request {RequestId} retains recovery state", item.Request); }
        }
    }

    private async Task RunAsync(string appId, string requestId, CancellationToken ct)
    {
        var path = AppExecutionStore.FileFor(paths, appId, requestId);
        var gate = gates.GetOrAdd(path, _ => new(1, 1));
        await gate.WaitAsync(ct);
        try
        {
            var operation = await AppExecutionStore.ReadAsync(paths, appId, requestId, ct);
            if (operation is null || operation.State != "running") return;
            try
            {
                await ValidateAsync(operation.Actor, ct, operation.Request.Kind == "workspace");
                operation = await lifecycle.ExecuteTargetAsync(operation, ct, token => ValidateAsync(operation.Actor, token, operation.Request.Kind == "workspace"));
                await AppExecutionStore.SaveAsync(paths, operation, ct);
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested) { throw; }
            catch (Exception ex)
            {
                // Reread phases written before a failure so a retry never forgets its Stop boundary.
                operation = (await AppExecutionStore.ReadAsync(paths, appId, requestId, CancellationToken.None)) ?? operation;
                await AppExecutionStore.SaveAsync(paths, operation with { State = "failed",
                    Code = ex is AppLifecycleException life ? life.Code : ex is AppIdentityException identity ? identity.Code : "execution_failed",
                    Error = ex.Message }, CancellationToken.None);
            }
        }
        finally { gate.Release(); }
    }

    private async Task RunGroupAsync(string workspaceId, string requestId, CancellationToken ct)
    {
        var group = (await JsonStorage.ReadAsync<WorkspaceExecutionOperation>(AppExecutionStore.GroupFile(paths, workspaceId, requestId), ct))!;
        if (group.State == "completed") return;
        foreach (var id in group.Apps)
        {
            var child = WorkspaceRuntimeFiles.ChildId(requestId, id);
            var current = await AppExecutionStore.ReadAsync(paths, id, child, ct);
            if (current?.State == "completed") continue;
            try
            {
                await SubmitAsync(id, new(child, group.Request.Kind, group.Request.Runtime,
                    group.Request.Kind == "workspace" ? workspaceId : null), group.Actor, ct,
                    group.Request.Kind == "package" ? workspaceId : null);
                await RunAsync(id, child, ct);
            }
            catch (Exception ex) when (ex is AppLifecycleException or AppIdentityException)
            {
                var app = await apps.GetAppAsync(id, ct);
                if (current is null)
                {
                    var input = new AppExecutionTargetRequest(child, group.Request.Kind, group.Request.Runtime,
                        group.Request.Kind == "workspace" ? workspaceId : null);
                    var onlyWorkspace = group.Request.Kind == "package" ? workspaceId : null;
                    var previous = await JsonStorage.ReadAsync<AppExecutionOwner>(
                        Path.Combine(AppExecutionStore.DirectoryFor(paths, id), "owner.json"), ct);
                    // An authority failure before admission still retains the exact child intent.
                    // Restoring that authority must not turn its original UUID into a conflict.
                    current = new(id, input, group.Actor, app?.InstalledAt ?? default,
                        app is null ? "" : AppExecutionStore.Binding(app), AppExecutionStore.Fingerprint(input, group.Actor, onlyWorkspace),
                        OnlyWorkspaceId: onlyWorkspace, PreviousRequestId: previous?.RequestId);
                }
                await AppExecutionStore.SaveAsync(paths, current with { State = "failed",
                    Code = ex is AppLifecycleException life ? life.Code : "execution_forbidden", Error = ex.Message }, ct);
            }
        }
        var state = await WorkspaceStatusAsync(workspaceId, requestId, group.Actor.UserId, ct);
        var result = state.Apps.All(a => a.State == "completed") ? "completed"
            : state.Apps.Any(a => a.State == "review-required") ? "review-required" : "failed";
        await AppExecutionStore.SaveGroupAsync(paths, group with { State = result }, ct);
    }
}
