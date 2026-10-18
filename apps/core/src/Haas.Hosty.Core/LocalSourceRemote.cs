namespace Haas.Hosty.Core;

// Transport authority is separate from the durable local repository and its main branch.
internal sealed record LocalSourceRemote(string Repository, string TargetBranch, SourceReadGrant Grant);
internal sealed record LocalRemoteCommand(string RequestId, string AppId, string? Repository = null,
    string? ConnectionId = null, string? TargetBranch = null, string? ExpectedTargetHead = null);
internal sealed record LocalRemoteObservation(DateTimeOffset At, string State, string Repository,
    string TargetBranch, string? Head, int? Ahead = null, int? Behind = null, bool Related = false);
internal sealed record LocalRemoteStatus(string AppId, LocalSourceRemote? Remote,
    string? AcceptedHead, LocalRemoteObservation? Observation, WorkspaceOperation? Operation = null);

internal sealed partial class DevelopmentWorkspaceService
{
    private ISourceGitAccess RemoteGit => privateSources ?? throw PrivateSourceService.Denied();

    private async Task<AppRecord> RequireLocalRemoteApp(DevelopmentWorkspace w, string appId, CancellationToken ct, bool validateGrant = true)
    {
        var app = await apps.GetAppAsync(appId, ct);
        if (app is null || !w.Apps.Any(a => a.AppId == appId && a.Installation == app.InstalledAt) ||
            app.SourceState is not { Type: "local-git" } source)
            throw Error("source_changed", "The local app source binding changed. Retained source and worktree are unchanged.");
        var local = await LocalBuildingSource.ReadAsync(paths, app, ct);
        if (local.Unavailable is not null) throw Error("source_changed", local.Unavailable);
        if (await CanonicalRepository(source.Repository, source.LocalOverridePath, ct) != w.Repository)
            throw Error("source_changed", "The registered local repository identity changed.");
        if (source.Remote is { } remote)
        {
            if (remote.Grant.OwnerId != w.Owner.UserId) throw Error("forbidden", "This source connection belongs to another user.");
            if (validateGrant) await RemoteGit.ValidateAsync(new(Git: remote.Grant), ct);
        }
        return app;
    }

    private static LocalRemoteStatus RemoteStatus(DevelopmentWorkspace w, AppRecord app, WorkspaceOperation? operation = null)
        => new(app.Id, app.SourceState!.Remote, app.SourceState.Commit,
            app.SourceState.Remote is { } r && w.RemoteObservation is { } o && o.Repository == r.Repository && o.TargetBranch == r.TargetBranch ? o : null, operation);

    public async Task<LocalRemoteStatus> RemoteStatusAsync(string id, WorkspaceOwner owner, string appId, CancellationToken ct)
    {
        var tree = await Read(id, owner, ct);
        await RequireLocalRemoteApp(tree, appId, ct);
        return await Locked(Hash(OwnerIdentity(owner)), () => Locked("repository-admission:" + tree.RepositoryId, async () =>
        {
            var w = await Read(id, owner, ct);
            return RemoteStatus(w, await RequireLocalRemoteApp(w, appId, ct, validateGrant: false), w.Operations.LastOrDefault(o => o.RemoteCommand?.AppId == appId));
        }, ct), ct);
    }

    public async Task<LocalRemoteStatus> RemoteCommandAsync(string id, WorkspaceOwner owner, string kind, LocalRemoteCommand input, CancellationToken ct)
    {
        RequestId(input.RequestId);
        if (kind is not ("connect" or "fetch" or "push-base") || string.IsNullOrWhiteSpace(input.AppId) || input.AppId.Length > 63)
            throw Error("request_invalid", "Supply a local app and a supported remote operation.");
        var tree = await Read(id, owner, ct);
        var app = await RequireLocalRemoteApp(tree, input.AppId, ct);
        var grant = kind == "connect"
            ? await RemoteGit.BindAsync(owner.UserId, input.ConnectionId ?? "", input.Repository ?? "", false, ct)
            : app.SourceState!.Remote?.Grant ?? throw Error("remote_required", "Connect an existing repository first.");
        // The same order as publication: connection, then app/workspace/repository admission.
        return await RemoteGit.WithConnectionAsync(grant, connection => RemoteCommandLocked(id, owner, kind, input, connection, ct), ct);
    }

