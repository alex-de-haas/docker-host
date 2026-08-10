using Microsoft.Extensions.Logging;

namespace Haas.Hosty.Core;

// The ingress controller for the `cloudflare-remote` provider: it materializes publications as desired
// state, the way the local provider materializes `config.yml`.
//
// It exists because materialization used to be a property of the *entry point* rather than of the
// provider. Publishing was reachable only from the publish endpoint, so a hostname followed its local
// port only when an operator happened to press a button; a port moved by anything else — the operator's
// own reassignment, the boot rehoming pass — left the tunnel routing to a port nothing listens on, and
// nothing in Hosty knew. Behind IIngressController the question "who changed the port" stops mattering:
// every caller that already reconciles gets the right behavior for the selected provider for free.
//
// Diffing is what makes reconciling at boot affordable. A publication stores the last target written into
// the tunnel, so an unchanged route costs no API call at all and a steady-state boot does no network I/O.
// Only the boot where something actually moved talks to Cloudflare.
internal sealed class CloudflareRemoteIngressController(
    CoreSettingsService settings,
    CloudflareIntegrationStore integration,
    CloudflareCredentialStore credentials,
    CloudflarePublicationStore publications,
    CloudflarePublicationReconciler reconciler,
    ILogger<CloudflareRemoteIngressController> logger) : IIngressController
{
    private static readonly IReadOnlyDictionary<string, string> Empty =
        new Dictionary<string, string>(StringComparer.Ordinal);

    // A publication owns its origin; this provider never derives one from a base domain.
    public bool DerivesPublicOrigins => false;

    public IReadOnlyDictionary<string, string> ResolvePublicOrigins(
        string appId,
        string? subdomainOverride,
        IReadOnlyList<string> publicEndpointKeys) => Empty;

    // Deliberately NOT gated on the active provider. A publication outlives a provider change — that is
    // why unpublish is ungated too (CloudflarePublicationService.RequireConnectionAsync) — so switching to
    // `none` or `cloudflared` leaves its hostname routed and live. Gating here would mean a port moved
    // after such a switch strands that hostname on a dead port with nothing even recording it. Creating a
    // publication stays gated; keeping an existing one correct is maintenance of something that exists.
    // The work is bounded by publications, so a host with none does nothing at all here.
    public async Task ReconcileAsync(IReadOnlyList<AppRecord> apps, CancellationToken cancellationToken = default)
    {
        try
        {
            // A port that moved and came back before anyone could push needs no API call — the route is
            // already right — but the marker recorded while it was wrong has to go, or the endpoint stays
            // reported as drifted forever.
            await ClearResolvedDriftAsync(apps, cancellationToken);

            var pending = await FindDriftedPublicationsAsync(apps, cancellationToken);
            if (pending.Count == 0)
            {
                return;
            }

            var connection = await TryResolveConnectionAsync(cancellationToken);
            if (connection is null)
            {
                // No usable token. Record the drift so it is visible and repairable, and stop: retrying a
                // missing connection on the startup path would only delay boot to reach the same answer.
                await RecordDriftAsync(pending, cancellationToken);
                logger.LogWarning(
                    "{Count} Cloudflare publication(s) point at a local port that moved, and no usable Cloudflare connection is stored. Reconnect Cloudflare to repair them.",
                    pending.Count);
                return;
            }

            var (token, target) = connection.Value;
            foreach (var (publication, serviceUrl) in pending)
            {
                cancellationToken.ThrowIfCancellationRequested();
                try
                {
                    await reconciler.RepointAsync(token, target, publication, serviceUrl, cancellationToken);
                }
                catch (Exception exception) when (exception is not OperationCanceledException)
                {
                    await RecordDriftAsync([(publication, serviceUrl)], cancellationToken);
                    logger.LogWarning(
                        exception,
                        "Could not re-point '{Hostname}' at {ServiceUrl}; the publication is recorded as drifted.",
                        publication.Hostname,
                        serviceUrl);
                }
            }
        }
        catch (Exception exception) when (exception is not OperationCanceledException)
        {
            // Same boundary the local provider keeps: reconciliation runs on the startup path and on
            // settings saves, so it reports and returns rather than throwing into either.
            logger.LogWarning(exception, "Cloudflare publication reconciliation did not complete.");
        }
    }

    // Publications whose endpoint's current local URL differs from the target last written into the tunnel.
    // A publication whose app or endpoint is gone, or whose endpoint has no URL yet, is skipped: removal is
    // the lifecycle cleanup path's job, and an endpoint with no local target has nothing to route to.
    private async Task<IReadOnlyList<(CloudflarePublication Publication, string ServiceUrl)>> FindDriftedPublicationsAsync(
        IReadOnlyList<AppRecord> apps,
        CancellationToken cancellationToken)
    {
        var byId = apps.ToDictionary(app => app.Id, StringComparer.Ordinal);
        var pending = new List<(CloudflarePublication, string)>();
        foreach (var publication in await publications.ListAsync(cancellationToken))
        {
            if (!byId.TryGetValue(publication.AppId, out var app))
            {
                continue;
            }

            var endpoint = app.Endpoints.FirstOrDefault(candidate =>
                string.Equals(candidate.Key, publication.EndpointKey, StringComparison.Ordinal));
            if (endpoint is null || string.IsNullOrWhiteSpace(endpoint.Url))
            {
                continue;
            }

            if (!string.Equals(endpoint.Url, publication.ServiceUrl, StringComparison.Ordinal))
            {
                pending.Add((publication, endpoint.Url!));
            }
        }

        return pending;
    }

    // Drop the drift marker from any publication whose endpoint URL now matches the target already in the
    // tunnel. Reached when a port moved while Cloudflare was unreachable and then moved back — a
    // reassignment undone, or a rehoming fallback the next boot corrected — so the route was never wrong
    // by the time anyone could act on it.
    private async Task ClearResolvedDriftAsync(IReadOnlyList<AppRecord> apps, CancellationToken cancellationToken)
    {
        var byId = apps.ToDictionary(app => app.Id, StringComparer.Ordinal);
        foreach (var publication in await publications.ListAsync(cancellationToken))
        {
            if (string.IsNullOrWhiteSpace(publication.DriftedServiceUrl) ||
                !byId.TryGetValue(publication.AppId, out var app))
            {
                continue;
            }

            var url = app.Endpoints
                .FirstOrDefault(candidate => string.Equals(candidate.Key, publication.EndpointKey, StringComparison.Ordinal))?.Url;
            if (string.IsNullOrWhiteSpace(url) || !string.Equals(url, publication.ServiceUrl, StringComparison.Ordinal))
            {
                continue;
            }

            await publications.UpdateAsync(
                publication.AppId,
                publication.EndpointKey,
                entry => entry with { DriftedServiceUrl = null },
                cancellationToken);
            logger.LogInformation(
                "'{Hostname}' is back on the port its route already names; clearing the recorded drift.",
                publication.Hostname);
        }
    }

    private async Task RecordDriftAsync(
        IReadOnlyList<(CloudflarePublication Publication, string ServiceUrl)> pending,
        CancellationToken cancellationToken)
    {
        foreach (var (publication, serviceUrl) in pending)
        {
            await publications.UpdateAsync(
                publication.AppId,
                publication.EndpointKey,
                entry => entry with { DriftedServiceUrl = serviceUrl },
                cancellationToken);
        }
    }

    // The non-throwing half of CloudflarePublicationService.RequireConnectionAsync. Reconciliation cannot
    // raise "connect Cloudflare first" at an operator who is not there — a missing, half-finished or
    // reconnect-required connection is simply "cannot push right now".
    private async Task<(string Token, CloudflareIngressTarget Target)?> TryResolveConnectionAsync(CancellationToken cancellationToken)
    {
        var state = await integration.LoadAsync(cancellationToken);
        if (state is null ||
            !string.Equals(state.Status, CloudflareConnectionStatuses.Connected, StringComparison.Ordinal) ||
            string.IsNullOrWhiteSpace(state.AccountId) ||
            string.IsNullOrWhiteSpace(state.ZoneId) ||
            string.IsNullOrWhiteSpace(state.TunnelId) ||
            string.IsNullOrWhiteSpace(state.BaseDomain))
        {
            return null;
        }

        var credential = await credentials.LoadAsync(cancellationToken);
        return credential is null || string.IsNullOrWhiteSpace(credential.Token)
            ? null
            : (credential.Token, new CloudflareIngressTarget(state.AccountId, state.ZoneId, state.TunnelId, state.BaseDomain));
    }
}

// The IIngressController the rest of Core talks to. Both providers are asked to reconcile on every call
// and each no-ops unless it is the selected one, so the provider stays an operator setting rather than a
// DI-time choice — and, critically, the local provider still gets to remove a `config.yml` it wrote before
// the operator switched away from it. Dispatching to exactly one controller would leave that file behind.
internal sealed class ProviderIngressController(
    CloudflaredIngressController local,
    CloudflareRemoteIngressController remote) : IIngressController
{
    // Only the local provider derives origins; the remote one's publications own theirs.
    public bool DerivesPublicOrigins => local.DerivesPublicOrigins;

    public IReadOnlyDictionary<string, string> ResolvePublicOrigins(
        string appId,
        string? subdomainOverride,
        IReadOnlyList<string> publicEndpointKeys)
        => local.ResolvePublicOrigins(appId, subdomainOverride, publicEndpointKeys);

    public async Task ReconcileAsync(IReadOnlyList<AppRecord> apps, CancellationToken cancellationToken = default)
    {
        await local.ReconcileAsync(apps, cancellationToken);
        await remote.ReconcileAsync(apps, cancellationToken);
    }
}
