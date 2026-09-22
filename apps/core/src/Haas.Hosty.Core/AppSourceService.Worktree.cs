using System.Collections.Concurrent;
using System.Security.Cryptography;
using System.Text;

namespace Haas.Hosty.Core;

internal sealed partial class AppSourceService
{
    private const int MaxStatusOutput = 8 * 1024 * 1024;
    private const int MaxGitOutput = 256 * 1024;
    // Previews are requested per expanded file. Allow large documents while bounding payloads
    // and browser parsing: decoded characters for Git patches, bytes for untracked contents.
    private const int MaxDiffOutput = 4 * 1024 * 1024;
    private const long MaxDiscardFileBytes = 4 * 1024 * 1024;
    private readonly ConcurrentDictionary<string, DiscardReview> discardReviews = new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<string, SemaphoreSlim> sourceLocks = new(StringComparer.Ordinal);

    private async Task<AppSourceStatus> ReadWorktreeStatusAsync(string appId, CancellationToken cancellationToken = default)
    {
        var app = await RequireAppAsync(appId, cancellationToken);
        return await ReadScopeStatusAsync(appId, () => ResolveInspectionScope(app),
            app.SourceState?.InspectionPaths, clock.UtcNow, cancellationToken);
    }

    internal static async Task<AppSourceStatus> ReadScopeStatusAsync(string sourceId, Func<string?> resolveScope,
        IReadOnlyList<string>? inspectionPaths, DateTimeOffset observedAt, CancellationToken cancellationToken,
        bool entireRepository = false)
    {
        string? scope = null;
        AppSourceStatus Empty(string state) => new(sourceId, state, scope, null, null, [], false, observedAt);
        try
        {
            scope = resolveScope();
            if (scope is null) return Empty("none");
            if (!Directory.Exists(scope)) return Empty("missing");
            if (!HasGitAncestor(scope)) return Empty("no-git");

            var root = (await WorktreeGitAsync(scope, ["rev-parse", "--show-toplevel"], cancellationToken)).StandardOutput.Trim();
            if (entireRepository) scope = MountPathPolicy.ResolveRealPath(root);
            var headResult = await WorktreeGitAsync(scope, ["rev-parse", "--verify", "--quiet", "HEAD"], cancellationToken, allowFailure: true);
            var head = headResult.ExitCode == 0 ? headResult.StandardOutput.Trim() : null;
            var branchResult = await WorktreeGitAsync(scope, ["symbolic-ref", "--quiet", "--short", "HEAD"], cancellationToken, allowFailure: true);
            var branch = branchResult.ExitCode == 0 ? branchResult.StandardOutput.Trim() : null;
            var result = await WorktreeGitAsync(scope, ["status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all", "--", .. inspectionPaths is { Count: > 0 } selectedPaths ? selectedPaths : ["."]], cancellationToken, limit: MaxStatusOutput);
            var truncated = result.StandardOutput.Length > MaxStatusOutput;
            var records = result.StandardOutput.Split('\0');
            var files = new List<AppSourceFile>();
            var seen = new HashSet<string>(StringComparer.Ordinal);
            // A truncated final record is not a complete filename.
            foreach (var entry in records.Take(records.Length - 1))
            {
                if (entry.Length < 4) continue;
                var fullPath = Path.GetFullPath(Path.Combine(root, entry[3..]));
                if (!IsWithinScope(scope, fullPath)) continue;
                var relative = Path.GetRelativePath(scope, fullPath).Replace(Path.DirectorySeparatorChar, '/');
                if (inspectionPaths is { Count: > 0 } allowed && !allowed.Any(path => relative == path || relative.StartsWith(path.TrimEnd('/') + "/", StringComparison.Ordinal))) continue;
                // `git rm --cached` can list the same path as both deleted and untracked. Restore
                // that tracked path once, rather than presenting it again as a new-file deletion.
                if (!seen.Add(relative)) continue;
                var status = entry[..2];
                var conflict = status.Contains('U') || status is "AA" or "DD";
                var canDiscard = head is not null && !conflict && IsRegularSourcePath(scope, relative)
                    && (!File.Exists(fullPath) || new FileInfo(fullPath).Length <= MaxDiscardFileBytes);
                files.Add(new(relative, status, status is "??" || status.Contains('A'), canDiscard));
            }
            return new(sourceId, files.Count > 0 || truncated ? "changes" : "clean", scope, branch, head,
                files.OrderBy(file => file.Path, StringComparer.Ordinal).ToArray(), truncated, observedAt);
        }
        catch (Exception ex) when (ex is AppLifecycleException or IOException or UnauthorizedAccessException)
        {
            return Empty("unavailable") with { Error = "Source status could not be inspected. Check the source path, Git installation and permissions." };
        }
    }

