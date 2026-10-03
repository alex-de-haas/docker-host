namespace Haas.Hosty.Core;

// Complete cleanup before the runtime supervisor can adopt or start installed apps.
internal sealed class AppPermissionMigration(AppRegistryStore apps) : IHostedService
{
    public Task StartAsync(CancellationToken cancellationToken)
        => apps.RemoveUnsupportedGrantsAsync(cancellationToken);

    public Task StopAsync(CancellationToken cancellationToken) => Task.CompletedTask;
}
