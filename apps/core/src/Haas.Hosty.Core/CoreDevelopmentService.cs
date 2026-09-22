using System.Diagnostics;
using Haas.Hosty.Launch;

namespace Haas.Hosty.Core;

internal sealed record CoreSourceRequest(string? OverridePath, string Revision);
internal sealed record CoreRestartRequest(string RequestId, string Instance, string? Mode = null, string? SourceRevision = null);
internal sealed record CoreDevelopmentState(CoreLaunchIdentity Launch, string Instance, bool Manageable,
    CoreSourceSettings Source, string ManagedPath, string SourcePath, string SelectedProjectPath, bool RestartRequired,
    string? Branch, string? Commit, int? ChangedFiles, long? Additions, long? Deletions, string? GitError, bool GitTruncated = false);

internal sealed class CoreDevelopmentService(HostyCoreRuntimeConfig config, CoreLaunchIdentity? identity = null)
{
    private readonly SemaphoreSlim gate = new(1, 1);
    private readonly CoreLaunchIdentity launch = identity ?? CoreLaunchIdentity.Current();
    internal string Instance => $"{launch.ProcessId}:{launch.StartedAt.UtcTicks}";
    private string ManagedPath => Path.Combine(config.DataRoot, "core", "source");
    private CoreSourceSettings Settings => CoreLaunchFiles.Read(CoreLaunchFiles.SourcePath(config.DataRoot), CoreLaunchJson.Default.CoreSourceSettings)
        ?? new(null, "initial");
    private string SelectedRoot(CoreSourceSettings settings) => settings.OverridePath ?? ManagedPath;
    private static string Project(string root) => Path.Combine(root, "apps", "core", "src", "Haas.Hosty.Core", "Haas.Hosty.Core.csproj");

    public async Task<CoreDevelopmentState> GetAsync(CancellationToken cancellationToken = default)
    {
        var settings = Settings;
        var sourceRoot = SelectedRoot(settings);
        var status = await GetSourceStatusAsync(cancellationToken);
        var available = status.State is "clean" or "changes";
        return new(launch, Instance, (launch.Mode is "dev" or "release") && CoreCliLauncher.ResolveCliPath() is not null,
            settings, ManagedPath, sourceRoot, Project(sourceRoot), launch.Mode == "dev" && settings.PendingForInstance == Instance,
            status.Branch, status.Head, available ? status.FileCount : null,
            status.LineStats?.Additions, status.LineStats?.Deletions,
            available ? null : status.Error ?? "Source checkout is unavailable.", status.Truncated);
    }

    private Task<AppSourceStatus> ReadSourceStatusAsync(CancellationToken cancellationToken)
        => AppSourceService.ReadScopeStatusAsync("hosty-core",
            () => launch.Mode == "dev"
                ? launch.ProjectPath is { } project ? Path.GetDirectoryName(project) : null
                : SelectedRoot(Settings),
            null, DateTimeOffset.UtcNow, cancellationToken, entireRepository: true);

    public async Task<AppSourceStatus> GetSourceStatusAsync(CancellationToken cancellationToken = default)
    {
        var status = await AppSourceService.AddLineStatisticsAsync(await ReadSourceStatusAsync(cancellationToken), cancellationToken);
        return status with { Files = status.Files.Select(file => file with { CanDiscard = false }).ToArray() };
    }

    public async Task<AppSourceDiff> GetSourceDiffAsync(AppSourceDiffRequest request, CancellationToken cancellationToken = default)
        => await AppSourceService.ReadScopeDiffAsync(await ReadSourceStatusAsync(cancellationToken), request, cancellationToken);

    public async Task<CoreSourceSettings> SaveAsync(CoreSourceRequest request, CancellationToken cancellationToken)
    {
        await gate.WaitAsync(cancellationToken);
        try
        {
            using var lease = CoreLaunchFiles.Lock(config.DataRoot);
            CheckBusy();
            var old = Settings;
            if (request.Revision != old.Revision) throw new InvalidOperationException("Source changed; refresh before saving.");
            string? path = null;
            if (!string.IsNullOrWhiteSpace(request.OverridePath))
            {
                if (!Path.IsPathFullyQualified(request.OverridePath)) throw new InvalidOperationException("Source override must be an absolute host path.");
                path = Path.TrimEndingDirectorySeparator(Path.GetFullPath(request.OverridePath));
                if (!File.Exists(Project(path))) throw new InvalidOperationException("The selected folder does not contain the Core project.");
            }
            var runningProject = launch.ProjectPath is { } project ? Path.GetFullPath(project) : null;
            var pending = launch.Mode == "dev" && !string.Equals(Project(path ?? ManagedPath), runningProject, OperatingSystem.IsWindows() ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal);
            if (old.OverridePath == path && old.PendingForInstance == (pending ? Instance : null)) return old;
            var updated = new CoreSourceSettings(path, Guid.NewGuid().ToString("N"), pending ? Instance : null);
            CoreLaunchFiles.Write(CoreLaunchFiles.SourcePath(config.DataRoot), updated, CoreLaunchJson.Default.CoreSourceSettings);
            return updated;
        }
        finally { gate.Release(); }
    }

