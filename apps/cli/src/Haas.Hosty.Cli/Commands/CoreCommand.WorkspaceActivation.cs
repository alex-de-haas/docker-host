using Haas.Hosty.Launch;
using System.Diagnostics;
using System.Text.Json;
using Spectre.Console;

namespace Haas.Hosty.Cli.Commands;

internal sealed partial class CoreCommand
{
    private async Task<int> ActivateWorkspaceAsync(string[] args)
    {
        if (args.Length == 3 && args[1] == "--helper") return await RunWorkspaceHelperAsync(args[0], args[2]);
        if (args.Length is < 1 or > 2 || args.Length == 2 && args[1] != "--resume")
            throw new CommandUsageException("Supply a prepared activation UUID and optionally --resume.", Usage);
        var root = context.Environment.RootDirectory;
        var helper = WorkspaceActivationSupervisor.Dispatch(root, args[0], args.Length == 2, h =>
        {
            var executable = Environment.ProcessPath ?? throw new InvalidOperationException("CLI executable is unavailable.");
            var command = new List<string>();
            if (Path.GetFileNameWithoutExtension(executable).Equals("dotnet", StringComparison.OrdinalIgnoreCase))
                command.Add(Path.Combine(AppContext.BaseDirectory, "hosty.dll"));
            command.AddRange(["--data-root", root, "core", "activate-workspace", h.Id, "--helper", h.Attempt]);
            DetachedCliProcess.SpawnDetached(executable, command, root, "workspace-" + h.Id + ".log", h.LogPath);
        });
        context.Console.WriteLine($"Activation {helper.Id}: {helper.State}. Inspect with core workspace-activation {helper.Id}.");
        context.Console.WriteLine("Helper log: " + helper.LogPath);
        return 0;
    }

    private async Task<int> ReturnWorkspaceAsync(string[] args)
    {
        if (args.Length < 2) throw new CommandUsageException("Supply activation UUID, Return UUID, --core and/or --app <id>, and optionally --accept-data-changes.", Usage);
        var apps = new List<string>(); var includeCore = false; var accept = false;
        for (var i = 2; i < args.Length; i++)
            switch (args[i])
            {
                case "--core": includeCore = true; break;
                case "--accept-data-changes": accept = true; break;
                case "--app" when i + 1 < args.Length: apps.Add(args[++i]); break;
                default: throw new CommandUsageException("Unknown Return option: " + args[i], Usage);
            }
        var root = context.Environment.RootDirectory;
        WorkspaceRuntimeActivation returning;
        using (CoreLaunchFiles.Lock(root))
            returning = WorkspaceActivationReturn.Prepare(root, args[0], new(args[1], apps.ToArray(), includeCore, accept));
        if (returning.Returns?.LastOrDefault() is not { State: "pending" } current || current.Request.RequestId != args[1])
            return await WorkspaceActivationStatusAsync([args[0]]);
        return await ActivateWorkspaceAsync([args[0], "--resume"]);
    }

    private Task<int> WorkspaceActivationStatusAsync(string[] args)
    {
        if (args.Length is < 1 or > 2 || args.Length == 2 && args[1] != "--cancel")
            throw new CommandUsageException("Supply an activation UUID and optionally --cancel.", Usage);
        var status = args.Length == 2
            ? WorkspaceActivationSupervisor.Cancel(context.Environment.RootDirectory, args[0])
            : WorkspaceActivationSupervisor.Status(context.Environment.RootDirectory, args[0]);
        context.Console.WriteLine(JsonSerializer.Serialize(status, WorkspaceSupervisorJson.Default.WorkspaceActivationStatus));
        return Task.FromResult(0);
    }

    private async Task<int> RunWorkspaceHelperAsync(string id, string attempt)
    {
        var root = context.Environment.RootDirectory;
        // Dispatch still owns the launch lock while the detached process starts (notably Windows).
        FileStream? lease = null;
        for (var i = 0; i < 50 && lease is null; i++)
        {
            try { lease = CoreLaunchFiles.Lock(root); }
            catch (IOException) { await Task.Delay(100); }
        }
        using var held = lease ?? throw new IOException("Another Core lifecycle operation owns the launch lock. Retry the original activation.");
        var helper = WorkspaceActivationSupervisor.Claim(root, id, attempt);
        try
        {
            CoreLaunchFiles.AssertNoPendingOperations(root, ownWorkspaceId: id);
            await new WorkspaceActivationHandover(root, new WorkspaceRuntime(this, context)).RunAsync(id);
            WorkspaceActivationSupervisor.Save(root, helper with { State = "completed", Error = null });
            return 0;
        }
        catch (Exception ex) when (ex is IOException or InvalidOperationException or CoreControlException or
            HttpRequestException or OperationCanceledException or System.ComponentModel.Win32Exception)
        {
            WorkspaceActivationSupervisor.Save(root, helper with { State = ex is OperationCanceledException || WorkspaceActivationSupervisor.CancellationRequested(root, id) ? "paused" : "failed",
                Error = "Activation did not finish. Inspect the retained phase and helper log; resume the original request." });
            context.Error.WriteLine(ex.Message);
            return 1;
        }
    }

