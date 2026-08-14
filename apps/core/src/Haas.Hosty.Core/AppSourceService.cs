using System.Text.RegularExpressions;

namespace Haas.Hosty.Core;

internal sealed class AppSourceService(CoreDataPaths paths, AppRegistryStore apps, IClock clock)
{
    private static readonly Regex CommitPattern = new("^[0-9a-fA-F]{4,64}$", RegexOptions.Compiled);

    // `--force` is not optional: without it a tag that moved upstream is *rejected* ("would clobber
    // existing tag") and `git fetch` exits non-zero, which fails the whole operation even though every
    // branch fetched fine. Source repositories legitimately carry moving channel tags (this repo's own
    // `cli-dev`/`cardputer-dev` are re-pointed by CI), so an unforced fetch breaks every source-backed
    // app update the moment such a tag moves — for a reason unrelated to the app's own ref.
    private static readonly string[] FetchArgs = ["fetch", "--all", "--tags", "--prune", "--force"];

    public async Task<AppSourceResponse> GetAsync(string appId, CancellationToken cancellationToken = default)
    {
        var app = await RequireAppAsync(appId, cancellationToken);
        return new AppSourceResponse(app.Id, app.SourceState);
    }

    public async Task<AppSourceResponse> ResolveManagedAsync(
        string appId,
        AppSourceResolveRequest request,
        CancellationToken cancellationToken = default)
    {
        var app = await RequireAppAsync(appId, cancellationToken);
        var source = app.SourceState;
        if (source?.Repository is null)
        {
            throw new AppLifecycleException("source_not_configured", $"Runtime app '{appId}' does not declare a source repository.");
        }

        ValidateManagedRepository(source.Repository);
        var checkoutPath = source.ManagedCheckoutPath ?? paths.ResolveManagedCheckoutPath(appId);
        await EnsureCheckoutAsync(source.Repository, checkoutPath, cancellationToken);
        if (request.Fetch)
        {
            _ = await RunGitAsync(checkoutPath, FetchArgs, cancellationToken);
        }

        var resolvedRef = request.Commit ?? request.Tag ?? request.Branch ?? source.ResolvedRef ?? "HEAD";
        var commit = await ResolveCommitAsync(checkoutPath, request, resolvedRef, cancellationToken);
        var state = source with
        {
            ResolvedRef = resolvedRef,
            Commit = commit,
            ManagedCheckoutPath = checkoutPath,
            UpdatedAt = clock.UtcNow,
        };
        await apps.UpdateAppAsync(appId, current => current with { SourceState = state }, cancellationToken);
        return new AppSourceResponse(appId, state);
    }

