using System.Security.Cryptography;

namespace Haas.Hosty.Core;

internal static class CoreAppPermissions
{
    public const string Install = "apps.install";
    public const string ReadApps = "apps.read";
    public const string AppLogs = "apps.logs";
    public const string Notifications = "apps.notifications";
    public const string AppLifecycle = "apps.lifecycle";
    public const string ConfigureApps = "apps.configure";
    public const string ReadCore = "core.read";
    public const string UpdateCore = "core.update";
    public const string CoreLifecycle = "core.lifecycle";
    public const string ConfigureCore = "core.configure";
    public const string CoreLogs = "core.logs";
    public const string ReadUsers = "users.read";
    public const string ManageUsers = "users.manage";
    public const string Sources = "apps.sources.full";
    public const string SourcesRead = "apps.sources.read";
    public const string LegacySources = "apps.sources";
    public const string SourceConnections = "sources.connections";
    public const string ReadSkills = "apps.skills.read";
    public const string SpeechProviders = "providers.speech-to-text";
    public const string AssistantProviders = "providers.assistant";
    public static readonly string[] Known = [Install, ReadApps, AppLogs, Notifications, AppLifecycle, ConfigureApps, ReadCore, UpdateCore, CoreLifecycle, ConfigureCore, CoreLogs, ReadUsers, ManageUsers, Sources, SourcesRead, SourceConnections, ReadSkills, SpeechProviders, AssistantProviders];

    // The old name grants exactly the same authority. Other retired permissions remain unsupported.
    public static string Normalize(string permission) => permission == LegacySources ? Sources : permission;

    public static IReadOnlyList<string> Normalize(IReadOnlyList<string> permissions)
        => permissions.Any(p => p == LegacySources) ? permissions.Select(Normalize).ToArray() : permissions;

    public static IReadOnlyList<string> ResolveGrants(IReadOnlyList<string> required,
        IReadOnlyList<string> optional, IReadOnlyList<string>? selected, IReadOnlyList<string>? previous = null)
    {
        required = Normalize(required);
        optional = Normalize(optional);
        selected = selected is null ? null : Normalize(selected);
        previous = previous is null ? null : Normalize(previous);
        var unsupported = required.Concat(selected ?? []).Where(p => !Known.Contains(p, StringComparer.Ordinal)).ToArray();
        if (unsupported.Length > 0)
            throw new AppLifecycleException("app_permissions_unsupported", $"Unsupported permission declarations: {string.Join(", ", unsupported)}. Update the app manifest before approving permissions.");
        var choices = selected ?? (previous ?? []).Intersect(optional, StringComparer.Ordinal).Where(p => Known.Contains(p, StringComparer.Ordinal)).ToArray();
        if (choices.Any(p => !optional.Contains(p, StringComparer.Ordinal)))
            throw new AppLifecycleException("permission_selection_invalid", "An optional permission was not part of the reviewed declarations.");
        return required.Concat(choices).Distinct(StringComparer.Ordinal).Order(StringComparer.Ordinal).ToArray();
    }

    public static string Describe(string permission) => permission switch
    {
        Sources => "Access and modify application source code, including code Hosty executes on this host in development mode; manage workspaces and use selected source-provider connections",
        SourcesRead => "Read repository documentation and development workspace document changes as the current administrator; no source edits or workspace mutations",
        SourceConnections => "Manage your own source-provider accounts and Git identity; select connections for reviewed installations",
        ReadApps => "List applications and read their state",
        AppLogs => "Read application logs",
        Notifications => "Read application notifications",
        AppLifecycle => "Start, stop and restart applications; change autostart and select reviewed runtimes. Source folder changes require Core confirmation",
        ConfigureApps => "Read and change application settings, including sensitive values, mounts and backups",
        ReadCore => "Read Core state",
        UpdateCore => "Update Core",
        CoreLifecycle => "Restart Core",
        ConfigureCore => "Read and change Core settings, shared mounts and ingress",
        CoreLogs => "Read Core logs",
        ReadUsers => "Read user-management information",
        ManageUsers => "Manage users and their access",
        SpeechProviders => "List and use all current and future speech-to-text providers",
        AssistantProviders => "Create draft assistant conversations on your behalf",
        ReadSkills => "Read agent skills published by installed apps",
        Install => "Install, update and remove applications; routine updates need no confirmation, other changes require Core review",
        _ => permission,
    };
}

