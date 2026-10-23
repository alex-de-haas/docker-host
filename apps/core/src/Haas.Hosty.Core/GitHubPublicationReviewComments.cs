using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace Haas.Hosty.Core;

internal sealed partial class GitHubPublicationProvider
{
    public async Task<PublicationReviewCommentCreated> CreateReviewCommentAsync(UserProviderConnection connection,
        PublicationRecord record, PublicationReviewCommand command, string marker, bool recoverOnly,
        Func<Task> admitMutation, CancellationToken ct)
    {
        var account = await Request(connection, HttpMethod.Get, "/user", null, ct);
        if (account["id"]?.ToString() != connection.AccountId)
            throw new PublicationException("identity_changed", "Reconnect the selected GitHub account.");
        // A new thread's marker is always in its first comment. Reconciliation does not
        // require the old head to remain current, or the PR to remain open.
        var existing = await FindNewReviewCommentAsync(connection, record, marker, ct);
        if (existing is not null) return existing;
        if (recoverOnly)
            throw new PublicationException("comment_uncertain", "The comment has not been observed yet. Recover this request again; it will never be posted twice automatically.");
        var snapshot = await ReadReviewSnapshotAsync(connection, record, ct);
        if (snapshot.Head != command.ExpectedHead || snapshot.Observation.State != "open" || snapshot.Truncated)
            throw new PublicationException("review_changed", "Refresh the current open PR head before commenting.");
        var file = snapshot.Files.SingleOrDefault(f => f.Path == command.Path);
        if (file is null || !ReviewCommentRangeIsInPatch(file, command.DiffSide, command.StartLine, command.Line))
            throw new PublicationException("comment_location_invalid", "Select lines present in a complete published PR patch. Unpublished, binary and unavailable lines cannot receive a PR comment.");
        // The comparison may take several requests. Obtain fresh evidence directly
        // before admission, then pin the POST to that same immutable commit_id.
        var current = await Graph(connection, record, ct);
        if (Text(current, "headRefOid") != snapshot.Head || Text(current, "baseRefOid") != snapshot.Base ||
            Text(current, "state") != "OPEN")
            throw new PublicationException("review_changed", "The PR changed while preparing the comment. Refresh the review.");
        var body = new JsonObject
        {
            ["body"] = command.Body + "\n\n" + marker, ["commit_id"] = snapshot.Head,
            ["path"] = command.Path, ["line"] = command.Line, ["side"] = command.DiffSide
        };
        if (command.StartLine is { } start && start != command.Line)
        {
            body["start_line"] = start;
            body["start_side"] = command.DiffSide;
        }
        await admitMutation();
        try
        {
            var response = await Request(connection, HttpMethod.Post,
                $"/repos/{Slug(record.Repository)}/pulls/{record.Number}/comments", body, ct);
            var commentId = Text(response, "node_id");
            if (commentId.Length == 0 || !Text(response, "body").EndsWith(marker, StringComparison.Ordinal) ||
                response["user"]?["id"]?.ToString() != connection.AccountId || Text(response, "commit_id") != snapshot.Head ||
                Text(response, "path") != command.Path || Text(response, "side") != command.DiffSide ||
                response["line"]?.GetValue<int>() != command.Line ||
                command.StartLine is { } rangeStart && rangeStart != command.Line &&
                    (response["start_line"]?.GetValue<int>() != rangeStart || Text(response, "start_side") != command.DiffSide))
                throw new PublicationException("comment_uncertain", "GitHub did not confirm the published comment identity and location. Recover with the same request ID.");
            var created = await FindNewReviewCommentAsync(connection, record, marker, ct);
            if (created is null || created.CommentId != commentId)
                throw new PublicationException("comment_uncertain", "GitHub has not exposed the new review thread yet. Recover with the same request ID.");
            return created;
        }
        catch (Exception ex) when (ex is System.Text.Json.JsonException or InvalidOperationException)
        {
            throw new PublicationException("comment_uncertain", "GitHub returned an incomplete comment confirmation. Recover with the same request ID.");
        }
    }