    public async Task<AppSourceDiff> GetWorktreeDiffAsync(string appId, AppSourceDiffRequest request, CancellationToken cancellationToken = default)
    {
        var status = await ReadWorktreeStatusAsync(appId, cancellationToken);
        return await ReadScopeDiffAsync(status, request, cancellationToken);
    }

    internal static async Task<AppSourceDiff> ReadScopeDiffAsync(AppSourceStatus status, AppSourceDiffRequest request,
        CancellationToken cancellationToken)
    {
        var file = RequireChangedFile(status, request.Path);
        var scope = status.ScopePath!;
        var fullPath = Path.Combine(scope, file.Path);
        if (!IsRegularSourcePath(scope, file.Path))
            throw SourceError("source_diff_unsupported", "Symlinks and submodule directories cannot be previewed here.");
        await RequireRegularFileAsync(fullPath, cancellationToken);
        if (IsSourceImagePath(file.Path))
            return new(file.Path, "", "", false, status.Head, file.NewFile,
                Image: await GetSourceImageAsync(status, file, cancellationToken));
        if (file.Status == "??")
        {
            await using var stream = File.OpenRead(fullPath);
            var buffer = new byte[MaxDiffOutput + 1];
            var count = await stream.ReadAtLeastAsync(buffer, buffer.Length, throwOnEndOfStream: false, cancellationToken);
            var binary = buffer.AsSpan(0, count).Contains((byte)0);
            var tooLarge = !binary && count > MaxDiffOutput;
            return new(file.Path, binary ? "New binary file" : tooLarge ? "" : Encoding.UTF8.GetString(buffer, 0, count),
                "", tooLarge, status.Head, NewFile: true, Binary: binary);
        }
        string[] common = ["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--relative"];
        var combined = await WorktreeGitAsync(scope, [.. common, .. status.Head is null ? Array.Empty<string>() : new[] { status.Head }, "--", file.Path], cancellationToken, limit: MaxDiffOutput);
        var staged = await WorktreeGitAsync(scope, [.. common, "--cached", "--", file.Path], cancellationToken, limit: MaxDiffOutput);
        var truncated = combined.StandardOutput.Length > MaxDiffOutput || staged.StandardOutput.Length > MaxDiffOutput;
        return new(file.Path, truncated ? "" : combined.StandardOutput,
            truncated ? "" : staged.StandardOutput,
            truncated, status.Head, file.NewFile,
            Binary: IsBinaryPatch(combined.StandardOutput) || IsBinaryPatch(staged.StandardOutput));
    }

    public async Task<AppSourceDiscardPlan> PlanDiscardAsync(string appId, AppSourceDiscardRequest request, CancellationToken cancellationToken = default)
    {
        foreach (var pair in discardReviews)
            if (pair.Value.Plan.ExpiresAt <= clock.UtcNow) discardReviews.TryRemove(pair.Key, out _);
        if (discardReviews.Count >= 64) throw SourceError("source_reviews_busy", "Too many pending source reviews; retry after they expire.");
        var selected = ValidateSelection(request.Paths);
        var status = await ReadWorktreeStatusAsync(appId, cancellationToken);
        var fingerprint = await DiscardFingerprintAsync(status, selected, cancellationToken);
        var files = selected.Select(path => RequireChangedFile(status, path)).ToArray();
        var plan = new AppSourceDiscardPlan(appId, Convert.ToHexString(RandomNumberGenerator.GetBytes(24)), status.Head!,
            status.ScopePath!, files, clock.UtcNow.AddMinutes(5));
        discardReviews[plan.ReviewId] = new(plan, fingerprint);
        return plan;
    }

