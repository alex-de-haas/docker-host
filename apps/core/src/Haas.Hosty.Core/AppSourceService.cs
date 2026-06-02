namespace Haas.Hosty.Core;

internal sealed class AppSourceService(CoreDataPaths paths, AppRegistryStore apps, IClock clock)
{
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

        _ = await RunGitProcessAsync(null, ["clone", repository, checkoutPath], cancellationToken);
    }

    private static async Task<string> ResolveCommitAsync(
        string checkoutPath,
        AppSourceResolveRequest request,
        string fallbackRef,
        CancellationToken cancellationToken)
    {
        if (!string.IsNullOrWhiteSpace(request.Commit))
        {
            return await RunGitAsync(checkoutPath, ["rev-parse", $"{request.Commit}^{{commit}}"], cancellationToken);
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

        return await RunGitAsync(checkoutPath, ["rev-parse", $"{fallbackRef}^{{commit}}"], cancellationToken);
    }

    private static async Task<string> RunGitAsync(string workingDirectory, IReadOnlyList<string> args, CancellationToken cancellationToken)
        => await RunGitProcessAsync(workingDirectory, args, cancellationToken);

    private static async Task<string> RunGitProcessAsync(string? workingDirectory, IReadOnlyList<string> args, CancellationToken cancellationToken)
    {
        var process = new System.Diagnostics.Process
        {
            StartInfo = new System.Diagnostics.ProcessStartInfo
            {
                FileName = "git",
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                WorkingDirectory = workingDirectory ?? Directory.GetCurrentDirectory(),
            },
        };
        foreach (var arg in args)
        {
            process.StartInfo.ArgumentList.Add(arg);
        }

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
}

internal sealed record AppSourceResolveRequest(
    string? Branch = null,
    string? Tag = null,
    string? Commit = null,
    bool Fetch = false);

internal sealed record AppSourceOverrideRequest(string Path, string? Commit = null);

internal sealed record AppSourceResponse(string AppId, AppSourceState? Source);
