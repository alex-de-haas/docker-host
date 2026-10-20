using Haas.Hosty.Launch;

namespace Haas.Hosty.Core;

// A detached CLI owns handover. Core only redrives abandoned accepted attempts; deterministic
// failures and cancellation remain explicit operator recovery, never a background restart loop.
internal sealed class WorkspaceActivationRecovery(HostyCoreRuntimeConfig config,
    ILogger<WorkspaceActivationRecovery> logger) : BackgroundService
{
    internal WorkspaceActivationHelper Dispatch(string id, bool resume = false) => WorkspaceActivationSupervisor.Dispatch(config.DataRoot, id, resume, helper =>
    {
        var cli = CoreCliLauncher.ResolveCliPath() ?? throw new InvalidOperationException("The Hosty CLI is unavailable; resume through the local CLI.");
        CoreCliLauncher.SpawnDetached(cli, ["--data-root", config.DataRoot, "core", "activate-workspace", id, "--helper", helper.Attempt],
            config, "workspace-" + id + ".log", helper.LogPath);
    });

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(15));
        while (await timer.WaitForNextTickAsync(stoppingToken))
        {
            try
            {
                foreach (var activation in WorkspaceRuntimeFiles.List(config.DataRoot))
                {
                    if (activation.Phase is "active" or "returned" or "cancelled") continue;
                    var helper = WorkspaceActivationSupervisor.Read(config.DataRoot, activation.Id);
                    if (!WorkspaceActivationSupervisor.Pending(helper) || WorkspaceActivationSupervisor.Alive(helper!) ||
                        WorkspaceActivationSupervisor.CancellationRequested(config.DataRoot, activation.Id)) continue;
                    try { Dispatch(activation.Id); }
                    catch (Exception ex) when (ex is IOException or InvalidOperationException or System.ComponentModel.Win32Exception)
                    { logger.LogWarning(ex, "Workspace activation {Id} retains recovery state", activation.Id); }
                }
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or System.Text.Json.JsonException or System.ComponentModel.Win32Exception)
            { logger.LogWarning(ex, "Workspace activation recovery could not read retained state"); }
        }
    }
}
