using System.Globalization;
using System.Text;

namespace Haas.Hosty.Core;

internal sealed record WorkspaceBranchNaming(int Version, string Slug, int SuffixLength);

internal sealed partial class DevelopmentWorkspaceService
{
    internal static string WorkspaceBranchSlug(string name)
    {
        var result = new StringBuilder();
        var bytes = 0;
        var separator = false;
        var attached = false;
        // Enumerating scalars replaces malformed UTF-16 before normalization.
        var validText = new StringBuilder();
        foreach (var rune in name.EnumerateRunes()) validText.Append(rune.ToString());
        foreach (var rune in validText.ToString().Normalize(NormalizationForm.FormC).ToLowerInvariant().EnumerateRunes())
        {
            var category = Rune.GetUnicodeCategory(rune);
            var letterOrDigit = Rune.IsLetter(rune) || category == UnicodeCategory.DecimalDigitNumber;
            var mark = category is UnicodeCategory.NonSpacingMark or UnicodeCategory.SpacingCombiningMark or UnicodeCategory.EnclosingMark;
            if (!letterOrDigit && !(mark && attached))
            {
                separator = result.Length > 0;
                attached = false;
                continue;
            }
            var size = rune.Utf8SequenceLength + (separator ? 1 : 0);
            if (bytes + size > 32) break;
            if (separator) result.Append('-');
            result.Append(rune.ToString());
            bytes += size;
            separator = false;
            attached = true;
        }
        return result.Length == 0 ? "workspace" : result.ToString();
    }

    internal static bool ValidWorkspaceBranch(DevelopmentWorkspace tree)
    {
        if (tree.BranchNaming is not { } naming) return tree.Branch == "hosty/session/" + tree.Id;
        return naming.Version == 1 && naming.Slug is { Length: > 0 }
            && naming.SuffixLength is >= 12 and <= 64 && naming.SuffixLength % 4 == 0
            && tree.Id is { Length: 64 } && tree.Id.All(c => char.IsAsciiHexDigit(c) && !char.IsAsciiLetterUpper(c))
            && GitObjectId(tree.OriginalBase)
            && naming.Slug == WorkspaceBranchSlug(naming.Slug)
            && tree.Branch == BranchFor(tree.Id, naming);
    }

    private static bool GitObjectId(string? value)
        => value is { Length: 40 or 64 } && value.All(char.IsAsciiHexDigit);

    private static string BranchFor(string id, WorkspaceBranchNaming naming)
        => "hosty/" + naming.Slug + "-" + id[..naming.SuffixLength];

    internal static string BranchAllocationRef(DevelopmentWorkspace tree) => "refs/hosty/allocations/" + tree.Id;

    // A private blob binds the ref transaction to this exact allocation, independent of mutable names.
    private static string BranchAllocationReceipt(DevelopmentWorkspace tree)
        => "hosty-workspace-branch-v1\n" + tree.Id + "\n" + tree.Branch + "\n" + tree.OriginalBase + "\n";

    private async Task<string> BranchAllocationObject(DevelopmentWorkspace tree, bool write, CancellationToken ct)
    {
        var result = await Git(RepoPath(tree.RepositoryId),
            write ? ["hash-object", "-w", "--stdin"] : ["hash-object", "--stdin"], ct,
            standardInput: BranchAllocationReceipt(tree));
        var value = result.StandardOutput.Trim();
        if (!GitObjectId(value)) throw Error("ownership_invalid", "Git returned an invalid allocation receipt.");
        return value;
    }

