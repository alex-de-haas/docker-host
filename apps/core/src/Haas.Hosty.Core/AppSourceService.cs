using System.Text.RegularExpressions;

namespace Haas.Hosty.Core;

internal sealed class AppSourceService(CoreDataPaths paths, AppRegistryStore apps, IClock clock)
{
    private static readonly Regex CommitPattern = new("^[0-9a-fA-F]{4,64}$", RegexOptions.Compiled);

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
        var checkoutPath = source.ManagedCheckoutPath ?? Path.Combine(paths.SourcesRoot, appId);
        await EnsureCheckoutAsync(source.Repository, checkoutPath, cancellationToken);
        if (request.Fetch)
        {
            _ = await RunGitAsync(checkoutPath, ["fetch", "--all", "--tags", "--prune"], cancellationToken);
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
            Commit: string.IsNullOrWhiteSpace(commit) ? existing?.Commit : commit.Trim(),
            ManagedCheckoutPath: existing?.ManagedCheckoutPath ?? Path.Combine(paths.SourcesRoot, appId),
            LocalOverridePath: overridePath,
            UpdatedAt: clock.UtcNow);
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
            UpdatedAt = clock.UtcNow,
        };
        await apps.UpdateAppAsync(appId, current => current with { SourceState = state }, cancellationToken);
        return new AppSourceResponse(appId, state);
    }

    public async Task<AppSourceCleanupPlan> CreateCleanupPlanAsync(CancellationToken cancellationToken = default)
    {
        if (!Directory.Exists(paths.SourcesRoot))
        {
            return new AppSourceCleanupPlan([]);
        }

        var candidates = new List<AppSourceCleanupCandidate>();
        foreach (var sourceDirectory in Directory.EnumerateDirectories(paths.SourcesRoot).Order(StringComparer.Ordinal))
        {
            cancellationToken.ThrowIfCancellationRequested();
            var appId = Path.GetFileName(sourceDirectory);
            if (string.IsNullOrWhiteSpace(appId))
            {
                continue;
            }

            var app = await apps.GetAppAsync(appId, cancellationToken);
            var reason = GetCleanupReason(app, sourceDirectory);
            if (reason is not null)
            {
                candidates.Add(new AppSourceCleanupCandidate(appId, Path.GetFullPath(sourceDirectory), reason));
            }
        }

        return new AppSourceCleanupPlan(candidates);
    }

    public async Task<AppSourceCleanupApplyResponse> ApplyCleanupAsync(CancellationToken cancellationToken = default)
    {
        var plan = await CreateCleanupPlanAsync(cancellationToken);
        var deleted = new List<AppSourceCleanupCandidate>();
        foreach (var candidate in plan.Candidates)
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (!IsManagedSourceRootChild(candidate.Path))
            {
                continue;
            }

            if (Directory.Exists(candidate.Path))
            {
                Directory.Delete(candidate.Path, recursive: true);
                deleted.Add(candidate);
            }
        }

        return new AppSourceCleanupApplyResponse(deleted);
    }

    private async Task<AppRecord> RequireAppAsync(string appId, CancellationToken cancellationToken)
        => await apps.GetAppAsync(appId, cancellationToken) ??
            throw new AppLifecycleException("app_not_found", $"Runtime app '{appId}' was not found.");

    private string? GetCleanupReason(AppRecord? app, string sourceDirectory)
    {
        if (app is null)
        {
            return "app-not-installed";
        }

        var source = app.SourceState;
        if (source is null || string.IsNullOrWhiteSpace(source.Repository))
        {
            return "source-not-configured";
        }

        var fullSourceDirectory = Path.GetFullPath(sourceDirectory);
        if (!string.IsNullOrWhiteSpace(source.LocalOverridePath) &&
            string.Equals(Path.GetFullPath(source.LocalOverridePath), fullSourceDirectory, StringComparison.Ordinal))
        {
            return null;
        }

        var managedCheckoutPath = source.ManagedCheckoutPath ?? Path.Combine(paths.SourcesRoot, app.Id);
        if (!string.Equals(Path.GetFullPath(managedCheckoutPath), fullSourceDirectory, StringComparison.Ordinal))
        {
            return "managed-checkout-path-changed";
        }

        return null;
    }

    private bool IsManagedSourceRootChild(string candidatePath)
    {
        var root = Path.GetFullPath(paths.SourcesRoot);
        var candidate = Path.GetFullPath(candidatePath);
        return string.Equals(Path.GetDirectoryName(candidate), root, StringComparison.Ordinal);
    }

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
            try
            {
                return await RunGitAsync(checkoutPath, ["rev-parse", $"refs/heads/{request.Branch}^{{commit}}"], cancellationToken);
            }
            catch (AppLifecycleException)
            {
                return await RunGitAsync(checkoutPath, ["rev-parse", $"refs/remotes/origin/{request.Branch}^{{commit}}"], cancellationToken);
            }
        }

        if (fallbackRef.StartsWith('-'))
        {
            throw new AppLifecycleException("source_ref_invalid", "Source ref must not start with '-'.");
        }

        return await RunGitAsync(checkoutPath, ["rev-parse", $"{fallbackRef}^{{commit}}"], cancellationToken);
    }

    private static async Task<string> RunGitAsync(string workingDirectory, IReadOnlyList<string> args, CancellationToken cancellationToken)
        => await RunGitProcessAsync(workingDirectory, args, cancellationToken);

    private static async Task<string> RunGitProcessAsync(string? workingDirectory, IReadOnlyList<string> args, CancellationToken cancellationToken)
    {
        var process = new System.Diagnostics.Process
        {
            StartInfo = CreateGitStartInfo(workingDirectory, args),
        };

        try
        {
            process.Start();
        }
        catch (Exception ex) when (ex is InvalidOperationException or System.ComponentModel.Win32Exception)
        {
            throw new AppLifecycleException("source_git_unavailable", $"Git is not available: {ex.Message}");
        }

        var stdout = await process.StandardOutput.ReadToEndAsync(cancellationToken);
        var stderr = await process.StandardError.ReadToEndAsync(cancellationToken);
        await process.WaitForExitAsync(cancellationToken);
        if (process.ExitCode != 0)
        {
            throw new AppLifecycleException("source_git_failed", string.IsNullOrWhiteSpace(stderr) ? $"Git exited with code {process.ExitCode}." : stderr.Trim());
        }

        return stdout.Trim();
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

internal sealed record AppSourceCleanupPlan(IReadOnlyList<AppSourceCleanupCandidate> Candidates);

internal sealed record AppSourceCleanupCandidate(string AppId, string Path, string Reason);

internal sealed record AppSourceCleanupApplyResponse(IReadOnlyList<AppSourceCleanupCandidate> Deleted);
