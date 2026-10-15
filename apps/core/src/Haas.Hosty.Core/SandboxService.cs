using System.Text;

namespace Haas.Hosty.Core;

internal sealed class SandboxService(SandboxStore store, ISandboxInputs inputs, ISandboxRuntime runtime, IClock clock, UserDirectoryStore? directory = null, HostyCoreRuntimeConfig? config = null)
{
    private readonly SemaphoreSlim allocationGate = new(1, 1);

    public async Task<SandboxPlan> PlanAsync(SandboxActor actor, SandboxPlanRequest request, CancellationToken ct)
    {
        // Leave room for the relay, admission probes and one browser in the default child pool.
        // Persist effective defaults in the reviewed plan; explicit operator limits stay unchanged.
        var defaults = request.Limits is null && config is not null
            && await CoreEnvironmentResources.ManagedAsync(config, ct) is not null
            ? new SandboxLimits(MemoryBytes: 2147483648, Cpus: .5, Pids: 128) : null;
        request = request with { Limits = SandboxValidation.Limits(request.Limits ?? defaults) };
        if (request.Context is { } context)
            foreach (var field in new[] { context.WorkspaceId, context.SessionId, context.JobId }.OfType<string>())
                SandboxValidation.Text(field, 200, "context");
        var input = await inputs.ResolveAsync(actor, request, ct);
        if (request.Source.Kind == "appArtifact") request = request with { Source = request.Source with { ArtifactDigest = input.Digest } };
        var digest = SandboxValidation.Hash(CoreJson.Text(request) + "\n" + input.Digest + "\n" + input.Installation.ToString("O"));
        var plan = new SandboxPlan(Guid.NewGuid().ToString("N"), digest, actor, request, input.Installation,
            input.Digest, clock.UtcNow.AddMinutes(30), input.Reviewed ? [] : ["sandbox_contract_review_required"]);
        await allocationGate.WaitAsync(ct);
        try
        {
            await store.PrunePlansAndCheckCapacityAsync(clock.UtcNow, ct);
            await JsonStorage.WriteAsync(store.PlanPath(plan.Id), new SandboxPlanRecord(plan, input), true, ct);
        }
        finally { allocationGate.Release(); }
        return plan;
    }

    public async Task<SandboxPlan> ApproveAsync(string id, string digest, SandboxActor actor, CancellationToken ct)
    {
        if (actor.AppId is not null) throw Forbidden();
        var record = await ReadPlan(id, ct);
        if (record.Plan.Owner.UserId != actor.UserId || record.Plan.Digest != digest || record.Plan.ExpiresAt <= clock.UtcNow)
            throw new SandboxException("sandbox_plan_stale", "Review the current sandbox plan.");
        var approved = record with { Plan = record.Plan with { Blockers = [] } };
        await JsonStorage.WriteAsync(store.PlanPath(id), approved, true, ct);
        return approved.Plan;
    }

