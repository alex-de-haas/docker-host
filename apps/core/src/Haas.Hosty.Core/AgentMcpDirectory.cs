using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace Haas.Hosty.Core;

internal sealed record AssistantTargetGrant(DateTimeOffset InstalledAt, string Revision, IReadOnlyList<string>? DeniedTools = null, bool? Enabled = null);
internal sealed record AgentAssistant(string Id, string DisplayName);
internal sealed record AgentTargetPolicy(DateTimeOffset? InstalledAt, bool Offered, IReadOnlyDictionary<string, string> ApprovedSkills,
    IReadOnlyDictionary<string, AssistantTargetGrant>? Assistants = null);
internal sealed record AgentPolicyDocument(IReadOnlyDictionary<string, AgentTargetPolicy> Targets);
internal sealed record AgentSkillStatus(string Key, string? Digest, string? ApprovedDigest, string? Markdown);
internal sealed record AgentMcpInterface(string Key, string? Url, string? Service, string Readiness);
internal sealed record AgentMcpTarget(string Id, string DisplayName, bool Offered, string RuntimeState,
    IReadOnlyList<AgentMcpInterface> Interfaces, IReadOnlyList<AgentSkillStatus> Skills, DateTimeOffset? InstalledAt = null, IReadOnlyList<string>? AssistantIds = null, IReadOnlyList<string>? DeniedTools = null);
internal sealed record AgentDirectoryResponse(string Revision, IReadOnlyList<AgentMcpTarget> Targets, string? SettingsUrl = null, IReadOnlyList<AgentAssistant>? Assistants = null);
internal sealed record AgentPolicyUpdate(string Revision, bool Offered, IReadOnlyDictionary<string, string>? ApproveSkills = null, IReadOnlyList<string>? AssistantIds = null);

/// Core-owned policy, independent of assistant settings. Installation identity prevents retained data
/// or a racing removal from granting a later installation of the same app id.
internal sealed class AgentPolicyStore(CoreDataPaths paths)
{
    private readonly SemaphoreSlim gate = new(1, 1);
    private string FilePath => Path.Combine(paths.CoreRoot, "agent-policy.json");

    public async Task<AgentPolicyDocument> ReadAsync(CancellationToken cancellationToken = default)
    {
        await gate.WaitAsync(cancellationToken);
        try { return await JsonStorage.ReadAsync<AgentPolicyDocument>(FilePath, cancellationToken) ?? new(new Dictionary<string, AgentTargetPolicy>()); }
        finally { gate.Release(); }
    }

    public async Task ChangeManyAsync(IReadOnlyDictionary<string, AgentTargetPolicy> changes, CancellationToken ct)
    {
        await gate.WaitAsync(ct);
        try
        {
            var current = await JsonStorage.ReadAsync<AgentPolicyDocument>(FilePath, ct);
            var targets = new Dictionary<string, AgentTargetPolicy>(current?.Targets ?? new Dictionary<string, AgentTargetPolicy>(), StringComparer.Ordinal);
            foreach (var (id, policy) in changes) targets[id] = policy;
            await JsonStorage.WriteOwnerFileAsync(FilePath, new AgentPolicyDocument(targets), ct);
        }
        finally { gate.Release(); }
    }

    public async Task ChangeAsync(string id, AgentTargetPolicy? policy, CancellationToken cancellationToken = default)
    {
        await gate.WaitAsync(cancellationToken);
        try
        {
            var current = await JsonStorage.ReadAsync<AgentPolicyDocument>(FilePath, cancellationToken);
            var targets = new Dictionary<string, AgentTargetPolicy>(current?.Targets ?? new Dictionary<string, AgentTargetPolicy>(), StringComparer.Ordinal);
            if (policy is null) targets.Remove(id); else targets[id] = policy;
            await JsonStorage.WriteOwnerFileAsync(FilePath, new AgentPolicyDocument(targets), cancellationToken);
        }
        finally { gate.Release(); }
    }
}

