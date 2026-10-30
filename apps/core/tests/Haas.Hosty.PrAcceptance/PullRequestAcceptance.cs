using System.Net;
using System.Text.Json.Nodes;
using Microsoft.Extensions.DependencyInjection.Extensions;

namespace Haas.Hosty.Core;

// Deterministic provider boundary inside an otherwise ordinary managed child Core.
// Only explicit fixture credentials work; no network forwarding or fixture HTTP control routes.
internal static class PullRequestAcceptance
{
    public static void Register(WebApplicationBuilder builder)
    {
        builder.Services.RemoveAll<SourceProviderRegistry>();
        builder.Services.AddSingleton(services => new SourceProviderRegistry([
            new GitHubSourceProvider(new HttpClient(new Fixture()), builder.Configuration,
                services.GetRequiredService<IClock>(), budget: services.GetRequiredService<PullRequestProviderBudget>(),
                observationCache: services.GetRequiredService<PullRequestObservationCache>())]));
    }
    private sealed class Fixture : HttpMessageHandler
    {
        private readonly System.Collections.Concurrent.ConcurrentDictionary<int, string> heads = new();
        private readonly System.Collections.Concurrent.ConcurrentDictionary<int, bool> merged = new();
        private string Head(int n) => heads.GetValueOrDefault(n, new string('a', 40));
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            var token = request.Headers.Authorization?.Parameter;
            if (token is not ("hosty-pr-fixture-alice" or "hosty-pr-fixture-bob")) return Reply(HttpStatusCode.Unauthorized, new JsonObject());
            if (request.RequestUri!.Host != "api.github.com") return Reply(HttpStatusCode.NotFound, new JsonObject());
            var path = request.RequestUri.AbsolutePath;
            if (path == "/user") return Reply(HttpStatusCode.OK, new JsonObject { ["id"] = token.EndsWith("alice") ? 101 : 102, ["login"] = token.EndsWith("alice") ? "fixture-alice" : "fixture-bob" });
            if (token.EndsWith("bob") || path.Contains("denied")) return Reply(HttpStatusCode.Forbidden, new JsonObject());
            if (request.Method == HttpMethod.Put && path.Contains("/pulls/"))
            {
                var n = int.Parse(path.Split('/')[5]);
                var body = JsonNode.Parse(await request.Content!.ReadAsStringAsync(ct))!;
                if (path.EndsWith("/update-branch"))
                {
                    if (body["expected_head_sha"]?.ToString() != Head(n)) return Reply(HttpStatusCode.UnprocessableEntity, new JsonObject());
                    heads[n] = new string('c', 40); return Reply(HttpStatusCode.Accepted, new JsonObject());
                }
                if (path.EndsWith("/merge-async"))
                {
                    if (body["sha"]?.ToString() != Head(n) || Head(n) != new string('c', 40) || body["merge_method"]?.ToString() != "merge" || body["bypass_rules"]?.GetValue<bool>() != false)
                        return Reply(HttpStatusCode.UnprocessableEntity, new JsonObject());
                    merged[n] = true; return Reply(HttpStatusCode.OK, new JsonObject { ["status"] = "merged" });
                }
                return Reply(HttpStatusCode.NotFound, new JsonObject());
            }
            if (path == "/graphql")
            {
                var input = JsonNode.Parse(await request.Content!.ReadAsStringAsync(ct))!;
                var query = input["query"]!.ToString(); var vars = input["variables"]!;
                if (vars["repo"]?.ToString() == "denied") return Reply(HttpStatusCode.OK, JsonNode.Parse("""{"data":{"repository":null},"errors":[{"type":"FORBIDDEN"}]}""")!);
                var repository = new JsonObject();
                foreach (var variable in vars.AsObject().Where(p => p.Key.StartsWith('n') && p.Key != "number"))
                    repository["p" + variable.Key[1..]] = Graph(variable.Value!.GetValue<int>());
                if (vars["number"] is { } number) repository["pullRequest"] = Graph(number.GetValue<int>());
                return Reply(HttpStatusCode.OK, new JsonObject { ["data"] = new JsonObject { ["repository"] = repository,
                    ["rateLimit"] = new JsonObject { ["cost"] = 1, ["limit"] = 5000, ["remaining"] = 4900, ["resetAt"] = DateTimeOffset.UtcNow.AddHours(1).ToString("O") } } });
            }
            if (path.Contains("/compare/")) return Reply(HttpStatusCode.OK, new JsonObject {
                ["status"] = "ahead", ["base_commit"] = new JsonObject { ["sha"] = new string('b', 40) }, ["merge_base_commit"] = new JsonObject { ["sha"] = new string('b', 40) },
                ["files"] = new JsonArray(new JsonObject { ["filename"] = "package.json", ["status"] = "modified", ["additions"] = 1, ["deletions"] = 1,
                    ["patch"] = "@@ -1 +1 @@\n-old\n+new" }) });
            if (path.EndsWith("/pulls"))
            {
                var response = Reply(HttpStatusCode.OK, merged.GetValueOrDefault(12) ? new JsonArray(Rest(11)) : new JsonArray(Rest(12), Rest(11)));
                response.Headers.ETag = new("\"fixture-list-" + Head(12) + "-" + merged.GetValueOrDefault(12) + "\"");
                if (request.Headers.IfNoneMatch.Any(tag => tag.Tag == response.Headers.ETag.Tag)) response.StatusCode = HttpStatusCode.NotModified;
                return response;
            }
            if (path.Contains("/pulls/") && int.TryParse(path.Split('/').Last(), out var requestedNumber)) return Reply(HttpStatusCode.OK, Rest(requestedNumber));
            if (path.StartsWith("/repos/")) return Reply(HttpStatusCode.OK, new JsonObject { ["node_id"] = "R_fixture_shared", ["full_name"] = "hosty-fixture/shared", ["permissions"] = new JsonObject { ["push"] = true }, ["allow_merge_commit"] = true, ["allow_auto_merge"] = true, ["archived"] = false });
            return Reply(HttpStatusCode.NotFound, new JsonObject());
        }
        private JsonObject Rest(int n) => new() {
            ["node_id"] = "PR_" + n, ["number"] = n, ["title"] = n == 12 ? "Bump dependencies with Dependabot" : "Improve keyboard navigation",
            ["body"] = """
                ## Change
                A representative read-only pull request.

                - Preserve keyboard navigation
                - Verify tests before merging

                <details><summary>Release notes</summary><p><em>Sourced from <a href="https://github.com/hosty-fixture/shared/releases">the release notes</a>.</em></p><blockquote><h2>2.1.5</h2><ul><li>Handle <code>AbortSignal</code> correctly.</li><li>Preserve keyboard navigation.</li></ul></blockquote></details>
                <details><summary>Commits</summary>

                - **Fix:** preserve `request.signal`
                - [Compare changes](https://github.com/hosty-fixture/shared/compare/v2.1.0...v2.1.5)

                </details>
                """, ["state"] = merged.GetValueOrDefault(n) ? "closed" : "open", ["merged"] = merged.GetValueOrDefault(n), ["draft"] = n == 11,
            ["mergeable"] = true, ["mergeable_state"] = Head(n) == new string('c', 40) ? "clean" : "behind",
            ["updated_at"] = DateTimeOffset.UtcNow.ToString("O"), ["comments"] = 2,
            ["user"] = new JsonObject { ["login"] = n == 12 ? "dependabot[bot]" : "fixture-alice", ["type"] = n == 12 ? "Bot" : "User" },
            ["head"] = new JsonObject { ["sha"] = Head(n), ["ref"] = "feature/" + n, ["repo"] = new JsonObject { ["full_name"] = "hosty-fixture/shared" } },
            ["base"] = new JsonObject { ["sha"] = new string('b', 40), ["ref"] = "main" } };
        private JsonObject Graph(int n)
        {
            var rest = Rest(n);
            var checks = JsonNode.Parse("""{"nodes":[{"commit":{"statusCheckRollup":{"contexts":{"totalCount":3,"pageInfo":{"hasNextPage":false},"nodes":[{"id":"check-build","name":"Build","status":"COMPLETED","conclusion":"SUCCESS"},{"id":"check-test","name":"Tests","status":"IN_PROGRESS","conclusion":null},{"id":"check-optional","name":"Optional check","status":"COMPLETED","conclusion":"SKIPPED"}]}}}}]}""");
            if (Head(n) == new string('c', 40))
            {
                var check = checks!["nodes"]![0]!["commit"]!["statusCheckRollup"]!["contexts"]!["nodes"]![1]!;
                check["status"] = "COMPLETED"; check["conclusion"] = "SUCCESS";
            }
            return new() { ["id"] = "PR_" + n, ["number"] = n, ["title"] = rest["title"]!.ToString(), ["state"] = merged.GetValueOrDefault(n) ? "MERGED" : "OPEN", ["isDraft"] = n == 11,
                ["updatedAt"] = DateTimeOffset.UtcNow.ToString("O"), ["headRefOid"] = Head(n), ["baseRefOid"] = new string('b', 40), ["headRefName"] = "feature/" + n, ["baseRefName"] = "main",
                ["headRepository"] = new JsonObject { ["nameWithOwner"] = "hosty-fixture/shared" },
                ["author"] = new JsonObject { ["login"] = rest["user"]!["login"]!.ToString(), ["__typename"] = n == 12 ? "Bot" : "User" },
                ["mergeStateStatus"] = Head(n) == new string('c', 40) ? "CLEAN" : "BEHIND", ["reviewDecision"] = Head(n) == new string('c', 40) ? "APPROVED" : "REVIEW_REQUIRED", ["comments"] = new JsonObject { ["totalCount"] = 2 },
                ["commits"] = checks,
                ["reviewThreads"] = JsonNode.Parse("""{"totalCount":1,"pageInfo":{"hasNextPage":false},"nodes":[{"id":"thread-1","isResolved":false,"isOutdated":false,"comments":{"nodes":[{"author":{"login":"reviewer"},"body":"Please check the keyboard path.","url":"https://github.com/hosty-fixture/shared/pull/12#discussion_r1"}]}}]}""") };
        }
        private static HttpResponseMessage Reply(HttpStatusCode status, JsonNode body) => new(status) { Content = new StringContent(body.ToJsonString(), System.Text.Encoding.UTF8, "application/json") };
    }
}
