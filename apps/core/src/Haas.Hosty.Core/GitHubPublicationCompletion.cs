using System.Globalization;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Haas.Hosty.Core;

internal sealed partial class GitHubPublicationProvider
{
    private async Task<PublicationCompletionIssue?> Completion(UserProviderConnection c, PublicationRecord r,
        string commit, CancellationToken ct)
    {
        string kind = "merge", requirement = "commit";
        PublicationCompletionIssue Issue(string state) => new(kind, requirement, state, commit);
        if (string.IsNullOrEmpty(commit)) return Issue("missing");
        try
        {
            if (r.Policy.RequiredChecks.Length > 0)
            {
                kind = "check"; requirement = string.Join(", ", r.Policy.RequiredChecks);
                var checks = await Request(c, HttpMethod.Get, $"/repos/{r.Repository}/commits/{commit}/check-runs?per_page=100&filter=latest", null, ct);
                var runs = CompletePage(checks, "check_runs");
                foreach (var name in r.Policy.RequiredChecks)
                {
                    requirement = name;
                    var matches = runs.Where(n => Text(n, "name") == name && Text(n, "head_sha") == commit).ToArray();
                    if (matches.Length == 0) return Issue("missing");
                    foreach (var run in matches)
                    {
                        var state = RunState(run);
                        if (state is not null) return Issue(state);
                    }
                }
            }
            foreach (var workflow in r.Policy.RequiredWorkflows)
            {
                kind = "workflow"; requirement = workflow.ToString(CultureInfo.InvariantCulture);
                var response = await Request(c, HttpMethod.Get, $"/repos/{r.Repository}/actions/workflows/{workflow}/runs?head_sha={commit}&per_page=100", null, ct);
                var runs = CompletePage(response, "workflow_runs");
                var latest = runs.Where(n => Text(n, "head_sha") == commit && Text(n, "head_branch") == r.TargetBranch &&
                    Text(n, "event") is not ("" or "pull_request" or "pull_request_target"))
                    .OrderByDescending(n => n?["run_number"]?.GetValue<long>() ?? 0).FirstOrDefault();
                if (latest is null) return Issue("missing");
                var state = RunState(latest);
                if (state is not null) return Issue(state);
            }
            foreach (var artifact in r.Policy.Artifacts)
            {
                kind = "artifact";
                requirement = artifact.Kind == "release" ? $"release:{artifact.Tag}/{artifact.Asset}" : $"{artifact.Kind}:{artifact.Package}@{artifact.Version}";
                if (artifact.Kind != "release")
                {
                    if (!await new PublicationArtifacts(http).Verify(artifact, r.Repository, commit, ct)) return Issue("unverified");
                    continue;
                }
                var tag = await Request(c, HttpMethod.Get, $"/repos/{r.Repository}/commits/{Escape(artifact.Tag!)}", null, ct);
                if (Text(tag, "sha") != commit) return Issue("unverified");
                var release = await Request(c, HttpMethod.Get, $"/repos/{r.Repository}/releases/tags/{Escape(artifact.Tag!)}", null, ct);
                if (release["draft"]?.GetValue<bool>() != false) return Issue("pending");
                var assets = release["assets"] as JsonArray ?? throw new JsonException("Incomplete release evidence.");
                var asset = assets.FirstOrDefault(a => Text(a, "name") == artifact.Asset);
                if (asset is null) return Issue("missing");
                if (Text(asset, "state") != "uploaded") return Issue("pending");
            }
            return null;
        }
        catch (Exception ex) when (ex is PublicationException or HttpRequestException or JsonException or InvalidOperationException or FormatException)
        {
            // Never include provider response bodies, tokens or exception messages in diagnostics.
            return Issue("unavailable");
        }
    }

    private static JsonArray CompletePage(JsonNode response, string property)
    {
        var count = response["total_count"]?.GetValue<int>();
        var nodes = response[property] as JsonArray;
        if (count is null or < 0 or > 100 || nodes is null || count != nodes.Count)
            throw new JsonException("Incomplete publication evidence.");
        return nodes;
    }

    private static string? RunState(JsonNode? run) => Text(run, "status") switch
    {
        "completed" => Text(run, "conclusion") switch
        {
            "success" => null,
            "failure" or "cancelled" or "timed_out" or "action_required" or "neutral" or "skipped" or "stale" or "startup_failure" => "failed",
            _ => "unavailable"
        },
        "queued" or "in_progress" or "waiting" or "pending" or "requested" => "pending",
        _ => "unavailable"
    };
}