    public async Task<SandboxView> PrepareAsync(SandboxActor actor, SandboxPrepareRequest request, CancellationToken ct)
    {
        SandboxValidation.Request(request.RequestId);
        var fingerprint = SandboxValidation.Hash(CoreJson.Text(request));
        await allocationGate.WaitAsync(ct);
        try
        {
            var path = store.AllocationPath(actor);
            var allocations = await JsonStorage.ReadAsync<SandboxAllocationState>(path, ct) ?? new([]);
            var prior = allocations.Allocations.FirstOrDefault(a => a.RequestId == request.RequestId);
            if (prior is null)
            {
                var interrupted = (await store.ListAsync(ct)).FirstOrDefault(i => i.Owner.Key == actor.Key
                    && i.Operations.Any(o => o.Kind == "prepare" && o.Id == request.RequestId));
                if (interrupted is not null)
                {
                    var operation = interrupted.Operations.Single(o => o.Kind == "prepare" && o.Id == request.RequestId);
                    prior = new(request.RequestId, operation.Fingerprint, interrupted.Id);
                    allocations = allocations with { Allocations = allocations.Allocations.Append(prior).ToArray() };
                    await JsonStorage.WriteAsync(path, allocations, true, ct);
                }
            }
            if (prior is not null)
            {
                if (prior.Fingerprint != fingerprint) throw ReplayConflict();
                var recovered = await store.ReadAsync(prior.InstanceId, ct);
                if (recovered is null) return await ReadAsync(actor, prior.InstanceId, ct);
                // Preparation persists before acquiring a worktree lease or creating data. Resume
                // the same allocation after a crash instead of publishing a second instance.
                if (recovered.State == "preparing") return await CompletePrepare(recovered, ct);
                return await ReadAsync(actor, prior.InstanceId, ct);
            }
            if (allocations.Allocations.Length >= 4096)
                throw new SandboxException("sandbox_metadata_quota", "This owner's durable allocation journal is full; operator retention review is required.");
            await store.PrunePlansAndCheckCapacityAsync(clock.UtcNow, ct);
            var record = await ReadPlan(request.PlanId, ct);
            if (record.Plan.Owner.Key != actor.Key || record.Plan.Digest != request.Digest) throw Forbidden();
            if (record.Plan.ExpiresAt <= clock.UtcNow || record.Plan.Blockers.Length > 0)
                throw new SandboxException("sandbox_plan_unapproved", "The reviewed plan expired or has unresolved blockers.");
            var current = await inputs.ResolvePinnedAsync(actor, record.Plan.Request, record.Input, ct);
            if (current.Installation != record.Plan.Installation || current.Digest != record.Input.Digest)
                throw new SandboxException("sandbox_input_changed", "Execution inputs changed after review.");
            if ((await store.ListAsync(ct)).Length >= 5)
                throw new SandboxException("sandbox_instance_quota", "Finish an existing sandbox before creating another.");
            var instance = new SandboxInstance
            {
                Id = Guid.NewGuid().ToString("N"), Owner = actor, Request = record.Plan.Request, Input = current,
                CreatedAt = clock.UtcNow, State = "preparing", PreviewPort = AllocatePreviewPort((await store.ListAsync(ct)).Select(i => i.PreviewPort).ToHashSet()),
                SourceLeaseId = record.Plan.Request.Source.WorktreeId is null ? null : Guid.NewGuid().ToString(),
                Operations = [new(request.RequestId, "prepare", fingerprint, "running", clock.UtcNow)]
            };
            // Journal the allocation first. An incomplete allocation retains its identity on replay.
            await store.WriteAsync(instance, ct);
            await JsonStorage.WriteAsync(path, allocations with { Allocations = allocations.Allocations.Append(
                new(request.RequestId, fingerprint, instance.Id)).ToArray() }, true, ct);
            return await CompletePrepare(instance, ct);
        }
        finally { allocationGate.Release(); }
    }

    private static int AllocatePreviewPort(HashSet<int> retained)
    {
        for (var attempt = 0; attempt < 64; attempt++)
        {
            using var socket = new System.Net.Sockets.Socket(System.Net.Sockets.AddressFamily.InterNetwork, System.Net.Sockets.SocketType.Stream, System.Net.Sockets.ProtocolType.Tcp);
            socket.Bind(new System.Net.IPEndPoint(System.Net.IPAddress.Loopback, 0));
            var port = ((System.Net.IPEndPoint)socket.LocalEndPoint!).Port;
            if (!retained.Contains(port)) return port;
        }
        throw new SandboxException("sandbox_preview_port_unavailable", "No unused instance preview port could be reserved.");
    }

