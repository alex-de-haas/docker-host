using System.Threading.Channels;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace Haas.Hosty.Core;

/// <summary>Resumes durable waiting starts from registry/readiness changes after boot's priority barriers.</summary>
internal sealed class DependencyStartupService(
    AppRegistryStore apps, CoreLifecycleService lifecycle, ILogger<DependencyStartupService> logger) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        var changes = Channel.CreateBounded<bool>(new BoundedChannelOptions(1)
        {
            FullMode = BoundedChannelFullMode.DropOldest, SingleReader = true, AllowSynchronousContinuations = false,
        });
        void Changed(string _) => changes.Writer.TryWrite(true);
        apps.Changed += Changed;
        try
        {
            await lifecycle.DependencyStartupReady.WaitAsync(stoppingToken);
            changes.Writer.TryWrite(true); // Resync includes changes missed before subscription.
            await foreach (var _ in changes.Reader.ReadAllAsync(stoppingToken))
            {
                try { await lifecycle.ResumeWaitingAppsAsync(stoppingToken); }
                catch (Exception ex) when (!stoppingToken.IsCancellationRequested)
                { logger.LogWarning(ex, "Could not resume dependency-waiting applications."); }
            }
        }
        catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { }
        finally { apps.Changed -= Changed; }
    }
}
