using System.Diagnostics;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace Haas.Hosty.Core;

// Core owns these repositories independently of app source/cache retention. Native agent access
// remains cooperative; every managed operation still validates ownership and actual Git state.
internal sealed class DevelopmentWorkspaceService(CoreDataPaths paths, AppRegistryStore apps, IClock clock,
    LocalCommandProcessRegistry? processes = null, ILogger<DevelopmentWorkspaceService>? logger = null,
    IDockerCommandRunner? docker = null, PrivateSourceService? privateSources = null)
{
    private readonly SemaphoreSlim gate = new(1, 1);
    private string Root => MountPathPolicy.ResolveRealPath(System.IO.Path.Combine(paths.CoreRoot, "development"));
    private string Records => System.IO.Path.Combine(Root, "workspaces");
    private string RepoPath(string id) => System.IO.Path.Combine(Root, "repositories", id + ".git");
    private string WorkPath(string id) => System.IO.Path.Combine(Root, "trees", id);
    private string RecordPath(string id) => System.IO.Path.Combine(Records, id + ".json");
    internal static AppLifecycleException Error(string code, string message) => new("workspace_" + code, message);
    internal static string Hash(string value) => Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(value)));

    private static void Id(string id)
    {
        if (id is null || id.Length != 64 || id.Any(c => !char.IsAsciiHexDigit(c))) throw Error("not_found", "Workspace not found.");
    }
    private static void RequestId(string id)
    {
        if (!Guid.TryParse(id, out _)) throw Error("request_invalid", "A UUID requestId is required. Reuse it after an uncertain response.");
    }
    private Task Save(DevelopmentWorkspace value) => JsonStorage.WriteAsync(RecordPath(value.Id), value, restrictToOwner: true);
    private async Task<T> Locked<T>(Func<Task<T>> action, CancellationToken ct)
    {
        await gate.WaitAsync(ct);
        try { return await action(); } finally { gate.Release(); }
    }
    internal async Task<DevelopmentWorkspace> Read(string id, WorkspaceOwner? owner, CancellationToken ct)
    {
        Id(id);
        var w = await JsonStorage.ReadAsync<DevelopmentWorkspace>(RecordPath(id), ct) ?? throw Error("not_found", "Workspace not found.");
        if (owner is not null && w.Owner != owner) throw Error("forbidden", "This workspace belongs to another assistant installation, user or session.");
        if (w.Path != WorkPath(id) || w.RepositoryId != Hash(w.Repository) || w.Branch != "hosty/session/" + id)
            throw Error("ownership_invalid", "Workspace ownership metadata is inconsistent.");
        return w;
    }
    public Task<WorkspaceList> ListAsync(WorkspaceOwner? owner, bool includeReleased, CancellationToken ct)
        => Locked(async () =>
        {
            if (!Directory.Exists(Records)) return new WorkspaceList([]);
            var found = new List<DevelopmentWorkspace>();
            foreach (var file in Directory.EnumerateFiles(Records, "*.json"))
            {
                try
                {
                    var w = await Read(System.IO.Path.GetFileNameWithoutExtension(file), null, ct);
                    if ((owner is null || w.Owner == owner) && (includeReleased || w.State != "released")) found.Add(w);
                }
                catch (Exception ex) when (ex is JsonException or AppLifecycleException or IOException)
                {
                    // One damaged record must not stop observation of every other repository.
                    logger?.LogError(ex, "Cannot read workspace record {Record}", file);
                }
            }
            return new WorkspaceList(found.ToArray());
        }, ct);

    public Task<DevelopmentWorkspace> PrepareAsync(WorkspaceOwner owner, WorkspacePrepare input, CancellationToken ct)
        => Locked(async () =>
        {
            RequestId(input.RequestId);
            if (owner.SessionId != input.SessionId || string.IsNullOrWhiteSpace(input.SessionId) || input.SessionId.Length > 200)
                throw Error("session_invalid", "A bounded nonempty session ID is required.");
            if (string.IsNullOrWhiteSpace(input.AppId) || string.IsNullOrWhiteSpace(input.SessionPath) || input.SessionPath.Length > 2048 || !input.SessionPath.StartsWith('/') || input.SessionPath.StartsWith("//") || input.SessionPath.Contains('\\') || input.SessionPath.Any(char.IsControl))
                throw Error("session_path_invalid", "Session path must be relative to the assistant origin.");
            var app = await apps.GetAppAsync(input.AppId, ct) ?? throw Error("app_missing", "The source app is no longer installed.");
            var grant = app.PrivateSources?.Git;
            if (grant is not null && grant.OwnerId != owner.UserId)
                throw Error("source_forbidden", "This app's private source belongs to another user.");
            if (grant is not null) await (privateSources ?? throw PrivateSourceService.Denied()).ValidateAsync(new(Git: grant), ct);
            var source = app.SourceState ?? throw Error("source_missing", "This app has no source repository.");
            if (grant is not null && (source.Repository is null || PrivateSourceService.NormalizeRepository(source.Repository) != grant.Repository))
                throw PrivateSourceService.Denied("The Git source changed. Select and review its connection again.");
            var repository = grant?.Repository ?? await CanonicalRepository(source.Repository, source.LocalOverridePath, ct);
            var repositoryId = Hash(repository);
            var id = Hash(CoreJson.Text(owner) + "\n" + repositoryId);
            var existing = await JsonStorage.ReadAsync<DevelopmentWorkspace>(RecordPath(id), ct);
            if (existing is not null)
            {
                existing = await Read(id, owner, ct);
                if (existing.State is "released" or "releasing") throw Error("released", "This session's workspace has been released. Start a new session.");
                if (input.TargetBranch is not null && input.TargetBranch != existing.TargetBranch)
                    throw Error("base_conflict", "The existing workspace has a different target branch.");
                if (existing.Apps.Any(a => a.AppId == app.Id && a.Installation != app.InstalledAt))
                    throw Error("app_reinstalled", "This source app was reinstalled; start a new development session.");
                var prior = existing.Operations.FirstOrDefault(o => o.Id == input.RequestId);
                if (prior is not null && (prior.Kind != "prepare" || prior.Fingerprint != Hash(CoreJson.Text(input))))
                    throw Error("request_conflict", "This request ID was used with different preparation arguments.");
                existing = existing with { SourceGrant = existing.SourceGrant ?? grant };
                existing = await Materialize(existing, ct);
                if (prior is not null) { await Save(existing); return await Observe(existing, ct); }
                existing = Attach(existing, app, input.LeaseId);
                existing = existing with { Operations = [.. existing.Operations, new(input.RequestId, "prepare", Hash(CoreJson.Text(input)), "succeeded", ResultHead: existing.OriginalBase)] };
                await Save(existing);
                return await Observe(existing, ct);
            }
            var repo = RepoPath(repositoryId);
            Directory.CreateDirectory(System.IO.Path.GetDirectoryName(repo)!);
            if (!Directory.Exists(repo))
            {
                await Git(Root, ["init", "--bare", repo], ct);
            }
            var target = input.TargetBranch;
            if (string.IsNullOrWhiteSpace(target))
            {
                // A reviewed pin/tag is not the development branch. Only a declared branch is used.
                if (app.ManifestPath is { } manifestPath)
                    target = (await JsonStorage.ReadAsync<RuntimeAppManifest>(manifestPath, ct))?.Source?.Branch;
                if (string.IsNullOrWhiteSpace(target))
                {
                    var remote = grant is null ? (await Git(repo, ["ls-remote", "--symref", repository, "HEAD"], ct)).StandardOutput
                        : await (privateSources ?? throw PrivateSourceService.Denied()).GitAsync(grant, repository, repo, ["ls-remote", "--symref", repository, "HEAD"], ct);
                    target = remote.Split('\n').FirstOrDefault(l => l.StartsWith("ref: refs/heads/", StringComparison.Ordinal))?.Split('\t')[0][16..];
                }
            }
            if (string.IsNullOrWhiteSpace(target)) throw Error("branch_required", "The repository default branch is unavailable; select a development branch.");
            await Git(repo, ["check-ref-format", "refs/heads/" + target], ct);
            var baseHead = await Fetch(repo, repository, target, ct, grant);
            var w = new DevelopmentWorkspace { Id = id, Owner = owner, Repository = repository, RepositoryId = repositoryId,
                Path = WorkPath(id), Branch = "hosty/session/" + id, TargetBranch = target, OriginalBase = baseHead,
                IntegrationBase = baseHead, SessionPath = input.SessionPath, SourceGrant = grant,
                Operations = [new(input.RequestId, "prepare", Hash(CoreJson.Text(input)), "pending")] };
            w = Attach(w, app, input.LeaseId);
            await Save(w); // Allocation identity precedes Git side effects.
            w = await Materialize(w, ct);
            await Save(w);
            return await Observe(w, ct);
        }, ct);

    private static DevelopmentWorkspace Attach(DevelopmentWorkspace w, AppRecord app, string? lease)
    {
        if (lease is not null && (!Guid.TryParse(lease, out _))) throw Error("lease_invalid", "Lease ID must be a UUID.");
        var binding = new WorkspaceApp(app.Id, app.InstalledAt, app.SourceState?.ManifestSubpath);
        if (w.Apps.Any(a => a.AppId == app.Id && a.Installation != app.InstalledAt)) throw Error("app_reinstalled", "This source app was reinstalled; start a new development session.");
        return w with { Apps = [.. w.Apps.Where(a => a.AppId != app.Id), binding],
            Leases = lease is null ? w.Leases : w.Leases.Append(lease).Distinct().ToArray() };
    }
    private async Task<DevelopmentWorkspace> Materialize(DevelopmentWorkspace w, CancellationToken ct)
    {
        if (w.State != "preparing") { await ValidateTree(w, ct); return w; }
        Directory.CreateDirectory(System.IO.Path.GetDirectoryName(w.Path)!);
        if (!Directory.Exists(w.Path))
        {
            var branch = await Git(RepoPath(w.RepositoryId), ["show-ref", "--verify", "--quiet", "refs/heads/" + w.Branch], ct, true);
            await Git(RepoPath(w.RepositoryId), branch.ExitCode == 0
                ? ["worktree", "add", w.Path, w.Branch]
                : ["worktree", "add", "-b", w.Branch, w.Path, w.OriginalBase], ct);
        }
        await ValidateTree(w, ct);
        return w with { State = "active", Operations = w.Operations.Select(o => o.Kind == "prepare" ? o with { State = "succeeded", ResultHead = w.OriginalBase } : o).ToArray() };
    }
    private async Task ValidateTree(DevelopmentWorkspace w, CancellationToken ct)
    {
        if (!Directory.Exists(w.Path) || MountPathPolicy.ResolveRealPath(w.Path) != System.IO.Path.GetFullPath(w.Path))
            throw Error("unavailable", "The owned workspace is missing or was replaced with a link.");
        var common = (await Git(w.Path, ["rev-parse", "--path-format=absolute", "--git-common-dir"], ct)).StandardOutput.Trim();
        var branch = (await Git(w.Path, ["symbolic-ref", "HEAD"], ct)).StandardOutput.Trim();
        if (MountPathPolicy.ResolveRealPath(common) != MountPathPolicy.ResolveRealPath(RepoPath(w.RepositoryId)) || branch != "refs/heads/" + w.Branch)
            throw Error("ownership_invalid", "The worktree no longer uses its registered repository and branch.");
    }
    public Task<DevelopmentWorkspace> ObserveAsync(string id, WorkspaceOwner? owner, CancellationToken ct)
        => Locked(async () => await Observe(await Read(id, owner, ct), ct), ct);
    private async Task<DevelopmentWorkspace> Observe(DevelopmentWorkspace w, CancellationToken ct)
    {
        if (w.State == "released") return w;
        try
        {
            await ValidateTree(w, ct);
            var local = await AppSourceService.ReadScopeStatusAsync(w.Id, () => w.Path, null, clock.UtcNow, ct, true);
            if (local.Head is null || local.Truncated || local.State == "unavailable") throw Error("unavailable", "The full workspace status could not be read.");
            var target = (await Git(RepoPath(w.RepositoryId), ["rev-parse", "refs/hosty/targets/" + Hash(w.TargetBranch)], ct)).StandardOutput.Trim();
            var counts = (await Git(w.Path, ["rev-list", "--left-right", "--count", local.Head + "..." + target], ct)).StandardOutput.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries);
            var changed = await Git(w.Path, ["diff", "--name-only", "-z", "--no-renames", w.OriginalBase, "--"], ct);
            var files = changed.StandardOutput.Split('\0', StringSplitOptions.RemoveEmptyEntries).Concat(local.Files.Where(f => f.Status == "??").Select(f => f.Path)).Distinct().Order(StringComparer.Ordinal).ToArray();
            var merge = await Git(w.Path, ["rev-parse", "--verify", "MERGE_HEAD"], ct, true);
            w = w with { Observation = new(clock.UtcNow, "ok", local.Head, target, int.Parse(counts[0]), int.Parse(counts[1]), merge.ExitCode == 0, local, files) };
        }
        catch (Exception ex) when (ex is AppLifecycleException or IOException or UnauthorizedAccessException)
        {
            w = w with { Observation = new(clock.UtcNow, "unavailable", Error: ex.Message) };
        }
        await Save(w);
        return w;
    }
    public Task<AppSourceDiff> DiffAsync(string id, WorkspaceOwner? owner, WorkspaceDiffRequest input, CancellationToken ct)
        => Locked(async () =>
        {
            var w = await Observe(await Read(id, owner, ct), ct);
            if (w.State != "active" || w.Observation is not { State: "ok", Local: { } local }) throw Error("unavailable", "Workspace is unavailable.");
            if (input.View == "local") return await AppSourceService.ReadScopeDiffAsync(local, new(input.Path), ct);
            if (input.View != "session" || w.Observation.SessionFiles?.Contains(input.Path, StringComparer.Ordinal) != true)
                throw Error("diff_invalid", "Choose a changed file and local or session view.");
            if (!AppSourceService.IsRegularSourcePath(w.Path, input.Path)) throw Error("diff_unsupported", "Only regular files inside the worktree can be previewed.");
            await AppSourceService.RequireRegularFileAsync(System.IO.Path.Combine(w.Path, input.Path), ct);
            // Compare the original base to the current files through an isolated index. A file
            // deleted in a commit and recreated as untracked must still get its original before side.
            var index = System.IO.Path.Combine(Root, "indexes", Guid.NewGuid().ToString("N") + ".index");
            Directory.CreateDirectory(System.IO.Path.GetDirectoryName(index)!);
            try
            {
                await Git(w.Path, ["read-tree", w.OriginalBase], ct, index: index);
                if (File.Exists(System.IO.Path.Combine(w.Path, input.Path)))
                    await Git(w.Path, ["add", "--intent-to-add", "--force", "--", input.Path], ct, index: index);
                var status = local with { Head = w.OriginalBase, Files = [new(input.Path, " M", false, false)] };
                return await AppSourceService.ReadScopeDiffAsync(status, new(input.Path), ct, index);
            }
            finally { File.Delete(index); }
        }, ct);

    public Task<DevelopmentWorkspace> CommandAsync(string id, WorkspaceOwner? owner, string kind, WorkspaceCommand input, CancellationToken ct)
        => Locked(async () =>
        {
            RequestId(input.RequestId);
            var w = await Read(id, owner, ct);
            var fingerprint = Hash(CoreJson.Text(input));
            var old = w.Operations.FirstOrDefault(o => o.Id == input.RequestId);
            if (old is not null)
            {
                if (old.Kind != kind || old.Fingerprint != fingerprint) throw Error("request_conflict", "This request ID was used for a different operation.");
                if (old.State != "pending") return w;
                return await Recover(w, old, ct);
            }
            if (w.State != "active") throw Error("not_active", "The workspace is not active.");
            if (w.Operations.Any(o => o.State == "pending")) throw Error("operation_pending", "Recover the previous operation with its original request ID first.");
            await ValidateTree(w, ct);
            w = await Observe(w, ct);
            if (w.Observation?.State != "ok") throw Error("unavailable", "Refresh workspace state before retrying.");
            if (input.ExpectedHead is not null && input.ExpectedHead != w.Observation.Head) throw Error("stale_head", "Workspace HEAD changed; review the current state.");
            var op = new WorkspaceOperation(input.RequestId, kind, fingerprint, "pending", w.Observation.Head, Command: input);
            w = w with { Operations = [.. w.Operations, op] };
            await Save(w);
            try
            {
                switch (kind)
                {
                    case "lease":
                        if (!Guid.TryParse(input.LeaseId, out _)) throw Error("lease_invalid", "Lease ID must be a UUID.");
                        w = w with { Leases = w.Leases.Append(input.LeaseId!).Distinct().ToArray() }; break;
                    case "release-lease":
                        if (!Guid.TryParse(input.LeaseId, out _)) throw Error("lease_invalid", "Lease ID must be a UUID.");
                        w = w with { Leases = w.Leases.Where(l => l != input.LeaseId).ToArray() }; break;
                    case "refresh":
                        await Fetch(RepoPath(w.RepositoryId), w.Repository, w.TargetBranch, ct, await WorkspaceGrantAsync(w, ct)); break;
                    case "references":
                        var urls = input.PullRequests ?? [];
                        if (urls.Length > 100 || urls.Any(u => u is null || u.Length > 2048 || !Uri.TryCreate(u, UriKind.Absolute, out var uri) || uri.Scheme != "https" || !string.IsNullOrEmpty(uri.UserInfo)))
                            throw Error("references_invalid", "Supply bounded HTTPS pull request links without credentials.");
                        w = w with { PullRequests = w.PullRequests.Concat(urls).Distinct().ToArray() }; break;
                    case "commit":
                        RequireHead(input); ValidateAuthor(input);
                        if (w.Observation.Conflict) throw Error("conflict", "Resolve the pending merge with an explicit external workflow or abort it first.");
                        if (input.Paths is not { Length: > 0 and <= 256 } || input.Paths.Any(p => string.IsNullOrWhiteSpace(p) || !CoreDataPaths.TryResolveContainedRelativePath(w.Path, p, out _)))
                            throw Error("paths_invalid", "Select up to 256 repository-relative paths.");
                        var index = System.IO.Path.Combine(Root, "indexes", input.RequestId + ".index");
                        Directory.CreateDirectory(System.IO.Path.GetDirectoryName(index)!);
                        try
                        {
                            await Git(w.Path, ["read-tree", op.BeforeHead!], ct, index: index);
                            await Git(w.Path, ["add", "--", .. input.Paths], ct, index: index);
                            var tree = (await Git(w.Path, ["write-tree"], ct, index: index)).StandardOutput.Trim();
                            var parentTree = (await Git(w.Path, ["rev-parse", op.BeforeHead + "^{tree}"], ct)).StandardOutput.Trim();
                            if (tree == parentTree) throw Error("no_changes", "Selected paths have no changes to commit.");
                            var result = await Git(w.Path, ["commit-tree", tree, "-p", op.BeforeHead!, "-m", input.Message!], ct, author: input);
                            op = op with { ResultHead = result.StandardOutput.Trim() };
                            w = Put(w, op); await Save(w); // The exact object is durable before advancing a ref.
                            await Git(w.Path, ["update-ref", "refs/heads/" + w.Branch, op.ResultHead!, op.BeforeHead!], ct);
                            await Git(w.Path, ["reset", "--quiet", "HEAD", "--", .. input.Paths], ct);
                        }
                        finally { File.Delete(index); }
                        break;
                    case "merge":
                        RequireHead(input); ValidateAuthor(input);
                        if (w.Observation.Local!.Files.Count > 0 || w.Observation.Conflict) throw Error("dirty", "Commit or explicitly resolve existing changes before integrating target updates.");
                        var target = await Fetch(RepoPath(w.RepositoryId), w.Repository, w.TargetBranch, ct, await WorkspaceGrantAsync(w, ct));
                        op = op with { ResultHead = target }; w = Put(w, op); await Save(w);
                        var merged = await Git(w.Path, ["merge", "--no-edit", "--no-ff", "-m", input.Message!, target], ct, true, author: input);
                        if (merged.ExitCode != 0)
                        {
                            var mergeHead = await Git(w.Path, ["rev-parse", "--verify", "MERGE_HEAD"], ct, true);
                            if (mergeHead.ExitCode != 0) throw Error("git_failed", "Target integration failed before establishing a merge.");
                            op = op with { State = "conflict", Error = "Resolve the conflict in the worktree or request abort-merge." };
                        }
                        else w = w with { IntegrationBase = target };
                        break;
                    case "abort-merge":
                        RequireHead(input);
                        if (!w.Observation.Conflict) throw Error("no_merge", "There is no pending merge to abort.");
                        await Git(w.Path, ["merge", "--abort"], ct); break;
                    case "cleanup":
                        RequireHead(input);
                        await CheckCleanup(w, ct);
                        w = w with { State = "releasing" }; await Save(w);
                        return await FinishCleanup(w, op, ct);
                    default: throw Error("operation_invalid", "Unknown workspace operation.");
                }
                if (op.State == "pending") op = op with { State = "succeeded" };
                w = Put(w, op); await Save(w);
                return await Observe(w, ct);
            }
            catch (Exception ex) when (ex is AppLifecycleException or IOException or UnauthorizedAccessException or OperationCanceledException)
            {
                // Cancellation/IO can occur after a Git side effect. Preserve pending intent for recovery.
                if (ex is AppLifecycleException && op.ResultHead is null && w.State != "releasing")
                    w = Put(w, op with { State = "failed", Error = ex.Message });
                await Save(w);
                throw;
            }
        }, ct);

    private static void RequireHead(WorkspaceCommand input)
    {
        if (string.IsNullOrWhiteSpace(input.ExpectedHead)) throw Error("head_required", "Expected HEAD is required for this mutation.");
    }
    private static void ValidateAuthor(WorkspaceCommand input)
    {
        if (string.IsNullOrWhiteSpace(input.Message) || input.Message.Length > 16000 || string.IsNullOrWhiteSpace(input.AuthorName) ||
            string.IsNullOrWhiteSpace(input.AuthorEmail) || input.AuthorName.Any(c => char.IsControl(c) || c is '<' or '>') ||
            input.AuthorEmail.Any(c => char.IsWhiteSpace(c) || c is '<' or '>'))
            throw Error("commit_invalid", "A bounded message and explicit author name/email are required.");
    }
    private static DevelopmentWorkspace Put(DevelopmentWorkspace w, WorkspaceOperation op)
        => w with { Operations = w.Operations.Select(o => o.Id == op.Id ? op : o).ToArray() };

    private async Task<DevelopmentWorkspace> Recover(DevelopmentWorkspace w, WorkspaceOperation op, CancellationToken ct)
    {
        if (w.State == "releasing" && op.Kind == "cleanup") return await FinishCleanup(w, op, ct);
        await ValidateTree(w, ct);
        var head = (await Git(w.Path, ["rev-parse", "HEAD"], ct)).StandardOutput.Trim();
        if (op.Kind == "commit" && op.ResultHead == head)
            op = op with { State = "succeeded", Error = "Recovered commit; inspect the index before the next commit." };
        else if (op.Kind == "merge" && op.ResultHead is not null && (await Git(w.Path, ["merge-base", "--is-ancestor", op.ResultHead, head], ct, true)).ExitCode == 0)
        { w = w with { IntegrationBase = op.ResultHead }; op = op with { State = "succeeded" }; }
        else op = op with { State = "unknown", Error = "Interrupted operation. Inspect Git state before submitting a new request; no mutation was replayed." };
        w = Put(w, op); await Save(w); return await Observe(w, ct);
    }
    private async Task CheckCleanup(DevelopmentWorkspace w, CancellationToken ct)
    {
        if (w.Leases.Length > 0) throw Error("in_use", "An assistant or consumer still holds an activity lease.");
        if (w.Observation is not { State: "ok", Conflict: false, Local: { Files.Count: 0, Truncated: false } })
            throw Error("dirty", "Workspace has changes, conflicts or unavailable status.");
        await CheckConsumers(w, ct);
        var target = await Fetch(RepoPath(w.RepositoryId), w.Repository, w.TargetBranch, ct, await WorkspaceGrantAsync(w, ct));
        if ((await Git(w.Path, ["merge-base", "--is-ancestor", "HEAD", target], ct, true)).ExitCode != 0)
            throw Error("unmerged", "Workspace commits are not contained in the current target branch.");
    }
    private async Task CheckConsumers(DevelopmentWorkspace w, CancellationToken ct)
    {
        if (w.Leases.Length > 0) throw Error("in_use", "An assistant or consumer still holds an activity lease.");
        foreach (var process in processes?.Snapshot() ?? [])
        {
            if (IsUnder(w.Path, process.Value.WorkingDirectory) && !process.Value.Process.HasExited)
                throw Error("in_use", "A Core-managed local service still runs from this workspace.");
        }
        // Ignored build output is disposable; active runtime/source bindings are not.
        foreach (var app in await apps.ListAppRecordsAsync(ct))
        {
            var source = app.SourceState?.LocalOverridePath;
            if (source is not null && IsUnder(w.Path, source)) throw Error("in_use", "An installed app selects this worktree as its source override.");
            if (docker is not null && app.RuntimeState is "running" or "degraded" or "starting" && app.ManifestPath is not null)
            {
                var manifest = await JsonStorage.ReadAsync<RuntimeAppManifest>(app.ManifestPath, ct);
                if (manifest?.Services.Any(s => s.Runtimes.TryGetValue(app.SelectedRuntime ?? "", out var runtime) && runtime.Type == "docker") == true)
                    await CheckDockerConsumers(w, app.Id, ct);
            }
        }
    }
    private async Task CheckDockerConsumers(DevelopmentWorkspace w, string appId, CancellationToken ct)
    {
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(ct);
        deadline.CancelAfter(TimeSpan.FromSeconds(10));
        try
        {
            var list = await docker!.RunAsync(["ps", "--filter", "label=hosty.app.id=" + appId, "--format", "{{.ID}}"], cancellationToken: deadline.Token);
            if (list.ExitCode != 0) throw Error("consumer_unavailable", "Cannot verify running Docker source consumers.");
            var ids = list.StandardOutput.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries);
            if (ids.Length == 0) return;
            if (ids.Length > 256 || ids.Any(id => id.Length > 64 || !id.All(char.IsAsciiHexDigit))) throw Error("consumer_unavailable", "Docker returned invalid container identities.");
            var mounts = await docker.RunAsync(["inspect", "--format", "{{json .Mounts}}", .. ids], cancellationToken: deadline.Token);
            if (mounts.ExitCode != 0) throw Error("consumer_unavailable", "Cannot verify running Docker mounts.");
            foreach (var line in mounts.StandardOutput.Split('\n', StringSplitOptions.RemoveEmptyEntries))
            {
                using var json = JsonDocument.Parse(line);
                foreach (var mount in json.RootElement.EnumerateArray())
                {
                    if (mount.TryGetProperty("Source", out var property) && property.GetString() is { Length: > 0 } source &&
                        (IsUnder(w.Path, source) || IsUnder(source, w.Path)))
                        throw Error("in_use", "A running Docker service mounts this workspace.");
                }
            }
        }
        catch (Exception ex) when (ex is DockerUnavailableException or JsonException || ex is OperationCanceledException && !ct.IsCancellationRequested)
        {
            throw Error("consumer_unavailable", "Cannot verify running Docker source consumers; cleanup was refused.");
        }
    }
    private async Task<DevelopmentWorkspace> FinishCleanup(DevelopmentWorkspace w, WorkspaceOperation op, CancellationToken ct)
    {
        await CheckConsumers(w, ct);
        if (Directory.Exists(w.Path))
        {
            await ValidateTree(w, ct);
            w = await Observe(w, ct);
            if (w.Observation?.Head != op.BeforeHead) throw Error("stale_head", "Workspace HEAD changed during cleanup; source was preserved.");
            await CheckCleanup(w, ct);
            await Git(RepoPath(w.RepositoryId), ["worktree", "remove", w.Path], ct);
        }
        var branch = await Git(RepoPath(w.RepositoryId), ["show-ref", "--verify", "refs/heads/" + w.Branch], ct, true);
        if (branch.ExitCode == 0)
        {
            var head = branch.StandardOutput.Split(' ')[0];
            if (head != op.BeforeHead) throw Error("stale_head", "The branch changed during cleanup; it was preserved.");
            var target = await Fetch(RepoPath(w.RepositoryId), w.Repository, w.TargetBranch, ct, await WorkspaceGrantAsync(w, ct));
            if ((await Git(RepoPath(w.RepositoryId), ["merge-base", "--is-ancestor", head, target], ct, true)).ExitCode != 0)
                throw Error("unmerged", "The target changed during cleanup; the branch was preserved.");
            var registrations = await Git(RepoPath(w.RepositoryId), ["worktree", "list", "--porcelain"], ct);
            if (registrations.StandardOutput.Split('\n').Contains("branch refs/heads/" + w.Branch, StringComparer.Ordinal))
                throw Error("in_use", "The branch still has a registered worktree; recover its registration before retrying.");
            await Git(RepoPath(w.RepositoryId), ["update-ref", "-d", "refs/heads/" + w.Branch, head], ct);
        }
        w = Put(w with { State = "released", Observation = null }, op with { State = "succeeded" });
        await Save(w); return w;
    }
    internal static bool IsUnder(string root, string candidate)
    {
        var relative = System.IO.Path.GetRelativePath(MountPathPolicy.ResolveRealPath(root), MountPathPolicy.ResolveRealPath(candidate));
        return relative == "." || (!System.IO.Path.IsPathRooted(relative) && relative != ".." && !relative.StartsWith(".." + System.IO.Path.DirectorySeparatorChar));
    }
    private async Task<string> CanonicalRepository(string? repository, string? localSourceRoot, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(repository)) throw Error("source_missing", "No source repository is declared.");
        repository = repository.Trim();
        AppSourceService.ValidateManagedRepository(repository);
        if (!System.IO.Path.IsPathFullyQualified(repository))
        {
            if (Uri.TryCreate(repository, UriKind.Absolute, out var uri))
            {
                if (!string.IsNullOrEmpty(uri.Query) || !string.IsNullOrEmpty(uri.Fragment)) throw Error("repository_invalid", "Repository URLs cannot contain query strings or fragments.");
                if (!uri.IsFile) return uri.GetLeftPart(UriPartial.Path).TrimEnd('/');
                repository = uri.LocalPath;
            }
            else
            {
                // Installation already resolves manifest-relative sources to a repository root.
                // Never interpret the declaration relative to Core's current working directory.
                if (string.IsNullOrWhiteSpace(localSourceRoot) || !System.IO.Path.IsPathFullyQualified(localSourceRoot))
                    throw Error("source_missing", "The relative source repository has no resolved local source root.");
                repository = localSourceRoot;
            }
        }
        var local = MountPathPolicy.ResolveRealPath(repository);
        return (await Git(local, ["rev-parse", "--path-format=absolute", "--git-common-dir"], ct)).StandardOutput.Trim();
    }

    private async Task<SourceReadGrant?> WorkspaceGrantAsync(DevelopmentWorkspace workspace, CancellationToken ct)
    {
        if (workspace.SourceGrant is null) return null;
        foreach (var binding in workspace.Apps)
        {
            var app = await apps.GetAppAsync(binding.AppId, ct);
            if (app?.InstalledAt != binding.Installation) continue;
            if (app.PrivateSources?.Git is { } grant && grant.OwnerId == workspace.Owner.UserId &&
                grant.Repository == workspace.Repository) return grant;
            // A reviewed switch to public access must also stop old workspaces using the grant.
            if (app.PrivateSources is { Git: null }) return null;
        }
        return workspace.SourceGrant;
    }

    private async Task<string> Fetch(string repo, string repository, string branch, CancellationToken ct, SourceReadGrant? grant = null)
    {
        var reference = "refs/hosty/targets/" + Hash(branch);
        if (grant is null) await Git(repo, ["fetch", "--no-tags", repository, "+refs/heads/" + branch + ":" + reference], ct);
        else await (privateSources ?? throw PrivateSourceService.Denied()).GitAsync(grant, repository, repo,
            ["fetch", "--no-tags", "--", repository, "+refs/heads/" + branch + ":" + reference], ct);
        return (await Git(repo, ["rev-parse", reference], ct)).StandardOutput.Trim();
    }
    internal static async Task<ProcessRunResult> Git(string cwd, string[] args, CancellationToken ct, bool allowFailure = false,
        string? index = null, WorkspaceCommand? author = null)
    {
        var start = new ProcessStartInfo("git") { WorkingDirectory = cwd };
        foreach (var key in start.Environment.Keys.Where(k => k.StartsWith("GIT_", StringComparison.Ordinal)).ToArray()) start.Environment.Remove(key);
        start.Environment["GIT_TERMINAL_PROMPT"] = "0";
        start.Environment["GIT_CONFIG_NOSYSTEM"] = "1";
        start.Environment["GIT_CONFIG_GLOBAL"] = OperatingSystem.IsWindows() ? "NUL" : "/dev/null";
        start.Environment["GIT_NO_REPLACE_OBJECTS"] = "1";
        if (index is not null) start.Environment["GIT_INDEX_FILE"] = index;
        if (author is not null)
        {
            start.Environment["GIT_AUTHOR_NAME"] = start.Environment["GIT_COMMITTER_NAME"] = author.AuthorName;
            start.Environment["GIT_AUTHOR_EMAIL"] = start.Environment["GIT_COMMITTER_EMAIL"] = author.AuthorEmail;
        }
        foreach (var arg in new[] { "--literal-pathspecs", "-c", "core.hooksPath=" + (OperatingSystem.IsWindows() ? "NUL" : "/dev/null"),
            "-c", "core.fsmonitor=false", "-c", "credential.helper=", "-c", "commit.gpgSign=false", "-c", "protocol.ext.allow=never" }.Concat(args)) start.ArgumentList.Add(arg);
        ProcessRunResult result;
        try { result = await ProcessRunner.RunAsync(start, TimeSpan.FromSeconds(90), ct, 4 * 1024 * 1024); }
        catch (System.ComponentModel.Win32Exception) { throw Error("git_unavailable", "Git is unavailable."); }
        if (result.TimedOut) throw Error("git_timeout", "Git timed out. Recover with the same request ID.");
        if (result.StandardOutput.Length > 4 * 1024 * 1024) throw Error("output_limit", "Git output exceeded the inspection limit.");
        if (result.ExitCode != 0 && !allowFailure) throw Error("git_failed", "Git operation failed. Inspect the workspace before retrying.");
        return result;
    }
}