    private async Task<SandboxView> CompletePrepare(SandboxInstance instance, CancellationToken ct)
    {
        var gate = store.Gate(instance.Id); await gate.WaitAsync(ct);
        try
        {
            await RevalidateInput(instance, ct);
            await inputs.AcquireAsync(instance, ct);
            store.AllocateData(instance.Id);
            instance = instance with { State = "prepared", Operations = instance.Operations.Select(o => o.Kind == "prepare"
                ? o with { State = "succeeded" } : o).ToArray() };
            await store.WriteAsync(instance, ct);
            return View(instance);
        }
        catch (Exception ex) when (ex is SandboxException or IOException or OperationCanceledException or AppLifecycleException)
        {
            await store.WriteAsync(instance with { State = "unknown", AccessRevoked = true, ErrorCode = "sandbox_prepare_incomplete",
                Operations = instance.Operations.Select(o => o.Kind == "prepare" ? o with { State = "failed", ErrorCode = "sandbox_prepare_incomplete" } : o).ToArray() }, default);
            throw;
        }
        finally { gate.Release(); }
    }

    public async Task<SandboxInventory> ListAsync(SandboxActor actor, CancellationToken ct)
    {
        var records = await store.ListAsync(ct);
        return new(records.Where(r => Allowed(actor, r.Owner)).Select(View).ToArray());
    }

    public async Task<SandboxView> ReadAsync(SandboxActor actor, string id, CancellationToken ct)
    {
        var instance = await store.ReadAsync(id, ct);
        if (instance is not null) { RequireOwner(actor, instance.Owner); return View(instance); }
        var receipt = await JsonStorage.ReadAsync<SandboxReceipt>(store.ReceiptPath(id), ct)
            ?? throw new SandboxException("sandbox_not_found", "Sandbox not found.", 404);
        RequireOwner(actor, receipt.Owner);
        return new(id, receipt.AppId, receipt.Owner, new("disposed"), null, 0, "", "", "disposed", null, null, new(), receipt.Operations, []);
    }

    public async Task<SandboxDiagnostics> DiagnosticsAsync(SandboxActor actor, string id, CancellationToken ct)
    {
        var instance = await RequireAsync(actor, id, ct);
        return new(id, instance.State, instance.ErrorCode, await runtime.LogsAsync(instance, ct));
    }

    public async Task<SandboxPreview> PreviewAsync(SandboxActor actor, string id, string? userId, CancellationToken ct)
    {
        var instance = await RequireAsync(actor, id, ct);
        if (userId is not null && !instance.Users.Any(u => u.Id == userId && u.Enabled))
            throw new SandboxException("sandbox_user_unavailable", "Select an enabled test user in this sandbox.", 404);
        var url = instance.State == "ready" && !instance.AccessRevoked && instance.PreviewUrl is not null
            ? instance.PreviewUrl + "?hosty_sandbox_persona=" + Uri.EscapeDataString(userId ?? "core") : null;
        return new(id, instance.State, userId is null ? "core" : "sandbox", userId, url);
    }

    internal async Task<SandboxInstance> RequireAsync(SandboxActor actor, string id, CancellationToken ct)
    {
        var instance = await store.ReadAsync(id, ct) ?? throw new SandboxException("sandbox_not_found", "Sandbox not found.", 404);
        RequireOwner(actor, instance.Owner);
        return instance;
    }

