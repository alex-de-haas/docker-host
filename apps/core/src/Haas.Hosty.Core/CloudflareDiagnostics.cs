using Microsoft.Extensions.Logging;

namespace Haas.Hosty.Core;

// Cloudflare ingress: does what Hosty believes it published still match what Cloudflare actually serves?
//
// Publication is request-driven and never reconciled in the background, so the two can drift: a route
// deleted from the dashboard, a DNS record repointed, an app whose local port moved. Nothing here mutates
// anything — it reads once and reports, because a background writer would fight the operator's dashboard
// and this feature's standing rule is that Hosty touches only what it was asked to.
//
// It also answers the other half of the question: which public endpoints have no address at all. That one
// is deduplicated by construction (one entry per endpoint, computed from the app registry) rather than
// emitted as a warning per app per check.
internal sealed class CloudflareDiagnosticsService(
    CoreSettingsService settings,
    CloudflareIntegrationStore integration,
    CloudflareCredentialStore credentials,
    CloudflarePublicationStore publications,
    AppRegistryStore apps,
    ICloudflareApiClient client,
    ILogger<CloudflareDiagnosticsService> logger)
{
    public async Task<CloudflareDiagnostics> InspectAsync(CancellationToken cancellationToken = default)
    {
        var records = await apps.ListAppRecordsAsync(cancellationToken);
        var unpublished = BuildUnpublishedEndpoints(records, await publications.ListAsync(cancellationToken));

        var state = await integration.LoadAsync(cancellationToken);
        var credential = await credentials.LoadAsync(cancellationToken);
        var connected = state is not null &&
            string.Equals(state.Status, CloudflareConnectionStatuses.Connected, StringComparison.Ordinal) &&
            credential is not null &&
            !string.IsNullOrWhiteSpace(credential.Token) &&
            !string.IsNullOrWhiteSpace(state.AccountId) &&
            !string.IsNullOrWhiteSpace(state.ZoneId) &&
            !string.IsNullOrWhiteSpace(state.TunnelId);

        if (!settings.Ingress.PublishesThroughApi || !connected)
        {
            // Nothing to compare against. Reported rather than errored: the missing-origin half of the
            // answer is still useful, and is exactly what an operator on provider "none" wants.
            return new CloudflareDiagnostics(Checked: false, [], unpublished);
        }

        var target = new CloudflareIngressTarget(state!.AccountId!, state.ZoneId!, state.TunnelId!, state.BaseDomain ?? "");
        var stored = await publications.ListAsync(cancellationToken);
        if (stored.Count == 0)
        {
            return new CloudflareDiagnostics(Checked: true, [], unpublished);
        }

        IReadOnlyList<string> routedHostnames;
        try
        {
            var config = (await client.GetTunnelConfigurationAsync(credential!.Token, target.AccountId, target.TunnelId, cancellationToken))?.Config;
            routedHostnames = config is null ? [] : CloudflareTunnelConfigPatcher.IngressHostnames(config);
        }
        catch (Exception exception) when (exception is not OperationCanceledException)
        {
            logger.LogWarning(exception, "Cloudflare diagnostics could not read the tunnel configuration.");
            return new CloudflareDiagnostics(Checked: false, [], unpublished);
        }

        var routed = routedHostnames.ToHashSet(StringComparer.OrdinalIgnoreCase);
        var installed = records.Select(record => record.Id).ToHashSet(StringComparer.Ordinal);
        var expectedDnsContent = $"{target.TunnelId}.cfargotunnel.com";

        var results = new List<CloudflarePublicationDiagnostic>();
        foreach (var publication in stored)
        {
            results.Add(new CloudflarePublicationDiagnostic(
                publication.AppId,
                publication.EndpointKey,
                publication.Hostname,
                await ClassifyAsync(publication, credential!.Token, target, routed, installed, expectedDnsContent, cancellationToken)));
        }

        return new CloudflareDiagnostics(Checked: true, results, unpublished);
    }

    // One publication's verdict, most-broken first: an app that is gone explains everything else, a
    // missing route means the hostname resolves to nothing, and a repointed DNS record means someone
    // else's server answers for it.
    private async Task<string> ClassifyAsync(
        CloudflarePublication publication,
        string token,
        CloudflareIngressTarget target,
        IReadOnlySet<string> routed,
        IReadOnlySet<string> installed,
        string expectedDnsContent,
        CancellationToken cancellationToken)
    {
        if (!installed.Contains(publication.AppId))
        {
            return CloudflareDiagnosticStates.AppMissing;
        }

        if (!routed.Contains(publication.Hostname))
        {
            return CloudflareDiagnosticStates.RouteMissing;
        }

        try
        {
            var records = await client.ListDnsRecordsAsync(token, target.ZoneId, publication.Hostname, cancellationToken);
            if (records.Count == 0)
            {
                return CloudflareDiagnosticStates.DnsMissing;
            }

            // Content, not record id: an operator who recreated the record by hand still has a working
            // setup, and calling that "foreign" would send them chasing a problem they do not have.
            return records.Any(record => string.Equals(record.Content, expectedDnsContent, StringComparison.OrdinalIgnoreCase))
                ? CloudflareDiagnosticStates.Ok
                : CloudflareDiagnosticStates.DnsForeign;
        }
        catch (Exception exception) when (exception is not OperationCanceledException)
        {
            logger.LogDebug(exception, "Cloudflare diagnostics could not read the DNS record for '{Hostname}'.", publication.Hostname);
            return CloudflareDiagnosticStates.Unknown;
        }
    }

    // Public endpoints with neither a publication nor an operator-set origin: declared reachable from the
    // internet, and reachable from nowhere.
    private static IReadOnlyList<CloudflareUnpublishedEndpoint> BuildUnpublishedEndpoints(
        IReadOnlyList<AppRecord> records,
        IReadOnlyList<CloudflarePublication> publications)
    {
        var published = publications
            .Select(publication => (publication.AppId, publication.EndpointKey))
            .ToHashSet();

        return records
            .SelectMany(record => (record.Endpoints ?? [])
                .Where(endpoint => endpoint.Public && !string.IsNullOrWhiteSpace(endpoint.Key))
                .Where(endpoint => !published.Contains((record.Id, endpoint.Key)))
                .Where(endpoint => !record.Settings.TryGetValue(PublicOriginSettings.BuildSettingKey(endpoint.Key), out var setting) ||
                    string.IsNullOrWhiteSpace(setting.Value))
                .Select(endpoint => new CloudflareUnpublishedEndpoint(record.Id, record.DisplayName, endpoint.Key)))
            .OrderBy(entry => entry.AppId, StringComparer.Ordinal)
            .ThenBy(entry => entry.EndpointKey, StringComparer.Ordinal)
            .ToArray();
    }
}

