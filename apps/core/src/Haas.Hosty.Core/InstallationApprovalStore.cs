using System.Security.Cryptography;

namespace Haas.Hosty.Core;

internal static class CoreAppPermissions
{
    public const string Install = "apps.install";
    public const string Update = "apps.update";
    public static readonly string[] Known = [Install, Update];

    public static string Describe(string permission) => permission switch
    {
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

    public void Decide(InstallationApproval entry, string nonce, string sessionId, bool approve)
    {
        lock (gate)
        {
            _ = Get(entry.Id);
            if (entry.Status != "pending" || string.IsNullOrEmpty(entry.DecisionNonce) ||
                !string.Equals(entry.DecisionSession, sessionId, StringComparison.Ordinal) ||
                !CryptographicOperations.FixedTimeEquals(System.Text.Encoding.UTF8.GetBytes(entry.DecisionNonce), System.Text.Encoding.UTF8.GetBytes(nonce)))
                throw new AppLifecycleException("approval_invalid", "The confirmation is invalid or has already been used.");
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
                $"{origin.TrimEnd('/')}/install/confirm/{entry.Id}", entry.ExpiresAt, entry.Error);
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
    public string? FeedsUrl { get; init; }
    public string? FeedId { get; init; }
    public string Status { get; set; } = "draft";
    public IReadOnlyDictionary<string, string?>? Settings { get; set; }
    public bool Autostart { get; set; } = true;
    public string? Error { get; set; }
    internal string? DecisionNonce { get; set; }
    internal string? DecisionSession { get; set; }
    public string Permission => UpdatePlan is null ? CoreAppPermissions.Install : CoreAppPermissions.Update;
}

internal sealed record InstallationPrepare(string? ManifestPath = null, string? FeedsUrl = null,
    string? FeedId = null, string? SelectedRuntime = null, string? UpdateAppId = null, string? PlanDigest = null);
internal sealed record InstallationSubmit(IReadOnlyDictionary<string, string?>? Settings = null, bool Autostart = true);
internal sealed record InstallationRequestView(string Id, string Status, AppInstallPlan? Plan, AppUpdatePlan? UpdatePlan,
    string ApprovalUrl, DateTimeOffset ExpiresAt, string? Error);