    // Materializes the managed checkout at the pinned commit (detached HEAD) for a locked source runtime
    // — Development Mode off. Clones if needed, resolves the recorded ref to a commit when none is pinned
    // yet, checks that exact commit out (so the working tree is the reviewed, immutable source rather than
    // the branch tip), and records it. Only a reviewed source-resolve/update advances the commit, which
    // makes "off" an honest lock. Requires a source repository (a pure folder install cannot be pinned).
    public async Task<AppSourceResponse> EnsurePinnedCommitAsync(string appId, CancellationToken cancellationToken = default)
    {
        var app = await RequireAppAsync(appId, cancellationToken);
        var source = app.SourceState;
        if (source?.Repository is null)
        {
            throw new AppLifecycleException("source_not_configured", $"Runtime app '{appId}' does not declare a source repository.");
        }

        ValidateManagedRepository(source.Repository);
        var checkoutPath = source.ManagedCheckoutPath ?? paths.ResolveManagedCheckoutPath(appId);
        await EnsureCheckoutAsync(source.Repository, checkoutPath, cancellationToken);

        // The reviewed commit to pin to: the recorded one, and only a re-resolve of the reviewed ref when
        // nothing is recorded yet. A configured override does not change this — the override folder's own
        // commit lives in AppSourceState.OverrideCommit and never enters the pin. Re-resolving whenever an
        // override existed was the ghost-update defect: it threw away the commit a reviewed update had just
        // stamped and silently re-pinned the checkout to `origin/{ref}` as of its last fetch, so the app
        // kept running the old code and the very next check re-offered the same update forever.
        // The managed checkout is not fetched for a re-resolve, so it returns a stable commit; only a
        // reviewed source-resolve/update fetches and advances the ref.
        var commit = string.IsNullOrWhiteSpace(source.Commit)
            // Resolve locally; if the ref isn't known locally yet (e.g. a reviewed update just advanced it),
            // fetch once and retry so the advance succeeds.
            ? await WithSourceFetchRetryAsync(
                checkoutPath,
                () => ResolveCommitAsync(checkoutPath, new AppSourceResolveRequest(), source.ResolvedRef ?? "HEAD", cancellationToken),
                cancellationToken)
            : source.Commit;

        var pinnedCommit = commit;
        if (!await CommitExistsAsync(checkoutPath, pinnedCommit, cancellationToken))
        {
            // The clone does not have the pin yet — the usual reason is a reviewed update that advanced it
            // to a commit this checkout has never fetched. A failing fetch is a real failure and surfaces:
            // pinning something older because the network blinked is the ghost update this lock exists to
            // prevent.
            _ = await RunGitAsync(checkoutPath, FetchArgs, cancellationToken);
            if (!await CommitExistsAsync(checkoutPath, pinnedCommit, cancellationToken))
            {
                // The repository does not contain the recorded commit at all, and failing here would wedge
                // every start of the app. It is reachable through no fault of the operator: a record written
                // before OverrideCommit existed may carry an override folder's commit (another repository's
                // object) in the pin, and a force-pushed branch can drop a commit upstream. Fall back to the
                // reviewed ref — what the app would have pinned with no recorded commit at all — and let the
                // record self-heal on the write below.
                pinnedCommit = await ResolveCommitAsync(checkoutPath, new AppSourceResolveRequest(), source.ResolvedRef ?? "HEAD", cancellationToken);
            }
        }

        // Force the working tree to exactly the pinned commit: discard tracked edits and remove untracked
        // files (e.g. left by a prior Dev-Mode-on live run) so OFF is an honest, reproducible lock. Ignored
        // build outputs are kept (no `-x`) for `setup` to manage.
        _ = await RunGitAsync(checkoutPath, ["checkout", "--detach", "--force", pinnedCommit], cancellationToken);
        _ = await RunGitAsync(checkoutPath, ["clean", "-fd"], cancellationToken);

        // Build the new state from the current record inside the update lambda so a concurrent change to
        // other AppSourceState fields (override, ref) is not overwritten by this pre-read snapshot.
        var document = await apps.UpdateAppAsync(appId, current =>
        {
            var currentSource = current.SourceState;
            return currentSource is null
                ? current
                : current with
                {
                    SourceState = currentSource with
                    {
                        Commit = pinnedCommit,
                        ManagedCheckoutPath = checkoutPath,
                        UpdatedAt = clock.UtcNow,
                    },
                };
        }, cancellationToken);
        return new AppSourceResponse(appId, document.App.SourceState);
    }

    // Resolves the commit the manifest-declared source ref points at right now (digest pinning phase
    // 2b), using a single `git ls-remote` round trip — an explicit commit pin costs no round trip at
    // all. Deliberately materializes nothing: it neither clones nor fetches the managed checkout, and
    // does not touch the app record. The update sweep builds a plan for every app, so a routine update
    // check must not populate disk with clones for apps that were never started, nor pay a full fetch
    // per app. The update plan caches the result so the operator reviews the exact current→new commit
    // pair, and apply persists it inside its own record write — the pin only ever moves as part of a
    // reviewed update. The checkout catches up at the next start: EnsurePinnedCommitAsync fetches and
    // retries when the pinned commit is not present locally yet.
    public async Task<string> ResolveManifestCommitAsync(RuntimeAppSource source, CancellationToken cancellationToken = default)
    {
        if (source.Repository is null)
        {
            throw new AppLifecycleException("source_not_configured", "Source repository is required to resolve a source commit.");
        }

        ValidateManagedRepository(source.Repository);
        var repository = source.Repository.Trim();
        if (!string.IsNullOrWhiteSpace(source.Commit))
        {
            var commit = source.Commit.Trim();
            return CommitPattern.IsMatch(commit)
                ? commit
                : throw new AppLifecycleException("source_commit_invalid", "Source commit must be a 4-64 character hexadecimal object id.");
        }

        if (!string.IsNullOrWhiteSpace(source.Tag))
        {
            return await ResolveRemoteRefAsync(repository, $"refs/tags/{source.Tag.Trim()}", cancellationToken);
        }

        return string.IsNullOrWhiteSpace(source.Branch)
            ? await ResolveRemoteRefAsync(repository, "HEAD", cancellationToken)
            : await ResolveRemoteRefAsync(repository, $"refs/heads/{source.Branch.Trim()}", cancellationToken);
    }

