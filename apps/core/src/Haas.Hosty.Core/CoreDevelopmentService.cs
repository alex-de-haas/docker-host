using System.Diagnostics;
using Haas.Hosty.Launch;

namespace Haas.Hosty.Core;

internal sealed record CoreSourceRequest(string? OverridePath, string Revision, CoreSourceSelection? Repository = null);
internal sealed record CoreRestartRequest(string RequestId, string Instance, string? Mode = null, string? SourceRevision = null);
internal sealed record CoreDevelopmentState(CoreLaunchIdentity Launch, string Instance, bool Manageable,
    CoreSourceSettings Source, string ManagedPath, string SourcePath, string SelectedProjectPath, bool RestartRequired,
    string? Branch, string? Commit, int? ChangedFiles, long? Additions, long? Deletions, string? GitError, bool GitTruncated = false, CoreBuildProvenance? Build = null, string UpdateRepository = CoreSourceDefaults.UpdateRepository);

internal sealed partial class CoreDevelopmentService(HostyCoreRuntimeConfig config, CoreLaunchIdentity? identity = null, ISourceGitAccess? privateSources = null)
{
    private readonly SemaphoreSlim gate = new(1, 1);
    private readonly CoreLaunchIdentity launch = identity ?? CoreLaunchIdentity.Current();
    internal CoreLaunchIdentity Launch => launch;
    internal string Instance => $"{launch.ProcessId}:{launch.StartedAt.UtcTicks}";
    private string LegacyManagedPath => Path.Combine(config.DataRoot, "core", "source");

    public async Task<CoreDevelopmentState> GetAsync(CancellationToken cancellationToken = default)
    {
        var settings = await SourceSettingsAsync(cancellationToken);
        var sourceRoot = SelectedRoot(settings);
        var status = await GetSourceStatusAsync(cancellationToken);
        var available = status.State is "clean" or "changes";
        return new(launch, Instance, (launch.Mode is "dev" or "release") && CoreCliLauncher.ResolveCliPath() is not null,
            settings, ManagedRoot(settings), sourceRoot, Project(sourceRoot, settings.ProjectPath), launch.Mode == "dev" && settings.PendingForInstance == Instance,
            status.Branch, status.Head, available ? status.FileCount : null,
            status.LineStats?.Additions, status.LineStats?.Deletions,
            available ? null : status.Error ?? "Source checkout is unavailable.", status.Truncated, CoreBuildProvenance.Current);
    }

    private async Task<AppSourceStatus> ReadSourceStatusAsync(CancellationToken cancellationToken)
    {
        var settings = await SourceSettingsAsync(cancellationToken);
        return await AppSourceService.ReadScopeStatusAsync("hosty-core",
            () => launch.Mode == "dev" ? launch.ProjectPath is { } project ? Path.GetDirectoryName(project) : null
                : SelectedRoot(settings), null, DateTimeOffset.UtcNow, cancellationToken, entireRepository: true);
    }

    public async Task<AppSourceStatus> GetSourceStatusAsync(CancellationToken cancellationToken = default)
    {
        var status = await AppSourceService.AddLineStatisticsAsync(await ReadSourceStatusAsync(cancellationToken), cancellationToken);
        return status with { Files = status.Files.Select(file => file with { CanDiscard = false }).ToArray() };
    }

    public async Task<AppSourceDiff> GetSourceDiffAsync(AppSourceDiffRequest request, CancellationToken cancellationToken = default)
        => await AppSourceService.ReadScopeDiffAsync(await ReadSourceStatusAsync(cancellationToken), request, cancellationToken);

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

    public async Task<CoreLaunchOperation> RestartAsync(CoreRestartRequest request, CancellationToken cancellationToken, string? actor = null)
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
            var source = await SourceSettingsAsync(cancellationToken);
            if (source.Revision != request.SourceRevision) throw new InvalidOperationException("Source changed or its revision is missing; refresh before restarting.");
            var cli = CoreCliLauncher.ResolveCliPath() ?? throw new InvalidOperationException("The Hosty CLI is unavailable.");
            string? project = null;
            if (mode == "dev")
            {
                _ = await SourceGrantAsync(source, actor, cancellationToken);
                var useSelected = request.Mode == "dev" || source.PendingForInstance == Instance;
                if (useSelected) project = await PrepareSourceAsync(source, cancellationToken, actor: actor);
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

    private void CheckBusy() => CoreLaunchFiles.AssertNoPendingOperations(config.DataRoot);
}