    public Task<SandboxView> UserAsync(SandboxActor actor, string id, SandboxUserRequest request, CancellationToken ct)
        => Mutate(actor, id, "user", request.RequestId, request.ExpectedRevision, CoreJson.Text(request), async instance =>
        {
            SandboxValidation.Text(request.FixtureKey, 100, "fixtureKey");
            SandboxValidation.Text(request.DisplayName, 160, "displayName");
            if (!instance.Input.Roles.Contains(request.Role, StringComparer.Ordinal)
                || request.Permissions is { Length: > 100 } || (request.Permissions ?? []).Any(p => !instance.Input.Permissions.Contains(p, StringComparer.Ordinal)))
                throw new SandboxException("sandbox_role_unsupported", "The app does not declare this role/permission scenario.", 400);
            if (Encoding.UTF8.GetByteCount(CoreJson.Text(request)) > 16384)
                throw new SandboxException("sandbox_user_too_large", "Test user records are limited to 16 KiB.", 400);
            var prior = instance.Users.FirstOrDefault(u => u.FixtureKey == request.FixtureKey);
            if (prior is null && instance.Users.Length >= 50) throw new SandboxException("sandbox_user_quota", "This sandbox already has 50 users.");
            var user = new SandboxUser(prior?.Id ?? "sandbox_" + Guid.NewGuid().ToString("N"), request.FixtureKey,
                request.DisplayName, request.Role, (request.Permissions ?? []).Distinct(StringComparer.Ordinal).Order(StringComparer.Ordinal).ToArray(),
                request.Enabled, (prior?.Revision ?? 0) + 1);
            await Task.CompletedTask;
            return instance with { Users = instance.Users.Where(u => u.FixtureKey != user.FixtureKey).Append(user).ToArray() };
        }, ct);

    public Task<SandboxView> DeleteUserAsync(SandboxActor actor, string id, SandboxUserDeleteRequest request, CancellationToken ct)
        => Mutate(actor, id, "user-delete", request.RequestId, request.ExpectedRevision, CoreJson.Text(request), instance =>
            Task.FromResult(instance with { Users = instance.Users.Where(u => u.Id != request.UserId).ToArray() }), ct);

    public Task<SandboxView> ViewersAsync(SandboxActor actor, string id, SandboxViewersRequest request, CancellationToken ct)
        => Mutate(actor, id, "viewers", request.RequestId, request.ExpectedRevision, CoreJson.Text(request), async instance =>
        {
            if (request.UserIds is null || request.UserIds.Length > 32 || directory is null)
                throw new SandboxException("sandbox_viewers_invalid", "Select up to 32 active Core users.", 400);
            var users = (await directory.ReadAsync(ct)).Users;
            if (request.UserIds.Any(id => !users.Any(u => u.Id == id && !u.Disabled)))
                throw new SandboxException("sandbox_viewers_invalid", "Every preview viewer must be an active Core user.", 400);
            return instance with { Viewers = request.UserIds.Distinct(StringComparer.Ordinal).ToArray() };
        }, ct);

    public Task<SandboxView> ClearEvidenceAsync(SandboxActor actor, string id, SandboxEvidenceClearRequest request, CancellationToken ct)
        => Mutate(actor, id, "evidence-clear", request.RequestId, request.ExpectedRevision, CoreJson.Text(request), async instance =>
        {
            SandboxValidation.Id(request.JobId);
            var path = Path.Combine(store.DataPath(id, "evidence"), request.JobId + ".json");
            var journal = await JsonStorage.ReadAsync<SandboxBrowserJournal>(path, ct);
            if (journal?.Report.State == "running") throw new SandboxException("sandbox_browser_pending", "Stop or finish the browser job before deleting its evidence.");
            if (File.Exists(path)) File.Delete(path);
            return instance;
        }, ct);