    // Called under the lifecycle app lock. A source lock also serializes two apps sharing a scope.
    public async Task<AppSourceStatus> ApplyDiscardAsync(string appId, AppSourceDiscardApplyRequest request, CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrWhiteSpace(request.ReviewId) || !discardReviews.TryGetValue(request.ReviewId, out var review) || review.Plan.AppId != appId || review.Plan.ExpiresAt <= clock.UtcNow)
            throw SourceError("source_review_expired", "Review the selected source changes again before discarding.");
        var gate = sourceLocks.GetOrAdd(review.Plan.ScopePath, _ => new SemaphoreSlim(1, 1));
        await gate.WaitAsync(cancellationToken);
        try
        {
            if (!discardReviews.TryRemove(request.ReviewId, out _))
                throw SourceError("source_review_expired", "This source review was already used.");
            var selected = review.Plan.Files.Select(file => file.Path).ToArray();
            var current = await ReadWorktreeStatusAsync(appId, cancellationToken);
            var fingerprint = await DiscardFingerprintAsync(current, selected, cancellationToken);
            if (fingerprint != review.Fingerprint)
                throw SourceError("source_review_stale", "Selected files, Git state or source location changed. Review the changes again; nothing was discarded.");
            var tracked = review.Plan.Files.Where(file => file.Status != "??").Select(file => file.Path).ToArray();
            if (tracked.Length > 0)
                await WorktreeGitAsync(current.ScopePath!, ["restore", "--source", review.Plan.Head, "--staged", "--worktree", "--", .. tracked], cancellationToken);
            foreach (var file in review.Plan.Files.Where(file => file.Status == "??"))
            {
                // Never recursive: only the exact regular file from the review can be removed.
                if (!IsRegularSourcePath(current.ScopePath!, file.Path))
                    throw SourceError("source_review_stale", "A selected path changed during discard. Refresh source status to see the partial result.");
                await RequireRegularFileAsync(Path.Combine(current.ScopePath!, file.Path), cancellationToken);
                File.Delete(Path.Combine(current.ScopePath!, file.Path));
            }
            return await GetWorktreeStatusAsync(appId, cancellationToken);
        }
        finally { gate.Release(); }
    }

    private async Task<string> DiscardFingerprintAsync(AppSourceStatus status, string[] selected, CancellationToken cancellationToken)
    {
        if (status.Head is null || status.ScopePath is null || status.State != "changes" || status.Truncated)
            throw SourceError("source_discard_unavailable", "Discard requires a complete Git status and an existing HEAD commit.");
        using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        void Add(string text)
        {
            var bytes = Encoding.UTF8.GetBytes(text);
            hash.AppendData(BitConverter.GetBytes(bytes.Length));
            hash.AppendData(bytes);
        }
        Add(status.AppId); Add(status.ScopePath); Add(status.Head);
        foreach (var path in selected)
        {
            var file = RequireChangedFile(status, path);
            if (!file.CanDiscard || !IsRegularSourcePath(status.ScopePath, path))
                throw SourceError("source_discard_unsupported", "Selected paths must be regular files under 4 MiB, without conflicts or symbolic links.");
            var tree = await WorktreeGitAsync(status.ScopePath, ["ls-tree", status.Head, "--", path], cancellationToken);
            var index = await WorktreeGitAsync(status.ScopePath, ["ls-files", "--stage", "--", path], cancellationToken);
            // A removed symlink or gitlink may have no current filesystem entry; check Git modes too.
            foreach (var line in (tree.StandardOutput + "\n" + index.StandardOutput).Split('\n', StringSplitOptions.RemoveEmptyEntries))
                if (!line.StartsWith("100644 ", StringComparison.Ordinal) && !line.StartsWith("100755 ", StringComparison.Ordinal))
                    throw SourceError("source_discard_unsupported", "Symlinks and submodules require an explicit Git workflow outside this file discard.");
            Add(path); Add(file.Status); Add(index.StandardOutput);
            var fullPath = Path.Combine(status.ScopePath, path);
            if (File.Exists(fullPath))
            {
                await RequireRegularFileAsync(fullPath, cancellationToken);
                Add(OperatingSystem.IsWindows() ? File.GetAttributes(fullPath).ToString() : File.GetUnixFileMode(fullPath).ToString());
                await using var stream = File.OpenRead(fullPath);
                if (stream.Length > MaxDiscardFileBytes) throw SourceError("source_discard_unsupported", "The selected file is too large for this review.");
                Add(Convert.ToHexString(await SHA256.HashDataAsync(stream, cancellationToken)));
            }
            else Add("missing");
        }
        return Convert.ToHexString(hash.GetHashAndReset());
    }

    private static string[] ValidateSelection(string[]? paths)
    {
        if (paths is null || paths.Length is 0 or > 32 || paths.Any(path => !SafeRelativePath(path)) || paths.Distinct(StringComparer.Ordinal).Count() != paths.Length)
            throw SourceError("source_paths_invalid", "Select between 1 and 32 distinct source files.");
        return paths.Order(StringComparer.Ordinal).ToArray();
    }

    private static AppSourceFile RequireChangedFile(AppSourceStatus status, string path)
        => status.Files.FirstOrDefault(file => string.Equals(file.Path, path, StringComparison.Ordinal))
            ?? throw SourceError("source_file_not_changed", "The selected file is not in the current scoped change list. Refresh source status.");

    private static string? ResolveInspectionScope(AppRecord app)
    {
        var source = app.SourceState;
        var root = source?.LocalOverridePath ?? source?.ManagedCheckoutPath;
        if (string.IsNullOrWhiteSpace(root)) return null;
        root = MountPathPolicy.ResolveRealPath(root);
        if (source?.InspectionPaths is { Count: > 0 } inspectionPaths)
        {
            foreach (var path in inspectionPaths)
            {
                if (!DockerSourceRuntime.SafeRelative(path) || path == "." || CoreDataPaths.ContainsSymbolicLink(root, Path.GetFullPath(Path.Combine(root, path))))
                    throw SourceError("source_scope_invalid", "Source inspection paths must stay within the registered checkout.");
            }
            return root;
        }
        var scope = string.IsNullOrEmpty(source?.ManifestSubpath) ? root : Path.GetFullPath(Path.Combine(root, source.ManifestSubpath));
        if (scope != root && (!IsWithinScope(root, scope) || CoreDataPaths.ContainsSymbolicLink(root, scope)))
            throw SourceError("source_scope_invalid", "The source manifest directory must remain within the registered source root.");
        return scope;
    }

    private static bool HasGitAncestor(string path)
    {
        for (var current = new DirectoryInfo(path); current is not null; current = current.Parent)
            if (Directory.Exists(Path.Combine(current.FullName, ".git")) || File.Exists(Path.Combine(current.FullName, ".git"))) return true;
        return false;
    }

    private static bool SafeRelativePath(string? path)
        => !string.IsNullOrEmpty(path) && !Path.IsPathRooted(path) && !path.Contains('\\') && !path.Contains('\0')
            && path.Split('/').All(part => part.Length > 0 && part != "." && part != ".." && !part.Equals(".git", StringComparison.OrdinalIgnoreCase));

    private static bool IsWithinScope(string root, string path)
        => Path.GetRelativePath(root, path) is var relative && relative != ".." && !relative.StartsWith(".." + Path.DirectorySeparatorChar, StringComparison.Ordinal) && !Path.IsPathRooted(relative);

    private static bool IsRegularSourcePath(string scope, string path)
    {
        if (!SafeRelativePath(path)) return false;
        var full = Path.GetFullPath(Path.Combine(scope, path));
        return IsWithinScope(scope, full) && !Directory.Exists(full) && !CoreDataPaths.ContainsSymbolicLink(scope, full);
    }

    private static AppLifecycleException SourceError(string code, string message) => new(code, message);

    private static async Task RequireRegularFileAsync(string path, CancellationToken cancellationToken)
    {
        if (!File.Exists(path)) return; // A deleted tracked file can still be restored.
        if (OperatingSystem.IsWindows())
        {
            if ((File.GetAttributes(path) & FileAttributes.Device) == 0) return;
        }
        else
        {
            // File.Exists also accepts Unix FIFOs. Check the type without opening the file: opening
            // a FIFO to fingerprint/preview it can block indefinitely waiting for another process.
            var start = new System.Diagnostics.ProcessStartInfo("/bin/test");
            start.ArgumentList.Add("-f");
            start.ArgumentList.Add(path);
            var result = await ProcessRunner.RunAsync(start, TimeSpan.FromSeconds(5), cancellationToken, outputLimit: 256);
            if (!result.TimedOut && result.ExitCode == 0) return;
        }
        throw SourceError("source_file_unsupported", "Only regular source files can be previewed or discarded; special files require an external workflow.");
    }

    private static async Task<ProcessRunResult> WorktreeGitAsync(string scope, IReadOnlyList<string> args, CancellationToken cancellationToken,
        bool allowFailure = false, int limit = MaxGitOutput, Encoding? outputEncoding = null, string? indexPath = null)
    {
        var start = CreateGitStartInfo(scope, ["--literal-pathspecs", "-c", "core.fsmonitor=false", "-c", "core.quotePath=false", .. args]);
        if (outputEncoding is not null) start.StandardOutputEncoding = outputEncoding;
        foreach (var key in new[] { "GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_CONFIG_PARAMETERS", "GIT_CONFIG_COUNT" })
            start.Environment.Remove(key);
        // Only internal callers supply an isolated index; inherited overrides remain stripped.
        if (indexPath is not null) start.Environment["GIT_INDEX_FILE"] = indexPath;
        start.Environment["GIT_OPTIONAL_LOCKS"] = "0";
        start.Environment["GIT_NO_REPLACE_OBJECTS"] = "1";
        ProcessRunResult result;
        try { result = await ProcessRunner.RunAsync(start, TimeSpan.FromSeconds(10), cancellationToken, outputLimit: limit); }
        catch (System.ComponentModel.Win32Exception) { throw SourceError("source_git_unavailable", "Git is unavailable."); }
        if (result.TimedOut) throw SourceError("source_git_timeout", "Git source operation timed out. Refresh status before retrying.");
        if (result.ExitCode != 0 && !allowFailure) throw SourceError("source_git_failed", "Git source operation failed. Refresh source status and inspect the repository.");
        return result;
    }

    private sealed record DiscardReview(AppSourceDiscardPlan Plan, string Fingerprint);
}

internal sealed record AppSourceLineStats(long Additions, long Deletions);
internal sealed record AppSourceFile(string Path, string Status, bool NewFile, bool CanDiscard,
    AppSourceLineStats? LineStats = null, bool Binary = false);
internal sealed record AppSourceStatus(string AppId, string State, string? ScopePath, string? Branch, string? Head,
    IReadOnlyList<AppSourceFile> Files, bool Truncated, DateTimeOffset ObservedAt, string? Error = null, AppSourceLineStats? LineStats = null)
{
    public int FileCount => Files.Count;
}
internal sealed record AppSourceDiffRequest(string Path);
internal sealed record AppSourceDiff(string Path, string Combined, string Staged, bool Truncated, string? Head, bool NewFile,
    bool Binary = false, AppSourceImagePreview? Image = null);
internal sealed record AppSourceDiscardRequest(string[] Paths);
internal sealed record AppSourceDiscardPlan(string AppId, string ReviewId, string Head, string ScopePath, IReadOnlyList<AppSourceFile> Files, DateTimeOffset ExpiresAt);
internal sealed record AppSourceDiscardApplyRequest(string ReviewId);