internal sealed class AgentMcpDirectory(
    AgentPolicyStore policies, AppRegistryStore apps, CoreLifecycleService lifecycle,
    HostyCoreRuntimeConfig config, AuditStore audit, IClock clock, ShellPublicOriginResolver shellOrigins)
{
    public const string CoreId = "hosty:core";
    public const string SkillKey = "agent";
    private readonly SemaphoreSlim updateGate = new(1, 1);

    public async Task<AgentDirectoryResponse> ReadAsync(bool includeText = false, CancellationToken cancellationToken = default)
    {
        var policy = await policies.ReadAsync(cancellationToken);
        var installed = await lifecycle.ListAppsAsync(cancellationToken);
        var records = (await apps.ListAppRecordsAsync(cancellationToken)).ToDictionary(app => app.Id, StringComparer.Ordinal);
        var assistants = records.Values.Where(IsAssistant).OrderBy(a => a.Id, StringComparer.Ordinal).ToArray();
        string[] Granted(AgentTargetPolicy? entry) => assistants.Where(a => entry?.Assistants?.GetValueOrDefault(a.Id) is { } grant && grant.InstalledAt == a.InstalledAt && (grant.Enabled ?? entry.Offered)).Select(a => a.Id).ToArray();
        var targets = new List<AgentMcpTarget>();
        policy.Targets.TryGetValue(CoreId, out var corePolicy);
        targets.Add(new(CoreId, "Hosty Core", corePolicy?.Offered ?? true, "running",
            [new("default", config.ListenUrl.TrimEnd('/') + "/api/mcp", null, "ready")], [], AssistantIds: Granted(corePolicy)));
        foreach (var app in installed.OrderBy(app => app.Id, StringComparer.Ordinal))
        {
            if (app.Interfaces?.TryGetValue("mcp", out var declarations) != true || !records.TryGetValue(app.Id, out var record)) continue;
            policy.Targets.TryGetValue(app.Id, out var entry);
            if (entry?.InstalledAt != record.InstalledAt) entry = null;
            var skills = new List<AgentSkillStatus>();
            targets.Add(new(app.Id, app.DisplayName, entry?.Offered ?? false, app.RuntimeState,
                declarations!.Select(declaration =>
                {
                    var health = app.Health?.Services.FirstOrDefault(service => service.Service == declaration.Service);
                    var readiness = health is null
                        ? (app.RuntimeState == "running" ? "ready" : "unavailable")
                        : health.Status != "running" ? "unavailable" : health.Health == "healthy" || health.Health is null ? "ready" : health.Health;
                    return new AgentMcpInterface(declaration.Key, declaration.Url, declaration.Service, readiness);
                }).ToArray(), skills, record.InstalledAt, Granted(entry)));
        }
        // Text is excluded so admin and consumer snapshots share one revision. Changes to MCP
        // policy, URLs, readiness, installation identity or any app's fleet state invalidate it.
        var canonical = new AgentDirectoryResponse("", targets.Select(target => target with
        { Skills = target.Skills.Select(skill => skill with { Markdown = null }).ToArray() }).ToArray());
        var json = JsonSerializer.Serialize(canonical, CoreJsonSerializerContext.Default.AgentDirectoryResponse);
        var fleet = string.Join("\n", records.Values.OrderBy(app => app.Id, StringComparer.Ordinal)
            .Select(app => $"{app.Id}:{app.InstalledAt:O}:{app.Version}:{app.RuntimeState}:{app.DisplayName}:{app.Description}:{app.SelectedRuntime}:{app.UpdatedAt:O}"));
        var shell = await shellOrigins.ResolveAsync(cancellationToken);
        var grantsRevision = string.Join("\n", policy.Targets.OrderBy(p => p.Key, StringComparer.Ordinal)
            .SelectMany(p => (p.Value.Assistants ?? new Dictionary<string, AssistantTargetGrant>()).OrderBy(a => a.Key, StringComparer.Ordinal)
                .Select(a => $"{p.Key}:{a.Key}:{a.Value.InstalledAt:O}:{a.Value.Revision}")));
        return new(Digest(json + fleet + shell + grantsRevision), targets, shell is null ? null : shell.TrimEnd('/') + "/settings",
            assistants.Select(a => new AgentAssistant(a.Id, a.DisplayName)).ToArray());
    }

    public async Task<IResult> UpdateAsync(string id, AgentPolicyUpdate input, string actor, CancellationToken cancellationToken)
    {
        await updateGate.WaitAsync(cancellationToken);
        try
        {
            var snapshot = await ReadAsync(includeText: true, cancellationToken);
            if (snapshot.Revision != input.Revision)
                return CoreJson.Json(new ErrorResponse("agent_policy_changed", "The directory changed. Reload and review again."), statusCode: 409);
            var target = snapshot.Targets.FirstOrDefault(target => target.Id == id);
            if (target is null) return CoreJson.Json(new ErrorResponse("agent_target_not_found", "The MCP target is not installed."), statusCode: 404);
            var record = id == CoreId ? null : await apps.GetAppAsync(id, cancellationToken);
            if (id != CoreId && (record is null || record.InstalledAt != target.InstalledAt)) return CoreJson.Json(new ErrorResponse("agent_target_not_found", "The MCP target is not installed."), statusCode: 404);
            var approved = target.Skills.Where(skill => skill.ApprovedDigest is not null)
                .ToDictionary(skill => skill.Key, skill => skill.ApprovedDigest!, StringComparer.Ordinal);
            foreach (var (key, digest) in input.ApproveSkills ?? new Dictionary<string, string>())
            {
                if (target.Skills.FirstOrDefault(skill => skill.Key == key)?.Digest is not { } current || current != digest)
                    return CoreJson.Json(new ErrorResponse("agent_skill_changed", "The skill changed. Reload and review its current text."), statusCode: 409);
                approved[key] = digest;
            }
            var oldPolicy = (await policies.ReadAsync(cancellationToken)).Targets.GetValueOrDefault(id);
            var bindings = new Dictionary<string, AssistantTargetGrant>(oldPolicy?.Assistants ?? new Dictionary<string, AssistantTargetGrant>(), StringComparer.Ordinal);
            if (input.AssistantIds is not null)
            {
                foreach (var key in bindings.Keys.Where(key => !input.AssistantIds.Contains(key, StringComparer.Ordinal)).ToArray())
                    bindings[key] = bindings[key] with { Enabled = false, Revision = Guid.NewGuid().ToString("N") };
                foreach (var assistantId in input.AssistantIds.Distinct(StringComparer.Ordinal))
                {
                    var assistant = await apps.GetAppAsync(assistantId, cancellationToken);
                    if (assistant is null || !IsAssistant(assistant))
                        return CoreJson.Json(new ErrorResponse("assistant_not_found", "Select an installed, confirmed assistant."), 400);
                    var previous = oldPolicy?.Assistants?.GetValueOrDefault(assistantId);
                    bindings[assistantId] = previous?.InstalledAt == assistant.InstalledAt
                        ? previous.Enabled == false ? previous with { Enabled = input.Offered, Revision = Guid.NewGuid().ToString("N") } : previous
                        : new(assistant.InstalledAt, Guid.NewGuid().ToString("N"));
                }
            }
            await audit.AppendAsync(new AuditRecord($"audit_{Guid.NewGuid():N}", "agent.policy.updated", "agent-target", id,
                "succeeded", actor, clock.UtcNow, new Dictionary<string, string>
                {
                    ["offered"] = input.Offered.ToString(),
                    ["assistants"] = string.Join(",", bindings.Keys.Order(StringComparer.Ordinal)),
                    ["approvedSkills"] = string.Join(",", approved.OrderBy(pair => pair.Key).Select(pair => $"{pair.Key}:{pair.Value}")),
                }), cancellationToken);
            await policies.ChangeAsync(id, new(record?.InstalledAt, input.Offered, approved, bindings), cancellationToken);
            return CoreJson.Json(await ReadAsync(includeText: true, cancellationToken));
        }
        finally { updateGate.Release(); }
    }

    internal async Task<AssistantAccessPlan> ReviewAssistantAsync(string assistantId, string targetId, CancellationToken ct)
    {
        var assistant = await apps.GetAppAsync(assistantId, ct);
        if (assistant is null || !IsAssistant(assistant))
            throw new AppLifecycleException("mcp_assistant_required", "Select an installed, confirmed assistant.");
        var snapshot = await ReadAsync(true, ct);
        var target = snapshot.Targets.FirstOrDefault(t => t.Id == targetId)
            ?? throw new AppLifecycleException("agent_target_not_found", "The MCP target is not installed.");
        return new(assistantId, assistant.DisplayName, assistant.InstalledAt, snapshot.Revision, target);
    }

    internal async Task ApplyAssistantReviewAsync(AssistantAccessPlan plan, bool enabled, IReadOnlyList<string> skills, string actor, CancellationToken ct)
    {
        var mutex = apps.OperationLock(plan.AssistantId);
        await mutex.WaitAsync(ct);
        try
        {
            var assistant = await apps.GetAppAsync(plan.AssistantId, ct);
            if (assistant is null || !IsAssistant(assistant) || assistant.InstalledAt != plan.InstalledAt)
                throw new AppLifecycleException("agent_policy_changed", "The assistant changed. Review its access again.");
            var assistants = (plan.Target.AssistantIds ?? []).Where(id => id != plan.AssistantId).ToList();
            if (enabled) assistants.Add(plan.AssistantId);
            var approved = plan.Target.Skills.Where(s => skills.Contains(s.Key, StringComparer.Ordinal) && s.Digest is not null)
                .ToDictionary(s => s.Key, s => s.Digest!, StringComparer.Ordinal);
            // Access changes affect this assistant only. A target must also be offered globally to
            // enable the relationship; the Core page explicitly describes that shared effect.
            var result = await UpdateAsync(plan.Target.Id, new(plan.Revision, enabled || plan.Target.Offered,
                approved, assistants), actor, ct);
            if (result is IStatusCodeHttpResult { StatusCode: >= 400 })
                throw new AppLifecycleException("agent_policy_changed", "The directory or instructions changed. Open a fresh review.");
        }
        finally { mutex.Release(); }
    }

    internal static bool IsAssistant(AppRecord app) => app.ConfirmedRoles?.Contains("assistant", StringComparer.Ordinal) == true
        && app.Interfaces?.ContainsKey("assistant") == true;

    internal async Task<AgentDirectoryResponse> ReadForAssistantAsync(string appId, CancellationToken ct)
    {
        var snapshot = await ReadAsync(false, ct);
        var policy = await policies.ReadAsync(ct);
        var assistant = await apps.GetAppAsync(appId, ct);
        return snapshot with { Targets = snapshot.Targets.Select(t => {
            var entry = policy.Targets.GetValueOrDefault(t.Id);
            var grant = entry is not null && entry.InstalledAt == t.InstalledAt ? entry.Assistants?.GetValueOrDefault(appId) : null;
            var current = grant?.InstalledAt == assistant?.InstalledAt && grant is not null;
            return t with { Offered = current && (grant!.Enabled ?? entry!.Offered),
                DeniedTools = current ? grant!.DeniedTools ?? [] : [], AssistantIds = null };
        }).ToArray(), Assistants = null };
    }

    internal async Task<AssistantAccessBatchPlan> ReviewBatchAsync(AssistantAccessChange input, CancellationToken ct)
    {
        if (!Guid.TryParse(input.RequestId, out _) || input.Targets.Count is 0 or > 200 ||
            input.Targets.Select(t => t.TargetId).Distinct(StringComparer.Ordinal).Count() != input.Targets.Count)
            throw new AppLifecycleException("mcp_change_invalid", "Choose distinct applications and a valid request ID.");
        var assistant = await apps.GetAppAsync(input.AssistantId, ct);
        if (assistant is null || !IsAssistant(assistant))
            throw new AppLifecycleException("mcp_assistant_required", "Select an installed, confirmed assistant.");
        var snapshot = await ReadForAssistantAsync(input.AssistantId, ct);
        if (snapshot.Revision != input.Revision)
            throw new AppLifecycleException("agent_policy_changed", "The directory changed. Reload and review again.");
        var changes = input.Targets.Select(change => {
            var target = snapshot.Targets.FirstOrDefault(t => t.Id == change.TargetId)
                ?? throw new AppLifecycleException("agent_target_not_found", "The MCP target is no longer installed.");
            if (change.DeniedTools.Count > 1000 || change.DeniedTools.Any(t => string.IsNullOrWhiteSpace(t) || t.Length > 256 || t.Any(char.IsControl)))
                throw new AppLifecycleException("mcp_change_invalid", "Tool names must be nonempty and at most 256 characters.");
            return new AssistantTargetChangePlan(target.Id, target.DisplayName, target.InstalledAt,
                target.Offered, target.DeniedTools ?? [], change.Enabled,
                change.DeniedTools.Distinct(StringComparer.Ordinal).Order(StringComparer.Ordinal).ToArray());
        }).ToArray();
        return new(input.RequestId, assistant.Id, assistant.DisplayName, assistant.InstalledAt, snapshot.Revision, changes);
    }

    internal async Task ApplyBatchAsync(AssistantAccessBatchPlan plan, string actor, CancellationToken ct, Func<Task>? revalidate = null)
    {
        var locks = plan.Targets.Select(t => t.TargetId).Append(plan.AssistantId).Where(id => id != CoreId)
            .Distinct(StringComparer.Ordinal).Order(StringComparer.Ordinal).Select(apps.OperationLock).ToArray();
        var acquired = 0;
        var updating = false;
        try
        {
            foreach (var mutex in locks) { await mutex.WaitAsync(ct); acquired++; }
            await updateGate.WaitAsync(ct); updating = true;
            if (revalidate is not null) await revalidate();
            var assistant = await apps.GetAppAsync(plan.AssistantId, ct);
            if (assistant is null || !IsAssistant(assistant) || assistant.InstalledAt != plan.InstalledAt ||
                (await ReadAsync(false, ct)).Revision != plan.Revision)
                throw new AppLifecycleException("agent_policy_changed", "The directory changed. Reload and review again.");
            var policy = await policies.ReadAsync(ct);
            var changes = new Dictionary<string, AgentTargetPolicy>(StringComparer.Ordinal);
            foreach (var change in plan.Targets)
            {
                var old = policy.Targets.GetValueOrDefault(change.TargetId);
                if (old?.InstalledAt != change.InstalledAt) old = null;
                var bindings = new Dictionary<string, AssistantTargetGrant>(old?.Assistants ?? new Dictionary<string, AssistantTargetGrant>(), StringComparer.Ordinal);
                bindings[plan.AssistantId] = new(plan.InstalledAt, Guid.NewGuid().ToString("N"), change.DeniedTools, change.Enabled);
                changes[change.TargetId] = new(change.InstalledAt, old?.Offered ?? (change.TargetId == CoreId), old?.ApprovedSkills ?? new Dictionary<string, string>(), bindings);
            }
            await policies.ChangeManyAsync(changes, ct);
            await audit.AppendAsync(new AuditRecord($"audit_{Guid.NewGuid():N}", "app.mcp.access.changed", "app",
                plan.AssistantId, "succeeded", actor, clock.UtcNow,
                new Dictionary<string, string> { ["requestId"] = plan.RequestId, ["targets"] = string.Join(",", changes.Keys) }), ct);
        }
        finally { if (updating) updateGate.Release(); for (var i = acquired - 1; i >= 0; i--) locks[i].Release(); }
    }

    public static string Digest(string text) => Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(text.Trim())))[..32];
}

