using System.Security.Cryptography;

namespace Haas.Hosty.Core;

internal static class CoreAppPermissions
{
    public const string Install = "apps.install";
    public const string Update = "apps.update";
    public const string Publication = "apps.publications.manage";
    public const string Workspaces = "apps.workspaces.manage";
    public const string ReadSkills = "apps.skills.read";
    public const string SpeechProviders = "providers.speech-to-text";
    public const string AssistantProviders = "providers.assistant";
    public static readonly string[] Known = [Install, Update, ReadSkills, Workspaces, Publication, SpeechProviders, AssistantProviders];

    public static IReadOnlyList<string> ResolveGrants(IReadOnlyList<string> required,
        IReadOnlyList<string> optional, IReadOnlyList<string>? selected, IReadOnlyList<string>? previous = null)
    {
        var choices = selected ?? (previous ?? []).Intersect(optional, StringComparer.Ordinal).ToArray();
        if (choices.Any(p => !optional.Contains(p, StringComparer.Ordinal)))
            throw new AppLifecycleException("permission_selection_invalid", "An optional permission was not part of the reviewed declarations.");
        return required.Concat(choices).Distinct(StringComparer.Ordinal).Order(StringComparer.Ordinal).ToArray();
    }

    public static string Describe(string permission) => permission switch
    {
        Publication => "Publish and merge session pull requests using the administrator's selected Git account",
        SpeechProviders => "List and use all current and future speech-to-text providers",
        AssistantProviders => "List and send requests to all current and future assistant providers",
        Workspaces => "Manage session worktrees and local Git operations for an administrator",
        ReadSkills => "Read agent skills published by installed apps",
        Install => "Request installation of other apps (Core confirmation required)",
        Update => "Request updates to installed apps (Core confirmation required)",
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
            if (input.OptionalPermissions is not null)
            {
                var declared = entry.PermissionPlan?.Optional ?? entry.InstallPlan?.OptionalCorePermissions ?? entry.UpdatePlan?.TargetOptionalCorePermissions ?? [];
                if (input.OptionalPermissions.Except(declared, StringComparer.Ordinal).Any())
                    throw new AppLifecycleException("optional_permission_invalid", "Only declared optional permissions may be selected.");
                entry.SelectedOptionalPermissions = input.OptionalPermissions.Distinct(StringComparer.Ordinal).ToArray();
            }
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

    public void Decide(InstallationApproval entry, string nonce, string sessionId, bool approve, IReadOnlyList<string>? optionalPermissions = null)
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
                $"{origin.TrimEnd('/')}/install/confirm/{entry.Id}", entry.ExpiresAt, entry.Error, entry.PermissionPlan);
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
    public IReadOnlyList<string>? SelectedOptionalPermissions { get; set; }
    public string? FeedsUrl { get; init; }
    public string? FeedId { get; init; }
    public string Status { get; set; } = "draft";
    public IReadOnlyDictionary<string, string?>? Settings { get; set; }
    public bool Autostart { get; set; } = true;
    public string? Error { get; set; }
    internal string? DecisionNonce { get; set; }
    internal string? DecisionSession { get; set; }
    public string? Permission => PermissionPlan is not null ? null : UpdatePlan is null ? CoreAppPermissions.Install : CoreAppPermissions.Update;
}

internal sealed record InstallationPrepare(string? ManifestPath = null, string? FeedsUrl = null,
    string? FeedId = null, string? SelectedRuntime = null, string? UpdateAppId = null, string? PlanDigest = null, PrivateSourceChoice? SourceConnections = null, string? PermissionsAppId = null);
internal sealed record InstallationSubmit(IReadOnlyDictionary<string, string?>? Settings = null, bool Autostart = true, IReadOnlyList<string>? OptionalPermissions = null);
internal sealed record InstallationRequestView(string Id, string Status, AppInstallPlan? Plan, AppUpdatePlan? UpdatePlan,
    string ApprovalUrl, DateTimeOffset ExpiresAt, string? Error, AppPermissionPlan? PermissionPlan = null);

internal sealed record AppPermissionPlan(string AppId, string DisplayName, DateTimeOffset InstalledAt,
    string? Revision, IReadOnlyList<string> Required, IReadOnlyList<string> Optional, IReadOnlyList<string> Granted,
    string? Source = null, string? Runtime = null, string? ManifestDigest = null, string? Identity = null,
    IReadOnlyList<string>? AcceptedRequired = null, IReadOnlyList<string>? AcceptedOptional = null);
