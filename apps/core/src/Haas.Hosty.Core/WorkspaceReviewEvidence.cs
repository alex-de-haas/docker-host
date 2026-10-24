using System.Globalization;
using System.Text.RegularExpressions;

namespace Haas.Hosty.Core;

internal sealed partial class WorkspaceInspectionService
{
    private static async Task<WorkspaceReviewPublishedEvidence> PublishedReviewEvidenceAsync(
        DevelopmentWorkspace tree, PublicationReviewSnapshot published, string path, AppSourceDiff rendered,
        CancellationToken ct)
    {
        WorkspaceReviewPublishedEvidence Unavailable(string reason) => new(published.Url, published.Head, false, [], reason);
        if (published.Truncated || rendered.Truncated)
            return Unavailable("The diff is incomplete; unpublished line evidence is unavailable.");
        if (rendered.Binary || rendered.Image is not null)
            return Unavailable("Unpublished line evidence is available only for complete text diffs.");
        if (!AppSourceService.IsRegularSourcePath(tree.Path, path))
            return Unavailable("Unpublished line evidence requires a regular file inside the workspace.");
        // Provider revisions are data, never arbitrary Git refs or options.
        if (!Regex.IsMatch(published.Head, "^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$", RegexOptions.CultureInvariant))
            return Unavailable("The published revision is unavailable locally.");
        var directory = Path.Combine(Path.GetTempPath(), "hosty-review-evidence-" + Guid.NewGuid().ToString("N"));
        try
        {
            await AppSourceService.RequireRegularFileAsync(Path.Combine(tree.Path, path), ct);
            var exists = await DevelopmentWorkspaceService.Git(tree.Path,
                ["cat-file", "-e", published.Head + "^{commit}"], ct, allowFailure: true);
            if (exists.ExitCode != 0)
                return Unavailable("The published revision is unavailable locally. No source fetch was performed.");
            var entry = await DevelopmentWorkspaceService.Git(tree.Path,
                ["ls-tree", "-z", published.Head, "--", path], ct);
            if (entry.StandardOutput.Length > 0 &&
                !entry.StandardOutput.StartsWith("100644 blob ", StringComparison.Ordinal) &&
                !entry.StandardOutput.StartsWith("100755 blob ", StringComparison.Ordinal))
                return Unavailable("The published path is not a regular source file.");
            Directory.CreateDirectory(directory);
            var index = Path.Combine(directory, "index");
            // A temporary index includes files absent from the published head without staging anything
            // in the operator's real index. It is removed even when Git or the evidence parser fails.
            await DevelopmentWorkspaceService.Git(tree.Path, ["read-tree", published.Head], ct, index: index);
            if (File.Exists(Path.Combine(tree.Path, path)))
                await DevelopmentWorkspaceService.Git(tree.Path,
                    ["add", "--intent-to-add", "--force", "--", path], ct, index: index);
            var patch = await DevelopmentWorkspaceService.Git(tree.Path,
                ["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--unified=0", "--inter-hunk-context=0",
                    published.Head, "--", path], ct, index: index);
            if (AppSourceService.IsBinaryPatch(patch.StandardOutput))
                return Unavailable("Unpublished line evidence is available only for complete text diffs.");
            if (!TryParseUnpublishedRanges(patch.StandardOutput, out var ranges))
                return Unavailable("Git returned incomplete line evidence; unpublished markers are unavailable.");
            return new(published.Url, published.Head, true, ranges);
        }
        catch (AppLifecycleException)
        {
            return Unavailable("The local comparison is unavailable; no unpublished line markers were inferred.");
        }
        finally
        {
            if (Directory.Exists(directory)) Directory.Delete(directory, recursive: true);
        }
    }

    // Only added RIGHT-side lines are absent from the published file. Deletions have no working
    // line to mark; unchanged/context lines must never inherit a neighbouring addition's marker.
    internal static bool TryParseUnpublishedRanges(string patch, out WorkspaceReviewLineRange[] ranges)
    {
        ranges = [];
        var result = new List<WorkspaceReviewLineRange>();
        long oldRemaining = 0, newRemaining = 0, nextNew = 0;
        var inHunk = false;
        foreach (var line in patch.Split('\n'))
        {
            if (line.StartsWith("@@", StringComparison.Ordinal))
            {
                if (oldRemaining != 0 || newRemaining != 0) return false;
                var match = Regex.Match(line, @"^@@ -([0-9]+)(?:,([0-9]+))? \+([0-9]+)(?:,([0-9]+))? @@(?:.*)$", RegexOptions.CultureInvariant);
                if (!match.Success || !long.TryParse(match.Groups[1].Value, NumberStyles.None, CultureInfo.InvariantCulture, out var oldStart) ||
                    !long.TryParse(match.Groups[2].Success ? match.Groups[2].Value : "1", NumberStyles.None, CultureInfo.InvariantCulture, out oldRemaining) ||
                    !long.TryParse(match.Groups[3].Value, NumberStyles.None, CultureInfo.InvariantCulture, out nextNew) ||
                    !long.TryParse(match.Groups[4].Success ? match.Groups[4].Value : "1", NumberStyles.None, CultureInfo.InvariantCulture, out newRemaining) ||
                    oldStart > int.MaxValue || nextNew > int.MaxValue || oldRemaining > int.MaxValue || newRemaining > int.MaxValue ||
                    oldStart + oldRemaining > (long)int.MaxValue + 1 ||
                    nextNew + newRemaining > (long)int.MaxValue + 1 || oldRemaining > 0 && oldStart < 1 || newRemaining > 0 && nextNew < 1)
                    return false;
                inHunk = true;
                continue;
            }
            if (!inHunk) continue;
            if (line.StartsWith("\\ No newline at end of file", StringComparison.Ordinal)) continue;
            if (oldRemaining == 0 && newRemaining == 0)
            {
                if (line.Length == 0 || line.StartsWith("diff --git ", StringComparison.Ordinal))
                {
                    inHunk = false;
                    continue;
                }
                return false;
            }
            if (line.Length == 0) return false;
            switch (line[0])
            {
                case '+':
                    if (newRemaining-- <= 0 || nextNew < 1 || nextNew > int.MaxValue) return false;
                    var number = (int)nextNew++;
                    if (result.Count > 0 && result[^1].EndLine == number - 1)
                        result[^1] = result[^1] with { EndLine = number };
                    else result.Add(new(number, number));
                    break;
                case '-':
                    if (oldRemaining-- <= 0) return false;
                    break;
                case ' ':
                    if (oldRemaining-- <= 0 || newRemaining-- <= 0) return false;
                    nextNew++;
                    break;
                default: return false;
            }
        }
        if (oldRemaining != 0 || newRemaining != 0) return false;
        ranges = result.ToArray();
        return true;
    }
}