internal static class CloudflareDiagnosticStates
{
    public const string Ok = "ok";
    // The owning app was uninstalled without the cleanup completing, so the hostname is an orphan.
    public const string AppMissing = "app_missing";
    // Hosty believes it published this, but the tunnel has no route for it — the hostname resolves to
    // nothing.
    public const string RouteMissing = "route_missing";
    public const string DnsMissing = "dns_missing";
    // A DNS record exists but points somewhere other than this tunnel.
    public const string DnsForeign = "dns_foreign";
    // The check itself could not complete; the publication may well be fine.
    public const string Unknown = "unknown";
}

// `Checked` is false when nothing could be compared — no API provider, no connection, or the tunnel
// configuration could not be read. `Publications` is empty in that case; `UnpublishedEndpoints` is not,
// because it needs nothing from Cloudflare.
internal sealed record CloudflareDiagnostics(
    bool Checked,
    IReadOnlyList<CloudflarePublicationDiagnostic> Publications,
    IReadOnlyList<CloudflareUnpublishedEndpoint> UnpublishedEndpoints);

internal sealed record CloudflarePublicationDiagnostic(string AppId, string EndpointKey, string Hostname, string State);

internal sealed record CloudflareUnpublishedEndpoint(string AppId, string DisplayName, string EndpointKey);
