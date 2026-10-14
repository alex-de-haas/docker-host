using System.Collections.Concurrent;
using System.Net;
using System.Net.Sockets;

namespace Haas.Hosty.Core;

internal sealed class CoreEnvironmentService(CoreEnvironmentStore store, ICoreEnvironmentRuntime runtime, IClock clock, DevelopmentWorkspaceService? workspaces = null, WorkspaceInspectionService? inspection = null)
{
    private readonly SemaphoreSlim allocation = new(1, 1);
    private readonly ConcurrentDictionary<string, SemaphoreSlim> gates = new(StringComparer.Ordinal);
    private volatile bool accepting = true;
    private readonly CancellationTokenSource operationsStopping = new();
    internal CancellationToken Stopping => operationsStopping.Token;
    internal SemaphoreSlim Gate(string id) { SandboxValidation.Id(id); return gates.GetOrAdd(id, _ => new(1, 1)); }
    internal static string RequestId(string id) => Guid.TryParse(id, out var value) ? value.ToString("N")
        : throw new SandboxException("environment_request_invalid", "Persist a request UUID before sending an operation.", 400);
    internal CoreEnvironmentView View(CoreEnvironmentRecord record) => new(record.Id, record.Request.Label,
        record.Request.Mode, record.Request.ProjectPath, record.Request.Context, record.State, record.Revision, record.Port,
        record.State == "finished" ? null : store.Root(record.Id), $"http://core.i-{record.Id}.hosty.localhost:{record.Port}",
        record.Process, record.Error, record.Operations ?? []);
    internal async Task<CoreEnvironmentRecord> RequireAsync(SandboxActor actor, string id, CancellationToken ct)
    {
        var record = await store.ReadAsync(id, ct) ?? throw new SandboxException("environment_not_found", "Environment not found.", 404);
        if (!record.Owner.SameOwner(actor) && actor.AppId is not null)
            throw new SandboxException("environment_forbidden", "The environment belongs to another caller.", 403);
        return record;
    }
    public async Task<CoreEnvironmentList> ListAsync(SandboxActor actor, CancellationToken ct)
    {
        var records = await store.ListAsync(ct);
        var observed = new List<CoreEnvironmentView>();
        foreach (var record in records.Where(r => actor.AppId is null || r.Owner.SameOwner(actor)))
        {
            var gate = Gate(record.Id);
            if (!await gate.WaitAsync(0, ct)) { observed.Add(View((await store.ReadAsync(record.Id, ct))!)); continue; }
            try
            {
                var current = (await store.ReadAsync(record.Id, ct))!;
                try { observed.Add(View(await ObserveAsync(current, ct))); }
                catch (Exception ex) when (ex is SandboxException or IOException or System.Text.Json.JsonException)
                { observed.Add(View(current with { State = "failed", Error = ex.Message })); }
            }
            finally { gate.Release(); }
        }
        return new(observed);
    }
    public async Task<CoreEnvironmentView> ReadAsync(SandboxActor actor, string id, CancellationToken ct)
    {
        var gate = Gate(id);
        if (!await gate.WaitAsync(0, ct)) return View(await RequireAsync(actor, id, ct));
        try
        {
            var record = await RequireAsync(actor, id, ct);
            return View(await ObserveAsync(record, ct));
        }
        finally { gate.Release(); }
    }
    private async Task<CoreEnvironmentRecord> ObserveAsync(CoreEnvironmentRecord record, CancellationToken ct)
    {
        if (record.State is "finished" or "finishing") return record;
        store.VerifyRoot(record);
        var process = await runtime.ObserveAsync(record, store.Root(record.Id), ct);
        var state = process is not null ? "running" : record.State == "running" ? "stopped" : record.State;
        if (process is null && CoreEnvironmentRuntime.Alive(record.Process)) { process = record.Process; state = "unready"; }
        if (process == record.Process && state == record.State) return record;
        record = record with { Process = process, State = state, Revision = record.Revision + 1 };
        await store.WriteAsync(record, ct); return record;
    }
    public async Task<CoreEnvironmentView> CreateFromWorkspaceAsync(SandboxActor actor, CoreEnvironmentWorkspaceCreate input, CancellationToken ct)
    {
        if (inspection is null || input.WorktreeIds is not { Length: > 0 and <= 16 }
            || input.WorktreeIds.Distinct(StringComparer.Ordinal).Count() != input.WorktreeIds.Length)
            throw new SandboxException("environment_worktrees_invalid", "Select one to sixteen active worktrees.", 400);
        var trees = new List<DevelopmentWorkspace>();
        foreach (var id in input.WorktreeIds)
        {
            var tree = await inspection.RequireAsync(input.WorkspaceId, id, actor.UserId, ct);
            if (tree.State != "active") throw new SandboxException("environment_worktree_unavailable", "The selected worktree is not active.", 409);
            trees.Add(tree);
        }
        string? project = null;
        if (input.CoreWorktreeId is not null)
        {
            var tree = trees.FirstOrDefault(t => t.Id == input.CoreWorktreeId)
                ?? throw new SandboxException("environment_project_invalid", "Select the Core project from an attached worktree.", 400);
            var relative = input.CoreProject ?? "";
            if (string.IsNullOrWhiteSpace(relative) || Path.IsPathRooted(relative) || relative.Contains('\\')
                || relative.Split('/').Any(p => p is ".." or "." or "") || relative.Any(char.IsControl))
                throw new SandboxException("environment_project_invalid", "Use a project path relative to the selected worktree.", 400);
            project = Path.GetFullPath(Path.Combine(tree.Path, relative));
            if (CoreDataPaths.ContainsSymbolicLink(tree.Path, project))
                throw new SandboxException("environment_project_invalid", "The Core project must stay inside its worktree without symlinks.", 400);
        }
        else if (input.CoreProject is not null)
            throw new SandboxException("environment_project_invalid", "Select a worktree for the Core project.", 400);
        // A workspace owner's assistant retains access to a sandbox created by that same operator.
        // External or other-user workspaces remain operator-owned; never impersonate another user.
        var owner = trees[0].Owner;
        var assistantOwned = !owner.IsExternal && owner.UserId == actor.UserId;
        var environmentOwner = assistantOwned ? new SandboxActor(actor.UserId, owner.AppId, owner.Installation) : actor;
        return await CreateAsync(environmentOwner, new(input.RequestId, input.Label, project is null ? "current" : "source", project,
            new(WorkspaceId: input.WorkspaceId, SessionId: assistantOwned ? owner.SessionId : null), input.WorktreeIds), ct);
    }
    public async Task<CoreEnvironmentView> CreateAsync(SandboxActor actor, CoreEnvironmentCreate input, CancellationToken ct)
    {
        var requestId = RequestId(input.RequestId);
        input = input with { RequestId = requestId, Label = input.Label?.Trim() ?? "" };
        if (input.Label.Length is < 1 or > 120 || input.Mode is not ("current" or "source" or "release")
            || input.Mode == "source" && (input.ProjectPath is null || !Path.IsPathFullyQualified(input.ProjectPath)
                || !File.Exists(input.ProjectPath) || Path.GetExtension(input.ProjectPath) != ".csproj")
            || input.Mode != "source" && input.ProjectPath is not null)
            throw new SandboxException("environment_input_invalid", "Select a label and current, release, or source with an absolute Core project path.", 400);
        if (input.WorktreeIds is { } selected && (selected.Length > 16 || selected.Distinct(StringComparer.Ordinal).Count() != selected.Length))
            throw new SandboxException("environment_worktrees_invalid", "Select at most sixteen distinct worktrees.", 400);
        await ValidateWorktreesAsync(actor, input, ct);
        var fingerprint = SandboxValidation.Hash(CoreJson.Text(input));
        await allocation.WaitAsync(ct);
        try
        {
            if (!accepting) throw new SandboxException("environment_shutdown", "Core is stopping; new environments are closed.", 409);
            var budget = await store.BudgetStoreAsync(ct);
            using var reservation = await budget.LockAllocationAsync(ct);
            var all = await store.ListAsync(ct);
            var existing = all.FirstOrDefault(r => r.Owner.SameOwner(actor) && r.Request.RequestId == requestId);
            if (existing is not null)
            {
                if (existing.Fingerprint != fingerprint) throw ReplayConflict();
                await EnsureRootAsync(existing, ct);
                return View(existing);
            }
            var descendants = await budget.ListUnfinishedTreeAsync(ct);
            if (descendants.Count >= 2)
                throw new SandboxException("environment_capacity", "Finish an existing environment before creating another (root environment tree limit: two).", 409);
            var id = Guid.NewGuid().ToString("N");
            var port = RuntimePortHelper.AllocateLoopbackPort(descendants.Select(r => r.Port).ToHashSet());
            var record = new CoreEnvironmentRecord(id, actor, input, fingerprint, port, 1, "stopped", clock.UtcNow);
            // Persist ownership before creating any root or process so an interrupted allocation is visible.
            await store.WriteAsync(record, ct);
            await EnsureRootAsync(record, ct);
            return View(record);
        }
        finally { allocation.Release(); }
    }
    private async Task ValidateWorktreesAsync(SandboxActor actor, CoreEnvironmentCreate input, CancellationToken ct)
    {
        var trees = new List<DevelopmentWorkspace>();
        foreach (var treeId in input.WorktreeIds ?? [])
        {
            if (workspaces is null) throw new SandboxException("environment_worktrees_unavailable", "Worktrees are unavailable.", 409);
            var tree = await workspaces.Read(treeId, null, ct);
            if (actor.AppId is not null && (tree.Owner.AppId != actor.AppId || tree.Owner.Installation != actor.Installation
                || tree.Owner.UserId != actor.UserId || tree.Owner.SessionId != input.Context?.SessionId))
                throw new SandboxException("environment_worktree_forbidden", "Select a worktree owned by this session.", 403);
            if (tree.State != "active") throw new SandboxException("environment_worktree_unavailable", "The worktree is not active.", 409);
            trees.Add(tree);
        }
        if (actor.AppId is not null && input.Mode == "source"
            && !trees.Any(tree => !CoreDataPaths.ContainsSymbolicLink(tree.Path, input.ProjectPath!)))
            throw new SandboxException("environment_project_forbidden", "Select a Core project inside an attached worktree owned by this session, without symlinks.", 403);
    }
    private async Task EnsureRootAsync(CoreEnvironmentRecord record, CancellationToken ct)
    {
        if (record.State == "finished") return;
        var root = store.Root(record.Id);
        if (!File.Exists(CoreInstanceId.BuildPath(root)))
        {
            if (Directory.Exists(root) && Directory.EnumerateFileSystemEntries(root, "*", SearchOption.AllDirectories).Any(File.Exists))
                throw new SandboxException("environment_owner_mismatch", "An incomplete root contains unexpected files.", 409);
            Directory.CreateDirectory(Path.Combine(root, "core"));
            await JsonStorage.WriteTextAsync(CoreInstanceId.BuildPath(root), record.Id, ct);
        }
        store.VerifyRoot(record);
        await JsonStorage.WriteTextAsync(Path.Combine(root, "core", "distribution-apps.json"),
            "{\"schemaVersion\":\"distribution-apps.0.1\",\"apps\":[]}", ct);
        foreach (var treeId in record.Request.WorktreeIds ?? [])
            await workspaces!.SetSandboxConsumerAsync(treeId, record.Id, true, ct);
    }
    public async Task<CoreEnvironmentView> CommandAsync(SandboxActor actor, string id, string kind,
        CoreEnvironmentCommand input, CancellationToken ct)
    {
        if (kind is not ("start" or "stop" or "restart" or "finish"))
            throw new SandboxException("environment_operation_invalid", "Unknown environment operation.", 400);
        var requestId = RequestId(input.RequestId);
        var fingerprint = SandboxValidation.Hash(kind + "|" + CoreJson.Text(input with { RequestId = requestId }));
        var gate = Gate(id); await gate.WaitAsync(ct);
        try
        {
            var record = await RequireAsync(actor, id, ct);
            var operations = (record.Operations ?? []).ToList();
            var prior = operations.FirstOrDefault(o => o.Id == requestId);
            if (prior is not null)
            {
                if (prior.Fingerprint != fingerprint) throw ReplayConflict();
                if (prior.State != "running") return View(record);
            }
            else
            {
                if (input.ExpectedRevision != record.Revision)
                    throw new SandboxException("environment_revision_conflict", "Read the current environment revision before changing it.", 409);
                if (record.State == "finished") return View(record);
                if (!accepting) throw new SandboxException("environment_shutdown", "Core is stopping.", 409);
                if (operations.Count >= 1024 && kind != "finish") throw new SandboxException("environment_operation_capacity", "The environment operation journal is full; finish it.", 409);
                operations.Add(new(requestId, kind, fingerprint, "running"));
                record = record with { Revision = record.Revision + 1, Operations = operations, Error = null };
                await store.WriteAsync(record, ct);
            }
            // Client disconnects do not interrupt a durable accepted operation. The bounded runtime
            // controls its own deadlines, and shutdown closes admission before draining these gates.
            using var deadline = CancellationTokenSource.CreateLinkedTokenSource(operationsStopping.Token);
            deadline.CancelAfter(TimeSpan.FromMinutes(8));
            try
            {
                if (kind is "start" or "restart")
                {
                    await ValidateWorktreesAsync(record.Owner, record.Request, deadline.Token);
                    await EnsureRootAsync(record, deadline.Token);
                }
                store.VerifyRoot(record);
                var root = store.Root(id);
                if (kind is "start" or "restart")
                {
                    record = record with { State = record.Request.Mode == "source" ? "building" : "starting" };
                    await store.WriteAsync(record, deadline.Token);
                    var executable = await runtime.PrepareAsync(record, root, deadline.Token);
                    record = record with { Executable = executable };
                    await store.WriteAsync(record, deadline.Token);
                }
                if (kind is "stop" or "restart" or "finish")
                {
                    record = record with { State = kind == "finish" ? "finishing" : "stopping" };
                    await store.WriteAsync(record, deadline.Token);
                    await runtime.StopAsync(record, root, kind == "finish", deadline.Token);
                    record = record with { Process = null, State = kind == "finish" ? "finishing" : "stopped" };
                }
                if (kind is "start" or "restart")
                {
                    record = record with { State = "starting" };
                    await store.WriteAsync(record, deadline.Token);
                    await runtime.StartAsync(record, root, async process =>
                    {
                        record = record with { Process = process };
                        await store.WriteAsync(record, deadline.Token);
                    }, deadline.Token);
                    record = record with { State = "running" };
                }
                if (kind == "finish")
                {
                    store.DeleteRoot(record);
                    foreach (var treeId in record.Request.WorktreeIds ?? [])
                        await workspaces!.SetSandboxConsumerAsync(treeId, record.Id, false, deadline.Token);
                    record = record with { State = "finished", Process = null, Executable = null };
                }
                operations = operations.Select(o => o.Id == requestId ? o with { State = "succeeded" } : o).ToList();
                record = record with { Revision = record.Revision + 1, Operations = operations, Error = null };
            }
            catch (Exception ex) when (ex is not OutOfMemoryException)
            {
                operations = operations.Select(o => o.Id == requestId ? o with { State = "failed", Error = ex.Message } : o).ToList();
                record = record with { Revision = record.Revision + 1, State = kind == "finish" ? "cleanup-failed" : "failed", Error = ex.Message, Operations = operations };
            }
            await store.WriteAsync(record, CancellationToken.None);
            if (record.State != "finished") await runtime.CleanupAsync(record, store.Root(id), CancellationToken.None);
            return View(record);
        }
        finally { gate.Release(); }
    }
    internal async Task ReconcileAsync(CancellationToken ct)
    {
        foreach (var snapshot in await store.ListAsync(ct))
        {
            var gate = Gate(snapshot.Id); await gate.WaitAsync(ct);
            try
            {
                var record = (await store.ReadAsync(snapshot.Id, ct))!;
                if (record.State == "finished") continue;
                record = await ObserveAsync(record, ct);
                await runtime.CleanupAsync(record, store.Root(record.Id), ct);
                if ((record.Operations ?? []).Any(o => o.State == "running"))
                {
                    record = record with { Revision = record.Revision + 1, Error = "An operation was interrupted. Inspect state and retry with a new request ID.",
                        Operations = record.Operations!.Select(o => o.State == "running" ? o with { State = "failed", Error = "Parent Core stopped during the operation." } : o).ToArray() };
                    await store.WriteAsync(record, ct);
                }
            }
            catch (Exception ex) when (ex is not OutOfMemoryException and not OperationCanceledException)
            {
                var record = (await store.ReadAsync(snapshot.Id, ct))!;
                await store.WriteAsync(record with { State = "failed", Error = ex.Message, Revision = record.Revision + 1 }, ct);
            }
            finally { gate.Release(); }
        }
    }
    internal async Task ShutdownAsync(bool keep, CancellationToken ct)
    {
        accepting = false;
        operationsStopping.Cancel();
        await allocation.WaitAsync(ct); allocation.Release();
        await Task.WhenAll((await store.ListAsync(ct)).Where(r => r.State != "finished").Select(async snapshot =>
        {
            var gate = Gate(snapshot.Id); await gate.WaitAsync(ct);
            try
            {
                var record = (await store.ReadAsync(snapshot.Id, ct))!;
                if (keep) return;
                try
                {
                    await runtime.StopAsync(record, store.Root(record.Id), false, ct);
                    record = record with { State = "stopped", Process = null, Revision = record.Revision + 1 };
                }
                catch (Exception ex) when (ex is not OutOfMemoryException)
                { record = record with { State = "cleanup-failed", Error = ex.Message, Revision = record.Revision + 1 }; }
                await store.WriteAsync(record, CancellationToken.None);
            }
            finally { gate.Release(); }
        }));
    }
    private static SandboxException ReplayConflict() => new("environment_replay_conflict", "Reuse the original request UUID with exactly the original arguments.", 409);
}

internal sealed class CoreEnvironmentSupervisor(CoreEnvironmentService service, CoreShutdownOptions shutdown,
    ILogger<CoreEnvironmentSupervisor> logger) : IHostedService
{
    public async Task StartAsync(CancellationToken ct)
    {
        try { await service.ReconcileAsync(ct); }
        catch (Exception ex) { logger.LogError(ex, "Child Core reconciliation failed; environment records are retained for repair."); }
    }
    public Task StopAsync(CancellationToken ct) => service.ShutdownAsync(shutdown.KeepRuntimeApps, ct);
}
