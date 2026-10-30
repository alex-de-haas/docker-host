namespace Haas.Hosty.Core;

internal static class PullRequestPolicy
{
    public static readonly TimeSpan Baseline = TimeSpan.FromMinutes(5);
    public static readonly TimeSpan Discovery = TimeSpan.FromMinutes(1);
    public static readonly TimeSpan Quiet = TimeSpan.FromMinutes(1);
    public static readonly TimeSpan Active = TimeSpan.FromSeconds(10);
    public static readonly TimeSpan UnknownWindow = TimeSpan.FromMinutes(2);
    public const int RepositoryLimit = 100;
    public const int RepositoryPullRequestLimit = 1000;
    public const int OwnerPullRequestLimit = 10000;
    public const int DescriptionBytes = 256 * 1024;
    public const int MaxChecks = 500;
    public const int PageSize = 100;

    public static bool IsActive(PullRequestSummary pr, DateTimeOffset headObservedAt, DateTimeOffset now)
        => pr.State == "open" && (pr.Checks.Items.Any(c => c.State is "running" or "pending") ||
            pr.Checks.Completeness == "unknown" && now - headObservedAt < UnknownWindow);

    public static TimeSpan Interval(bool demand, bool discovery, bool active)
        => !demand ? Baseline : discovery ? Discovery : active ? Active : Quiet;

    internal static TimeSpan Jitter(TimeSpan interval, string resource)
    {
        uint hash = 2166136261;
        foreach (var c in resource) hash = unchecked((hash ^ c) * 16777619);
        return interval + TimeSpan.FromTicks((long)(interval.Ticks * ((hash % 1001) / 10000d)));
    }
    public static string CheckState(string status, string conclusion) => status.ToUpperInvariant() switch
    {
        "IN_PROGRESS" => "running",
        "QUEUED" or "REQUESTED" or "WAITING" or "PENDING" or "EXPECTED" => "pending",
        _ => conclusion.ToUpperInvariant() switch
        {
            "SUCCESS" => "passed",
            "FAILURE" or "ERROR" or "TIMED_OUT" or "ACTION_REQUIRED" or "STALE" or "STARTUP_FAILURE" => "failed",
            "CANCELLED" => "cancelled",
            "SKIPPED" => "skipped",
            "NEUTRAL" => "neutral",
            _ => "unknown"
        }
    };

    public static string Ci(PullRequestSummary pr) => pr.Checks.Items.Any(c => c.State == "failed") ? "failed"
        : pr.Checks.Items.Any(c => c.State is "running" or "pending") ? "pending"
        : pr.Checks.Completeness != "complete" || pr.Checks.Items.Length == 0 || pr.Checks.Items.Any(c => c.State == "unknown") ? "unknown"
        : pr.Checks.Items.Any(c => c.State == "cancelled") ? "cancelled"
        : pr.Checks.Items.All(c => c.State == "passed") ? "passed" : "completed";
}
