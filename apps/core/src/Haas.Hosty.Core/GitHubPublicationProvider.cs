using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace Haas.Hosty.Core;

internal sealed class GitHubPublicationProvider(HttpClient http, IClock clock) : IPublicationProvider
{
    public string NormalizeRepository(string url) => Repository(url);
    public string PullRequestUrl(string repository, int number) => $"https://github.com/{Slug(repository)}/pull/{number}";
    internal static string Repository(string url)
    {
        if (!Uri.TryCreate(url, UriKind.Absolute, out var uri) || uri.Scheme != "https" || uri.Host != "github.com" || !uri.IsDefaultPort ||
            uri.UserInfo.Length > 0 || uri.Query.Length > 0 || uri.Fragment.Length > 0)
            throw new PublicationException("repository_invalid", "Publication requires a canonical HTTPS GitHub.com source repository.");
        var path = uri.AbsolutePath.Trim('/');
        return Slug(path.EndsWith(".git", StringComparison.Ordinal) ? path[..^4] : path);
    }
    internal static string Slug(string value)
    {
        if (!Regex.IsMatch(value, "^[A-Za-z0-9_-]+/[A-Za-z0-9_.-]+$", RegexOptions.CultureInvariant) || value.Split('/')[1] is "." or "..")
            throw new PublicationException("repository_invalid", "Invalid GitHub repository identity.");
        return value;
    }
    internal static string Text(JsonNode? node, string key) => node?[key]?.GetValue<string>() ?? "";
    private static string Escape(string value) => Uri.EscapeDataString(value);
    private async Task<JsonNode> Request(UserProviderConnection c, HttpMethod method, string path, JsonNode? body, CancellationToken ct)
    {
        if (c.Provider != "github") throw new PublicationException("provider_unsupported", "Select a GitHub connection.");
        using var request = new HttpRequestMessage(method, "https://api.github.com" + path);
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", c.AccessToken);
        request.Headers.UserAgent.ParseAdd("Hosty/1.0");
        request.Headers.Accept.ParseAdd("application/vnd.github+json");
        request.Headers.Add("X-GitHub-Api-Version", "2022-11-28");
        if (body is not null) request.Content = new StringContent(body.ToJsonString(), Encoding.UTF8, "application/json");
        using var response = await http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, ct);
        if (!response.IsSuccessStatusCode)
            throw new PublicationException("provider_unavailable", $"GitHub returned {(int)response.StatusCode}. Check connection permissions, repository rules and rate limits; recover uncertain operations with the same request ID.");
        if (response.Content.Headers.ContentLength > 4 * 1024 * 1024) throw new PublicationException("response_limit", "GitHub response is too large to verify.");
        await using var stream = await response.Content.ReadAsStreamAsync(ct);
        using var buffer = new MemoryStream();
        var chunk = new byte[16384]; int count;
        while ((count = await stream.ReadAsync(chunk, ct)) > 0)
        {
            buffer.Write(chunk, 0, count);
            if (buffer.Length > 4 * 1024 * 1024) throw new PublicationException("response_limit", "GitHub response is too large to verify.");
        }
        var result = JsonNode.Parse(buffer.ToArray()) ?? throw new PublicationException("response_invalid", "GitHub returned no data.");
        if (result is JsonObject obj && obj.ContainsKey("errors")) throw new PublicationException("provider_unavailable", "GitHub could not verify all requested facts. Check connection permissions.");
        return result;
    }
    public async Task<string> DestinationAsync(UserProviderConnection c, string repository, bool fork, CancellationToken ct)
    {
        var repo = await Request(c, HttpMethod.Get, "/repos/" + Slug(repository), null, ct);
        if (!fork && repo["permissions"]?["push"]?.GetValue<bool>() == true) return repository;
        var account = await Request(c, HttpMethod.Get, "/user", null, ct);
        if (account["id"]?.ToString() != c.AccountId) throw new PublicationException("identity_changed", "Reconnect the selected GitHub account.");
        var login = Text(account, "login");
        var network = Text(repo["source"] ?? repo, "full_name");
        async Task<string?> ExistingFork()
        {
            for (var page = 1; page <= 10; page++)
            {
                var owned = (await Request(c, HttpMethod.Get, $"/user/repos?affiliation=owner&per_page=100&page={page}", null, ct)).AsArray();
                foreach (var candidate in owned.Where(n => n?["fork"]?.GetValue<bool>() == true && n?["owner"]?["id"]?.ToString() == c.AccountId))
                {
                    var name = Slug(Text(candidate, "full_name"));
                    if (!name.StartsWith(login + "/", StringComparison.OrdinalIgnoreCase)) continue;
                    var verified = await Request(c, HttpMethod.Get, "/repos/" + name, null, ct);
                    if (ValidFork(verified, name)) return name;
                }
                if (owned.Count < 100) return null;
            }
            throw new PublicationException("fork_unavailable", "Owned repository discovery is incomplete. Existing forks cannot be reconciled safely.");
        }
        bool ValidFork(JsonNode verified, string name) =>
            name.StartsWith(login + "/", StringComparison.OrdinalIgnoreCase) &&
            string.Equals(Text(verified, "full_name"), name, StringComparison.OrdinalIgnoreCase) &&
            verified["owner"]?["id"]?.ToString() == c.AccountId &&
            string.Equals(Text(verified["source"], "full_name"), network, StringComparison.OrdinalIgnoreCase) &&
            verified["permissions"]?["push"]?.GetValue<bool>() == true;
        var existing = await ExistingFork();
        if (existing is not null) return existing;
        try
        {
            var created = await Request(c, HttpMethod.Post, "/repos/" + repository + "/forks", new JsonObject(), ct);
            var destination = Slug(Text(created, "full_name"));
            var verified = await Request(c, HttpMethod.Get, "/repos/" + destination, null, ct);
            if (!ValidFork(verified, destination)) throw new PublicationException("fork_unavailable", "The fork is not yet available with verified ownership, network and push rights. Retry the same request.");
            return destination;
        }
        catch (Exception ex) when (ex is PublicationException or HttpRequestException || ex is OperationCanceledException && !ct.IsCancellationRequested)
        {
            // Creation can succeed despite a lost response or delayed immediate lookup.
            existing = await ExistingFork();
            if (existing is not null) return existing;
            throw;
        }
    }

    public async Task PushAsync(UserProviderConnection c, DevelopmentWorkspace w, string destination, string branch, string head, CancellationToken ct)
    {
        var url = "https://github.com/" + Slug(destination) + ".git";
        await PrivateSourceService.ValidateGitConfigAsync(w.Path, url, ct);
        var start = AppSourceService.CreateGitStartInfo(w.Path, ["push", "--no-verify", url, head + ":refs/heads/" + branch]);
        PrivateSourceService.ConfigureGit(start, url, "Basic " + Convert.ToBase64String(Encoding.UTF8.GetBytes("x-access-token:" + c.AccessToken)));
        var result = await ProcessRunner.RunAsync(start, TimeSpan.FromMinutes(5), ct, 256 * 1024);
        if (result.TimedOut || result.ExitCode != 0)
            throw new PublicationException("push_uncertain", "Push did not confirm success. Recover using the same request ID; remote history is never force-pushed.");
    }
    public async Task<PublicationReference?> FindAsync(UserProviderConnection c, PublicationRecord r, CancellationToken ct)
    {
        var candidates = (await Request(c, HttpMethod.Get, $"/repos/{Slug(r.Repository)}/pulls?state=all&head={Escape(r.HeadRepository.Split('/')[0] + ":" + r.Branch)}&base={Escape(r.TargetBranch)}&per_page=100", null, ct)).AsArray();
        if (candidates.Count == 100) throw new PublicationException("observation_incomplete", "Too many candidate pull requests to reconcile safely.");
        var found = candidates.Where(p => string.Equals(Text(p?["head"]?["repo"], "full_name"), r.HeadRepository, StringComparison.OrdinalIgnoreCase) &&
            !r.History.Any(h => h.Number == p?["number"]?.GetValue<int>())).ToArray();
        if (found.Length > 1) throw new PublicationException("pr_ambiguous", "Several candidate PRs match this workspace. Select a concrete PR number.");
        return found.Length == 0 ? null : Reference(found[0]!);
    }
    private static PublicationReference Reference(JsonNode p) => new(p["number"]!.GetValue<int>(), Text(p, "html_url"), Text(p["head"], "sha"), Text(p, "merge_commit_sha"));
    public async Task<PublicationReference> PublishAsync(UserProviderConnection c, PublicationRecord r, PublicationCommand input, CancellationToken ct)
    {
        var body = new JsonObject { ["title"] = input.Title, ["body"] = input.Body };
        if (r.Number is null)
        {
            body["head"] = r.HeadRepository.Split('/')[0] + ":" + r.Branch;
            body["head_repo"] = r.HeadRepository.Split('/')[1]; body["base"] = r.TargetBranch; body["draft"] = input.Draft;
        }
        return Reference(await Request(c, r.Number is null ? HttpMethod.Post : HttpMethod.Patch,
            $"/repos/{Slug(r.Repository)}/pulls" + (r.Number is null ? "" : "/" + r.Number), body, ct));
    }
    private async Task<JsonNode> Graph(UserProviderConnection c, PublicationRecord r, CancellationToken ct)
    {
        const string query = "query($owner:String!,$repo:String!,$number:Int!){repository(owner:$owner,name:$repo){pullRequest(number:$number){id number url state isDraft headRefName headRefOid baseRefName headRepository{nameWithOwner} mergeCommit{oid} mergeStateStatus reviewDecision reviewThreads(first:100){pageInfo{hasNextPage} nodes{id path line isResolved comments(first:20){pageInfo{hasNextPage} nodes{body}}}} commits(last:1){nodes{commit{statusCheckRollup{contexts(first:100){pageInfo{hasNextPage} nodes{... on CheckRun{name status conclusion} ... on StatusContext{context state}}}}}}}}}";
        var parts = Slug(r.Repository).Split('/');
        var data = await Request(c, HttpMethod.Post, "/graphql", new JsonObject { ["query"] = query,
            ["variables"] = new JsonObject { ["owner"] = parts[0], ["repo"] = parts[1], ["number"] = r.Number } }, ct);
        var pr = data["data"]?["repository"]?["pullRequest"] ?? throw new PublicationException("pr_missing", "Pull request is unavailable.");
        if (!string.Equals(Text(pr["headRepository"], "nameWithOwner"), r.HeadRepository, StringComparison.OrdinalIgnoreCase) || Text(pr, "headRefName") != r.Branch || Text(pr, "baseRefName") != r.TargetBranch)
            throw new PublicationException("pr_mismatch", "The PR no longer matches its registered workspace, repository and target.");
        return pr;
    }
    public async Task<PublicationObservation> ObserveAsync(UserProviderConnection c, PublicationRecord r, CancellationToken ct)
    {
        var pr = await Graph(c, r, ct);
        var threads = pr["reviewThreads"]!;
        var contexts = pr["commits"]?["nodes"]?.AsArray().LastOrDefault()?["commit"]?["statusCheckRollup"]?["contexts"];
        if (threads["pageInfo"]?["hasNextPage"]?.GetValue<bool>() == true || contexts?["pageInfo"]?["hasNextPage"]?.GetValue<bool>() == true)
            throw new PublicationException("observation_incomplete", "Review or check results exceed the supported observation page; merge is unavailable.");
        var checks = contexts?["nodes"]?.AsArray().Select(n => new PublicationCheck(Text(n, "name") is { Length: > 0 } name ? name : Text(n, "context"),
            Text(n, "status") is { Length: > 0 } status ? status == "COMPLETED" ? Text(n, "conclusion") : status : Text(n, "state"))).ToArray() ?? [];
        var state = Text(pr, "state").ToLowerInvariant(); var merge = Text(pr["mergeCommit"], "oid");
        var complete = false; string? completionError = null;
        if (state == "merged")
        {
            try { complete = await Completion(c, r, merge, ct); }
            catch (Exception ex) when (ex is PublicationException or HttpRequestException or JsonException)
            { completionError = "PR merged; configured release evidence is unavailable or not yet published."; }
        }
        var reviews = threads["nodes"]!.AsArray().Select(t => new PublicationReview(Text(t, "id"), Text(t, "path"), t?["line"]?.GetValue<int>(),
            t?["isResolved"]?.GetValue<bool>() == true, (t?["comments"]?["nodes"]?.AsArray().Select(n => Text(n, "body")) ?? []).Concat(t?["comments"]?["pageInfo"]?["hasNextPage"]?.GetValue<bool>() == true ? ["Additional comments are available on the PR."] : []).ToArray())).ToArray();
        return new(clock.UtcNow, state, Text(pr, "headRefOid"), Text(pr, "baseRefName"), merge,
            pr["isDraft"]?.GetValue<bool>() ?? false, Text(pr, "mergeStateStatus"), Text(pr, "reviewDecision"),
            threads["nodes"]!.AsArray().Count(t => t?["isResolved"]?.GetValue<bool>() != true), complete, checks, completionError, reviews);
    }
    private async Task<bool> Completion(UserProviderConnection c, PublicationRecord r, string commit, CancellationToken ct)
    {
        if (string.IsNullOrEmpty(commit)) return false;
        if (r.Policy.RequiredChecks.Length > 0)
        {
            var checks = await Request(c, HttpMethod.Get, $"/repos/{r.Repository}/commits/{commit}/check-runs?per_page=100&filter=latest", null, ct);
            if (checks["total_count"]!.GetValue<int>() > 100) return false;
            var runs = checks["check_runs"]!.AsArray();
            if (r.Policy.RequiredChecks.Any(name => !runs.Any(n => Text(n, "name") == name && Text(n, "head_sha") == commit && Text(n, "conclusion") == "success" && Text(n, "status") == "completed"))) return false;
        }
        foreach (var workflow in r.Policy.RequiredWorkflows)
        {
            var runs = await Request(c, HttpMethod.Get, $"/repos/{r.Repository}/actions/workflows/{workflow}/runs?head_sha={commit}&per_page=100", null, ct);
            if (runs["total_count"]!.GetValue<int>() > 100) return false;
            var latest = runs["workflow_runs"]!.AsArray().Where(n => Text(n, "head_sha") == commit && Text(n, "head_branch") == r.TargetBranch && Text(n, "event") != "pull_request").OrderByDescending(n => n?["run_number"]?.GetValue<long>() ?? 0).FirstOrDefault();
            if (latest is null || Text(latest, "conclusion") != "success") return false;
        }
        foreach (var artifact in r.Policy.Artifacts)
        {
            if (artifact.Kind != "release")
            {
                if (!await new PublicationArtifacts(http).Verify(artifact, r.Repository, commit, ct)) return false;
                continue;
            }
            var tag = await Request(c, HttpMethod.Get, $"/repos/{r.Repository}/commits/{Escape(artifact.Tag!)}", null, ct);
            if (Text(tag, "sha") != commit) return false;
            var release = await Request(c, HttpMethod.Get, $"/repos/{r.Repository}/releases/tags/{Escape(artifact.Tag!)}", null, ct);
            if (release["draft"]?.GetValue<bool>() != false || !release["assets"]!.AsArray().Any(a => Text(a, "name") == artifact.Asset && Text(a, "state") == "uploaded")) return false;
        }
        return true;
    }
    public async Task MergeAsync(UserProviderConnection c, PublicationRecord r, string head, string method, CancellationToken ct)
    {
        if (method is not ("merge" or "squash" or "rebase")) throw new PublicationException("method_invalid", "Choose a repository-permitted merge method.");
        var body = new JsonObject { ["sha"] = head, ["merge_method"] = method };
        if (method != "rebase" && r.Contributors.Length > 0)
            body["commit_message"] = string.Join("\n", r.Contributors.Select(name => "Co-Authored-By: " + name));
        var result = await Request(c, HttpMethod.Put, $"/repos/{Slug(r.Repository)}/pulls/{r.Number}/merge", body, ct);
        if (result["merged"]?.GetValue<bool>() != true) throw new PublicationException("merge_uncertain", "GitHub did not confirm merge. Refresh the same operation.");
    }
    public async Task ReadyAsync(UserProviderConnection c, PublicationRecord r, CancellationToken ct)
    {
        var pr = await Graph(c, r, ct);
        if (pr["isDraft"]?.GetValue<bool>() != true) return;
        await Request(c, HttpMethod.Post, "/graphql", new JsonObject { ["query"] = "mutation($id:ID!){markPullRequestReadyForReview(input:{pullRequestId:$id}){pullRequest{id}}}",
            ["variables"] = new JsonObject { ["id"] = Text(pr, "id") } }, ct);
    }
    public async Task ResolveReviewAsync(UserProviderConnection c, PublicationRecord r, string threadId, string head, CancellationToken ct)
    {
        var pr = await Graph(c, r, ct);
        var thread = pr["reviewThreads"]?["nodes"]?.AsArray().FirstOrDefault(t => Text(t, "id") == threadId);
        if (Text(pr, "headRefOid") != head || Text(pr, "state") != "OPEN" || thread is null)
            throw new PublicationException("review_changed", "Refresh the current PR head and review thread before resolving.");
        if (thread["isResolved"]?.GetValue<bool>() == true) return;
        await Request(c, HttpMethod.Post, "/graphql", new JsonObject { ["query"] = "mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{id isResolved}}}",
            ["variables"] = new JsonObject { ["id"] = threadId } }, ct);
    }
    public async Task<PublicationIdentity> IdentityAsync(UserProviderConnection c, CancellationToken ct)
    {
        var user = await Request(c, HttpMethod.Get, "/user", null, ct);
        if (user["id"]?.ToString() != c.AccountId) throw new PublicationException("identity_changed", "Reconnect the selected GitHub account.");
        var emails = (await Request(c, HttpMethod.Get, "/user/emails?per_page=100", null, ct)).AsArray();
        var email = emails.FirstOrDefault(e => e?["primary"]?.GetValue<bool>() == true && e?["verified"]?.GetValue<bool>() == true);
        if (email is null) throw new PublicationException("identity_required", "Configure an explicit Git author identity or grant access to a verified primary email.");
        return new(Text(user, "name") is { Length: > 0 } name ? name : Text(user, "login"), Text(email, "email"));
    }
}
