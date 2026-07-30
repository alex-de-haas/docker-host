using Haas.Hosty.Core;

namespace Haas.Hosty.Core.Tests;

// A no-op IIngressController for tests where ingress is incidental (they exercise lifecycle/feed flows,
// not ingress). Production has a single controller that folds the "none" provider in; this stub just
// keeps those fixtures from having to wire up CoreSettingsService + HostyCoreRuntimeConfig.
internal sealed class NoopIngressController : IIngressController
{
    private static readonly IReadOnlyDictionary<string, string> Empty =
        new Dictionary<string, string>(StringComparer.Ordinal);

    public bool DerivesPublicOrigins => false;

    public IReadOnlyDictionary<string, string> ResolvePublicOrigins(
        string appId,
        string? subdomainOverride,
        IReadOnlyList<string> publicEndpointKeys)
        => Empty;

    public Task ReconcileAsync(IReadOnlyList<AppRecord> apps, CancellationToken cancellationToken = default)
        => Task.CompletedTask;
}