    // Called under the repository admission lock. Pending records reserve their names before refs exist.
    private async Task<WorkspaceBranchNaming> AllocateBranchNaming(string id, string repositoryId, WorkspaceOwner owner, CancellationToken ct)
    {
        var name = (await MetadataAsync(owner, ct)).Name ?? LegacyWorkspaceName(owner);
        var slug = WorkspaceBranchSlug(name);
        var references = (await Git(RepoPath(repositoryId), ["for-each-ref", "--format=%(refname)", "refs/heads/"], ct))
            .StandardOutput.Split('\n', StringSplitOptions.RemoveEmptyEntries).ToHashSet(StringComparer.Ordinal);
        if (Directory.Exists(Records))
            foreach (var path in Directory.EnumerateFiles(Records, "*.json"))
            {
                var other = await recordCache.ReadAsync<DevelopmentWorkspace>(path, ct);
                if (other is null || other.RepositoryId != repositoryId || other.Id == id || other.State == "released") continue;
                // An inconsistent reservation cannot be treated as an available name.
                other = await Read(other.Id, null, ct);
                references.Add("refs/heads/" + other.Branch);
            }
        for (var length = 12; length <= 64; length += 4)
        {
            var naming = new WorkspaceBranchNaming(1, slug, length);
            var reference = "refs/heads/" + BranchFor(id, naming);
            if (references.Any(existing => existing == reference
                || existing.StartsWith(reference + "/", StringComparison.Ordinal)
                || reference.StartsWith(existing + "/", StringComparison.Ordinal))) continue;
            await Git(RepoPath(repositoryId), ["check-ref-format", reference], ct);
            return naming;
        }
        throw Error("branch_conflict", "No workspace branch name is available. Existing refs were preserved.");
    }

    private async Task<string?> ReadAllocationRef(DevelopmentWorkspace tree, string reference, CancellationToken ct)
    {
        var repo = RepoPath(tree.RepositoryId);
        var symbolic = await Git(repo, ["symbolic-ref", "--quiet", reference], ct, true);
        if (symbolic.ExitCode != 1) throw Error("ownership_invalid", "An allocation ref is symbolic or unavailable.");
        var result = await Git(repo, ["rev-parse", "--verify", "--quiet", reference], ct, true);
        if (result.ExitCode == 1) return null;
        var value = result.StandardOutput.Trim();
        if (result.ExitCode != 0 || !GitObjectId(value)) throw Error("unavailable", "Cannot inspect the workspace allocation ref.");
        return value;
    }

    private async Task EnsureAllocatedBranch(DevelopmentWorkspace tree, CancellationToken ct)
    {
        if (!ValidWorkspaceBranch(tree)) throw Error("ownership_invalid", "Workspace branch metadata is inconsistent.");
        var repo = RepoPath(tree.RepositoryId);
        var reference = "refs/heads/" + tree.Branch;
        var proofRef = BranchAllocationRef(tree);
        var proof = await BranchAllocationObject(tree, true, ct);
        var branch = await ReadAllocationRef(tree, reference, ct);
        var receipt = await ReadAllocationRef(tree, proofRef, ct);
        if (branch is null && receipt is null && !Directory.Exists(tree.Path))
        {
            // Git verifies absence and locks both refs before committing either. Never adopt a ref
            // that appeared after admission, even if it points at our original base.
            await Git(repo, ["update-ref", "--stdin"], ct, standardInput:
                "start\noption no-deref\ncreate " + reference + " " + tree.OriginalBase
                + "\ncreate " + proofRef + " " + proof + "\nprepare\ncommit\n");
            return;
        }
        if (branch != tree.OriginalBase || receipt != proof)
            throw Error("branch_conflict", "Workspace branch creation cannot be proven. Existing refs were preserved.");
    }

    private async Task RequireBranchAllocation(DevelopmentWorkspace tree, CancellationToken ct)
    {
        if (tree.BranchNaming is null) return;
        _ = await ReadAllocationRef(tree, "refs/heads/" + tree.Branch, ct);
        var current = await ReadAllocationRef(tree, BranchAllocationRef(tree), ct);
        if (current != await BranchAllocationObject(tree, false, ct))
            throw Error("ownership_invalid", "Workspace allocation receipt is missing or changed; source was preserved.");
    }

    private async Task RemoveBranchAllocation(DevelopmentWorkspace tree, CancellationToken ct)
    {
        if (tree.BranchNaming is null) return;
        var reference = BranchAllocationRef(tree);
        var current = await ReadAllocationRef(tree, reference, ct);
        if (current is null) return; // Recovery after the receipt was already removed.
        var expected = await BranchAllocationObject(tree, false, ct);
        if (current != expected) throw Error("ownership_invalid", "Workspace allocation receipt changed; it was preserved.");
        await Git(RepoPath(tree.RepositoryId), ["update-ref", "--no-deref", "-d", reference, expected], ct);
    }
}