// The app sees a request ID, never a decision credential. Only the Core-origin page receives the
// nonce. Settings are frozen before that page can approve; claiming a decision is atomic.
internal sealed class InstallationApprovalStore(IClock clock)
{
    private readonly object gate = new();
    private readonly Dictionary<string, InstallationApproval> entries = new(StringComparer.Ordinal);
    internal static readonly TimeSpan Lifetime = TimeSpan.FromMinutes(15);
    internal const int Capacity = 64;

    public InstallationApproval Add(InstallationApproval entry)
    {
        lock (gate)
        {
            foreach (var id in entries.Where(pair => pair.Value.ExpiresAt <= clock.UtcNow && pair.Value.Status != "executing").Select(pair => pair.Key).ToArray())
                entries.Remove(id);
            if (entries.Count >= Capacity)
                throw new AppLifecycleException("approval_limit", "Too many pending requests. Try again later.");
            entries.Add(entry.Id, entry);
            return entry;
        }
    }

    public InstallationApproval Get(string id)
    {
        lock (gate)
        {
            if (!entries.TryGetValue(id, out var entry) || (entry.ExpiresAt <= clock.UtcNow && entry.Status != "executing"))
                throw new AppLifecycleException("approval_expired", "This request expired. Prepare a new plan.");
            return entry;
        }
    }

    public void Submit(InstallationApproval entry, InstallationSubmit input)
    {
        lock (gate)
        {
            _ = Get(entry.Id);
            if (entry.Status != "draft")
                throw new AppLifecycleException("approval_frozen", "This request has already been submitted.");
            entry.Settings = input.Settings is null ? new Dictionary<string, string?>() : new Dictionary<string, string?>(input.Settings, StringComparer.Ordinal);
            entry.Autostart = input.Autostart;
            entry.Status = "pending";
        }
    }

    public string IssueNonce(InstallationApproval entry, string sessionId)
    {
        lock (gate)
        {
            _ = Get(entry.Id);
            if (entry.Status != "pending") return "";
            entry.DecisionNonce = Convert.ToHexString(RandomNumberGenerator.GetBytes(32));
            entry.DecisionSession = sessionId;
            return entry.DecisionNonce;
        }
    }

    public void Decide(InstallationApproval entry, string nonce, string sessionId, bool approve, IReadOnlyList<string>? optionalPermissions = null, bool agentEnabled = false, IReadOnlyList<string>? agentSkills = null)
    {
        lock (gate)
        {
            _ = Get(entry.Id);
            if (entry.Status != "pending" || string.IsNullOrEmpty(entry.DecisionNonce) ||
                !string.Equals(entry.DecisionSession, sessionId, StringComparison.Ordinal) ||
                !CryptographicOperations.FixedTimeEquals(System.Text.Encoding.UTF8.GetBytes(entry.DecisionNonce), System.Text.Encoding.UTF8.GetBytes(nonce)))
                throw new AppLifecycleException("approval_invalid", "The confirmation is invalid or has already been used.");
            if (approve)
            {
                if (entry.AssistantAccessPlan is { } agent)
                {
                    var selectedSkills = agentSkills ?? [];
                    if (selectedSkills.Any(key => !agent.Target.Skills.Any(skill => skill.Key == key && skill.Digest is not null)))
                        throw new AppLifecycleException("agent_skill_changed", "Select only instructions shown in this review.");
                    entry.AgentEnabled = agentEnabled;
                    entry.AgentSkills = selectedSkills.Distinct(StringComparer.Ordinal).ToArray();
                }
                var declared = entry.PermissionPlan?.Optional ?? entry.InstallPlan?.OptionalCorePermissions ?? entry.UpdatePlan?.TargetOptionalCorePermissions ?? [];
                var selected = optionalPermissions ?? [];
                _ = CoreAppPermissions.ResolveGrants([], declared, selected);
                entry.SelectedOptionalPermissions = selected.Distinct(StringComparer.Ordinal).ToArray();
            }
            entry.DecisionNonce = null;
            entry.DecisionSession = null;
            entry.Status = approve ? "executing" : "denied";
            if (!approve) { entry.Settings = null; entry.IdentityToken = null; }
        }
    }

