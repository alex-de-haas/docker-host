using System.Net;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json.Nodes;

namespace Haas.Hosty.Core;

internal sealed partial class GitHubPublicationProvider : IPullRequestProvider
{
    private sealed record InboxResponse(JsonNode? Body, string? ETag, bool NotModified, bool HasNext);
    private async Task<InboxResponse> InboxRequest(UserProviderConnection connection, string path,
        JsonObject? body, string? etag, CancellationToken ct, bool repositoryRedirect = false)
    {
        if (connection.Provider != "github") throw new PullRequestException("pr_provider_unsupported", "Select a GitHub connection.");
        using var budgetLease = budget is null ? null : await budget.AcquireAsync(connection, body is not null, true, ct, waitForPacing: true);
        using var request = new HttpRequestMessage(body is null ? HttpMethod.Get : HttpMethod.Post, "https://api.github.com" + path);
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", connection.AccessToken);
        request.Headers.UserAgent.ParseAdd("Hosty/1.0");
        request.Headers.Accept.ParseAdd("application/vnd.github+json");
        request.Headers.Add("X-GitHub-Api-Version", "2022-11-28");
        if (etag is not null && EntityTagHeaderValue.TryParse(etag, out var validator)) request.Headers.IfNoneMatch.Add(validator);
        if (body is not null) request.Content = new StringContent(body.ToJsonString(), Encoding.UTF8, "application/json");
        using var response = await http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, ct);
        if (repositoryRedirect && response.StatusCode is HttpStatusCode.MovedPermanently or HttpStatusCode.TemporaryRedirect &&
            response.Headers.Location is { IsAbsoluteUri: true } location && location.Scheme == "https" && location.Host == "api.github.com" &&
            location.IsDefaultPort && location.UserInfo.Length == 0 && location.Query.Length == 0 && location.Fragment.Length == 0 &&
            System.Text.RegularExpressions.Regex.IsMatch(location.AbsolutePath, "^/repositories/[0-9]+$"))
        {
            budgetLease?.Complete(response); budgetLease?.Dispose();
            return await InboxRequest(connection, location.AbsolutePath, null, null, ct);
        }
        if (response.StatusCode == HttpStatusCode.NotModified)
        { budgetLease?.Complete(response); return new(null, response.Headers.ETag?.ToString() ?? etag, true, false); }
        JsonNode? payload = null;
        if (response.Content is not null)
        {
            if (response.Content.Headers.ContentLength > 4 * 1024 * 1024)
                throw new PullRequestException("pr_response_limit", "The provider response exceeds the preview limit.");
            await using var stream = await response.Content.ReadAsStreamAsync(ct);
            using var buffer = new MemoryStream();
            var chunk = new byte[16384]; int count;
            while ((count = await stream.ReadAsync(chunk, ct)) > 0)
            {
                buffer.Write(chunk, 0, count);
                if (buffer.Length > 4 * 1024 * 1024) throw new PullRequestException("pr_response_limit", "The provider response exceeds the preview limit.");
            }
            try { payload = JsonNode.Parse(buffer.ToArray()); }
            catch (System.Text.Json.JsonException) when (!response.IsSuccessStatusCode) { /* Preserve HTTP failure classification. */ }
        }
        budgetLease?.Complete(response, payload);
        if (!response.IsSuccessStatusCode)
            throw new PullRequestException(response.StatusCode is HttpStatusCode.Unauthorized or HttpStatusCode.Forbidden or HttpStatusCode.NotFound
                ? "pr_access_denied" : "pr_provider_unavailable", "GitHub could not provide this resource with the selected connection.",
                response.StatusCode is HttpStatusCode.Unauthorized or HttpStatusCode.Forbidden or HttpStatusCode.NotFound ? 403 : 502);
        return new(payload ?? throw new PullRequestException("pr_response_invalid", "GitHub returned no data."),
            response.Headers.ETag?.ToString(), false,
            response.Headers.TryGetValues("Link", out var links) && links.Any(l => l.Contains("rel=\"next\"", StringComparison.Ordinal)));
    }
    private PullRequestReceipt InboxReceipt(string completeness = "complete", string? reason = null)
        => new(Guid.NewGuid().ToString("N"), clock.UtcNow, clock.UtcNow, Freshness: "fresh", Completeness: completeness, Reason: reason);
    private static string? InboxUrl(string? value) => Uri.TryCreate(value, UriKind.Absolute, out var uri) &&
        uri.Scheme == "https" && uri.UserInfo.Length == 0 ? uri.AbsoluteUri : null;
    private static string BoundedText(JsonNode? value, int limit) => value?.ToString() is { } text ? text[..Math.Min(limit, text.Length)] : "";
    private static DateTimeOffset InboxDate(JsonNode? value) => DateTimeOffset.TryParse(value?.ToString(), out var date) ? date : DateTimeOffset.UnixEpoch;
    public async Task<PullRequestRemoteRepository> RepositoryAsync(UserProviderConnection connection, string repository, CancellationToken ct)
    {
        var node = (await InboxRequest(connection, "/repos/" + Slug(repository), null, null, ct, repositoryRedirect: true)).Body!;
        var name = Slug(Text(node, "full_name"));
        var id = Text(node, "node_id");
        if (id.Length == 0) throw new PullRequestException("pr_response_invalid", "GitHub repository identity is missing.");
        return new(id, name, "https://github.com/" + name);
    }
    private PullRequestSummary RestSummary(JsonNode node, string repository, string id)
    {
        var number = node["number"]?.GetValue<int>() ?? 0;
        if (number <= 0) throw new PullRequestException("pr_response_invalid", "GitHub returned an invalid PR number.");
        return new(id, number, Text(node, "node_id"), BoundedText(node["title"], 4096), PullRequestUrl(repository, number),
            BoundedText(node["user"]?["login"], 256), Text(node["user"], "type") == "Bot", node["draft"]?.GetValue<bool>() == true,
            node["merged_at"] is not null ? "merged" : Text(node, "state"), InboxDate(node["updated_at"]),
            Text(node["head"], "sha"), Text(node["base"], "sha"), Text(node["head"], "ref"), Text(node["base"], "ref"),
            "UNKNOWN", "UNKNOWN", node["comments"]?.GetValue<int>(), new([], null, "unknown"), InboxReceipt(), Text(node["head"]?["repo"], "full_name"));
    }
    public async Task<PullRequestRemotePage> ListPullRequestsAsync(UserProviderConnection connection, string repository,
        string repositoryId, int page, string? etag, CancellationToken ct)
    {
        if (page is < 1 or > 10) throw new PullRequestException("pr_page_invalid", "PR inventory page is out of range.");
        var result = await InboxRequest(connection, $"/repos/{Slug(repository)}/pulls?state=open&sort=created&direction=desc&per_page=100&page={page}", null, etag, ct);
        if (result.NotModified) return new([], result.ETag, true, false);
        var array = result.Body?.AsArray() ?? throw new PullRequestException("pr_response_invalid", "GitHub returned no PR list.");
        if (array.Count > 100) throw new PullRequestException("pr_response_limit", "GitHub exceeded the requested page size.");
        return new(array.OfType<JsonObject>().Select(n => RestSummary(n, repository, repositoryId)).ToArray(), result.ETag, false, result.HasNext);
    }
    private const string CheckFields = """
        totalCount pageInfo { hasNextPage endCursor }
        nodes { ... on CheckRun { id name status conclusion detailsUrl }
                ... on StatusContext { id context state targetUrl } }
        """;
    private static PullRequestChecks ParseChecks(JsonNode? contexts)
    {
        if (contexts?["nodes"] is not JsonArray nodes) return new([], null, "unknown");
        var items = nodes.OfType<JsonObject>().Select(n => new PullRequestCheck(Text(n, "id"),
            Text(n, n.ContainsKey("name") ? "name" : "context"),
            PullRequestPolicy.CheckState(Text(n, n.ContainsKey("status") ? "status" : "state"), Text(n, n.ContainsKey("conclusion") ? "conclusion" : "state")),
            InboxUrl(Text(n, n.ContainsKey("detailsUrl") ? "detailsUrl" : "targetUrl")))).ToArray();
        var total = contexts["totalCount"]?.GetValue<int>();
        var more = contexts["pageInfo"]?["hasNextPage"]?.GetValue<bool>() == true;
        return new(items, total, more || total is null || nodes.Any(n => n is null) ? "partial" : "complete",
            more ? Text(contexts["pageInfo"], "endCursor") : null);
    }
    private PullRequestSummary GraphSummary(JsonNode node, string repository, string repositoryId)
    {
        var number = node["number"]!.GetValue<int>();
        var contexts = node["commits"]?["nodes"]?.AsArray().FirstOrDefault()?["commit"]?["statusCheckRollup"]?["contexts"];
        return new(repositoryId, number, Text(node, "id"), BoundedText(node["title"], 4096), PullRequestUrl(repository, number),
            BoundedText(node["author"]?["login"], 256), Text(node["author"], "__typename") == "Bot",
            node["isDraft"]?.GetValue<bool>() == true, Text(node, "state").ToLowerInvariant(), InboxDate(node["updatedAt"]),
            Text(node, "headRefOid"), Text(node, "baseRefOid"), Text(node, "headRefName"), Text(node, "baseRefName"),
            Text(node, "reviewDecision"), Text(node, "mergeStateStatus"), node["comments"]?["totalCount"]?.GetValue<int>(), ParseChecks(contexts), InboxReceipt(), Text(node["headRepository"], "nameWithOwner"));
    }
    public Task<PullRequestSummary[]> ReadPullRequestsAsync(UserProviderConnection connection, string repository,
        string repositoryId, int[] numbers, CancellationToken ct) => observationCache is null
        ? ReadPullRequestsUncachedAsync(connection, repository, repositoryId, numbers, ct)
        : observationCache.ReadAsync(connection, repository, repositoryId, numbers,
            missing => ReadPullRequestsUncachedAsync(connection, repository, repositoryId, missing, ct), ct);
    private async Task<PullRequestSummary[]> ReadPullRequestsUncachedAsync(UserProviderConnection connection, string repository,
        string repositoryId, int[] numbers, CancellationToken ct)
    {
        if (numbers.Length is < 1 or > 10 || numbers.Any(n => n <= 0)) throw new PullRequestException("pr_request_invalid", "Select one to ten PRs.");
        var parts = Slug(repository).Split('/');
        var variables = new JsonObject { ["owner"] = parts[0], ["repo"] = parts[1] };
        var declarations = new StringBuilder("$owner: String!, $repo: String!");
        var fields = new StringBuilder();
        for (var i = 0; i < numbers.Length; i++)
        {
            variables["n" + i] = numbers[i]; declarations.Append($", $n{i}: Int!");
            fields.Append($$"""
                p{{i}}: pullRequest(number: $n{{i}}) {
                  id number title state isDraft updatedAt headRefName headRefOid baseRefName baseRefOid
                  headRepository { nameWithOwner } author { login __typename } mergeStateStatus reviewDecision comments { totalCount }
                  commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 100) { {{CheckFields}} } } } } }
                }
                """);
        }
        var query = $"query({declarations}) {{ repository(owner: $owner, name: $repo) {{ {fields} }} rateLimit {{ cost limit remaining resetAt }} }}";
        var body = (await InboxRequest(connection, "/graphql", new() { ["query"] = query, ["variables"] = variables }, null, ct)).Body!;
        var result = new List<PullRequestSummary>();
        for (var i = 0; i < numbers.Length; i++)
            if (body["data"]?["repository"]?["p" + i] is JsonObject pr)
            {
                var summary = GraphSummary(pr, repository, repositoryId);
                if (body["errors"] is JsonArray { Count: > 0 }) summary = summary with { Receipt = summary.Receipt with
                    { Completeness = "partial", Reason = "Some provider fields are unavailable." } };
                result.Add(summary);
            }
        if (result.Count == 0) throw new PullRequestException("pr_provider_unavailable", "GitHub did not return the requested PR facts.", 502);
        return result.ToArray();
    }
    public async Task<PullRequestRemoteDetail> ReadPullRequestAsync(UserProviderConnection connection, string repository,
        string repositoryId, int number, CancellationToken ct)
    {
        var node = (await InboxRequest(connection, $"/repos/{Slug(repository)}/pulls/{number}", null, null, ct)).Body!;
        var body = Text(node, "body");
        var bytes = Encoding.UTF8.GetBytes(body);
        var truncated = bytes.Length > PullRequestPolicy.DescriptionBytes;
        if (truncated)
        {
            var end = PullRequestPolicy.DescriptionBytes;
            while (end > 0 && (bytes[end] & 0xc0) == 0x80) end--;
            body = Encoding.UTF8.GetString(bytes, 0, end);
        }
        return new(RestSummary(node, repository, repositoryId), body, truncated);
    }
    private async Task<JsonNode> DetailGraph(UserProviderConnection connection, string repository, int number,
        string selection, string? cursor, CancellationToken ct)
    {
        if (cursor?.Length > 512) throw new PullRequestException("pr_cursor_invalid", "Invalid provider cursor.");
        var parts = Slug(repository).Split('/');
        var result = (await InboxRequest(connection, "/graphql", new()
        {
            ["query"] = "query($owner: String!, $repo: String!, $number: Int!, $after: String) { repository(owner: $owner, name: $repo) { pullRequest(number: $number) { headRefOid " + selection + " } } rateLimit { cost limit remaining resetAt } }",
            ["variables"] = new JsonObject { ["owner"] = parts[0], ["repo"] = parts[1], ["number"] = number, ["after"] = cursor }
        }, null, ct)).Body!;
        return result["data"]?["repository"]?["pullRequest"] ?? throw new PullRequestException("pr_provider_unavailable", "GitHub could not read these PR details.", 502);
    }
    public async Task<PullRequestChecks> ReadChecksAsync(UserProviderConnection connection, string repository,
        int number, string head, string? cursor, CancellationToken ct)
    {
        var node = await DetailGraph(connection, repository, number,
            "commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 100, after: $after) { " + CheckFields + " } } } } }", cursor, ct);
        if (Text(node, "headRefOid") != head) throw new PullRequestException("pr_changed", "The PR head changed. Reload its checks.");
        return ParseChecks(node["commits"]?["nodes"]?.AsArray().FirstOrDefault()?["commit"]?["statusCheckRollup"]?["contexts"]);
    }
    public async Task<PullRequestReview> ReadDiscussionAsync(UserProviderConnection connection, string repository,
        int number, string head, string? cursor, CancellationToken ct)
    {
        var node = await DetailGraph(connection, repository, number,
            "reviewThreads(first: 100, after: $after) { totalCount pageInfo { hasNextPage endCursor } nodes { id isResolved isOutdated comments(first: 1) { nodes { author { login } body url } } } }", cursor, ct);
        if (Text(node, "headRefOid") != head) throw new PullRequestException("pr_changed", "The PR head changed. Reload its review.");
        var threads = node["reviewThreads"];
        if (threads?["nodes"] is not JsonArray nodes) return new([], null, null, InboxReceipt("unknown"));
        var items = nodes.OfType<JsonObject>().Select(t =>
        {
            var comment = t["comments"]?["nodes"]?.AsArray().FirstOrDefault();
            return new PullRequestReviewItem(Text(t, "id"), Text(comment?["author"], "login"),
                t["isResolved"]?.GetValue<bool>() == true ? "resolved" : t["isOutdated"]?.GetValue<bool>() == true ? "outdated" : "unresolved",
                BoundedText(comment?["body"], 8192), InboxUrl(Text(comment, "url")));
        }).ToArray();
        var more = threads["pageInfo"]?["hasNextPage"]?.GetValue<bool>() == true;
        return new(items, threads["totalCount"]?.GetValue<int>(), more ? Text(threads["pageInfo"], "endCursor") : null,
            InboxReceipt(more || nodes.Any(n => n is null) ? "partial" : "complete"));
    }
    public async Task<PullRequestDiff> ReadDiffAsync(UserProviderConnection connection, string repository,
        string repositoryId, int number, string head, string basis, CancellationToken ct)
    {
        var before = await ReadPullRequestAsync(connection, repository, repositoryId, number, ct);
        if (!ReviewOid(head) || !ReviewOid(basis) || before.Summary.Head != head || before.Summary.Base != basis)
            throw new PullRequestException("pr_changed", "The PR revisions changed. Reload before opening its diff.");
        var comparison = (await InboxRequest(connection, $"/repos/{Slug(repository)}/compare/{basis}...{head}?per_page=1", null, null, ct)).Body!;
        var mergeBase = Text(comparison["merge_base_commit"], "sha");
        if (!ReviewOid(mergeBase) || Text(comparison["base_commit"], "sha") != basis)
            throw new PullRequestException("pr_diff_unavailable", "GitHub did not verify the comparison base.");
        var files = ReadComparisonFiles(comparison);
        var after = await ReadPullRequestAsync(connection, repository, repositoryId, number, ct);
        if (after.Summary.Head != head || after.Summary.Base != basis)
            throw new PullRequestException("pr_changed", "The PR changed while reading its diff. Reload the PR.");
        return new(head, basis, mergeBase, files, InboxReceipt(files.Any(f => f.Patch is null) ? "partial" : "complete"));
    }
}