    public CoreLaunchOperation? GetOperation(string id)
    {
        var path = CoreLaunchFiles.OperationPath(config.DataRoot, id);
        var operation = CoreLaunchFiles.Read(path, CoreLaunchJson.Default.CoreLaunchOperation);
        if (operation?.Status is "accepted" or "building" or "starting")
        {
            var dead = operation.HelperPid is { } pid && operation.HelperStartedAt is { } started
                ? !CoreBuildRetention.IsAlive(pid, started)
                : DateTimeOffset.UtcNow - operation.CreatedAt > TimeSpan.FromMinutes(2);
            if (dead)
            {
                // Acquire the same lock as the helper before declaring it abandoned. A helper
                // which just acquired the lease may not have published its identity yet.
                try
                {
                    using var lease = CoreLaunchFiles.Lock(config.DataRoot);
                    var current = CoreLaunchFiles.Read(path, CoreLaunchJson.Default.CoreLaunchOperation);
                    if (current == operation)
                    {
                        operation = operation with { Status = "failed", Error = "The restart helper exited before confirming startup. Inspect its log and use the CLI for recovery." };
                        CoreLaunchFiles.Write(path, operation, CoreLaunchJson.Default.CoreLaunchOperation);
                    }
                    else operation = current;
                }
                catch (IOException) { }
            }
        }
        return operation;
    }

    public async Task<CoreLaunchOperation> RestartAsync(CoreRestartRequest request, CancellationToken cancellationToken)
    {
        var operationPath = CoreLaunchFiles.OperationPath(config.DataRoot, request.RequestId);
        await gate.WaitAsync(cancellationToken);
        try
        {
            using var lease = CoreLaunchFiles.Lock(config.DataRoot);
            if (GetOperation(request.RequestId) is { } previous) return previous;
            CheckBusy();
            if (request.Instance != Instance) throw new InvalidOperationException("Core changed; refresh before restarting.");
            if (launch.Mode is not ("dev" or "release")) throw new InvalidOperationException("This Core launch is unmanaged; use the host CLI with an explicit project.");
            var mode = request.Mode ?? launch.Mode;
            if (mode is not ("dev" or "release")) throw new InvalidOperationException("Mode must be release or dev.");
            var source = Settings;
            if (source.Revision != request.SourceRevision) throw new InvalidOperationException("Source changed or its revision is missing; refresh before restarting.");
            var cli = CoreCliLauncher.ResolveCliPath() ?? throw new InvalidOperationException("The Hosty CLI is unavailable.");
            string? project = null;
            if (mode == "dev")
            {
                var useSelected = request.Mode == "dev" || source.PendingForInstance == Instance;
                if (useSelected) project = await PrepareSourceAsync(source, cancellationToken);
                else project = launch.ProjectPath;
                if (project is null || !File.Exists(project)) throw new InvalidOperationException("Core source project is unavailable.");
            }
            var log = Path.Combine(config.DataRoot, "core", "logs", $"core-restart-{request.RequestId}.log");
            var operation = new CoreLaunchOperation(request.RequestId, "accepted", mode, project, DateTimeOffset.UtcNow, source.Revision, LogPath: log);
            CoreLaunchFiles.Write(operationPath, operation, CoreLaunchJson.Default.CoreLaunchOperation);
            lease.Dispose();
            try
            {
                var args = new List<string> { "--data-root", config.DataRoot, "core", "restart", "--keep-apps", "--operation-id", request.RequestId };
                if (project is not null) args.AddRange(["--project", project]);
                CoreCliLauncher.SpawnDetached(cli, args, config, "core-restart.log", log);
                return operation;
            }
            catch (Exception ex)
            {
                CoreLaunchFiles.Write(operationPath, operation with { Status = "failed", Error = ex.Message }, CoreLaunchJson.Default.CoreLaunchOperation);
                throw;
            }
        }
        finally { gate.Release(); }
    }

    internal async Task<string> PrepareSourceAsync(CoreSourceSettings source, CancellationToken cancellationToken,
        string repository = "https://github.com/alex-de-haas/docker-host.git")
    {
        var root = SelectedRoot(source);
        if (source.OverridePath is null && !Directory.Exists(root))
        {
            var temp = root + "." + Guid.NewGuid().ToString("N");
            Directory.CreateDirectory(Path.GetDirectoryName(root)!);
            try
            {
                await GitAsync(Path.GetDirectoryName(root)!, ["clone", "--", repository, temp], cancellationToken);
                Directory.Move(temp, root);
            }
            finally { if (Directory.Exists(temp)) Directory.Delete(temp, true); }
        }
        var project = Project(root);
        if (!File.Exists(project)) throw new InvalidOperationException("Core source project is unavailable.");
        return project;
    }

    private void CheckBusy() => CoreLaunchFiles.AssertNoPendingOperations(config.DataRoot);

    private static async Task<string> GitAsync(string directory, string[] arguments, CancellationToken cancellationToken, bool allowFailure = false)
    {
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeout.CancelAfter(TimeSpan.FromMinutes(3));
        var start = new ProcessStartInfo("git") { WorkingDirectory = directory, UseShellExecute = false, RedirectStandardOutput = true, RedirectStandardError = true };
        start.Environment["GIT_TERMINAL_PROMPT"] = "0";
        start.Environment["GIT_OPTIONAL_LOCKS"] = "0";
        foreach (var arg in arguments) start.ArgumentList.Add(arg);
        using var process = Process.Start(start) ?? throw new IOException("Unable to start git.");
        var output = process.StandardOutput.ReadToEndAsync(timeout.Token);
        var error = process.StandardError.ReadToEndAsync(timeout.Token);
        try
        {
            await process.WaitForExitAsync(timeout.Token);
            var text = await output;
            var diagnostic = await error;
            if (process.ExitCode != 0 && !allowFailure) throw new IOException(diagnostic.Length > 2000 ? diagnostic[..2000] : diagnostic);
            return process.ExitCode == 0 ? text : "";
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            throw new IOException("Git did not finish within three minutes. Check repository access and retry.");
        }
        finally { if (!process.HasExited) process.Kill(true); }
    }
}
