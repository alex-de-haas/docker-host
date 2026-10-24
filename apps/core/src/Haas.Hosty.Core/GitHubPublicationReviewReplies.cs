using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace Haas.Hosty.Core;

internal sealed partial class GitHubPublicationProvider
{
    internal static string VisibleReviewBody(string body) => Regex.Replace(body,
        @"\n?\n?<!-- hosty-review-(?:reply|comment):[a-f0-9]{64} -->\s*$", "", RegexOptions.CultureInvariant);

    public async Task<string> ReplyReviewAsync(UserProviderConnection connection, PublicationRecord record,
        string threadId, string head, string body, string marker, bool recoverOnly,
        Func<Task> admitMutation, CancellationToken ct)
    {
        var pr = await Graph(connection, record, ct);
        var thread = pr["reviewThreads"]?["nodes"]?.AsArray().FirstOrDefault(t => Text(t, "id") == threadId);
        if (thread is null)
            throw new PublicationException("review_changed", "Refresh the current PR and select one of its review threads.");
        var account = await Request(connection, HttpMethod.Get, "/user", null, ct);
        if (account["id"]?.ToString() != connection.AccountId)
            throw new PublicationException("identity_changed", "Reconnect the selected GitHub account.");
        // Reconcile before checking a moved head: a previous reply may have reached GitHub
        // immediately before another contributor pushed. Recovery must still find that reply.
        var existing = await FindReplyAsync(connection, threadId, marker, ct);
        if (existing is not null) return existing;
        if (recoverOnly)
            throw new PublicationException("reply_uncertain", "The reply has not been observed yet. Recover this request again; it will never be posted twice automatically.");
        // Marker reconciliation can take several pages. Check fresh provider evidence
        // immediately before admitting a new reply, rather than reusing its earlier head.
        var current = await Graph(connection, record, ct);
        if (Text(current, "headRefOid") != head || Text(current, "state") != "OPEN" ||
            current["reviewThreads"]?["nodes"]?.AsArray().Any(t => Text(t, "id") == threadId) != true)
            throw new PublicationException("review_changed", "Refresh the current open PR head before replying.");
        await admitMutation();
        var result = await Request(connection, HttpMethod.Post, "/graphql", new JsonObject
        {
            ["query"] = "mutation($thread:ID!,$body:String!){addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId:$thread,body:$body}){comment{id body author{... on User{databaseId} ... on Bot{databaseId}}}}}",
            ["variables"] = new JsonObject { ["thread"] = threadId, ["body"] = body + "\n\n" + marker }
        }, ct);
        var comment = result["data"]?["addPullRequestReviewThreadReply"]?["comment"];
        if (string.IsNullOrEmpty(Text(comment, "id")) || !Text(comment, "body").EndsWith(marker, StringComparison.Ordinal) ||
            comment?["author"]?["databaseId"]?.ToString() != connection.AccountId)
            throw new PublicationException("reply_uncertain", "GitHub did not confirm the reply identity. Recover with the same request ID.");
        return Text(comment, "id");
    }

    private async Task<string?> FindReplyAsync(UserProviderConnection connection, string threadId, string marker, CancellationToken ct)
    {
        string? cursor = null;
        for (var page = 0; page < 10; page++)
        {
            var data = await Request(connection, HttpMethod.Post, "/graphql", new JsonObject
            {
                ["query"] = "query($id:ID!,$after:String){node(id:$id){... on PullRequestReviewThread{id comments(first:100,after:$after){pageInfo{hasNextPage endCursor} nodes{id body author{... on User{databaseId} ... on Bot{databaseId}}}}}}}",
                ["variables"] = new JsonObject { ["id"] = threadId, ["after"] = cursor }
            }, ct);
            var thread = data["data"]?["node"];
            if (Text(thread, "id") != threadId || thread?["comments"] is null)
                throw new PublicationException("review_changed", "The selected review thread is unavailable.");
            var comments = thread["comments"]!;
            var matches = comments["nodes"]?.AsArray().Where(comment =>
                Text(comment, "body").EndsWith(marker, StringComparison.Ordinal) &&
                comment?["author"]?["databaseId"]?.ToString() == connection.AccountId).ToArray() ?? [];
            if (matches.Length > 1)
                throw new PublicationException("reply_uncertain", "Several replies match this request. Inspect the PR before continuing.");
            if (matches.Length == 1) return Text(matches[0], "id");
            if (comments["pageInfo"]?["hasNextPage"]?.GetValue<bool>() != true) return null;
            var next = Text(comments["pageInfo"], "endCursor");
            if (string.IsNullOrEmpty(next) || next == cursor) break;
            cursor = next;
        }
        throw new PublicationException("reply_uncertain", "The review thread is too large to reconcile safely. Inspect it on GitHub before continuing.");
    }
}
