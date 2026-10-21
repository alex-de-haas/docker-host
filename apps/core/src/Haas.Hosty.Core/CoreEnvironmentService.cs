using System.Collections.Concurrent;
using System.Net;
using System.Net.Sockets;

namespace Haas.Hosty.Core;

internal sealed class CoreEnvironmentService(CoreEnvironmentStore store, ICoreEnvironmentRuntime runtime, IClock clock, DevelopmentWorkspaceService? workspaces = null, WorkspaceInspectionService? inspection = null, CoreEnvironmentConsentService? consent = null)
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
        record.Process, record.Error, record.Operations ?? [], CoreEnvironmentResources.Limits(record), record.State == "finished" ? null : record.Usage, InitializationRequested: record.Request.Initialization is not null);
    private async Task<CoreEnvironmentView> ViewAsync(CoreEnvironmentRecord record, CancellationToken ct, Dictionary<string, Task<string>>? digests = null)
        => View(record) with { Access = consent is null ? null : await consent.AccessAsync(record, ct, digests) };
    internal Task RequireConsentAsync(SandboxActor actor, CoreEnvironmentRecord record, bool launch, CancellationToken ct)
        => consent?.RequireAsync(actor, record, launch, ct) ?? Task.CompletedTask;
    internal async Task<CoreEnvironmentRecord> RequireAsync(SandboxActor actor, string id, CancellationToken ct)
    {
        var record = await store.ReadAsync(id, ct) ?? throw new SandboxException("environment_not_found", "Environment not found.", 404);
        if (record.Owner.UserId != actor.UserId || actor.AppId is not null && (!record.Owner.SameOwner(actor) || actor.GrantId is not null &&
                (record.Consent?.GrantId != actor.GrantId || record.Consent.ScopeId != actor.ScopeId)))
            throw new SandboxException("environment_forbidden", "The environment belongs to another caller.", 403);
        return record;
    }
    public async Task<CoreEnvironmentList> ListAsync(SandboxActor actor, CancellationToken ct)
    {
        var records = await store.ListAsync(ct);
        var observed = new List<CoreEnvironmentView>();
        var digests = new Dictionary<string, Task<string>>(StringComparer.Ordinal);
        foreach (var record in records.Where(r => r.Owner.UserId == actor.UserId && (actor.AppId is null || r.Owner.SameOwner(actor) && (actor.GrantId is null || r.Consent?.GrantId == actor.GrantId && r.Consent.ScopeId == actor.ScopeId))))
        {
            var gate = Gate(record.Id);
            if (!await gate.WaitAsync(0, ct)) { observed.Add(await ViewAsync((await store.ReadAsync(record.Id, ct))!, ct, digests)); continue; }
            try
            {
                var current = (await store.ReadAsync(record.Id, ct))!;
                try { observed.Add(await ViewAsync(await ObserveAsync(current, ct), ct, digests)); }
                catch (Exception ex) when (ex is SandboxException or IOException or System.Text.Json.JsonException)
                { observed.Add(await ViewAsync(current with { State = "failed", Error = ex.Message }, ct, digests)); }
            }
            finally { gate.Release(); }
        }
        return new(observed, consent is null ? [] : await consent.ListAsync(actor, ct, digests));
    }
    public async Task<CoreEnvironmentView> ReadAsync(SandboxActor actor, string id, CancellationToken ct)
    {
        var gate = Gate(id);
        if (!await gate.WaitAsync(0, ct)) return await ViewAsync(await RequireAsync(actor, id, ct), ct);
        try
        {
            var record = await RequireAsync(actor, id, ct);
            return await ViewAsync(await ObserveAsync(record, ct), ct);
        }
        finally { gate.Release(); }
    }
    private async Task<CoreEnvironmentRecord> ObserveAsync(CoreEnvironmentRecord record, CancellationToken ct)
    {
        if (record.State is "finished" or "finishing" or "cleanup-failed" || record.RootDeletionStarted) return record;
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
            new(WorkspaceId: input.WorkspaceId, SessionId: assistantOwned ? owner.SessionId : null), input.WorktreeIds), ct, operatorApproved: true);
    }
    internal async Task<CoreEnvironmentCreate> ValidateCreateAsync(SandboxActor actor, CoreEnvironmentCreate input, CancellationToken ct)
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
        if (input.ProjectPath is not null) input = input with { ProjectPath = Path.GetFullPath(input.ProjectPath) };
        CoreEnvironmentResources.Validate(input.Limits ?? new());
        if (input.CorePort is { } requestedPort && requestedPort is < 1024 or > 65535)
            throw new SandboxException("environment_port_invalid", "Choose a Core port from 1024 to 65535.", 400);
        if (input.Initialization is { } initialization)
        {
            try { input = input with { Initialization = HostInitializationService.Normalize(initialization) }; }
            catch (AppLifecycleException ex) { throw new SandboxException(ex.Code, ex.Message, 400); }
            if (input.CorePort is { } explicitPort && initialization.Ports?.Any(p => p.Port == explicitPort) == true)
                throw new SandboxException("environment_port_invalid", "Core and application ports must be distinct.", 400);
            var limits = input.Limits ?? new();
            var count = initialization.Apps.Length;
            if (count * limits.ApplicationMemoryBytes > limits.MemoryBytes || count * limits.ApplicationCpus > limits.Cpus
                || count * limits.ApplicationPids > limits.Pids)
                throw new SandboxException("environment_initialization_capacity", "The selected apps exceed this environment's resource allocation. Select fewer apps or explicitly increase the environment limits.", 409);
        }
        await ValidateWorktreesAsync(actor, input, ct);
        return input;
    }
    public Task<CoreEnvironmentView> CreateAsync(SandboxActor actor, CoreEnvironmentCreate input, CancellationToken ct, bool operatorApproved = false)
        => workspaces is null ? CreateResourceAsync(actor, input, ct, operatorApproved)
            : workspaces.WithResourceContextAsync(actor, input.Context, () => CreateResourceAsync(actor, input, ct, operatorApproved), ct);
    private async Task<CoreEnvironmentView> CreateResourceAsync(SandboxActor actor, CoreEnvironmentCreate input, CancellationToken ct, bool operatorApproved)
    {
        input = await ValidateCreateAsync(actor, input, ct);
        var requestId = input.RequestId;
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
                // Replay changes no reservation. Do not hold the root-wide allocation lock while
                // waiting for this environment's command/API gate (a child may allocate descendants).
                reservation.Dispose();
                var gate = Gate(existing.Id); await gate.WaitAsync(ct);
                try
                {
                    if (existing.Fingerprint != fingerprint) throw ReplayConflict();
                    existing = await RequireAsync(actor, existing.Id, ct);
                    // A terminal receipt is safe to replay after Finish retires one-run consent.
                    if (existing.State == "finished") return await ViewAsync(existing, ct);
                    if (actor.AppId is not null && !operatorApproved && consent is not null)
                    {
                        // A reviewed replacement target or revoked grant can be renewed by replaying
                        // the original creation request. Keep the child identity, data and operations.
                        var renewed = await consent.FindAsync(actor, input, ct);
                        if (renewed != existing.Consent)
                        {
                            existing = existing with { Consent = renewed, Revision = existing.Revision + 1 };
                            await store.WriteAsync(existing, ct);
                        }
                    }
                    else if (operatorApproved && existing.Consent is null && !existing.OperatorApproved)
                    {
                        existing = existing with { OperatorApproved = true, Revision = existing.Revision + 1 };
                        await store.WriteAsync(existing, ct);
                    }
                    else await RequireConsentAsync(actor, existing, false, ct);
                    await EnsureRootAsync(existing, ct);
                    return await ViewAsync(existing, ct);
                }
                finally { gate.Release(); }
            }
            var approved = actor.AppId is not null && !operatorApproved && consent is not null
                ? await consent.FindAsync(actor, input, ct) : null;
            var descendants = await budget.ListUnfinishedTreeAsync(ct);
            if (descendants.Count >= 2)
                throw new SandboxException("environment_capacity", "Finish an existing environment before creating another (root environment tree limit: two).", 409);
            CoreEnvironmentResources.Reserve(descendants, input.Limits ?? new());
            var id = Guid.NewGuid().ToString("N");
            var reserved = descendants.Select(r => r.Port).ToHashSet();
            foreach (var assignment in input.Initialization?.Ports ?? []) reserved.Add(assignment.Port);
            var port = input.CorePort ?? RuntimePortHelper.AllocateLoopbackPort(reserved);
            // The automatic allocator already probes its candidate. A second transient bind probe
            // races concurrent allocators; revalidate automatic ports at the actual first launch.
            if (input.CorePort is not null && (reserved.Contains(port) || !RuntimePortHelper.IsLoopbackTcpPortAvailable(port)))
                throw new SandboxException("environment_port_occupied", "The requested Core port is already occupied or reserved.", 409);
            var record = new CoreEnvironmentRecord(id, actor with { GrantId = null, ScopeId = null }, input, fingerprint, port, 1, "stopped", clock.UtcNow, Consent: approved, OperatorApproved: operatorApproved || actor.AppId is null);
            // Persist ownership before creating any root or process so an interrupted allocation is visible.
            await store.WriteAsync(record, ct);
            await EnsureRootAsync(record, ct);
            return await ViewAsync(record, ct);
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
        if (record.State == "finished" || record.RootDeletionStarted || record.State is "finishing" or "cleanup-failed") return;
        var root = store.Root(record.Id);
        if (!File.Exists(CoreInstanceId.BuildPath(root)))
        {
            if (!IncompleteAllocationRoot(root, record.Id))
                throw new SandboxException("environment_owner_mismatch", "An incomplete root contains unexpected files.", 409);
            Directory.CreateDirectory(Path.Combine(root, "core"));
            await JsonStorage.WriteTextAsync(CoreInstanceId.BuildPath(root), record.Id, ct);
        }
        store.VerifyRoot(record);
        if (record.Request.Initialization is null)
            await JsonStorage.WriteTextAsync(Path.Combine(root, "core", "distribution-apps.json"),
                "{\"schemaVersion\":\"distribution-apps.0.1\",\"apps\":[]}", ct);
        else Haas.Hosty.Initialization.InitializationFiles.Request(root);
        foreach (var treeId in record.Request.WorktreeIds ?? [])
            await workspaces!.SetSandboxConsumerAsync(treeId, record.Id, true, ct);
    }
    private static bool IncompleteAllocationRoot(string root, string id)
    {
        if (!Directory.Exists(root)) return true;
        foreach (var entry in Directory.EnumerateFileSystemEntries(root))
        {
            if (entry != Path.Combine(root, "core") || CoreDataPaths.ContainsSymbolicLink(root, entry) || !Directory.Exists(entry)) return false;
            foreach (var file in Directory.EnumerateFileSystemEntries(entry))
            {
                var name = Path.GetFileName(file);
                var prefix = Path.GetFileName(CoreInstanceId.BuildPath(root)) + ".";
                if (CoreDataPaths.ContainsSymbolicLink(root, file) || !File.Exists(file) || !name.StartsWith(prefix, StringComparison.Ordinal)
                    || !name.EndsWith(".tmp", StringComparison.Ordinal) || !Guid.TryParseExact(name[prefix.Length..^4], "N", out _)
                    || !id.StartsWith(File.ReadAllText(file), StringComparison.Ordinal)) return false;
            }
        }
        return true;
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
                if (prior.State == "succeeded" || operations.Last().Id != requestId || record.State == "finished") return await ViewAsync(record, ct);
            }
            // Exact terminal replays do not launch anything. New and retryable operations still
            // require live consent before changing the journal or preparing the child.
            if (kind is "start" or "restart") await RequireConsentAsync(actor, record, true, ct);
            if (prior is not null)
            {
                if (!accepting) throw new SandboxException("environment_shutdown", "Core is stopping.", 409);
                operations = operations.Select(o => o.Id == requestId ? o with { State = "running", Error = null } : o).ToList();
                record = record with { Revision = record.Revision + 1, Operations = operations, Error = null };
                await store.WriteAsync(record, ct);
            }
            else
            {
                if (input.ExpectedRevision != record.Revision)
                    throw new SandboxException("environment_revision_conflict", "Read the current environment revision before changing it.", 409);
                if (record.State == "finished") return await ViewAsync(record, ct);
                if (!accepting) throw new SandboxException("environment_shutdown", "Core is stopping.", 409);
                if (kind != "finish" && (record.RootDeletionStarted || operations.Any(o => o.Kind == "finish")))
                    throw new SandboxException("environment_finishing", "Finish has closed this environment; retry its original request.", 409);
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
                    // Retention must see the prepared generation even if consent changed during
                    // the build. No process is launched before revalidation succeeds.
                    record = record with { Executable = executable };
                    await store.WriteAsync(record, deadline.Token);
                    await RequireConsentAsync(actor, record, true, deadline.Token);
                }
                if (kind is "stop" or "restart" or "finish")
                {
                    record = record with { State = kind == "finish" ? "finishing" : "stopping",
                        CleanupOwners = kind == "finish" ? record.CleanupOwners ?? await store.CleanupOwnersAsync(record, deadline.Token) : record.CleanupOwners };
                    await store.WriteAsync(record, deadline.Token);
                    await runtime.StopAsync(record, root, kind == "finish", deadline.Token);
                    record = record with { Process = null, State = kind == "finish" ? "finishing" : "stopped" };
                }
                if (kind is "start" or "restart")
                {
                    record = record with { State = "starting" };
                    await store.WriteAsync(record, deadline.Token);
                    for (var attempt = 0; ; attempt++)
                    {
                        record = await RevalidateInitialPortAsync(record, root, deadline.Token);
                        try
                        {
                            await runtime.StartAsync(record, root, async process =>
                            {
                                record = record with { Process = process };
                                await store.WriteAsync(record, deadline.Token);
                            }, deadline.Token);
                            break;
                        }
                        catch (SandboxException ex) when (ex.Code == "environment_port_collision" && attempt < 2
                            && CanMoveInitialPort(record) && !CoreEnvironmentRuntime.Alive(record.Process))
                        {
                            record = record with { Process = null };
                            record = await RevalidateInitialPortAsync(record, root, deadline.Token, force: true);
                        }
                    }
                    record = record with { State = "running", HasStarted = true };
                    await store.WriteAsync(record, deadline.Token);
                    await CoreEnvironmentInitialization.ResumeAsync(record, root, deadline.Token);
                }
                if (kind == "finish")
                {
                    // This journal lives outside the deleted tree. After all writers and Docker resources
                    // are gone, a crash during recursive deletion may remove the root identity first.
                    record = record with { RootDeletionStarted = true };
                    await store.WriteAsync(record, deadline.Token);
                    store.DeleteRoot(record);
                    if (consent is not null) await consent.FinishAsync(record, deadline.Token);
                    foreach (var treeId in record.Request.WorktreeIds ?? [])
                        await workspaces!.SetSandboxConsumerAsync(treeId, record.Id, false, deadline.Token);
                    record = record with { State = "finished", Process = null, Executable = null, Usage = null };
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
            return await ViewAsync(record, ct);
        }
        finally { gate.Release(); }
    }
    private static bool CanMoveInitialPort(CoreEnvironmentRecord record)
        => record.Request.CorePort is null && !record.HasStarted
            && !(record.Operations ?? []).Any(o => o.Kind is "start" or "restart" && o.State == "succeeded");

    private async Task<CoreEnvironmentRecord> RevalidateInitialPortAsync(CoreEnvironmentRecord record, string root,
        CancellationToken ct, bool force = false)
    {
        if (!CanMoveInitialPort(record) || CoreEnvironmentRuntime.Alive(record.Process)
            || await runtime.ObserveAsync(record, root, ct) is not null) return record;
        var listener = await JsonStorage.ReadAsync<InitializationListenerState>(InitializationListener.PathFor(root), ct);
        // Core may have reached readiness before the parent saved the successful operation.
        if (listener?.Ready == true) return record;
        if (listener is not null && listener.Port != record.Port)
            await JsonStorage.WriteAsync(InitializationListener.PathFor(root), listener with { Port = record.Port }, restrictToOwner: true, ct);
        if (!force && RuntimePortHelper.IsLoopbackTcpPortAvailable(record.Port)) return record;
        var budget = await store.BudgetStoreAsync(ct);
        using var reservation = await budget.LockAllocationAsync(ct);
        var reserved = (await budget.ListUnfinishedTreeAsync(ct)).Select(r => r.Port).ToHashSet();
        foreach (var port in record.Request.Initialization?.Ports ?? []) reserved.Add(port.Port);
        record = record with { Port = RuntimePortHelper.AllocateLoopbackPort(reserved) };
        await store.WriteAsync(record, ct);
        // The parent owns the child's explicit launch binding; update its unready checkpoint only.
        if (listener is not null)
            await JsonStorage.WriteAsync(InitializationListener.PathFor(root), listener with { Port = record.Port }, restrictToOwner: true, ct);
        return record;
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
                    record = record with { Revision = record.Revision + 1, State = record.Operations!.Any(o => o.Kind == "finish" && o.State == "running") ? "cleanup-failed" : record.State,
                        Error = "An operation was interrupted. Retry the original request ID and arguments.",
                        Operations = record.Operations!.Select(o => o.State == "running" ? o with { State = "failed", Error = "Parent Core stopped during the operation." } : o).ToArray() };
                    await store.WriteAsync(record, ct);
                }
            }
            catch (Exception ex) when (ex is not OutOfMemoryException and not OperationCanceledException)
            {
                var record = (await store.ReadAsync(snapshot.Id, ct))!;
                var error = ex.Message;
                if (ex is SandboxException { Code: "environment_core_version" })
                {
                    try
                    {
                        await runtime.StopAsync(record, store.Root(record.Id), false, ct);
                        record = record with { Process = null };
                    }
                    catch (Exception stopError) when (stopError is not OutOfMemoryException and not OperationCanceledException)
                    { error += " Stopping the incompatible child also failed: " + stopError.Message; }
                }
                await store.WriteAsync(record with { State = record.RootDeletionStarted || record.Operations?.Any(o => o.Kind == "finish") == true ? "cleanup-failed" : "failed", Error = error, Revision = record.Revision + 1 }, ct);
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
                    record = record with { State = record.Operations?.Any(o => o.Kind == "finish") == true ? "cleanup-failed" : "stopped", Process = null, Revision = record.Revision + 1 };
                }
                catch (Exception ex) when (ex is not OutOfMemoryException)
                { record = record with { State = "cleanup-failed", Error = ex.Message, Revision = record.Revision + 1 }; }
                await store.WriteAsync(record, CancellationToken.None);
            }
            finally { gate.Release(); }
        }));
    }
    internal async Task ObserveResourcesAsync(CancellationToken ct)
    {
        foreach (var snapshot in await store.ListAsync(ct))
        {
            if (snapshot.State is "finished" or "finishing" or "cleanup-failed" || snapshot.RootDeletionStarted) continue;
            var gate = Gate(snapshot.Id); if (!await gate.WaitAsync(0, ct)) continue;
            try
            {
                var record = (await store.ReadAsync(snapshot.Id, ct))!;
                if (record.State is "finished" or "finishing" or "cleanup-failed" || record.RootDeletionStarted) continue;
                try
                {
                    var usage = await runtime.InspectResourcesAsync(record, store.Root(record.Id), ct);
                    if (usage is null) continue;
                    record = record with { Usage = usage };
                    if (usage.OwnedDiskBytes > CoreEnvironmentResources.Limits(record).DiskBytes)
                    {
                        await runtime.StopAsync(record, store.Root(record.Id), false, ct);
                        record = record with { State = "quota-exceeded", Process = null, Revision = record.Revision + 1,
                            Error = "The owned-data soft disk limit is exceeded. Data is retained; Finish releases the reservation." };
                    }
                }
                catch (Exception ex) when (ex is not OutOfMemoryException and not OperationCanceledException)
                {
                    record = record with { Usage = new(record.Usage?.OwnedDiskBytes ?? 0, record.Usage?.ContainerMemoryBytes ?? 0,
                        record.Usage?.CoreMemoryBytes ?? 0, "unknown", clock.UtcNow, ex.Message) };
                }
                await store.WriteAsync(record, ct);
            }
            finally { gate.Release(); }
        }
    }
    private static SandboxException ReplayConflict() => new("environment_replay_conflict", "Reuse the original request UUID with exactly the original arguments.", 409);
}

internal sealed class CoreEnvironmentSupervisor(CoreEnvironmentService service, CoreShutdownOptions shutdown,
    ILogger<CoreEnvironmentSupervisor> logger) : BackgroundService
{
    public override async Task StartAsync(CancellationToken ct)
    {
        try { await service.ReconcileAsync(ct); }
        catch (Exception ex) { logger.LogError(ex, "Child Core reconciliation failed; environment records are retained for repair."); }
        await base.StartAsync(ct);
    }
    protected override async Task ExecuteAsync(CancellationToken ct)
    {
        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(15));
        while (await timer.WaitForNextTickAsync(ct))
            try { await service.ObserveResourcesAsync(ct); }
            catch (Exception ex) when (ex is not OperationCanceledException) { logger.LogWarning(ex, "Environment resource observation deferred."); }
    }
    public override async Task StopAsync(CancellationToken ct)
    {
        await base.StopAsync(ct);
        await service.ShutdownAsync(shutdown.KeepRuntimeApps, ct);
    }
}
