using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace Haas.Hosty.Core;

internal sealed record AgentTargetPolicy(DateTimeOffset? InstalledAt, bool Offered, IReadOnlyDictionary<string, string> ApprovedSkills);
internal sealed record AgentPolicyDocument(IReadOnlyDictionary<string, AgentTargetPolicy> Targets);
internal sealed record AgentSkillStatus(string Key, string? Digest, string? ApprovedDigest, string? Markdown);
internal sealed record AgentMcpInterface(string Key, string? Url, string? Service, string Readiness);
internal sealed record AgentMcpTarget(string Id, string DisplayName, bool Offered, string RuntimeState,
    IReadOnlyList<AgentMcpInterface> Interfaces, IReadOnlyList<AgentSkillStatus> Skills, DateTimeOffset? InstalledAt = null);
internal sealed record AgentDirectoryResponse(string Revision, IReadOnlyList<AgentMcpTarget> Targets, string? SettingsUrl = null);
internal sealed record AgentPolicyUpdate(string Revision, bool Offered, IReadOnlyDictionary<string, string>? ApproveSkills = null);

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
    CoreDataPaths paths, HostyCoreRuntimeConfig config, AuditStore audit, IClock clock, ShellPublicOriginResolver shellOrigins)
{
    public const string CoreId = "hosty:core";
    public const string SkillKey = "agent";
    private readonly SemaphoreSlim updateGate = new(1, 1);

    public async Task<AgentDirectoryResponse> ReadAsync(bool includeText = false, CancellationToken cancellationToken = default)
    {
        var policy = await policies.ReadAsync(cancellationToken);
        var installed = await lifecycle.ListAppsAsync(cancellationToken);
        var records = (await apps.ListAppRecordsAsync(cancellationToken)).ToDictionary(app => app.Id, StringComparer.Ordinal);
        var targets = new List<AgentMcpTarget>();
        policy.Targets.TryGetValue(CoreId, out var corePolicy);
        targets.Add(new(CoreId, "Hosty Core", corePolicy?.Offered ?? true, "running",
            [new("default", config.ListenUrl.TrimEnd('/') + "/api/mcp", null, "ready")], []));
        foreach (var app in installed.OrderBy(app => app.Id, StringComparer.Ordinal))
        {
            if (app.Interfaces?.TryGetValue("mcp", out var declarations) != true || !records.TryGetValue(app.Id, out var record)) continue;
            policy.Targets.TryGetValue(app.Id, out var entry);
            if (entry?.InstalledAt != record.InstalledAt) entry = null;
            var skills = new List<AgentSkillStatus>();
            if (record.AgentSkillFile is { } file)
            {
                var text = await ReadSkillAsync(app.Id, file, cancellationToken);
                var digest = text is null ? null : Digest(text);
                skills.Add(new(SkillKey, digest, entry?.ApprovedSkills.GetValueOrDefault(SkillKey), includeText ? text : null));
            }
            targets.Add(new(app.Id, app.DisplayName, entry?.Offered ?? false, app.RuntimeState,
                declarations!.Select(declaration =>
                {
                    var health = app.Health?.Services.FirstOrDefault(service => service.Service == declaration.Service);
                    var readiness = health is null
                        ? (app.RuntimeState == "running" ? "ready" : "unavailable")
                        : health.Status != "running" ? "unavailable" : health.Health == "healthy" || health.Health is null ? "ready" : health.Health;
                    return new AgentMcpInterface(declaration.Key, declaration.Url, declaration.Service, readiness);
                }).ToArray(), skills, record.InstalledAt));
        }
        // Text is excluded so admin and consumer snapshots share one revision. Changes to skill bytes,
        // policy, URLs, readiness, installation identity or any app's fleet state invalidate it.
        var canonical = new AgentDirectoryResponse("", targets.Select(target => target with
        { Skills = target.Skills.Select(skill => skill with { Markdown = null }).ToArray() }).ToArray());
        var json = JsonSerializer.Serialize(canonical, CoreJsonSerializerContext.Default.AgentDirectoryResponse);
        var fleet = string.Join("\n", records.Values.OrderBy(app => app.Id, StringComparer.Ordinal)
            .Select(app => $"{app.Id}:{app.InstalledAt:O}:{app.Version}:{app.RuntimeState}:{app.DisplayName}:{app.Description}:{app.SelectedRuntime}:{app.UpdatedAt:O}"));
        var shell = await shellOrigins.ResolveAsync(cancellationToken);
        return new(Digest(json + fleet + shell), targets, shell is null ? null : shell.TrimEnd('/') + "/settings?tab=agents");
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
            await audit.AppendAsync(new AuditRecord($"audit_{Guid.NewGuid():N}", "agent.policy.updated", "agent-target", id,
                "succeeded", actor, clock.UtcNow, new Dictionary<string, string>
                {
                    ["offered"] = input.Offered.ToString(),
                    ["approvedSkills"] = string.Join(",", approved.OrderBy(pair => pair.Key).Select(pair => $"{pair.Key}:{pair.Value}")),
                }), cancellationToken);
            await policies.ChangeAsync(id, new(record?.InstalledAt, input.Offered, approved), cancellationToken);
            return CoreJson.Json(await ReadAsync(includeText: true, cancellationToken));
        }
        finally { updateGate.Release(); }
    }

    private async Task<string?> ReadSkillAsync(string id, string file, CancellationToken cancellationToken)
    {
        var relative = CoreDataPaths.NormalizeRelativeAssetPath("", file);
        if (relative is null || !AppAssetEndpoints.TryResolveAsset(paths.AppsRoot, id, relative, out var absolute, out _)) return null;
        try { return await File.ReadAllTextAsync(absolute, cancellationToken); }
        catch (IOException) { return null; }
    }

    public static string Digest(string text) => Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(text.Trim())))[..32];
}

internal static class AgentMcpEndpoints
{
    public static void Map(WebApplication app)
    {
        app.MapGet("/api/core/agents", async (HttpRequest request, UserDirectoryStore users, IClock clock,
            AgentMcpDirectory directory, CancellationToken cancellationToken) =>
            await CoreSessionAuthorization.RequireAdminSessionAsync(request, users, clock,
                async () => CoreJson.Json(await directory.ReadAsync(true, cancellationToken)), cancellationToken: cancellationToken));
        app.MapPut("/api/core/agents/{targetId}", async (string targetId, AgentPolicyUpdate input, HttpRequest request,
            UserDirectoryStore users, IClock clock, AgentMcpDirectory directory, CancellationToken cancellationToken) =>
            await CoreSessionAuthorization.RequireSessionAsync(request, users, clock, user =>
                AppAccessPolicy.IsAdmin(user) ? directory.UpdateAsync(targetId, input, user.Id, cancellationToken)
                    : Task.FromResult(CoreJson.Json(new ErrorResponse("admin_required", "A Host administrator is required."), statusCode: 403)),
                requireCsrf: true, cancellationToken: cancellationToken));
        app.MapGet("/control/v1/agents/directory", async (HttpRequest request, ControlSecret secret,
            AgentMcpDirectory directory, CancellationToken cancellationToken) =>
            await HostyCoreApplication.RequireControlSecret(request, secret,
                async () => CoreJson.Json(await directory.ReadAsync(false, cancellationToken))));
    }
}