    // One `git ls-remote` lookup of a single fully-qualified ref. The peeled form is requested
    // alongside it because an annotated tag lists the *tag object* under its own name and the commit
    // it points at under `{ref}^{}` — the peeled line is the one to pin, so it wins. Both patterns are
    // passed literally rather than as a glob, which would over-match siblings (`v1*` also matching
    // `v1.1`); for a branch or HEAD the peeled pattern simply matches nothing. A ref that does not
    // exist upstream is NOT a git failure — ls-remote exits 0 with empty output — so an unmatched
    // lookup is turned into an explicit error here rather than silently resolving to nothing.
    private static async Task<string> ResolveRemoteRefAsync(string repository, string reference, CancellationToken cancellationToken)
    {
        var peeled = $"{reference}^{{}}";
        var output = await RunGitProcessAsync(null, ["ls-remote", "--", repository, reference, peeled], cancellationToken);
        string? exact = null;
        foreach (var line in output.Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
        {
            var separator = line.IndexOf('\t', StringComparison.Ordinal);
            if (separator <= 0)
            {
                continue;
            }

            var commit = line[..separator];
            var listed = line[(separator + 1)..].Trim();
            if (string.Equals(listed, peeled, StringComparison.Ordinal))
            {
                return commit;
            }

            if (exact is null && string.Equals(listed, reference, StringComparison.Ordinal))
            {
                exact = commit;
            }
        }

        return exact ?? throw new AppLifecycleException(
            "source_ref_not_found",
            $"Source ref '{reference}' was not found in the source repository.");
    }

    // Whether the checkout already has this commit as an object, without throwing — the question the pin
    // path asks before deciding between "fetch it" and "this repository does not have it".
    private static async Task<bool> CommitExistsAsync(string checkoutPath, string commit, CancellationToken cancellationToken)
    {
        try
        {
            _ = await RunGitAsync(checkoutPath, ["cat-file", "-e", $"{commit}^{{commit}}"], cancellationToken);
            return true;
        }
        catch (AppLifecycleException)
        {
            return false;
        }
    }

    // Runs a git-backed operation against the managed checkout, fetching once and retrying if it fails
    // because the required object/ref isn't present locally yet. A genuine failure (e.g. the ref does not
    // exist upstream) surfaces on the retry. Cancellation propagates (never caught here).
    private static async Task<string> WithSourceFetchRetryAsync(string checkoutPath, Func<Task<string>> operation, CancellationToken cancellationToken)
    {
        try
        {
            return await operation();
        }
        catch (AppLifecycleException)
        {
            _ = await RunGitAsync(checkoutPath, FetchArgs, cancellationToken);
            return await operation();
        }
    }

    public async Task<AppSourceResponse> SetLocalOverrideAsync(
        string appId,
        AppSourceOverrideRequest request,
        CancellationToken cancellationToken = default)
    {
        var app = await RequireAppAsync(appId, cancellationToken);
        if (string.IsNullOrWhiteSpace(request.Path))
        {
            throw new AppLifecycleException("source_override_path_required", "Local source override path is required.");
        }

        var overridePath = Path.GetFullPath(request.Path);
        if (!Directory.Exists(overridePath))
        {
            throw new AppLifecycleException("source_override_not_found", $"Local source override path was not found: {overridePath}");
        }

        var commit = request.Commit;
        if (string.IsNullOrWhiteSpace(commit) && Directory.Exists(Path.Combine(overridePath, ".git")))
        {
            commit = await RunGitAsync(overridePath, ["rev-parse", "HEAD"], cancellationToken);
        }

        var existing = app.SourceState;
        var state = new AppSourceState(
            Type: existing?.Type ?? "git",
            Repository: existing?.Repository,
            ResolvedRef: existing?.ResolvedRef,
            // The reviewed pin is untouched. Configuring an operator folder says nothing about which
            // upstream commit was reviewed, and stamping the folder's HEAD here used to make the pinned
            // (Development Mode off) start path treat the whole field as untrustworthy.
            Commit: existing?.Commit,
            ManagedCheckoutPath: existing?.ManagedCheckoutPath ?? paths.ResolveManagedCheckoutPath(appId),
            LocalOverridePath: overridePath,
            UpdatedAt: clock.UtcNow,
            // Preserve the install-time manifest subpath: an override points at the same repo root, so
            // the app's manifest keeps the same in-repo offset.
            ManifestSubpath: existing?.ManifestSubpath,
            OverrideCommit: string.IsNullOrWhiteSpace(commit) ? null : commit.Trim());
        await apps.UpdateAppAsync(appId, current => current with { SourceState = state }, cancellationToken);
        return new AppSourceResponse(appId, state);
    }

    public async Task<AppSourceResponse> ClearLocalOverrideAsync(string appId, CancellationToken cancellationToken = default)
    {
        var app = await RequireAppAsync(appId, cancellationToken);
        if (app.SourceState is null)
        {
            return new AppSourceResponse(appId, null);
        }

        var state = app.SourceState with
        {
            LocalOverridePath = null,
            // The recorded commit belonged to the folder, not to the app.
            OverrideCommit = null,
            UpdatedAt = clock.UtcNow,
        };
        await apps.UpdateAppAsync(appId, current => current with { SourceState = state }, cancellationToken);
        return new AppSourceResponse(appId, state);
    }

    private async Task<AppRecord> RequireAppAsync(string appId, CancellationToken cancellationToken)
        => await apps.GetAppAsync(appId, cancellationToken) ??
            throw new AppLifecycleException("app_not_found", $"Runtime app '{appId}' was not found.");

    private static async Task EnsureCheckoutAsync(string repository, string checkoutPath, CancellationToken cancellationToken)
    {
        if (Directory.Exists(Path.Combine(checkoutPath, ".git")))
        {
            return;
        }

        Directory.CreateDirectory(Path.GetDirectoryName(checkoutPath) ?? ".");
        if (Directory.Exists(checkoutPath) && Directory.EnumerateFileSystemEntries(checkoutPath).Any())
        {
            throw new AppLifecycleException("source_checkout_not_empty", $"Managed source checkout path is not empty: {checkoutPath}");
        }

        _ = await RunGitProcessAsync(null, ["clone", "--", repository, checkoutPath], cancellationToken);
    }

    internal static void ValidateManagedRepository(string repository)
    {
        if (string.IsNullOrWhiteSpace(repository))
        {
            throw new AppLifecycleException("source_repository_required", "Source repository is required.");
        }

        var trimmed = repository.Trim();
        if (trimmed.StartsWith('-'))
        {
            throw new AppLifecycleException(
                "source_repository_invalid",
                "Source repository must not start with '-'.");
        }

        if (Uri.TryCreate(trimmed, UriKind.Absolute, out var uri))
        {
            if (uri.Scheme is "http" or "https")
            {
                if (!string.IsNullOrWhiteSpace(uri.UserInfo))
                {
                    throw new AppLifecycleException(
                        "source_repository_credentials_unsupported",
                        "Managed source checkouts support public-readable repositories only. Do not include credentials in source.repository.");
                }

                return;
            }

            if (uri.Scheme == "file")
            {
                return;
            }

            throw new AppLifecycleException(
                "source_repository_scheme_unsupported",
                $"Managed source checkouts support public-readable http/https repositories and local paths, not '{uri.Scheme}' repositories.");
        }

        if (LooksLikeScpStyleSshRepository(trimmed))
        {
            throw new AppLifecycleException(
                "source_repository_scheme_unsupported",
                "Managed source checkouts support public-readable http/https repositories and local paths, not SSH repository syntax.");
        }
    }

    private static async Task<string> ResolveCommitAsync(
        string checkoutPath,
        AppSourceResolveRequest request,
        string fallbackRef,
        CancellationToken cancellationToken)
    {
        if (!string.IsNullOrWhiteSpace(request.Commit))
        {
            var commit = request.Commit.Trim();
            if (!CommitPattern.IsMatch(commit))
            {
                throw new AppLifecycleException("source_commit_invalid", "Source commit must be a 4-64 character hexadecimal object id.");
            }

            return await RunGitAsync(checkoutPath, ["rev-parse", $"{commit}^{{commit}}"], cancellationToken);
        }

        if (!string.IsNullOrWhiteSpace(request.Tag))
        {
            return await RunGitAsync(checkoutPath, ["rev-parse", $"refs/tags/{request.Tag}^{{commit}}"], cancellationToken);
        }

        if (!string.IsNullOrWhiteSpace(request.Branch))
        {
            // Prefer the remote-tracking ref: the managed checkout's local branch is a clone-time
            // artifact that `git fetch` never advances, so resolving `refs/heads/{branch}` first
            // returns the clone-time tip forever no matter how often the checkout is fetched. The
            // local branch stays as the fallback for checkouts without an origin remote (or a branch
            // that only exists locally).
            try
            {
                return await RunGitAsync(checkoutPath, ["rev-parse", $"refs/remotes/origin/{request.Branch}^{{commit}}"], cancellationToken);
            }
            catch (AppLifecycleException)
            {
                return await RunGitAsync(checkoutPath, ["rev-parse", $"refs/heads/{request.Branch}^{{commit}}"], cancellationToken);
            }
        }

        if (fallbackRef.StartsWith('-'))
        {
            throw new AppLifecycleException("source_ref_invalid", "Source ref must not start with '-'.");
        }

        // The recorded ref may be a plain branch name (the manifest declared a branch), which has the
        // same stale-local-branch problem as the explicit branch case above — and it resolves
        // "successfully", so a caller's fetch-and-retry never fires. Prefer the remote-tracking
        // counterpart; a tag or commit id has none and falls through to the plain resolution. HEAD is
        // deliberately excluded: a pin re-resolve must return the stable checked-out commit, not chase
        // origin's default branch.
        if (!string.Equals(fallbackRef, "HEAD", StringComparison.Ordinal))
        {
            try
            {
                return await RunGitAsync(checkoutPath, ["rev-parse", $"refs/remotes/origin/{fallbackRef}^{{commit}}"], cancellationToken);
            }
            catch (AppLifecycleException)
            {
            }
        }

        return await RunGitAsync(checkoutPath, ["rev-parse", $"{fallbackRef}^{{commit}}"], cancellationToken);
    }

    private static async Task<string> RunGitAsync(string workingDirectory, IReadOnlyList<string> args, CancellationToken cancellationToken)
        => await RunGitProcessAsync(workingDirectory, args, cancellationToken);

    // Git clone/fetch on small source repos should never approach this; it bounds a hung git (e.g. an
    // interactive-credential prompt that the env vars in CreateGitStartInfo try to suppress).
    private static readonly TimeSpan GitTimeout = TimeSpan.FromMinutes(10);

    private static async Task<string> RunGitProcessAsync(string? workingDirectory, IReadOnlyList<string> args, CancellationToken cancellationToken)
    {
        ProcessRunResult result;
        try
        {
            result = await ProcessRunner.RunAsync(CreateGitStartInfo(workingDirectory, args), GitTimeout, cancellationToken);
        }
        catch (Exception ex) when (ex is InvalidOperationException or System.ComponentModel.Win32Exception)
        {
            throw new AppLifecycleException("source_git_unavailable", $"Git is not available: {ex.Message}");
        }

        if (result.TimedOut)
        {
            throw new AppLifecycleException("source_git_timed_out", $"Git command timed out after {GitTimeout.TotalMinutes:0} minutes.");
        }

        if (result.ExitCode != 0)
        {
            throw new AppLifecycleException("source_git_failed", string.IsNullOrWhiteSpace(result.StandardError) ? $"Git exited with code {result.ExitCode}." : result.StandardError.Trim());
        }

        return result.StandardOutput.Trim();
    }

    internal static System.Diagnostics.ProcessStartInfo CreateGitStartInfo(string? workingDirectory, IReadOnlyList<string> args)
    {
        var startInfo = new System.Diagnostics.ProcessStartInfo
        {
            FileName = "git",
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            WorkingDirectory = workingDirectory ?? Directory.GetCurrentDirectory(),
        };
        startInfo.Environment["GIT_TERMINAL_PROMPT"] = "0";
        startInfo.Environment["GIT_ASKPASS"] = "";
        startInfo.Environment["SSH_ASKPASS"] = "";
        startInfo.Environment["GCM_INTERACTIVE"] = "never";
        foreach (var arg in args)
        {
            startInfo.ArgumentList.Add(arg);
        }

        return startInfo;
    }

    private static bool LooksLikeScpStyleSshRepository(string value)
    {
        var colonIndex = value.IndexOf(':', StringComparison.Ordinal);
        if (colonIndex <= 0)
        {
            return false;
        }

        var slashIndex = value.IndexOfAny(['/', '\\']);
        return value[..colonIndex].Contains('@', StringComparison.Ordinal) &&
            (slashIndex < 0 || colonIndex < slashIndex);
    }
}

internal sealed record AppSourceResolveRequest(
    string? Branch = null,
    string? Tag = null,
    string? Commit = null,
    bool Fetch = false);

internal sealed record AppSourceOverrideRequest(string Path, string? Commit = null);

internal sealed record AppSourceResponse(string AppId, AppSourceState? Source);
