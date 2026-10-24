using System.Diagnostics;
using System.Text.Json;
using Haas.Hosty.Launch;
using Spectre.Console;

namespace Haas.Hosty.Cli.Commands;

internal sealed partial class CoreCommand
{
    private async Task PrepareWorkspaceContinuationAsync(CoreStartTarget target)
    {
        // Workspace activation/Return helpers already own their independent durable handover.
        if (launchLease is null) return;
        var current = (await ReadCoreStatusAsync(suppressErrors: true))?.Launch;
        if (workspaceContinuation is not null || WorkspaceCoreLaunchContinuation.Owner(context.Environment.RootDirectory, current, target.ProjectPath) is not null)
            await WorkspaceActivationCapability.RequireAsync(target.FileName);
        if (workspaceContinuation is not null) return;
        workspaceContinuation = WorkspaceCoreLaunchContinuation.Prepare(context.Environment.RootDirectory,
            activeOperationId ?? localLaunchRequestId, current, target.ProjectPath, target.FileName, target.GenerationPath);
    }

    // Explicit local administrator recovery for old launches without continuation receipts. This
    // does not pretend historical ancestry was proven, build code, stop Core or change its Return.
    private async Task<int> AdoptWorkspaceAsync(string[] args)
    {
        if (args.Length != 5 || !Guid.TryParseExact(args[0], "D", out _) || args[1] != "--instance" || args[3] != "--generation" ||
            !Path.IsPathFullyQualified(args[4]))
            throw new CommandUsageException("Supply an activation UUID, --instance <pid:ticks> and --generation <absolute-path> from the factual current Core.", Usage);
        try { return await AdoptReviewedWorkspaceAsync(args); }
        catch (Exception error) when (error is IOException or InvalidOperationException or ArgumentException or UnauthorizedAccessException or
            System.ComponentModel.Win32Exception or CoreControlException or CoreControlTimeoutException or HttpRequestException or JsonException or KeyNotFoundException)
        {
            context.Error.MarkupLine($"[red]Unable to adopt workspace:[/] {Markup.Escape(error.Message)}");
            return 1;
        }
    }

    private async Task<int> AdoptReviewedWorkspaceAsync(string[] args)
    {
        var root = context.Environment.RootDirectory;
        using var lease = CoreLaunchFiles.Lock(root);
        CoreLaunchFiles.AssertNoPendingOperations(root);
        var status = await ReadCoreStatusAsync() ?? throw new IOException("The intended Core is unavailable. No workspace ownership was changed.");
        var launch = RequireAdoptionInstance(status, root, args[2], args[4]);
        var activation = WorkspaceRuntimeFiles.Read(root, args[0]);
        var source = await ResolveAdoptionSourceAsync(root);
        ValidateAdoptionBinding(root, activation, launch, source);
        using var process = Process.GetProcessById(launch.ProcessId);
        if (!CoreBuildRetention.IsAlive(launch.ProcessId, launch.StartedAt)) throw new IOException("The reviewed Core process exited.");
        var executable = process.MainModule?.FileName ?? throw new IOException("The factual Core executable is unavailable.");
        var hash = WorkspaceCoreLaunchContinuation.ValidateManaged(root, launch.ProjectPath!, executable, launch.GenerationPath!, launch);
        using (var core = await CoreControlClient.TryCreateAsync(context) ?? throw new IOException("Core is unavailable."))
            _ = await core.PostAsync<JsonElement>("workspace-activations/" + activation.Id + "/validate-authority");
        // The control request can yield; recheck the exact process and ownership before publishing.
        var fresh = await ReadCoreStatusAsync() ?? throw new IOException("Core changed during adoption review.");
        if (RequireAdoptionInstance(fresh, root, args[2], args[4]) != launch ||
            WorkspaceCoreLaunchContinuation.ValidateManaged(root, launch.ProjectPath!, executable, launch.GenerationPath!, launch) != hash)
            throw new InvalidOperationException("Core changed during adoption review. Nothing was adopted.");
        var freshSource = await ResolveAdoptionSourceAsync(root);
        if (freshSource != source) throw new InvalidOperationException("Core source changed during adoption review. Nothing was adopted.");
        ValidateAdoptionBinding(root, activation, launch, freshSource);
        WorkspaceCoreLaunchContinuation.Adopt(root, Guid.NewGuid().ToString("N"), activation, launch, executable);
        context.Console.WriteLine("Current Core ownership was reconciled with the reviewed workspace. The captured Return target is unchanged.");
        return 0;
    }

