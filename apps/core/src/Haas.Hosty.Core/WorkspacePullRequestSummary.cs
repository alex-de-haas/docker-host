namespace Haas.Hosty.Core;

// Display metadata only; never completion evidence. No URLs, reviews, file bodies or provider calls.
internal sealed record WorkspacePullRequestSummary(int Count, string State, string Checks,
    DateTimeOffset? ObservedAt, bool Partial)
{
    internal static WorkspacePullRequestSummary? From(IEnumerable<InspectionPullRequest> references)
    {
        // A repeated link must not inflate counts or hide an unavailable observation.
        var items = references.GroupBy(p => p.Url, StringComparer.OrdinalIgnoreCase)
            .Select(g => g.OrderBy(p => Known(p) ? 1 : 0).ThenByDescending(p => p.Observation?.At).First()).ToArray();
        if (items.Length == 0) return null;
        var known = items.Where(Known).Select(p => p.Observation!).ToArray();
        var partial = known.Length != items.Length;
        var open = known.Where(p => p.State == "open").ToArray();
        var state = !partial && known.All(p => p.State == "merged") ? "merged"
            : open.Length > 0 ? open.All(p => p.Draft) ? "draft" : "open"
            : partial ? "unknown" : "closed";
        var checks = open.SelectMany(p => p.Checks ?? []).Select(c => c.State.ToUpperInvariant()).ToArray();
        var ci = checks.Any(c => c is "FAILURE" or "ERROR" or "CANCELLED" or "TIMED_OUT" or "ACTION_REQUIRED" or "STALE" or "STARTUP_FAILURE") ? "failed"
            : checks.Any(c => c is "PENDING" or "EXPECTED" or "QUEUED" or "IN_PROGRESS" or "WAITING" or "REQUESTED") ? "running"
            : partial || open.Any(p => p.Checks is null) || checks.Any(c => c is not ("SUCCESS" or "NEUTRAL" or "SKIPPED")) ? "unknown"
            : checks.Contains("SUCCESS") ? "passed" : "none";
        // Open PR freshness is independent of old merged history in a corrective cycle.
        var dates = (open.Length > 0 ? open : known).Select(p => (DateTimeOffset?)p.At);
        return new(items.Length, state, ci, dates.Min(), partial);
    }

    private static bool Known(InspectionPullRequest reference) => reference.Unavailable is null
        && reference.Observation is { Error: null, State: "open" or "closed" or "merged" };
}
