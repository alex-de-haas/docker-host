using System.Net.Http.Headers;
using System.Text;
using System.Text.Json.Nodes;

namespace Haas.Hosty.Core;

internal sealed partial class GitHubPublicationProvider : IPullRequestActionsProvider
{
    public async Task<PullRequestActions> ActionsAsync(UserProviderConnection c, string repository, int number, CancellationToken ct)
    {
        var path = "/repos/" + Slug(repository);
        var repo = await ActionRequest(c, HttpMethod.Get, path, null, null, ct);
        if (!string.Equals(Text(repo, "full_name"), repository, StringComparison.OrdinalIgnoreCase))
            throw new PullRequestException("pr_changed", "Repository identity changed. Refresh the installed repository.", 409);
        var pr = await ActionRequest(c, HttpMethod.Get, path + "/pulls/" + number, null, null, ct);
        var head = Text(pr["head"], "sha"); var basis = Text(pr["base"], "sha");
        var merged = pr["merged"]?.GetValue<bool>() == true;
        var state = merged ? "merged" : Text(pr, "state");
        var draft = pr["draft"]?.GetValue<bool>() != false;
        var mergeState = Text(pr, "mergeable_state");
        var write = repo["permissions"]?["push"]?.GetValue<bool>() == true;
        var headRepository = Text(pr["head"]?["repo"], "full_name");
        var sameRepository = string.Equals(headRepository, repository, StringComparison.OrdinalIgnoreCase);
        string? common = state != "open" ? "This pull request is not open." : draft ? "Mark this draft ready for review on GitHub first." :
            !write ? "The selected GitHub account needs write access to this repository." :
            repo["archived"]?.GetValue<bool>() == true ? "This repository is archived." :
            pr["mergeable"] is null ? "GitHub is still calculating mergeability. Refresh action status." :
            pr["mergeable"]?.GetValue<bool>() != true ? "Resolve merge conflicts before continuing." : null;
        var mergeReason = common ?? (repo["allow_merge_commit"]?.GetValue<bool>() != true ? "This repository does not allow merge commits. Open GitHub to choose another method." :
            mergeState != "clean" ? mergeState == "behind" ? "Update the branch, then wait for its checks and review requirements." : "GitHub has not confirmed that all merge requirements are satisfied." : null);
        // Fork updates stay conservative: their write/maintainer permissions are separate from base access.
        var updateReason = common ?? (!sameRepository ? "Update this fork branch on GitHub using its branch permissions." :
            mergeState != "behind" ? "No required branch update is currently reported by GitHub." : null);
        var auto = pr["auto_merge"];
        return new(head, basis, state, draft, mergeState, new(mergeReason is null, mergeReason),
            new(updateReason is null, updateReason), auto is not null ? "enabled" : repo["allow_auto_merge"]?.GetValue<bool>() == true ? "disabled" : "unavailable",
            auto is null ? null : Text(auto, "merge_method"), clock.UtcNow);
    }
    public async Task<PullRequestActionOutcome> ExecuteActionAsync(UserProviderConnection c, string repository, int number,
        PullRequestCommand command, Func<Task> beforeSend, CancellationToken ct)
    {
        var merge = command.Action == "merge";
        var body = merge ? new JsonObject { ["sha"] = command.Head, ["merge_method"] = "merge", ["merge_action"] = "direct_merge", ["bypass_rules"] = false }
            : new JsonObject { ["expected_head_sha"] = command.Head };
        try
        {
            var result = await ActionRequest(c, HttpMethod.Put, $"/repos/{Slug(repository)}/pulls/{number}/" + (merge ? "merge-async" : "update-branch"), body, beforeSend, ct);
            return merge ? await VerifyMergeOutcome(c, repository, number, command, MergeOutcome(result), ct) : new("pending", "GitHub accepted the branch update. Check the result; CI will be observed for the new head.");
        }
        catch (PullRequestException ex) when (ex.Code == "pr_action_rejected")
        { return new("failed", ex.Message); }
        finally { observationCache?.Invalidate(c, repository, number); }
    }
    public async Task<PullRequestActionOutcome> RecoverActionAsync(UserProviderConnection c, string repository, int number,
        PullRequestCommand command, PullRequestActionOutcome previous, CancellationToken ct)
    {
        var path = $"/repos/{Slug(repository)}/pulls/{number}";
        try
        {
            if (command.Action == "merge" && previous.ProviderRequestId is { } id && Guid.TryParseExact(id, "D", out _))
            {
                try { return await VerifyMergeOutcome(c, repository, number, command, MergeOutcome(await ActionRequest(c, HttpMethod.Get, path + "/merge-async/" + id, null, null, ct)), ct); }
                catch (PullRequestException ex) when (ex.Status == 404) { previous = new("unknown", "GitHub no longer retains this merge receipt. Inspect the PR result on GitHub.", id); }
            }
            var pr = await ActionRequest(c, HttpMethod.Get, path, null, null, ct);
            var head = Text(pr["head"], "sha");
            if (command.Action == "merge")
                return pr["merged"]?.GetValue<bool>() == true && head == command.Head ? new("merged", "Pull request merged.") : previous;
            if (head != command.Head && System.Text.RegularExpressions.Regex.IsMatch(head, "^[a-f0-9]{40}$"))
            {
                // A changed head alone could be an unrelated push. Verify both the old head and base are ancestors.
                foreach (var ancestor in new[] { command.Head, command.Base })
                {
                    var compare = await ActionRequest(c, HttpMethod.Get, $"/repos/{Slug(repository)}/compare/{ancestor}...{head}?per_page=1", null, null, ct);
                    if (Text(compare, "status") is not ("ahead" or "identical")) return new("unknown", "The PR head changed, but the requested branch update could not be verified. Inspect it on GitHub.");
                }
                return new("updated", "The PR branch includes the observed base and previous head. New CI results are being observed.");
            }
            return previous;
        }
        finally { observationCache?.Invalidate(c, repository, number); }
    }
    private async Task<PullRequestActionOutcome> VerifyMergeOutcome(UserProviderConnection c, string repository, int number,
        PullRequestCommand command, PullRequestActionOutcome outcome, CancellationToken ct)
    {
        if (outcome.State != "merged") return outcome;
        var pr = await ActionRequest(c, HttpMethod.Get, $"/repos/{Slug(repository)}/pulls/{number}", null, null, ct);
        return pr["merged"]?.GetValue<bool>() == true && Text(pr["head"], "sha") == command.Head ? outcome :
            new("unknown", "The merged head could not be verified against this request. Inspect the PR on GitHub.");
    }
    private static PullRequestActionOutcome MergeOutcome(JsonNode result)
    {
        var state = Text(result, "status");
        var id = Text(result["details"], "uuid");
        return state switch
        {
            "merged" => new("merged", "Pull request merged."),
            "pending" when Guid.TryParseExact(id, "D", out _) => new("pending", "GitHub is processing the merge. Check its result.", id),
            "failed" => new("failed", "GitHub declined the merge. Refresh action status and review repository requirements."),
            "enqueued" => new("enqueued", "This PR is already in GitHub's merge queue; it has not been confirmed merged."),
            _ => new("unknown", "GitHub's result could not be verified. Check the result without resending the action.")
        };
    }
    private async Task<JsonNode> ActionRequest(UserProviderConnection c, HttpMethod method, string path, JsonNode? body, Func<Task>? beforeSend, CancellationToken ct)
    {
        if (c.Provider != "github") throw new PullRequestException("pr_actions_unsupported", "Select a GitHub connection.", 409);
        using var lease = budget is null ? null : await budget.AcquireAsync(c, false, false, ct, waitForPacing: true);
        using var request = new HttpRequestMessage(method, "https://api.github.com" + path);
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", c.AccessToken);
        request.Headers.UserAgent.ParseAdd("Hosty/1.0"); request.Headers.Accept.ParseAdd("application/vnd.github+json");
        request.Headers.Add("X-GitHub-Api-Version", "2026-03-10");
        if (body is not null) request.Content = new StringContent(body.ToJsonString(), Encoding.UTF8, "application/json");
        if (beforeSend is not null) await beforeSend();
        using var response = await http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, ct);
        try { lease?.Complete(response); }
        catch (PullRequestException) when (method == HttpMethod.Put && (int)response.StatusCode is 403 or 429)
        { throw new PullRequestException("pr_action_rejected", "GitHub rate-limited this action without accepting it. Wait before confirming a new request.", 429); }
        if (!response.IsSuccessStatusCode)
        {
            var code = (int)response.StatusCode;
            if (method == HttpMethod.Put && code is 400 or 401 or 403 or 404 or 405 or 409 or 422 or 429)
                throw new PullRequestException("pr_action_rejected", $"GitHub declined the action (HTTP {code}). Refresh status and check permissions, branch rules or rate limits on GitHub.", code);
            throw new PullRequestException("pr_action_unavailable", $"GitHub action status is unavailable (HTTP {code}).", code >= 400 && code < 500 ? code : 502);
        }
        await using var stream = await response.Content.ReadAsStreamAsync(ct);
        using var buffer = new MemoryStream(); var block = new byte[16384]; int read;
        while ((read = await stream.ReadAsync(block, ct)) > 0)
        {
            if (buffer.Length + read > 4 * 1024 * 1024) throw new PullRequestException("pr_response_limit", "GitHub action response exceeds the read limit.", 502);
            buffer.Write(block, 0, read);
        }
        return JsonNode.Parse(buffer.ToArray()) ?? throw new PullRequestException("pr_action_unavailable", "GitHub returned no action result.", 502);
    }
}