    private async Task<LocalRemoteStatus> RemoteCommandLocked(string id, WorkspaceOwner owner, string kind, LocalRemoteCommand input, UserProviderConnection connection, CancellationToken ct)
    {
        RequestId(input.RequestId);
        if (kind is not ("connect" or "fetch" or "push-base") || string.IsNullOrWhiteSpace(input.AppId) || input.AppId.Length > 63)
            throw Error("request_invalid", "Supply a local app and a supported remote operation.");
        var tree = await Read(id, owner, ct);
        var appGate = apps.OperationLock(input.AppId);
        await appGate.WaitAsync(ct);
        try
        {
            return await Locked(Hash(OwnerIdentity(owner)), () => Locked("repository-admission:" + tree.RepositoryId, async () =>
            {
                var w = await Read(id, owner, ct);
                var app = await RequireLocalRemoteApp(w, input.AppId, ct, validateGrant: false);
                if (app.SourceState!.Remote is { } selected && (selected.Grant.ConnectionId != connection.Id || selected.Grant.OwnerId != connection.UserId))
                    throw Error("remote_changed", "The selected source connection changed.");
                await ValidateTree(w, ct);
                var fingerprint = Hash(CoreJson.Text(input));
                var prior = w.Operations.FirstOrDefault(o => o.Id == input.RequestId);
                if (prior is not null && (prior.Kind != "remote-" + kind || prior.Fingerprint != fingerprint))
                    throw Error("request_conflict", "This request ID belongs to different arguments.");
                if (prior?.State == "succeeded") return RemoteStatus(w, app, prior);
                await RequireOpenWorkflow(owner, ct);
                if (w.State != "active") throw Error("not_active", "Resume the retained workspace before changing its remote.");
                if (w.Operations.Any(o => o.Id != input.RequestId && o.State is "pending" or "unknown"))
                    throw Error("operation_pending", "Recover the previous operation first.");
                var binding = app.SourceState!.Remote;
                if (kind == "connect")
                {
                    if (string.IsNullOrWhiteSpace(input.Repository) || string.IsNullOrWhiteSpace(input.ConnectionId) ||
                        string.IsNullOrWhiteSpace(input.TargetBranch) || input.TargetBranch.Length > 200 ||
                        (await Git(w.Path, ["check-ref-format", "refs/heads/" + input.TargetBranch], ct, true)).ExitCode != 0)
                        throw Error("remote_invalid", "Select an existing HTTPS repository, a source connection and an explicit target branch.");
                    var repository = RemoteGit.NormalizeRepository(input.Repository);
                    var grant = new SourceReadGrant(connection.UserId, connection.Id, connection.Provider, connection.AccountName, connection.Label, repository);
                    if (connection.Id != input.ConnectionId || connection.UserId != owner.UserId)
                        throw Error("forbidden", "The selected connection belongs to another user.");
                    var candidate = new LocalSourceRemote(repository, input.TargetBranch, grant);
                    if (binding is not null && (binding.Repository != candidate.Repository || binding.TargetBranch != candidate.TargetBranch ||
                        binding.Grant.ConnectionId != candidate.Grant.ConnectionId))
                        throw Error("remote_changed", "This local source already has a different reviewed remote. No source or remote was replaced.");
                    binding = candidate;
                }
                if (binding is null) throw Error("remote_required", "Connect an existing repository first.");
                var op = prior ?? new WorkspaceOperation(input.RequestId, "remote-" + kind, fingerprint, "pending", RemoteCommand: input);
                op = op with { State = "pending", Error = null };
                w = w with { Operations = [.. w.Operations.Where(o => o.Id != op.Id), op] };
                await Save(w);
                try
                {
                    var head = await ReadRemoteHead(w, binding, ct, connection);
                    if (kind == "push-base")
                    {
                        // Only a reviewed accepted local main can initialize a missing remote target.
                        // An exact pre-existing ref also proves recovery after a lost push response.
                        var accepted = app.SourceState.Commit;
                        if (input.ExpectedTargetHead != accepted || string.IsNullOrWhiteSpace(accepted))
                            throw Error("stale_head", "Review the current accepted local main before publishing its base.");
                        if (head is not null && head != accepted)
                            throw Error("remote_exists", "The remote target already exists with different history. Fetch and reconcile it explicitly; it will not be overwritten.");
                        op = op with { ResultHead = accepted }; w = Put(w, op); await Save(w);
                        if (head is null)
                            // An absence lease is create-only: even a concurrent creator cannot be overwritten.
                            await RemoteGit.GitWithConnectionAsync(binding.Grant, binding.Repository, w.Path,
                                ["push", "--no-verify", "--force-with-lease=refs/heads/" + binding.TargetBranch + ":", binding.Repository, accepted + ":refs/heads/" + binding.TargetBranch], connection, ct);
                    }
                    var observation = await FetchRemote(w, binding, ct, connection);
                    if (kind == "connect")
                    {
                        await apps.UpdateAppAsync(app.Id, current => current with { SourceState = current.SourceState! with { Remote = binding } }, ct);
                        app = (await apps.GetAppAsync(app.Id, ct))!;
                    }
                    w = Put(w with { RemoteObservation = observation }, op with { State = "succeeded" });
                    await Save(w);
                    return RemoteStatus(w, app, w.Operations.Single(o => o.Id == op.Id));
                }
                catch (Exception ex) when (ex is AppLifecycleException or UserConnectionException or IOException or OperationCanceledException or HttpRequestException)
                {
                    // Keep the exact request available for reconciliation; never infer a failed push
                    // from a lost response or delete the user's source to recover connectivity.
                    await Save(Put(w, op with { State = op.ResultHead is null || ex is AppLifecycleException { Code: "workspace_remote_exists" } ? "failed" : "pending", Error = "Remote operation was not confirmed. Retry the original request after checking the connection." }));
                    throw;
                }
            }, ct), ct);
        }
        finally { appGate.Release(); }
    }

