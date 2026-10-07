using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;

namespace Haas.Hosty.Core;

// Every method re-resolves current installation and personal grants before touching the shared
// object store. Possessing a commit or blob ID is never authority to read another workspace.
internal sealed partial class SourceDocumentService(AppRegistryStore apps,
    DevelopmentWorkspaceService workspaces, PrivateSourceService? privateSources = null)
{
    internal const int FileLimit = 1024 * 1024;
    internal const int DocumentLimit = 10000;
    internal const long MetadataLimit = 64 * 1024 * 1024;
    private sealed record Binding(SourceRepository Entry, AppRecord[] Apps, DevelopmentWorkspace[] Workspaces);
    private sealed record TreeFile(string Path, string Sha, long Size, string Mode);
    private static AppLifecycleException Error(string code, string message) => new("source_document_" + code, message);
    internal static string EntryId(string repository, string branch) => DevelopmentWorkspaceService.Hash(repository + "\n" + branch);
    private string RepositoryEntryId(string repository, string branch) => EntryId(workspaces.LogicalRepositoryIdentity(repository), branch);
    private static string Ref(string branch) => "refs/hosty/targets/" + DevelopmentWorkspaceService.Hash(branch);

    public async Task<SourceRepositoryList> ListRepositoriesAsync(string userId, CancellationToken ct)
    {
        var bindings = await DiscoverAsync(ct);
        var result = new List<SourceRepository>();
        foreach (var binding in bindings)
        {
            try
            {
                await GrantAsync(binding, userId, ct);
                var entry = binding.Entry;
                var commit = await CurrentTargetAsync(entry, ct);
                result.Add(entry with { Commit = commit, FetchedAt = workspaces.Fetches.LastFetched(entry.Repository, entry.Branch) });
            }
            catch (AppLifecycleException ex) { result.Add(binding.Entry with { State = "unavailable", Error = ex.Message }); }
        }
        return new(result.ToArray());
    }

    private async Task<Binding[]> DiscoverAsync(CancellationToken ct)
    {
        var installed = await apps.ListAppRecordsAsync(ct);
        var existing = (await workspaces.ListAsync(null, false, ct)).Workspaces;
        var found = new Dictionary<string, Binding>(StringComparer.Ordinal);
        foreach (var app in installed)
        {
            if (app.SourceState?.Repository is not { Length: > 0 } repository) continue;
            string? branch = null;
            try
            {
                RuntimeAppManifest? manifest = app.ManifestPath is null ? null : await JsonStorage.ReadAsync<RuntimeAppManifest>(app.ManifestPath, ct);
                branch = manifest?.Source?.Branch;
                if (app.PrivateSources?.Git is { } git)
                {
                    if ((privateSources ?? throw PrivateSourceService.Denied()).NormalizeRepository(repository) != git.Repository)
                        throw Error("forbidden", "The installed app's Git source changed since its source connection was reviewed.");
                }
                repository = await workspaces.CanonicalRepositoryAsync(repository, app.SourceState.LocalOverridePath, ct);
                if (string.IsNullOrWhiteSpace(branch)) branch = workspaces.Fetches.DefaultBranch(repository) ?? await KnownDefaultAsync(app, repository, ct);
                branch ??= ""; // Resolving a remote default happens only in this entry's read.
                var id = RepositoryEntryId(repository, branch);
                var projection = new SourceRepositoryApp(app.Id, app.DisplayName, app.SourceState.ManifestSubpath,
                    (manifest?.Source?.Paths ?? app.SourceState.InspectionPaths ?? []).ToArray());
                if (found.TryGetValue(id, out var prior))
                    found[id] = prior with { Entry = prior.Entry with { Apps = [.. prior.Entry.Apps, projection] }, Apps = [.. prior.Apps, app] };
                else found[id] = new(new(id, repository, branch, false, [projection], "available"), [app], []);
            }
            catch (Exception ex) when (ex is AppLifecycleException or IOException or System.Text.Json.JsonException)
            {
                var id = RepositoryEntryId(repository, branch ?? "");
                found.TryAdd(id, new(new(id, repository, branch ?? "", false,
                    [new(app.Id, app.DisplayName, app.SourceState.ManifestSubpath, [])], "unavailable", ex.Message), [app], []));
            }
        }
        foreach (var workspace in existing)
        {
            var id = RepositoryEntryId(workspace.Repository, workspace.TargetBranch);
            if (found.TryGetValue(id, out var prior)) found[id] = prior with { Workspaces = [.. prior.Workspaces, workspace] };
            else found[id] = new(new(id, workspace.Repository, workspace.TargetBranch, true, [], "available"), [], [workspace]);
        }
        foreach (var group in existing.GroupBy(w => workspaces.LogicalRepositoryIdentity(w.Repository), StringComparer.Ordinal))
        {
            if (group.Select(w => w.Repository).Distinct(StringComparer.Ordinal).Count() <= 1) continue;
            foreach (var binding in found.Values.Where(b => workspaces.LogicalRepositoryIdentity(b.Entry.Repository) == group.Key).ToArray())
                found[binding.Entry.Id] = binding with { Entry = binding.Entry with { State = "unavailable",
                    Error = "Unreleased workspaces use multiple repository aliases; reconcile their registered object stores before reading a shared baseline." } };
        }
        return found.Values.OrderBy(b => b.Entry.Repository, StringComparer.Ordinal).ThenBy(b => b.Entry.Branch, StringComparer.Ordinal).ToArray();
    }

    private async Task<string?> KnownDefaultAsync(AppRecord app, string repository, CancellationToken ct)
    {
        var shared = workspaces.RepositoryPath(repository);
        if (Directory.Exists(shared))
        {
            var remembered = await DevelopmentWorkspaceService.Git(shared, ["symbolic-ref", "--quiet", "refs/hosty/default-branch"], ct, true);
            if (remembered.ExitCode == 0 && remembered.StandardOutput.Trim() is { } value && value.StartsWith("refs/heads/", StringComparison.Ordinal))
            {
                var branch = value[11..];
                workspaces.Fetches.SetDefaultBranch(repository, branch);
                return branch;
            }
        }
        var root = app.SourceState?.LocalOverridePath ?? app.SourceState?.ManagedCheckoutPath;
        if (root is not null && Directory.Exists(root))
        {
            var remote = await DevelopmentWorkspaceService.Git(root, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"], ct, true);
            if (remote.ExitCode == 0 && remote.StandardOutput.Trim() is { } reference && reference.StartsWith("refs/remotes/origin/", StringComparison.Ordinal))
                return reference[20..];
        }
        if (System.IO.Path.IsPathFullyQualified(repository) && Directory.Exists(repository))
        {
            var head = await DevelopmentWorkspaceService.Git(repository, ["symbolic-ref", "--quiet", "HEAD"], ct, true);
            if (head.ExitCode == 0 && head.StandardOutput.Trim() is { } reference && reference.StartsWith("refs/heads/", StringComparison.Ordinal))
                return reference[11..];
        }
        return null;
    }

    private async Task<Binding> RequireBindingAsync(string id, CancellationToken ct)
        => (await DiscoverAsync(ct)).FirstOrDefault(b => b.Entry.Id == id || b.Entry.Id != id &&
            b.Entry.Branch == workspaces.Fetches.DefaultBranch(b.Entry.Repository) && RepositoryEntryId(b.Entry.Repository, "") == id)
            ?? throw Error("not_found", "Source repository entry is no longer available.");

    private async Task<SourceReadGrant?> GrantAsync(Binding binding, string userId, CancellationToken ct)
    {
        var isPrivate = binding.Apps.Any(a => a.PrivateSources?.Git is not null);
        foreach (var workspace in binding.Workspaces.Where(w => w.SourceGrant is not null))
        {
            try { isPrivate |= await workspaces.WorkspaceGrantAsync(workspace, ct) is not null; }
            catch (AppLifecycleException) { isPrivate = true; }
        }
        if (!isPrivate) return null;
        foreach (var app in binding.Apps)
        {
            if (app.PrivateSources?.Git is not { } grant || grant.OwnerId != userId
                || grant.Repository != workspaces.LogicalRepositoryIdentity(binding.Entry.Repository)) continue;
            try { await (privateSources ?? throw PrivateSourceService.Denied()).ValidateAsync(new(Git: grant), ct); return grant; }
            catch (AppLifecycleException) { }
        }
        foreach (var workspace in binding.Workspaces)
        {
            if (workspace.Owner.UserId != userId || workspace.SourceGrant is null) continue;
            try
            {
                var grant = await workspaces.WorkspaceGrantAsync(workspace, ct);
                if (grant is null || grant.OwnerId != userId || grant.Repository != workspaces.LogicalRepositoryIdentity(binding.Entry.Repository)) continue;
                await (privateSources ?? throw PrivateSourceService.Denied()).ValidateAsync(new(Git: grant), ct); return grant;
            }
            catch (AppLifecycleException) { }
        }
        throw Error("forbidden", "This private repository needs an installed-app or effective workspace Git grant owned by the acting administrator.");
    }

    private async Task<DevelopmentWorkspace> RequireWorkspaceAsync(Binding binding, string? id, string userId, CancellationToken ct)
    {
        var workspace = binding.Workspaces.FirstOrDefault(w => w.Id == id)
            ?? throw Error("not_found", "Workspace does not belong to this repository entry.");
        if (binding.Entry.State != "available") throw Error("unavailable", binding.Entry.Error ?? "Repository is unavailable.");
        var grant = await GrantAsync(binding, userId, ct);
        if (grant is null && !workspaces.Fetches.HasPublicProof(binding.Entry.Repository, binding.Entry.Branch,
            await CurrentTargetAsync(binding.Entry, ct)))
            throw Error("unavailable", "List the tracked branch to verify public access before reading workspace documents.");
        if (grant is not null && workspace.Owner.UserId != userId)
            throw Error("forbidden", "Another administrator's private workspace is not available through this grant.");
        if (workspace.SourceGrant is not null)
        {
            var effective = await workspaces.WorkspaceGrantAsync(workspace, ct);
            if (effective is null || effective.OwnerId != userId || effective.Repository != workspaces.LogicalRepositoryIdentity(workspace.Repository))
                throw Error("forbidden", "This workspace's reviewed Git grant is no longer available to the acting administrator.");
            await (privateSources ?? throw PrivateSourceService.Denied()).ValidateAsync(new(Git: effective), ct);
        }
        if (workspace.State != "active") throw Error("unavailable", "Workspace is " + workspace.State + "; its document changes are unknown.");
        await workspaces.ValidateTree(workspace, ct);
        return workspace;
    }

    private async Task<Binding> EnsureTargetAsync(Binding binding, string userId, bool refresh, CancellationToken ct)
    {
        var grant = await GrantAsync(binding, userId, ct);
        if (binding.Entry.State == "unavailable") throw Error("unavailable", binding.Entry.Error ?? "Repository is unavailable.");
        var repository = binding.Entry.Repository;
        var path = workspaces.RepositoryPath(repository);
        Directory.CreateDirectory(System.IO.Path.GetDirectoryName(path)!);
        await workspaces.Fetches.EnsureRepositoryAsync(path, async () =>
        {
            await DevelopmentWorkspaceService.Git(System.IO.Path.GetDirectoryName(path)!,
                await DevelopmentWorkspaceService.RepositoryInitArgumentsAsync(repository, path, ct), ct);
        }, ct);
        if (binding.Entry.Branch.Length == 0)
        {
            if (grant is null) await PrivateSourceService.ValidateGitConfigAsync(path, repository, ct);
            using var deadline = CancellationTokenSource.CreateLinkedTokenSource(ct);
            deadline.CancelAfter(SourceRepositoryFetchCoordinator.Timeout);
            var output = grant is null
                ? (await DevelopmentWorkspaceService.Git(path, ["ls-remote", "--symref", repository, "HEAD"], deadline.Token)).StandardOutput
                : await (privateSources ?? throw PrivateSourceService.Denied()).GitAsync(grant, repository, path, ["ls-remote", "--symref", repository, "HEAD"], deadline.Token);
            var line = output.Split('\n').FirstOrDefault(l => l.StartsWith("ref: refs/heads/", StringComparison.Ordinal));
            var branch = line?.Split('\t')[0][16..];
            if (string.IsNullOrWhiteSpace(branch)) throw Error("unavailable", "The repository default branch is unavailable.");
            await workspaces.SetDefaultBranchAsync(repository, branch, ct);
            binding = binding with { Entry = binding.Entry with { Branch = branch, Id = RepositoryEntryId(repository, branch) } };
        }
        await DevelopmentWorkspaceService.Git(path, ["check-ref-format", "refs/heads/" + binding.Entry.Branch], ct);
        // Workspace-derived entries use their existing target; a normal listing need not fetch an
        // orphan's remote again. Explicit refresh remains available with its effective grant.
        var current = await CurrentTargetAsync(binding.Entry, ct);
        if (!binding.Entry.WorkspaceDerived || refresh || current is null || grant is null)
            await workspaces.Fetch(path, repository, binding.Entry.Branch, ct, grant, refresh);
        current = await CurrentTargetAsync(binding.Entry, ct);
        if (grant is null && !workspaces.Fetches.HasPublicProof(repository, binding.Entry.Branch, current))
        {
            await workspaces.Fetch(path, repository, binding.Entry.Branch, ct, refresh: true);
            if (!workspaces.Fetches.HasPublicProof(repository, binding.Entry.Branch, await CurrentTargetAsync(binding.Entry, ct)))
                throw Error("forbidden", "Cached repository bytes are unavailable until anonymous access to the tracked branch succeeds.");
        }
        return binding;
    }

    private async Task<string?> CurrentTargetAsync(SourceRepository entry, CancellationToken ct)
    {
        var path = workspaces.RepositoryPath(entry.Repository);
        if (entry.Branch.Length == 0 || !Directory.Exists(path)) return null;
        var result = await DevelopmentWorkspaceService.Git(path, ["rev-parse", "--verify", Ref(entry.Branch)], ct, true);
        return result.ExitCode == 0 ? result.StandardOutput.Trim() : null;
    }

    public async Task<SourceDocumentList> ListDocumentsAsync(string repositoryId, string userId, bool refresh, CancellationToken ct,
        string version = "target", string? workspaceId = null, string? documentPath = null)
    {
        if (documentPath is not null) RequirePath(documentPath);
        var binding = await RequireBindingAsync(repositoryId, ct);
        var grant = await GrantAsync(binding, userId, ct);
        if (version == "target")
        {
            binding = await EnsureTargetAsync(binding, userId, refresh, ct);
            var commit = await CurrentTargetAsync(binding.Entry, ct) ?? throw Error("unavailable", "Tracked branch has no fetched commit.");
            var docs = await ImmutableDocumentsAsync(workspaces.RepositoryPath(binding.Entry.Repository), commit, ct, documentPath);
            return new(binding.Entry.Id, version, null, commit, CopyDocuments(docs));
        }
        if (grant is null) binding = await EnsureTargetAsync(binding, userId, refresh, ct);
        var workspace = await RequireWorkspaceAsync(binding, workspaceId, userId, ct);
        var target = await CurrentTargetAsync(binding.Entry, ct) ?? throw Error("unavailable", "Tracked branch has no fetched commit.");
        var baseCommit = await MergeBaseAsync(workspace, target, ct);
        if (version == "base") return new(repositoryId, version, workspace.Id, baseCommit,
            CopyDocuments(await ImmutableDocumentsAsync(workspaces.RepositoryPath(workspace.Repository), baseCommit, ct, documentPath)));
        if (version == "worktree") return new(repositoryId, version, workspace.Id, null, await ListWorktreeAsync(workspace, ct, documentPath: documentPath));
        throw Error("invalid", "Choose target, base or worktree document version.");
    }

    public async Task<SourceDocumentContent> ReadContentAsync(string repositoryId, string userId, SourceDocumentRead input, CancellationToken ct)
    {
        RequirePath(input.Path);
        var binding = await RequireBindingAsync(repositoryId, ct);
        if (binding.Entry.State != "available") throw Error("unavailable", binding.Entry.Error ?? "Repository is unavailable.");
        // Workspace versions stay readable through their current private grant even when the
        // remote is unavailable. Public access still requires anonymous proof before local reads.
        if (input.Version == "target" || await GrantAsync(binding, userId, ct) is null)
            binding = await EnsureTargetAsync(binding, userId, false, ct);
        var root = workspaces.RepositoryPath(binding.Entry.Repository);
        string? commit;
        byte[] bytes;
        if (input.Version == "worktree")
        {
            var workspace = await RequireWorkspaceAsync(binding, input.WorkspaceId, userId, ct);
            if (string.IsNullOrWhiteSpace(input.ExpectedSha)) throw Error("invalid", "A worktree read requires its listed expectedSha.");
            bytes = await ReadWorktreeBytesAsync(workspace, input.Path, ct);
            var sha = await BlobShaAsync(root, bytes, ct);
            if (sha != input.ExpectedSha) throw Error("conflict", "Worktree document changed; list its current version again.");
            return new(input.Path, sha, Text(bytes), null, input.Version, workspace.Id,
                await ReferencesAsync(Text(bytes), input.Path, null, workspace, ct));
        }
        if (string.IsNullOrWhiteSpace(input.Commit)) throw Error("invalid", "A target or base read requires its listed commit.");
        if (input.Version == "target") commit = await CurrentTargetAsync(binding.Entry, ct);
        else if (input.Version == "base")
        {
            var workspace = await RequireWorkspaceAsync(binding, input.WorkspaceId, userId, ct);
            var target = await CurrentTargetAsync(binding.Entry, ct) ?? throw Error("unavailable", "Tracked branch has no fetched commit.");
            commit = await MergeBaseAsync(workspace, target, ct);
        }
        else throw Error("invalid", "Choose target, base or worktree document version.");
        if (commit is null || commit != input.Commit) throw Error("conflict", "Listed commit changed or does not belong to this document version.");
        var tree = await TreeSnapshotAsync(root, commit, ct);
        var file = tree.Metadata.GetValueOrDefault(input.Path) ?? throw Error("not_found", "Document does not exist in this version.");
        RequireTreeFile(file);
        bytes = await SnapshotBlobAsync(root, file, ct);
        var actualSha = BlobSha(bytes, file.Sha.Length == 64 ? "sha256" : "sha1");
        if (actualSha != file.Sha || input.ExpectedSha is not null && input.ExpectedSha != actualSha)
            throw Error("conflict", "Document bytes no longer match the listed version.");
        var references = snapshots.TryGet<SourceDocument[]>(DocumentsKey(root, commit), out var listing)
            ? listing.FirstOrDefault(document => document.Path == input.Path)?.ReferencePaths : null;
        references ??= await ReferencesAsync(Text(bytes), input.Path, (root, commit), null, ct, tree.Metadata);
        // Ref/base may move while the blob is read; never return a successful obsolete read.
        var current = input.Version == "target" ? await CurrentTargetAsync(binding.Entry, ct)
            : await MergeBaseAsync(await RequireWorkspaceAsync(binding, input.WorkspaceId, userId, ct),
                await CurrentTargetAsync(binding.Entry, ct) ?? "", ct);
        if (current != commit) throw Error("conflict", "Listed commit changed while reading the document.");
        return new(input.Path, actualSha, Text(bytes), commit, input.Version, input.WorkspaceId, references.ToArray());
    }

    private static async Task<string> MergeBaseAsync(DevelopmentWorkspace workspace, string target, CancellationToken ct)
        => (await DevelopmentWorkspaceService.Git(workspace.Path, ["merge-base", "HEAD", target], ct)).StandardOutput.Trim();

    internal static void RequirePath(string path)
    {
        if (string.IsNullOrWhiteSpace(path) || path.Length > 2048 || !path.StartsWith("docs/", StringComparison.Ordinal)
            || !path.EndsWith(".md", StringComparison.Ordinal) || path.Contains('\\') || path.Any(char.IsControl)
            || path.Split('/').Any(p => p is "" or "." or ".."))
            throw Error("path_invalid", "Only repository-relative docs/**/*.md paths are available.");
    }

    private static bool IsDocumentPath(string path)
    {
        try { RequirePath(path); return true; } catch (AppLifecycleException) { return false; }
    }
    private static void RequireTreeFile(TreeFile file)
    {
        if (file.Mode is not ("100644" or "100755")) throw Error("path_invalid", "Symbolic links and non-regular documents are refused.");
        if (file.Size > FileLimit) throw Error("size_limit", "Document exceeds the one MiB size limit.");
    }

    private static TreeFile[] ParseTree(string text)
        => text.Split('\0', StringSplitOptions.RemoveEmptyEntries).Select(line =>
        {
            var tab = line.IndexOf('\t');
            var header = line[..tab].Split(' ', StringSplitOptions.RemoveEmptyEntries);
            return new TreeFile(line[(tab + 1)..], header[2], long.TryParse(header.ElementAtOrDefault(3), out var size) ? size : 0, header[0]);
        }).ToArray();

    private static async Task<TreeFile?> TreeFileAsync(string root, string commit, string path, CancellationToken ct)
        => ParseTree((await DevelopmentWorkspaceService.Git(root, ["ls-tree", "-l", "-z", commit, "--", path], ct)).StandardOutput)
            .FirstOrDefault(f => f.Path == path);

    private async Task<SourceDocument[]> ListWorktreeAsync(DevelopmentWorkspace workspace, CancellationToken ct, bool references = true, string? documentPath = null)
    {
        var docs = new List<SourceDocument>();
        var budget = new SnapshotMetadataBudget();
        var format = (await DevelopmentWorkspaceService.Git(workspaces.RepositoryPath(workspace.Repository), ["rev-parse", "--show-object-format"], ct)).StandardOutput.Trim();
        foreach (var path in documentPath is null ? WorktreePaths(workspace.Path, ct) : FocusedWorktreePaths(workspace.Path, documentPath, ct))
        {
            ct.ThrowIfCancellationRequested();
            if (docs.Count >= DocumentLimit) throw Error("size_limit", "Workspace contains too many documents.");
            budget.AddDocument(path, format == "sha256" ? 64 : 40);
            var bytes = await ReadWorktreeBytesAsync(workspace, path, ct);
            docs.Add(new(path, BlobSha(bytes, format), bytes.Length,
                File.GetLastWriteTimeUtc(System.IO.Path.Combine(workspace.Path, path)),
                references ? await ReferencesAsync(Text(bytes), path, null, workspace, ct, budget: budget) : null));
        }
        return docs.ToArray();
    }

    private static string[] FocusedWorktreePaths(string root, string path, CancellationToken ct)
    {
        var cursor = root;
        FileAttributes attributes = default;
        foreach (var segment in path.Split('/'))
        {
            ct.ThrowIfCancellationRequested();
            cursor = System.IO.Path.Combine(cursor, segment);
            try { attributes = File.GetAttributes(cursor); }
            catch (Exception ex) when (ex is FileNotFoundException or DirectoryNotFoundException) { return []; }
            if ((attributes & FileAttributes.ReparsePoint) != 0) throw Error("path_invalid", "Symbolic links are refused in document paths.");
        }
        return (attributes & FileAttributes.Directory) == 0 ? [path] : [];
    }

    private static IEnumerable<string> WorktreePaths(string root, CancellationToken ct)
    {
        var docs = System.IO.Path.Combine(root, "docs");
        if (!Directory.Exists(docs) || IsLink(docs)) yield break;
        var pending = new Stack<string>(); pending.Push(docs);
        while (pending.TryPop(out var directory))
        {
            ct.ThrowIfCancellationRequested();
            foreach (var file in Directory.EnumerateFiles(directory))
            {
                ct.ThrowIfCancellationRequested();
                var path = System.IO.Path.GetRelativePath(root, file).Replace(System.IO.Path.DirectorySeparatorChar, '/');
                if (IsDocumentPath(path) && !IsLink(file)) yield return path;
            }
            foreach (var child in Directory.EnumerateDirectories(directory)) { ct.ThrowIfCancellationRequested(); if (!IsLink(child)) pending.Push(child); }
        }
    }
    private static bool IsLink(string path) => (File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0;
    private static async Task<byte[]> ReadWorktreeBytesAsync(DevelopmentWorkspace workspace, string path, CancellationToken ct)
    {
        RequirePath(path);
        var file = System.IO.Path.Combine(workspace.Path, path);
        ValidateWorktreePath(workspace, path, ct);
        await AppSourceService.RequireRegularFileAsync(file, ct);
        var before = new FileInfo(file);
        var length = before.Length;
        var modified = before.LastWriteTimeUtc;
        await using var stream = new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete, 16384, true);
        if (stream.Length > FileLimit) throw Error("size_limit", "Document exceeds the one MiB size limit.");
        using var bytes = new MemoryStream();
        var buffer = new byte[16384]; int count;
        while ((count = await stream.ReadAsync(buffer, ct)) != 0)
        {
            if (bytes.Length + count > FileLimit) throw Error("size_limit", "Document exceeds the one MiB size limit.");
            bytes.Write(buffer, 0, count);
        }
        // Agent edits and cleanup can race a read. Check the path again after the handle read so
        // a newly introduced link or replaced/deleted file cannot pass only the initial guard.
        ValidateWorktreePath(workspace, path, ct);
        var after = new FileInfo(file);
        if (after.Length != length || after.LastWriteTimeUtc != modified)
            throw Error("conflict", "Worktree document changed while it was read.");
        return bytes.ToArray();
    }
    private static void ValidateWorktreePath(DevelopmentWorkspace workspace, string path, CancellationToken ct)
    {
        var file = System.IO.Path.Combine(workspace.Path, path);
        var cursor = workspace.Path;
        foreach (var segment in path.Split('/'))
        {
            ct.ThrowIfCancellationRequested();
            cursor = System.IO.Path.Combine(cursor, segment);
            if (!File.Exists(cursor) && !Directory.Exists(cursor)) throw Error("not_found", "Worktree document does not exist.");
            if (IsLink(cursor)) throw Error("path_invalid", "Symbolic links are refused in document paths.");
        }
        if (MountPathPolicy.ResolveRealPath(file) != System.IO.Path.GetFullPath(file)) throw Error("path_invalid", "Document escaped its worktree.");
    }

    private static string Text(byte[] bytes)
    {
        try { return new UTF8Encoding(false, true).GetString(bytes); }
        catch (DecoderFallbackException) { throw Error("invalid", "Document is not valid UTF-8 Markdown."); }
    }
    private static async Task<string> BlobShaAsync(string root, byte[] bytes, CancellationToken ct)
    {
        var format = (await DevelopmentWorkspaceService.Git(root, ["rev-parse", "--show-object-format"], ct)).StandardOutput.Trim();
        return BlobSha(bytes, format);
    }
    internal static string BlobSha(byte[] bytes, string format)
    {
        using var hash = IncrementalHash.CreateHash(format == "sha256" ? HashAlgorithmName.SHA256 : HashAlgorithmName.SHA1);
        hash.AppendData(Encoding.ASCII.GetBytes("blob " + bytes.Length.ToString(System.Globalization.CultureInfo.InvariantCulture) + "\0"));
        hash.AppendData(bytes);
        return Convert.ToHexStringLower(hash.GetHashAndReset());
    }

    [GeneratedRegex(@"(?m)^components:\s*([^\r\n]*)$|\]\(\s*<?([^\s)>]+)>?(?:\s+[^)]*)?\)|^\s*\[[^\]]+\]:\s*<?([^\s>]+)>?", RegexOptions.CultureInvariant)]
    private static partial Regex ReferencePattern();
    [GeneratedRegex(@"(`+)[^`]*?\1", RegexOptions.CultureInvariant)]
    private static partial Regex InlineCodePattern();
    private async Task<SourceDocumentReference[]> ReferencesAsync(string content, string document,
        (string Root, string Commit)? tree, DevelopmentWorkspace? workspace, CancellationToken ct,
        IReadOnlyDictionary<string, TreeFile>? metadata = null, SnapshotMetadataBudget? budget = null)
    {
        var references = new HashSet<string>(StringComparer.Ordinal);
        var prose = new StringBuilder();
        char fence = '\0'; int fenceLength = 0;
        foreach (var line in content.Split('\n'))
        {
            ct.ThrowIfCancellationRequested();
            var trim = line.TrimStart();
            var marker = trim.Length != 0 && trim[0] is '`' or '~' ? trim.TakeWhile(c => c == trim[0]).ToArray() : [];
            if (marker.Length >= 3)
            {
                if (fence == '\0') { fence = marker[0]; fenceLength = marker.Length; }
                else if (fence == marker[0] && marker.Length >= fenceLength && string.IsNullOrWhiteSpace(trim[marker.Length..])) fence = '\0';
                continue;
            }
            if (fence == '\0') prose.AppendLine(InlineCodePattern().Replace(line, ""));
        }
        foreach (Match match in ReferencePattern().Matches(prose.ToString()))
        {
            ct.ThrowIfCancellationRequested();
            foreach (var raw in match.Groups[1].Success ? match.Groups[1].Value.Trim().Trim('[', ']').Split(',')
                : new[] { match.Groups[2].Success ? match.Groups[2].Value : match.Groups[3].Value })
            {
                ct.ThrowIfCancellationRequested();
                var target = raw.Trim().Trim('"', '\'');
                if (target.Length == 0 || target.StartsWith('#') || target.Contains('\\') || target.Any(char.IsControl)
                    || target.StartsWith('/') || Uri.TryCreate(target, UriKind.Absolute, out _)) continue;
                target = target.Split('#')[0].Split('?')[0];
                try { target = Uri.UnescapeDataString(target); } catch (UriFormatException) { }
                if (target.Length == 0 || target.StartsWith('/') || target.Contains('\\') || target.Any(char.IsControl)) continue;
                var normalized = NormalizeReference(match.Groups[1].Success ? "" : document[..(document.LastIndexOf('/') + 1)], target);
                if (normalized is null || normalized.Length > 2048) continue;
                if (references.Add(normalized)) budget?.AddReference(normalized);
                if (references.Count > 512) throw Error("reference_limit", "Document exceeds its 512 referenced-path metadata limit.");
            }
        }
        var result = new List<SourceDocumentReference>();
        foreach (var path in references.Order(StringComparer.Ordinal))
        {
            ct.ThrowIfCancellationRequested();
            if (tree is { } version)
            {
                var file = metadata is null ? await TreeFileAsync(version.Root, version.Commit, path, ct) : metadata.GetValueOrDefault(path);
                result.Add(new(path, file is not null, file?.Mode == "040000"));
            }
            else
            {
                var local = System.IO.Path.Combine(workspace!.Path, path);
                var exists = File.Exists(local) || Directory.Exists(local);
                if (exists && (!DevelopmentWorkspaceService.IsUnder(workspace.Path, local) || IsLink(local))) exists = false;
                result.Add(new(path, exists, exists && Directory.Exists(local)));
            }
        }
        return result.ToArray();
    }
    private static string? NormalizeReference(string prefix, string target)
    {
        var segments = new List<string>();
        foreach (var segment in (prefix + target).Split('/'))
        {
            if (segment is "" or ".") continue;
            if (segment == "..") { if (segments.Count == 0) return null; segments.RemoveAt(segments.Count - 1); }
            else segments.Add(segment);
        }
        return segments.Count == 0 ? null : string.Join('/', segments);
    }

    public async Task<SourceWorkspaceList> ListWorkspacesAsync(string userId, string? repositoryId, CancellationToken ct)
    {
        var result = new List<SourceWorkspace>();
        foreach (var binding in await DiscoverAsync(ct))
        {
            if (repositoryId is not null && repositoryId != binding.Entry.Id) continue;
            foreach (var workspace in binding.Workspaces)
            {
                var (url, urlError) = await SessionUrlAsync(workspace, ct);
                string? baseCommit = null, target = null, error = null;
                SourceDocumentChange[]? changes = null;
                try
                {
                    await RequireWorkspaceAsync(binding, workspace.Id, userId, ct);
                    target = await CurrentTargetAsync(binding.Entry, ct) ?? throw Error("unavailable", "Tracked branch has no fetched commit.");
                    baseCommit = await MergeBaseAsync(workspace, target, ct);
                    changes = await ChangesAsync(workspace, baseCommit, target, ct);
                }
                catch (Exception ex) when (ex is AppLifecycleException or IOException or UnauthorizedAccessException) { error = ex.Message; }
                result.Add(new(workspace.Id, binding.Entry.Id, workspace.Repository, workspace.TargetBranch, workspace.Branch,
                    workspace.State, workspace.Owner.UserId, workspace.Owner.AppId, workspace.Owner.SessionId, url, urlError,
                    workspace.Observation?.At, workspace.Observation?.State, workspace.PullRequests, baseCommit, target, changes, error));
            }
        }
        return new(result.ToArray());
    }

    private async Task<SourceDocumentChange[]> ChangesAsync(DevelopmentWorkspace workspace, string baseCommit, string target, CancellationToken ct)
    {
        var root = workspaces.RepositoryPath(workspace.Repository);
        var before = (await TreeSnapshotAsync(root, baseCommit, ct)).Files
            .Where(f => IsDocumentPath(f.Path) && f.Mode is "100644" or "100755").ToDictionary(f => f.Path, StringComparer.Ordinal);
        var currentTarget = (await TreeSnapshotAsync(root, target, ct)).Files
            .Where(f => IsDocumentPath(f.Path) && f.Mode is "100644" or "100755").ToDictionary(f => f.Path, StringComparer.Ordinal);
        var current = (await ListWorktreeAsync(workspace, ct, references: false)).ToDictionary(f => f.Path, StringComparer.Ordinal);
        var result = new List<SourceDocumentChange>();
        foreach (var path in before.Keys.Concat(current.Keys).Distinct().Order(StringComparer.Ordinal))
        {
            before.TryGetValue(path, out var old); current.TryGetValue(path, out var local); currentTarget.TryGetValue(path, out var latest);
            if (old?.Sha == local?.Sha || latest?.Sha == local?.Sha) continue;
            result.Add(new(path, old is null ? "added" : local is null ? "deleted" : "modified", local?.ModifiedAt,
                latest?.Sha != old?.Sha, old?.Sha, local?.Sha, latest?.Sha));
        }
        return result.ToArray();
    }

    private async Task<(string? Url, string? Error)> SessionUrlAsync(DevelopmentWorkspace workspace, CancellationToken ct)
    {
        var assistant = await apps.GetAppAsync(workspace.Owner.AppId, ct);
        if (assistant is null || assistant.InstalledAt != workspace.Owner.Installation)
            return (null, "The owning assistant installation was removed or replaced.");
        var endpoint = assistant.Endpoints.FirstOrDefault(e => e.Key == assistant.Ui?.EndpointKey)
            ?? assistant.Endpoints.FirstOrDefault(e => e.Public && e.Protocol is "http" or "https");
        var origin = endpoint is null ? null : LocalBrowserOrigins.App(assistant, endpoint);
        if (origin is null || !Uri.TryCreate(origin, UriKind.Absolute, out var baseUrl) || baseUrl.Scheme is not ("http" or "https")
            || !string.IsNullOrEmpty(baseUrl.UserInfo)) return (null, "The assistant browser origin is unavailable.");
        var path = workspace.SessionPath;
        if (!path.StartsWith('/') || path.StartsWith("//") || path.Contains('\\') || path.Any(char.IsControl)
            || !Uri.TryCreate(baseUrl, path, out var url) || url.Scheme != baseUrl.Scheme || url.Host != baseUrl.Host
            || url.Port != baseUrl.Port || !string.IsNullOrEmpty(url.UserInfo)) return (null, "Session path does not stay on the assistant's browser origin.");
        return (url.AbsoluteUri, null);
    }
}