internal static class AgentMcpEndpoints
{
    public static void Map(WebApplication app)
    {
        AssistantMcpDiscovery.Map(app);
        app.MapGet("/api/core/agents", async (HttpRequest request, UserDirectoryStore users, IClock clock,
            AgentMcpDirectory directory, CancellationToken cancellationToken) =>
            await CoreSessionAuthorization.RequireAdminSessionAsync(request, users, clock,
                async () => CoreJson.Json(await directory.ReadAsync(true, cancellationToken)), cancellationToken: cancellationToken));
        app.MapPut("/api/core/agents/{targetId}", async (HttpRequest request, UserDirectoryStore users, IClock clock, CancellationToken ct) =>
            await CoreSessionAuthorization.RequireAdminSessionAsync(request, users, clock, () => Task.FromResult(CoreJson.Json(
                new ErrorResponse("mcp_review_required", "Save MCP access through the assistant's Core confirmation flow."), 409)), requireCsrf: true, cancellationToken: ct));
        app.MapGet("/control/v1/agents/directory", async (HttpRequest request, ControlSecret secret,
            AgentMcpDirectory directory, CancellationToken cancellationToken) =>
            await HostyCoreApplication.RequireControlSecret(request, secret,
                async () => CoreJson.Json(await directory.ReadAsync(false, cancellationToken))));
    }
}

internal sealed record AssistantAccessPlan(string AssistantId, string DisplayName, DateTimeOffset InstalledAt,
    string Revision, AgentMcpTarget Target);

internal sealed record AssistantTargetChange(string TargetId, bool Enabled, IReadOnlyList<string> DeniedTools);
internal sealed record AssistantAccessChange(string RequestId, string AssistantId, string Revision, IReadOnlyList<AssistantTargetChange> Targets);
internal sealed record AssistantTargetChangePlan(string TargetId, string DisplayName, DateTimeOffset? InstalledAt,
    bool PreviouslyEnabled, IReadOnlyList<string> PreviousDeniedTools, bool Enabled, IReadOnlyList<string> DeniedTools);
internal sealed record AssistantAccessBatchPlan(string RequestId, string AssistantId, string DisplayName,
    DateTimeOffset InstalledAt, string Revision, IReadOnlyList<AssistantTargetChangePlan> Targets);