    internal static bool ReviewCommentRangeIsInPatch(PublicationReviewFile file, string? side, int? startLine, int? line)
    {
        if (side is not ("LEFT" or "RIGHT") || line is not > 0 || startLine is <= 0 ||
            startLine > line || file.Binary || file.Patch is null) return false;
        var start = startLine ?? line.Value;
        var hunk = Regex.Match(file.Patch, "^@@ ", RegexOptions.Multiline | RegexOptions.CultureInvariant);
        var firstHunk = hunk.Index;
        if (!hunk.Success || !CompleteReviewPatch(file.Patch[firstHunk..], file.Additions, file.Deletions)) return false;
        foreach (var patchLine in file.Patch[firstHunk..].Split('\n'))
        {
            if (!patchLine.StartsWith("@@ ", StringComparison.Ordinal)) continue;
            var match = Regex.Match(patchLine, "^@@ -([0-9]+)(?:,([0-9]+))? \\+([0-9]+)(?:,([0-9]+))? @@", RegexOptions.CultureInvariant);
            var offset = side == "LEFT" ? 1 : 3;
            if (!match.Success || !long.TryParse(match.Groups[offset].Value, out var first) ||
                !long.TryParse(match.Groups[offset + 1].Success ? match.Groups[offset + 1].Value : "1", out var count)) return false;
            if (count > 0 && first <= start && line.Value < first + count) return true;
        }
        return false;
    }

    private async Task<PublicationReviewCommentCreated?> FindNewReviewCommentAsync(UserProviderConnection connection,
        PublicationRecord record, string marker, CancellationToken ct)
    {
        const string query = """
            query($owner:String!,$repo:String!,$number:Int!,$after:String) {
              repository(owner:$owner,name:$repo) { pullRequest(number:$number) {
                reviewThreads(first:100,after:$after) {
                  pageInfo { hasNextPage endCursor }
                  nodes { id comments(first:1) { nodes { id body author { ... on User { databaseId } ... on Bot { databaseId } } } } }
                }
              } }
            }
            """;
        var parts = Slug(record.Repository).Split('/');
        string? cursor = null;
        PublicationReviewCommentCreated? found = null;
        for (var page = 0; page < 10; page++)
        {
            var data = await Request(connection, HttpMethod.Post, "/graphql", new JsonObject
            {
                ["query"] = query,
                ["variables"] = new JsonObject { ["owner"] = parts[0], ["repo"] = parts[1], ["number"] = record.Number, ["after"] = cursor }
            }, ct);
            var threads = data["data"]?["repository"]?["pullRequest"]?["reviewThreads"];
            var nodes = threads?["nodes"]?.AsArray()
                ?? throw new PublicationException("comment_uncertain", "The selected PR's review threads are unavailable for reconciliation.");
            foreach (var thread in nodes)
            {
                var comment = thread?["comments"]?["nodes"]?.AsArray().FirstOrDefault();
                if (!Text(comment, "body").EndsWith(marker, StringComparison.Ordinal) ||
                    comment?["author"]?["databaseId"]?.ToString() != connection.AccountId) continue;
                if (found is not null || Text(thread, "id").Length == 0 || Text(comment, "id").Length == 0)
                    throw new PublicationException("comment_uncertain", "Several comments match this request, or its thread identity is incomplete. Inspect the PR before continuing.");
                found = new(Text(thread, "id"), Text(comment, "id"));
            }
            if (threads?["pageInfo"]?["hasNextPage"]?.GetValue<bool>() != true) return found;
            var next = Text(threads["pageInfo"], "endCursor");
            if (next.Length == 0 || next == cursor) break;
            cursor = next;
        }
        throw new PublicationException("comment_uncertain", "The PR has too many review threads to reconcile safely. Inspect it on GitHub before continuing.");
    }
}