    public Task<SandboxView> SeedAsync(SandboxActor actor, string id, SandboxSeedRequest request, CancellationToken ct)
        => Mutate(actor, id, "seed", request.RequestId, request.ExpectedRevision, CoreJson.Text(request), async instance =>
        {
            RequireStopped(instance);
            if (request.Files is null || request.Files.Length > 1000 || request.Files.Any(f => f is null || f.Content is null)
                || request.Files.Select(f => f.Path).Distinct(StringComparer.OrdinalIgnoreCase).Count() != request.Files.Length
                || request.Files.Any(f => Encoding.UTF8.GetByteCount(f.Content) > 1048576)
                || request.Files.Sum(f => (long)Encoding.UTF8.GetByteCount(f.Content)) > 33554432)
                throw new SandboxException("sandbox_seed_quota", "Seeds are limited to 1000 files, 1 MiB per file and 32 MiB total.", 400);
            foreach (var file in request.Files) ValidateRelative(store.DataPath(id, "data"), file.Path);
            var revision = Guid.Parse(request.RequestId).ToString("N");
            var seed = new SandboxSeedRecord(revision, request.Files, instance.Users);
            var path = Path.Combine(store.DataPath(id, "seeds"), revision + ".json");
            var bytes = Encoding.UTF8.GetByteCount(CoreJson.Text(seed));
            var retained = Directory.EnumerateFiles(store.DataPath(id, "seeds"), "*.json").Where(p => p != path).Sum(p => new FileInfo(p).Length);
            if (retained + bytes > 33554432) throw new SandboxException("sandbox_seed_quota", "Retained seed revisions exceed the 32 MiB instance budget.");
            await JsonStorage.WriteAsync(path, seed, true, default);
            return instance;
        }, ct);

    public async Task<SandboxView> CommandAsync(SandboxActor actor, string id, string kind, SandboxCommand request, CancellationToken ct)
    {
        // Reject incomplete reset choices before entering a lifecycle transition. Once a transition
        // begins, its existing fail-closed credential revocation remains unchanged.
        if (kind == "reset")
        {
            await RequireAsync(actor, id, ct);
            if (request.SeedRevision is null) throw new SandboxException("sandbox_seed_required", "Choose empty or a seed revision.", 400);
            if (request.SeedRevision != "empty")
            {
                SandboxValidation.Id(request.SeedRevision);
                if (!File.Exists(Path.Combine(store.DataPath(id, "seeds"), request.SeedRevision + ".json")))
                    throw new SandboxException("sandbox_seed_not_found", "Seed revision not found.", 404);
            }
        }
        return await Mutate(actor, id, kind, request.RequestId, request.ExpectedRevision, CoreJson.Text(request), async instance =>
        {
            switch (kind)
            {
                case "start":
                case "restart":
                    await RevalidateInput(instance, ct);
                    await inputs.AcquireAsync(instance, ct);
                    store.AllocateData(instance.Id);
                    if (instance.State == "ready" && kind == "start") return instance;
                    await runtime.StopAsync(instance, ct);
                    await runtime.RemoveAsync(instance, ct);
                    if (SandboxSupervisor.ObserveStorage(store, instance, clock.UtcNow).ErrorCode is not null)
                        throw new SandboxException("storage_budget_exceeded", "Reduce retained storage before starting this instance.");
                    store.ClearEmergency(instance.Id);
                    instance = instance with { State = "starting", AccessRevoked = true, Generation = Guid.NewGuid().ToString("N"), Resources = [], Metrics = null };
                    await store.WriteAsync(instance, default);
                    var preview = await runtime.StartAsync(instance, async resource =>
                    {
                        instance = instance with { Resources = instance.Resources.Where(r => r.Kind != resource.Kind || r.Id != resource.Id).Append(resource).ToArray() };
                        await store.WriteAsync(instance, default);
                    }, ct);
                    return instance with { State = "ready", AccessRevoked = false, PreviewUrl = preview.PreviewUrl,
                        AuthOrigin = preview.AuthOrigin, Endpoints = preview.Endpoints, BrowserProxy = preview.BrowserProxy };
                case "stop":
                    instance = instance with { State = "stopping", AccessRevoked = true };
                    await store.WriteAsync(instance, default);
                    await runtime.StopAsync(instance, ct);
                    return instance with { State = "stopped" };
                case "reset":
                    SandboxSeedRecord? seed = null;
                    if (request.SeedRevision is not null and not "empty")
                    {
                        SandboxValidation.Id(request.SeedRevision);
                        seed = await JsonStorage.ReadAsync<SandboxSeedRecord>(Path.Combine(store.DataPath(id, "seeds"), request.SeedRevision + ".json"), ct)
                            ?? throw new SandboxException("sandbox_seed_not_found", "Seed revision not found.", 404);
                    }
                    if (request.SeedRevision is null) throw new SandboxException("sandbox_seed_required", "Choose empty or a seed revision.", 400);
                    instance = instance with { State = "resetting", AccessRevoked = true };
                    await store.WriteAsync(instance, default);
                    await runtime.StopAsync(instance, ct);
                    await runtime.RemoveAsync(instance, ct);
                    var data = store.DataPath(id, "data");
                    if (Directory.Exists(data)) Directory.Delete(data, true);
                    Directory.CreateDirectory(data);
                    var users = (seed?.Users ?? []).Select(u => u with { Id = "sandbox_" + Guid.NewGuid().ToString("N"), Revision = 1 }).ToArray();
                    foreach (var file in seed?.Files ?? [])
                    {
                        var path = ValidateRelative(data, file.Path);
                        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
                        var content = file.Content;
                        foreach (var user in users) content = content.Replace("{{sandbox.user." + user.FixtureKey + "}}", user.Id, StringComparison.Ordinal);
                        await File.WriteAllTextAsync(path, content, ct);
                    }
                    return instance with { State = "stopped", DataRevision = Guid.NewGuid().ToString("N"), Users = users, Resources = [], PreviewUrl = null };
                case "dispose":
                    instance = instance with { State = "disposing", AccessRevoked = true, Users = [] };
                    await store.WriteAsync(instance, default);
                    await runtime.StopAsync(instance, ct);
                    await runtime.RemoveAsync(instance, ct);
                    store.RemoveTemporary(id);
                    await inputs.ReleaseAsync(instance, ct);
                    return instance with { State = "disposed", Resources = [], PreviewUrl = null };
                default: throw new SandboxException("sandbox_operation_invalid", "Unknown sandbox lifecycle operation.", 400);
            }
        }, ct, recover: kind == "dispose");
    }

