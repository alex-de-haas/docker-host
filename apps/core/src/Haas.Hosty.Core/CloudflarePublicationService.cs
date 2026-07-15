namespace Haas.Hosty.Core;

// One-click Cloudflare public ingress, phase 3: the publication API that ties the connection, the reconciler,
// and app lifecycle together. Publishing a public origin for an app endpoint synchronizes DNS + the tunnel
// route (via the reconciler) and then records the resolved `https://<hostname>` into the app's
// HOSTY_PUBLIC_ORIGIN_<endpoint> setting, so a running app is flagged restart-required and a stopped app
// receives it on next start. Install-time port reservations guarantee the endpoint already has a local URL,
// so a stopped app can be published. See docs/planning/one-click-cloudflare-public-ingress.md.
internal sealed class CloudflarePublicationService(
    CloudflareIntegrationStore integration,
    CloudflareCredentialStore credentials,
    CloudflarePublicationReconciler reconciler,
    CloudflarePublicationStore publications,
    AppRegistryStore apps)
{
    public async Task<CloudflarePublicationResult> PublishAsync(string appId, string endpointKey, string label, CancellationToken cancellationToken = default)
    {
        var (token, target) = await RequireConnectionAsync(cancellationToken);
        var app = await apps.GetAppAsync(appId, cancellationToken)
            ?? throw new CloudflareConnectionException("cloudflare_app_not_found", $"App '{appId}' was not found.");
        var endpoint = app.Endpoints.FirstOrDefault(candidate =>
                string.Equals(candidate.Key, endpointKey, StringComparison.Ordinal) && candidate.Public)
            ?? throw new CloudflareConnectionException("cloudflare_endpoint_not_public", $"App '{appId}' has no public endpoint '{endpointKey}'.");
        if (string.IsNullOrWhiteSpace(endpoint.Url))
        {
            throw new CloudflareConnectionException(
                "cloudflare_endpoint_no_local_url",
                $"Endpoint '{endpointKey}' has no local URL yet; it must have a reserved port before it can be published.");
        }

        var publication = await reconciler.PublishAsync(token, target, appId, endpointKey, label, endpoint.Url, cancellationToken);
        var publicOrigin = $"https://{publication.Hostname}";
        var updated = await apps.UpdateAppAsync(appId, record => WithPublicOrigin(record, endpointKey, publicOrigin), cancellationToken);
        return new CloudflarePublicationResult(appId, endpointKey, publication.Hostname, publicOrigin, IsRunning(updated.App));
    }

    public async Task<CloudflarePublicationResult> UnpublishAsync(string appId, string endpointKey, CancellationToken cancellationToken = default)
    {
        var (token, target) = await RequireConnectionAsync(cancellationToken);
        await reconciler.UnpublishAsync(token, target, appId, endpointKey, cancellationToken);
        var updated = await apps.UpdateAppAsync(appId, record => WithoutPublicOrigin(record, endpointKey), cancellationToken);
        return new CloudflarePublicationResult(appId, endpointKey, null, null, IsRunning(updated.App));
    }

    public async Task<CloudflareAppPublications> ListForAppAsync(string appId, CancellationToken cancellationToken = default)
    {
        var summaries = (await publications.ListForAppAsync(appId, cancellationToken))
            .Select(publication => new CloudflarePublicationSummary(
                publication.EndpointKey,
                publication.Label,
                publication.Hostname,
                $"https://{publication.Hostname}",
                publication.OwnershipState))
            .ToArray();
        return new CloudflareAppPublications(summaries);
    }

    private async Task<(string Token, CloudflareIngressTarget Target)> RequireConnectionAsync(CancellationToken cancellationToken)
    {
        var state = await integration.LoadAsync(cancellationToken);
        if (state is null ||
            !string.Equals(state.Status, CloudflareConnectionStatuses.Connected, StringComparison.Ordinal) ||
            string.IsNullOrWhiteSpace(state.AccountId) ||
            string.IsNullOrWhiteSpace(state.ZoneId) ||
            string.IsNullOrWhiteSpace(state.TunnelId) ||
            string.IsNullOrWhiteSpace(state.BaseDomain))
        {
            throw new CloudflareConnectionException("cloudflare_not_connected", "Connect Cloudflare before publishing a public origin.");
        }

        var credential = await credentials.LoadAsync(cancellationToken)
            ?? throw new CloudflareConnectionException("cloudflare_not_connected", "The Cloudflare token is missing; reconnect Cloudflare.");
        return (credential.Token, new CloudflareIngressTarget(state.AccountId, state.ZoneId, state.TunnelId, state.BaseDomain));
    }

    private static AppRecord WithPublicOrigin(AppRecord record, string endpointKey, string publicOrigin)
    {
        var key = PublicOriginSettings.BuildSettingKey(endpointKey);
        var settings = new Dictionary<string, AppSettingValue>(record.Settings, StringComparer.Ordinal)
        {
            [key] = new AppSettingValue(key, "url", publicOrigin, Secret: false),
        };
        return record with { Settings = settings };
    }

    private static AppRecord WithoutPublicOrigin(AppRecord record, string endpointKey)
    {
        var key = PublicOriginSettings.BuildSettingKey(endpointKey);
        if (!record.Settings.ContainsKey(key))
        {
            return record;
        }

        var settings = new Dictionary<string, AppSettingValue>(record.Settings, StringComparer.Ordinal);
        settings.Remove(key);
        return record with { Settings = settings };
    }

    private static bool IsRunning(AppRecord app) => string.Equals(app.RuntimeState, "running", StringComparison.Ordinal);
}

internal sealed record CloudflarePublishRequest(string EndpointKey, string Label);

internal sealed record CloudflareUnpublishRequest(string EndpointKey);

// `RestartRequired` is true when the owning app is running: the public origin is an environment value that
// takes effect on the app's next start, so a running app must be restarted to pick it up.
internal sealed record CloudflarePublicationResult(string AppId, string EndpointKey, string? Hostname, string? PublicOrigin, bool RestartRequired);

internal sealed record CloudflarePublicationSummary(string EndpointKey, string Label, string Hostname, string? PublicOrigin, string OwnershipState);

internal sealed record CloudflareAppPublications(IReadOnlyList<CloudflarePublicationSummary> Publications);