    public void Complete(InstallationApproval entry, string? error)
    {
        lock (gate)
        {
            entry.Error = error;
            entry.Status = error is null ? "succeeded" : "failed";
            entry.Settings = null;
            entry.IdentityToken = null;
        }
    }

    public InstallationRequestView View(InstallationApproval entry, string origin)
    {
        lock (gate)
            return new(entry.Id, entry.Status, entry.InstallPlan, entry.UpdatePlan,
                $"{origin.TrimEnd('/')}/install/confirm/{entry.Id}", entry.ExpiresAt, entry.Error, entry.PermissionPlan, entry.RemovalPlan, entry.HostPathPlan);
    }
}

internal sealed class InstallationApproval
{
    public string Id { get; } = Convert.ToHexString(RandomNumberGenerator.GetBytes(24)).ToLowerInvariant();
    public required string UserId { get; init; }
    public string? CallerAppId { get; init; }
    public string? IdentityToken { get; set; }
    public required string CallerName { get; init; }
    public required DateTimeOffset ExpiresAt { get; init; }
    public AppInstallPlan? InstallPlan { get; init; }
    public AppUpdatePlan? UpdatePlan { get; init; }
    public AppPermissionPlan? PermissionPlan { get; init; }
    public AssistantAccessPlan? AssistantAccessPlan { get; init; }
    public bool AgentEnabled { get; set; }
    public IReadOnlyList<string> AgentSkills { get; set; } = [];
    public AppRemovalPlan? RemovalPlan { get; init; }
    public HostPathApprovalPlan? HostPathPlan { get; init; }
    public IReadOnlyList<string>? SelectedOptionalPermissions { get; set; }
    public string? FeedsUrl { get; init; }
    public string? FeedId { get; init; }
    public string Status { get; set; } = "draft";
    public IReadOnlyDictionary<string, string?>? Settings { get; set; }
    public bool Autostart { get; set; } = true;
    public string? Error { get; set; }
    internal string? DecisionNonce { get; set; }
    internal string? DecisionSession { get; set; }
    public bool RequiresSources { get; init; }
    public string? Permission => PermissionPlan is not null || AssistantAccessPlan is not null ? null : HostPathPlan?.Change.Permission ?? CoreAppPermissions.Install;
}

internal sealed record InstallationPrepare(string? ManifestPath = null, string? FeedsUrl = null,
    string? FeedId = null, string? SelectedRuntime = null, string? UpdateAppId = null, string? PlanDigest = null, PrivateSourceChoice? SourceConnections = null, string? PermissionsAppId = null,
    string? RemoveAppId = null, AppRemoveRequest? RemovalOptions = null, HostPathChange? HostPathChange = null);
internal sealed record InstallationSubmit(IReadOnlyDictionary<string, string?>? Settings = null, bool Autostart = true);
internal sealed record InstallationRequestView(string Id, string Status, AppInstallPlan? Plan, AppUpdatePlan? UpdatePlan,
    string ApprovalUrl, DateTimeOffset ExpiresAt, string? Error, AppPermissionPlan? PermissionPlan = null, AppRemovalPlan? RemovalPlan = null, HostPathApprovalPlan? HostPathPlan = null);

internal sealed record AppRemovalPlan(string AppId, string DisplayName, string Version,
    AppRemoveRequest Options, AppRemovalImpact Impact)
{
    internal string Identity { get; init; } = "";
}

internal sealed record AppPermissionPlan(string AppId, string DisplayName, DateTimeOffset InstalledAt,
    string? Revision, IReadOnlyList<string> Required, IReadOnlyList<string> Optional, IReadOnlyList<string> Granted,
    string? Source = null, string? Runtime = null, string? ManifestDigest = null, string? Identity = null,
    IReadOnlyList<string>? AcceptedRequired = null, IReadOnlyList<string>? AcceptedOptional = null);