    internal async Task<SandboxView> Mutate(SandboxActor actor, string id, string kind, string requestId, long expected,
        string body, Func<SandboxInstance, Task<SandboxInstance>> action, CancellationToken ct, bool recover = false)
    {
        SandboxValidation.Id(id); SandboxValidation.Request(requestId);
        var gate = store.Gate(id);
        await gate.WaitAsync(ct);
        try
        {
            var instance = await store.ReadAsync(id, ct);
            if (instance is null)
            {
                var disposed = await ReadAsync(actor, id, ct);
                var done = disposed.Operations.FirstOrDefault(o => o.Id == requestId);
                if (done is null || done.Fingerprint != SandboxValidation.Hash(kind + "\n" + body)) throw ReplayConflict();
                return disposed;
            }
            RequireOwner(actor, instance.Owner);
            var fingerprint = SandboxValidation.Hash(kind + "\n" + body);
            var prior = instance.Operations.FirstOrDefault(o => o.Id == requestId);
            if (prior is not null)
            {
                if (prior.Fingerprint != fingerprint) throw ReplayConflict();
                if (prior.State == "succeeded" || !recover) return View(instance);
            }
            else
            {
                if (instance.Operations.Length >= 1024 && kind != "dispose")
                    throw new SandboxException("sandbox_metadata_quota", "This instance's operation journal is full; export needed results and finish it.");
                if (instance.Revision != expected) throw new SandboxException("sandbox_revision_stale", "Read the current instance revision before changing it.");
                if (instance.State is "disposing" or "disposed" || instance.Operations.Any(o => o.State == "running"))
                    throw new SandboxException("sandbox_operation_pending", "Reconcile the existing operation before issuing another.");
                instance = instance with { Revision = instance.Revision + 1, Operations = instance.Operations.Append(
                    new SandboxOperation(requestId, kind, fingerprint, "running", clock.UtcNow)).ToArray() };
                await store.WriteAsync(instance, default);
            }
            try
            {
                instance = await action(instance);
                instance = instance with { ErrorCode = null, Operations = instance.Operations.Select(o => o.Id == requestId
                    ? o with { State = "succeeded", ErrorCode = null, Message = null } : o).ToArray() };
            }
            catch (Exception ex) when (ex is SandboxException or IOException or OperationCanceledException or DockerUnavailableException or AppLifecycleException)
            {
                // Runtime callbacks may have recorded resources before failure. Preserve that journal.
                instance = await store.ReadAsync(id, default) ?? instance;
                var code = ex is SandboxException sandbox ? sandbox.Code : "sandbox_operation_failed";
                instance = instance with { ErrorCode = code, AccessRevoked = kind is "start" or "restart" or "reset" or "dispose" || instance.AccessRevoked,
                    Operations = instance.Operations.Select(o => o.Id == requestId ? o with { State = "failed", ErrorCode = code,
                        Message = "Operation did not complete; inspect state and recorded resources before retrying." } : o).ToArray() };
                await store.WriteAsync(instance, default);
                throw;
            }
            if (instance.State == "disposed")
            {
                await JsonStorage.WriteAsync(store.ReceiptPath(id), new SandboxReceipt(id, instance.Owner, clock.UtcNow,
                    instance.Operations.Select(o => o with { Message = null }).ToArray(), instance.Input.AppId), true, default);
                store.RemoveMetadata(id);
            }
            else await store.WriteAsync(instance, default);
            return View(instance);
        }
        finally { gate.Release(); }
    }

