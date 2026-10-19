using Haas.Hosty.Launch;
using System.Text.Json;
using Spectre.Console;

namespace Haas.Hosty.Cli.Commands;

internal sealed partial class CoreCommand
{
    // Local operator primitive. The durable supervisor, browser/MCP admission and reconnect flow
    // build on this boundary; this command deliberately never guesses a different runtime on failure.
    private async Task<int> ActivateWorkspaceAsync(string[] args)
    {
        if (args.Length != 1) throw new CommandUsageException("Supply a prepared workspace activation UUID.", Usage);
        var root = context.Environment.RootDirectory;
        using var launchLock = CoreLaunchFiles.Lock(root);
        CoreLaunchFiles.AssertNoPendingOperations(root);
        var activation = WorkspaceRuntimeFiles.Read(root, args[0]);
        if (activation.Phase == "active") { context.Console.WriteLine("Workspace activation is already active."); return 0; }
        if (activation.Phase is not ("prepared" or "apps-active"))
            throw new CommandUsageException("Activation is not prepared. Inspect its retained state before retrying.", Usage);
        try
        {
            var status = await ReadCoreStatusAsync();
            if (status?.Launch is not { } launch || launch != activation.PreviousCore)
                throw new InvalidOperationException("The running Core no longer matches the reviewed activation.");
            if (!Uri.TryCreate(status.ListenUrl, UriKind.Absolute, out _))
                throw new InvalidOperationException("The running Core listen address is unavailable.");
            CoreStartTarget? target = null;
            if (activation.CoreProject is not null)
            {
                CoreStateSnapshot.Preflight(root);
                target = await new CoreBuildService(context).PrepareAsync(activation.CoreProject);
                activation = activation with { PreparedExecutable = target.FileName, Generation = target.GenerationPath, Error = null };
                WorkspaceRuntimeFiles.Save(root, activation);
            }
            using (var core = await CoreControlClient.TryCreateAsync(context, operationTimeout: TimeSpan.FromMinutes(30))
                ?? throw new InvalidOperationException("The intended Core is unavailable."))
                _ = await core.PostAsync<JsonElement>("workspace-activations/" + activation.Id + "/apply-apps");
            activation = WorkspaceRuntimeFiles.Read(root, activation.Id);
            if (target is null) { context.Console.WriteLine("Selected workspace applications are active."); return 0; }
            activation = activation with { Phase = "core-stopping" };
            WorkspaceRuntimeFiles.Save(root, activation);
            if (await StopCoreAsync(keepApps: true) != StopOutcome.Stopped)
                throw new IOException("Core did not confirm exit. The candidate was not started.");
            var snapshot = CoreStateSnapshot.Create(root, activation.Id);
            activation = activation with { Phase = "core-starting", Snapshot = snapshot.Archive };
            WorkspaceRuntimeFiles.Save(root, activation);
            if (await StartAsync(["--project", activation.CoreProject!, "--url", status.ListenUrl!], target) != 0)
                throw new IOException("Candidate Core did not become ready. Retain its snapshot and sources; no fallback was started.");
            activation = activation with { Phase = "active", Error = null };
            WorkspaceRuntimeFiles.Save(root, activation);
            context.Console.WriteLine("Selected workspace apps and Core are active. Core snapshot: " + snapshot.Archive);
            return 0;
        }
        catch (Exception ex) when (ex is IOException or InvalidOperationException or CoreControlException)
        {
            var latest = WorkspaceRuntimeFiles.Read(root, activation.Id);
            if (latest.Phase == "prepared")
            {
                using var live = await CoreControlClient.TryCreateAsync(context);
                if (live is not null)
                {
                    try { _ = await live.PostAsync<JsonElement>("workspace-activations/" + latest.Id + "/release-preparation"); }
                    catch (Exception releaseError) when (releaseError is IOException or CoreControlException)
                    { context.Error.WriteLine("Preparation remains reserved: " + releaseError.Message); }
                    latest = WorkspaceRuntimeFiles.Read(root, latest.Id);
                }
            }
            WorkspaceRuntimeFiles.Save(root, latest with { Error = "Activation did not complete. Inspect participant journals and the CLI diagnostics; source and data are retained." });
            context.Error.WriteLine(ex.Message);
            return 1;
        }
    }
}
