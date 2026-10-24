using System.Text;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace Haas.Hosty.Core;

internal sealed partial class GitHubPublicationProvider
{
    public async Task<PublicationReviewSnapshot> ReadReviewSnapshotAsync(UserProviderConnection connection,
        PublicationRecord record, CancellationToken ct)
    {
        var observation = await ObserveAsync(connection, record, ct);
        if (observation.State is not ("open" or "merged" or "closed") || !ReviewOid(observation.Head) || !ReviewOid(observation.BaseHead))
            throw new PublicationException("review_unavailable", "GitHub did not return an exact published head and target revision for this PR.");
        var head = observation.Head!;
        var basis = observation.BaseHead!;
        // The authenticated compare endpoint resolves a merge base using immutable server-observed SHAs.
        // It does not fetch into, check out, reset or change the registered Git worktree.
        var comparison = await Request(connection, HttpMethod.Get,
            $"/repos/{Slug(record.Repository)}/compare/{basis}...{head}?per_page=1", null, ct);
        var mergeBase = Text(comparison["merge_base_commit"], "sha");
        if (!ReviewOid(mergeBase) || Text(comparison["base_commit"], "sha") != basis)
            throw new PublicationException("review_unavailable", "GitHub did not verify the selected comparison base.");
        var nodes = comparison["files"]?.AsArray()
            ?? throw new PublicationException("review_unavailable", "GitHub did not return the PR file list.");
        // GitHub compare caps the file list at 300 and provides no proof that exactly 300 is complete.
        // Refuse that boundary instead of presenting an apparently complete truncated review.
        if (nodes.Count >= 300)
            throw new PublicationException("review_incomplete", "The PR exceeds the complete comparison limit. Open it on GitHub to review every file.");
        var files = new List<PublicationReviewFile>();
        var seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (var node in nodes)
        {
            var path = Text(node, "filename");
            var previous = Text(node, "previous_filename");
            if (!ReviewPath(path) || previous.Length > 0 && !ReviewPath(previous) || !seen.Add(path))
                throw new PublicationException("review_invalid", "GitHub returned an unsupported file path.");
            var status = Text(node, "status");
            if (status is not ("added" or "removed" or "modified" or "renamed" or "copied" or "changed" or "unchanged"))
                throw new PublicationException("review_invalid", "GitHub returned an unsupported file change.");
            var additions = node?["additions"]?.GetValue<int>() ?? 0;
            var deletions = node?["deletions"]?.GetValue<int>() ?? 0;
            if (additions < 0 || deletions < 0)
                throw new PublicationException("review_invalid", "GitHub returned invalid line statistics.");
            var body = node?["patch"]?.GetValue<string>();
            string? patch = null;
            if (body is not null && CompleteReviewPatch(body, additions, deletions))
                patch = ReviewPatch(path, previous.Length == 0 ? null : previous, status, body);
            // A missing patch can mean a large text file or a binary file. Do not guess which one.
            // Keep the complete inventory and statistics. The per-file diff marks an unavailable
            // preview; one binary/large file must not disable replies on every other thread.
            files.Add(new(path, status, previous.Length == 0 ? null : previous, patch, additions, deletions));
        }
        var final = await ObserveAsync(connection, record, ct);
        if (final.Head != head || final.BaseHead != basis || final.Base != observation.Base)
            throw new PublicationException("review_stale", "The PR changed while reading its diff. Refresh the review.");
        return new(record.Url ?? PullRequestUrl(record.Repository, record.Number!.Value), record.Repository,
            observation.Base ?? record.TargetBranch, basis, mergeBase, head, final, files.ToArray());
    }

    private static bool ReviewOid(string? value) => value is { Length: 40 or 64 } && value.All(char.IsAsciiHexDigit);
    private static bool ReviewPath(string path) => path.Length is > 0 and <= 4096 && !path.StartsWith('/') &&
        !path.Contains('\\') && !path.Any(char.IsControl) && path.Split('/').All(part => part is not ("" or "." or ".."));

    internal static bool CompleteReviewPatch(string patch, int additions, int deletions)
    {
        if (patch.Length > 4 * 1024 * 1024) return false;
        long added = 0, removed = 0;
        var hasHunk = false;
        long oldRemaining = 0, newRemaining = 0;
        foreach (var line in patch.Split('\n'))
        {
            if (line.StartsWith("@@ ", StringComparison.Ordinal))
            {
                if (hasHunk && (oldRemaining != 0 || newRemaining != 0)) return false;
                var match = Regex.Match(line, "^@@ -[0-9]+(?:,([0-9]+))? \\+[0-9]+(?:,([0-9]+))? @@", RegexOptions.CultureInvariant);
                if (!match.Success || !long.TryParse(match.Groups[1].Success ? match.Groups[1].Value : "1", out oldRemaining) ||
                    !long.TryParse(match.Groups[2].Success ? match.Groups[2].Value : "1", out newRemaining)) return false;
                hasHunk = true;
            }
            else if (hasHunk && line.StartsWith('+')) { added++; newRemaining--; }
            else if (hasHunk && line.StartsWith('-')) { removed++; oldRemaining--; }
            else if (hasHunk && line.StartsWith(' ')) { oldRemaining--; newRemaining--; }
            else if (line.Length != 0 && !line.StartsWith("\\ No newline at end of file", StringComparison.Ordinal)) return false;
            if (oldRemaining < 0 || newRemaining < 0) return false;
        }
        return oldRemaining == 0 && newRemaining == 0 && added == additions && removed == deletions;
    }

    private static string ReviewPatch(string path, string? previous, string status, string patch)
    {
        static string Quote(string value) => "\"" + value.Replace("\\", "\\\\", StringComparison.Ordinal).Replace("\"", "\\\"", StringComparison.Ordinal) + "\"";
        var before = previous ?? path;
        var result = new StringBuilder("diff --git ").Append(Quote("a/" + before)).Append(' ').Append(Quote("b/" + path)).Append('\n');
        if (status == "added") result.Append("new file mode 100644\n");
        if (status == "removed") result.Append("deleted file mode 100644\n");
        if (status == "renamed") result.Append("rename from ").Append(Quote(before)).Append("\nrename to ").Append(Quote(path)).Append('\n');
        result.Append("--- ").Append(status == "added" ? "/dev/null" : Quote("a/" + before)).Append('\n');
        result.Append("+++ ").Append(status == "removed" ? "/dev/null" : Quote("b/" + path)).Append('\n');
        return result.Append(patch).Append('\n').ToString();
    }
}