    private async Task RevalidateInput(SandboxInstance instance, CancellationToken ct)
    {
        var current = await inputs.ResolvePinnedAsync(instance.Owner, instance.Request, instance.Input, ct);
        if (current.Digest != instance.Input.Digest || current.Installation != instance.Input.Installation)
            throw new SandboxException("sandbox_input_changed", "The reviewed app or execution recipe changed.");
    }
    private async Task<SandboxPlanRecord> ReadPlan(string id, CancellationToken ct)
        => await JsonStorage.ReadAsync<SandboxPlanRecord>(store.PlanPath(id), ct)
            ?? throw new SandboxException("sandbox_plan_not_found", "Sandbox plan not found.", 404);
    private static string ValidateRelative(string root, string relative)
    {
        if (!CoreDataPaths.TryResolveContainedRelativePath(root, relative, out var path) || relative.Any(char.IsControl)
            || CoreDataPaths.ContainsSymbolicLink(root, path))
            throw new SandboxException("sandbox_seed_path_invalid", "Seed files must stay inside the selected sandbox.", 400);
        return path;
    }
    private static void RequireStopped(SandboxInstance instance)
    {
        if (instance.State is not ("prepared" or "stopped")) throw new SandboxException("sandbox_not_stopped", "Stop the instance before modifying fixtures.");
    }
    private static bool Allowed(SandboxActor actor, SandboxActor owner)
        => actor.SameOwner(owner) || (actor.AppId is null && actor.UserId == owner.UserId);
    private static void RequireOwner(SandboxActor actor, SandboxActor owner) { if (!Allowed(actor, owner)) throw Forbidden(); }
    private static SandboxException Forbidden() => new("sandbox_forbidden", "The sandbox is outside this caller's authority.", 403);
    private static SandboxException ReplayConflict() => new("sandbox_replay_conflict", "The request ID belongs to a different operation.");
    internal static SandboxView View(SandboxInstance instance) => new(instance.Id, instance.Input.AppId, instance.Owner,
        instance.Request.Source, instance.Request.Context, instance.Revision, instance.Generation, instance.DataRevision,
        instance.State, instance.PreviewUrl, instance.ErrorCode, instance.Request.Limits ?? new(), instance.Operations, instance.Users, instance.Storage, instance.Viewers, instance.Endpoints, instance.Metrics);
}