    internal static CoreLaunchIdentity RequireAdoptionInstance(CoreStatusDocument status, string root, string instance, string generation)
    {
        if (status.DataRoot != root || status.Launch is not { Mode: "dev", ProjectPath: not null, GenerationPath: not null } launch ||
            instance != $"{launch.ProcessId}:{launch.StartedAt.UtcTicks}" || generation != launch.GenerationPath)
            throw new InvalidOperationException("Core changed or the requested instance/generation does not exactly match this data root. Nothing was adopted.");
        return launch;
    }

    internal static async Task<CoreSourceSettings> ResolveAdoptionSourceAsync(string root)
    {
        var saved = CoreLaunchFiles.Read(CoreLaunchFiles.SourcePath(root), CoreLaunchJson.Default.CoreSourceSettings)
            ?? throw new IOException("The reviewed Core source configuration is unavailable.");
        if (saved.SchemaVersion >= 1) return saved;
        // Legacy source files do not persist repository identity. Resolve only their existing
        // configured checkout, as Core does; missing provenance never implies a vendor repository.
        var checkout = saved.OverridePath ?? Path.Combine(root, "core", "source");
        var repository = Directory.Exists(checkout) ? await CoreBuildRepository.ReadOriginAsync(checkout) : null;
        if (repository is null)
            throw new InvalidOperationException("The existing legacy Core checkout has no verifiable repository origin. No workspace ownership was changed.");
        return saved with { RepositoryUrl = repository, SchemaVersion = 1 };
    }

    internal static void ValidateAdoptionBinding(string root, WorkspaceRuntimeActivation activation, CoreLaunchIdentity launch, CoreSourceSettings? resolvedSource = null)
    {
        if (activation.Phase != "active" || activation.CoreReturned || activation.CoreSupersededBy is not null || !activation.CoreReserved ||
            activation.CoreProject != launch.ProjectPath || activation.CoreWorktreeId is null ||
            activation.Authority is null || activation.Authority.UserId != activation.UserId)
            throw new InvalidOperationException("The selected activation does not own an active matching Core workspace.");
        var source = resolvedSource ?? CoreLaunchFiles.Read(CoreLaunchFiles.SourcePath(root), CoreLaunchJson.Default.CoreSourceSettings)
            ?? throw new IOException("The reviewed Core source configuration is unavailable.");
        if (source.Revision != activation.CoreSourceRevision || source.RepositoryUrl is null ||
            source.ConnectionId is not null && source.ConnectionOwnerId != activation.UserId)
            throw new InvalidOperationException("Core source ownership or its reviewed revision changed.");
        var id = activation.CoreWorktreeId;
        if (id.Length != 64 || id.Any(c => !Uri.IsHexDigit(c))) throw new InvalidOperationException("The Core worktree registration is invalid.");
        var tree = Path.Combine(root, "core", "development", "trees", id);
        if (new DirectoryInfo(tree).LinkTarget is not null) throw new IOException("A linked workspace cannot be adopted.");
        using var registration = JsonDocument.Parse(File.ReadAllText(Path.Combine(root, "core", "development", "workspaces", id + ".json")));
        var value = registration.RootElement;
        var project = Path.GetFullPath(Path.Combine(tree, source.ProjectPath));
        static string Repository(string text) => text.TrimEnd('/').EndsWith(".git", StringComparison.Ordinal)
            ? text.TrimEnd('/')[..^4] : text.TrimEnd('/');
        if (value.GetProperty("id").GetString() != id || value.GetProperty("workspaceId").GetString() != activation.WorkspaceId ||
            value.GetProperty("owner").GetProperty("userId").GetString() != activation.UserId ||
            value.GetProperty("state").GetString() != "active" || value.GetProperty("path").GetString() != tree ||
            project != launch.ProjectPath || !project.StartsWith(tree + Path.DirectorySeparatorChar, StringComparison.Ordinal) ||
            Repository(value.GetProperty("repository").GetString()!) != Repository(source.RepositoryUrl))
            throw new InvalidOperationException("Core no longer matches the registered workspace, source project and owner.");
    }
}