    private sealed class WorkspaceRuntime(CoreCommand command, CommandContext context) : IWorkspaceActivationRuntime
    {
        public async Task<WorkspaceCoreObservation?> ObserveAsync()
        {
            var status = await command.ReadCoreStatusAsync(suppressErrors: true);
            if (status?.Launch is not { } launch || status.ListenUrl is not { } url) return null;
            using var process = Process.GetProcessById(launch.ProcessId);
            var executable = process.MainModule?.FileName;
            if (Path.GetFileNameWithoutExtension(executable) == "dotnet") executable = null;
            return new(launch, url, executable);
        }
        public async Task<WorkspaceCoreOutput> BuildAsync(string project)
        {
            var target = await new CoreBuildService(context).PrepareAsync(project);
            return new(target.FileName, target.GenerationPath!);
        }
        private async Task PostAsync(string id, string action)
        {
            using var core = await CoreControlClient.TryCreateAsync(context, operationTimeout: TimeSpan.FromMinutes(30))
                ?? throw new IOException("The intended Core is unavailable.");
            _ = await core.PostAsync<JsonElement>("workspace-activations/" + id + "/" + action);
        }
        public Task ValidateAuthorityAsync(string id) => PostAsync(id, "validate-authority");
        public async Task<WorkspaceReturnAppState[]> CaptureReturnAppsAsync(WorkspaceRuntimeActivation activation)
        {
            using var core = await CoreControlClient.TryCreateAsync(context) ?? throw new IOException("Core is unavailable.");
            var apps = await core.GetAsync<JsonElement>("apps");
            return WorkspaceReturnAppRecovery.Capture(apps, activation.ReturnedApps ?? []);
        }
        public async Task RestoreReturnAppsAsync(WorkspaceRuntimeActivation activation, WorkspaceReturnAppState[] apps)
        {
            using var core = await CoreControlClient.TryCreateAsync(context, operationTimeout: TimeSpan.FromMinutes(10))
                ?? throw new IOException("The returned Core is unavailable.");
            await WorkspaceReturnAppRecovery.RestoreAsync(apps,
                () => core.GetAsync<JsonElement>("apps"),
                (app, running) => WorkspaceReturnAppRecovery.RestoreTargetAsync(
                    async (path, body) => { _ = await core.PostAsync<JsonElement>(path, body); },
                    activation.Id, activation.Returns!.Last().Request.RequestId, app),
                app =>
                {
                    var current = WorkspaceRuntimeFiles.Read(context.Environment.RootDirectory, activation.Id);
                    var receipts = current.Returns!;
                    var last = receipts[^1];
                    if (last.Request.RequestId != activation.Returns!.Last().Request.RequestId || last.State != "pending")
                        throw new IOException("The Return request changed. No retired request was reapplied.");
                    WorkspaceRuntimeFiles.Save(context.Environment.RootDirectory, current with { Returns = receipts.Select((r, i) =>
                        i == receipts.Length - 1 ? r with { AppsBeforeCoreReturn = r.AppsBeforeCoreReturn!.Select(a =>
                            a.AppId == app ? a with { BootObserved = true } : a).ToArray() } : r).ToArray() });
                },
                () => WorkspaceActivationSupervisor.CheckCancellation(context.Environment.RootDirectory, activation.Id));
            foreach (var app in apps.Where(a => a.WasRunning))
            {
                var health = await core.GetAsync<JsonElement>("apps/" + Uri.EscapeDataString(app.AppId) + "/health");
                if (health.GetProperty("status").GetString() != "healthy")
                    throw new IOException($"Returned app {app.AppId} has not confirmed readiness. Resume the retained Return request.");
            }
        }
        public Task ReturnAppsAsync(string id) => PostAsync(id, "return-apps");
        public Task ApplyAppsAsync(string id) => PostAsync(id, "apply-apps");
        public Task VerifyAppsAsync(string id) => PostAsync(id, "verify-apps");
        public Task ReleasePreparationAsync(string id) => PostAsync(id, "release-preparation");
        public async Task StopAsync()
        {
            if (await command.StopCoreAsync(keepApps: true) is not (StopOutcome.Stopped or StopOutcome.NotRunning))
                throw new IOException("The previous Core did not confirm exit.");
        }
        public async Task RestorePreviousAsync(WorkspaceRuntimeActivation activation)
        {
            WorkspaceActivationReturn.VerifyPrevious(activation);
            if (!File.Exists(activation.PreviousExecutable)) throw new IOException("The captured previous Core executable is unavailable.");
            var prior = activation.PreviousCore;
            var target = new CoreStartTarget(activation.PreviousExecutable!, Path.GetDirectoryName(activation.PreviousExecutable!)!, [],
                prior.ProjectPath, prior.GenerationPath);
            var args = new List<string> { "--url", activation.ListenUrl! };
            if (prior.ProjectPath is not null) args.AddRange(["--project", prior.ProjectPath]);
            if (await command.StartAsync(args.ToArray(), target) != 0)
                throw new IOException("The captured previous Core could not resume the app transition. No alternate target was started.");
        }
        public async Task StartAsync(WorkspaceRuntimeActivation activation)
        {
            var target = new CoreStartTarget(activation.PreparedExecutable!, Path.GetDirectoryName(activation.CoreProject!)!, [],
                activation.CoreProject, activation.Generation);
            if (await command.StartAsync(["--project", activation.CoreProject!, "--url", activation.ListenUrl!], target) != 0)
                throw new IOException("Candidate readiness was not confirmed. Inspect status and retry the same activation.");
        }
    }
}