    private Task<string> RemoteTransport(DevelopmentWorkspace w, LocalSourceRemote remote, string[] args, UserProviderConnection? connection, CancellationToken ct)
        => connection is null ? RemoteGit.GitAsync(remote.Grant, remote.Repository, w.Path, args, ct)
            : RemoteGit.GitWithConnectionAsync(remote.Grant, remote.Repository, w.Path, args, connection, ct);

    private async Task<string?> ReadRemoteHead(DevelopmentWorkspace w, LocalSourceRemote remote, CancellationToken ct, UserProviderConnection? connection = null)
    {
        var value = await RemoteTransport(w, remote, ["ls-remote", "--heads", remote.Repository, "refs/heads/" + remote.TargetBranch], connection, ct);
        var lines = value.Split('\n', StringSplitOptions.RemoveEmptyEntries);
        if (lines.Length == 0) return null;
        var parts = lines[0].Split('\t');
        if (lines.Length != 1 || parts.Length != 2 || parts[1] != "refs/heads/" + remote.TargetBranch ||
            parts[0].Length is not (40 or 64) || parts[0].Any(c => !char.IsAsciiHexDigit(c)))
            throw Error("remote_invalid", "The upstream returned an invalid branch observation.");
        return parts[0];
    }

    private async Task<LocalRemoteObservation> FetchRemote(DevelopmentWorkspace w, LocalSourceRemote remote, CancellationToken ct, UserProviderConnection? connection = null)
    {
        if (await ReadRemoteHead(w, remote, ct, connection) is null)
            return new(clock.UtcNow, "missing", remote.Repository, remote.TargetBranch, null);
        var reference = "refs/hosty/upstream/" + Hash(remote.Repository + "\n" + remote.TargetBranch);
        await RemoteTransport(w, remote, ["fetch", "--no-tags", remote.Repository, "+refs/heads/" + remote.TargetBranch + ":" + reference], connection, ct);
        var head = (await Git(w.Path, ["rev-parse", reference], ct)).StandardOutput.Trim();
        var related = (await Git(w.Path, ["merge-base", "HEAD", head], ct, true)).ExitCode == 0;
        var counts = (await Git(w.Path, ["rev-list", "--left-right", "--count", "HEAD..." + head], ct)).StandardOutput.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries);
        return new(clock.UtcNow, "observed", remote.Repository, remote.TargetBranch, head,
            int.Parse(counts[0], System.Globalization.CultureInfo.InvariantCulture), int.Parse(counts[1], System.Globalization.CultureInfo.InvariantCulture), related);
    }

    private async Task<string> ReviewedUpstream(DevelopmentWorkspace w, WorkspaceCommand input, CancellationToken ct, UserProviderConnection connection)
    {
        var remote = await PublicationRemoteAsync(w, ct, validateGrant: false) ?? throw Error("remote_required", "This operation requires a connected local source.");
        var observed = await FetchRemote(w, remote, ct, connection);
        if (observed.Head is null || observed.Head != input.ExpectedRemoteHead)
            throw Error("stale_upstream", "Fetch and review the current upstream head before integrating it.");
        if (!observed.Related && input.AllowUnrelatedHistories != true)
            throw Error("unrelated_history", "These histories are unrelated. Review both histories and explicitly allow their integration.");
        return observed.Head;
    }

    internal async Task<LocalSourceRemote?> PublicationRemoteAsync(DevelopmentWorkspace w, CancellationToken ct, bool validateGrant = true)
    {
        foreach (var attached in w.Apps)
        {
            var app = await apps.GetAppAsync(attached.AppId, ct);
            if (app?.SourceState?.Type != "local-git" && w.Repository != Path.Combine(paths.ResolveManagedCheckoutPath(attached.AppId), ".git")) continue;
            app = await RequireLocalRemoteApp(w, attached.AppId, ct, validateGrant);
            return app.SourceState!.Remote ?? throw Error("remote_required", "Connect an existing repository before configuring publication.");
        }
        return null;
    }

    // Called under the workspace publication lock. Upstream evidence is independent of local-main
    // integration and does not authorize Accept locally, cleanup, or automatic pulling.
    internal async Task RequireRemotePublicationAsync(DevelopmentWorkspace w, string repository, string branch, string connectionId, Func<string, string> normalize, CancellationToken ct, UserProviderConnection? connection = null)
    {
        if (await PublicationRemoteAsync(w, ct, validateGrant: connection is null) is not { } remote) return;
        if (normalize(remote.Repository) != repository || remote.TargetBranch != branch || remote.Grant.ConnectionId != connectionId)
            throw Error("remote_changed", "The publication no longer matches the reviewed remote connection.");
        var observed = await FetchRemote(w, remote, ct, connection);
        await Save(w with { RemoteObservation = observed });
        if (observed.Head is null || (await Git(w.Path, ["merge-base", "--is-ancestor", observed.Head, "HEAD"], ct, true)).ExitCode != 0)
            throw Error("remote_reconciliation_required", "Fetch and explicitly reconcile the remote target in this worktree before publishing. Source is unchanged; no pull or force-push was performed.");
    }
}
