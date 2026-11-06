namespace Haas.Hosty.Core;

// A source long-poll must not delay credential revocation. Core events contain only invalidation
// hints here; they are never forwarded to the history/execution consumer.
internal sealed class CoreProviderStreamWatch : IAsyncDisposable
{
    private readonly CoreEventSubscription subscription;
    private readonly CancellationTokenSource lifetime;
    private readonly Task monitor;
    internal CoreProviderStreamWatch(CoreEventHub events, HttpRequest request, CoreCapabilityCaller caller,
        CancellationTokenSource stream, Func<CancellationToken, Task> validate)
    {
        lifetime = CancellationTokenSource.CreateLinkedTokenSource(stream.Token);
        subscription = events.Subscribe(caller.User.Id, AppAccessPolicy.IsAdmin(caller.User),
            CoreSessionAuthorization.ReadSessionCredential(request).Value, toolActivity: true);
        monitor = Observe(stream, validate);
    }
    private async Task Observe(CancellationTokenSource stream, Func<CancellationToken, Task> validate)
    {
        try
        {
            await foreach (var _ in subscription.Reader.ReadAllAsync(lifetime.Token)) await validate(lifetime.Token);
            if (!lifetime.IsCancellationRequested) stream.Cancel();
        }
        catch (OperationCanceledException) when (lifetime.IsCancellationRequested) { }
        catch (Exception ex) when (ex is AppIdentityException or CoreProviderException) { stream.Cancel(); }
    }
    public async ValueTask DisposeAsync()
    {
        lifetime.Cancel(); subscription.Dispose();
        try { await monitor; } finally { lifetime.Dispose(); }
    }
}
