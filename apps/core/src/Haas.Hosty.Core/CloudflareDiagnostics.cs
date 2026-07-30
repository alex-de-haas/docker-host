using System.Globalization;
using System.Text.Json.Nodes;
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
    HostyCoreRuntimeConfig config,
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

        var stored = await publications.ListAsync(cancellationToken);
        if (!settings.Ingress.PublishesThroughApi || !connected)
        {
            // Nothing to compare against. The stored publications are still reported, with the state that
            // says so: switching the provider away leaves every route and DNS record in place, and an
            // operator who believes otherwise thinks they have stopped exposing something they have not.
            return new CloudflareDiagnostics(
                Checked: false,
                stored.Select(publication => new CloudflarePublicationDiagnostic(
                    publication.AppId, publication.EndpointKey, publication.Hostname, CloudflareDiagnosticStates.Unknown)).ToArray(),
                unpublished,
                InspectCore(null));
        }

        var target = new CloudflareIngressTarget(state!.AccountId!, state.ZoneId!, state.TunnelId!, state.BaseDomain ?? "");

        // One read of the tunnel configuration serves both checks below: every stored publication, and
        // Core's own hostname, which is routed through the same tunnel but is not a publication.
        IReadOnlyDictionary<string, string?> routed;
        try
        {
            var tunnelConfig = (await client.GetTunnelConfigurationAsync(credential!.Token, target.AccountId, target.TunnelId, cancellationToken))?.Config;
            routed = ReadRoutes(tunnelConfig);
        }
        catch (Exception exception) when (exception is not OperationCanceledException)
        {
            logger.LogWarning(exception, "Cloudflare diagnostics could not read the tunnel configuration.");
            return new CloudflareDiagnostics(Checked: false, [], unpublished, InspectCore(null));
        }

        if (stored.Count == 0)
        {
            return new CloudflareDiagnostics(
                Checked: true,
                [],
                unpublished,
                await InspectCoreAsync(credential!.Token, target, routed, cancellationToken));
        }

        var installed = records.Select(record => record.Id).ToHashSet(StringComparer.Ordinal);
        // Keyed by (app, endpoint) rather than by app: an update that drops an endpoint, or makes it
        // private, leaves a route and a record for a hostname the app can no longer serve. The value is the
        // endpoint's current local URL, so a port that moved shows up as a route pointing at the old one.
        var publicEndpoints = records
            .SelectMany(record => (record.Endpoints ?? [])
                .Where(endpoint => endpoint.Public && !string.IsNullOrWhiteSpace(endpoint.Key))
                .Select(endpoint => (Key: (record.Id, endpoint.Key), endpoint.Url)))
            .ToDictionary(entry => entry.Key, entry => entry.Url);
        var expectedDnsContent = $"{target.TunnelId}.cfargotunnel.com";

        var results = new List<CloudflarePublicationDiagnostic>();
        foreach (var publication in stored)
        {
            results.Add(new CloudflarePublicationDiagnostic(
                publication.AppId,
                publication.EndpointKey,
                publication.Hostname,
                await ClassifyAsync(publication, credential!.Token, target, routed, installed, publicEndpoints, expectedDnsContent, cancellationToken)));
        }

        return new CloudflareDiagnostics(
            Checked: true,
            results,
            unpublished,
            await InspectCoreAsync(credential!.Token, target, routed, cancellationToken));
    }

    // Core's own hostname. It rides the same tunnel as every publication but is not one: Core is not an
    // app, so nothing here owns a route or a DNS record for it and nothing creates one. What the operator
    // must create by hand is exactly what this reports, which is the one thing publishing an app cannot do
    // for them — and the native client and every invitation link are built from this origin.
    //
    // Unreachable without a connection, so the no-token path answers the part that needs no Cloudflare at
    // all: whether Core has been given a public origin in the first place.
    private CloudflareCoreDiagnostic InspectCore(CloudflareIngressTarget? target)
    {
        var origin = config.EffectiveCorePublicOrigin;
        var expectedService = $"http://localhost:{config.CorePort.ToString(CultureInfo.InvariantCulture)}";
        // Carried even when no origin is configured: that is exactly the case where the operator needs the
        // full recipe, and half of it ("point a CNAME at *what*?") is the half they cannot guess.
        var expectedDns = target is null ? null : $"{target.TunnelId}.cfargotunnel.com";

        if (string.IsNullOrWhiteSpace(config.CorePublicOrigin))
        {
            return new CloudflareCoreDiagnostic(origin, null, CloudflareDiagnosticStates.NotConfigured, expectedDns, expectedService);
        }

        if (!Uri.TryCreate(config.CorePublicOrigin, UriKind.Absolute, out var uri) || string.IsNullOrWhiteSpace(uri.Host))
        {
            return new CloudflareCoreDiagnostic(origin, null, CloudflareDiagnosticStates.Unknown, expectedDns, expectedService);
        }

        return new CloudflareCoreDiagnostic(origin, uri.Host, CloudflareDiagnosticStates.Unknown, expectedDns, expectedService);
    }

    private async Task<CloudflareCoreDiagnostic> InspectCoreAsync(
        string token,
        CloudflareIngressTarget target,
        IReadOnlyDictionary<string, string?> routed,
        CancellationToken cancellationToken)
    {
        var seed = InspectCore(target);
        if (seed.Hostname is null)
        {
            return seed;
        }

        // Core published somewhere this connection knows nothing about — the operator's own reverse proxy,
        // or a second zone. Legitimate, and not something to compare against this tunnel.
        if (!string.IsNullOrWhiteSpace(target.BaseDomain) &&
            !seed.Hostname.Equals(target.BaseDomain, StringComparison.OrdinalIgnoreCase) &&
            !seed.Hostname.EndsWith($".{target.BaseDomain}", StringComparison.OrdinalIgnoreCase))
        {
            return seed with { State = CloudflareDiagnosticStates.External };
        }

        if (!routed.ContainsKey(seed.Hostname))
        {
            return seed with { State = CloudflareDiagnosticStates.RouteMissing };
        }

        // Deliberately no `route_stale` check for Core the way publications get one. Core's port is a launch
        // setting rather than something the allocator moves, and the operator writes this rule by hand, so
        // "http://127.0.0.1:7070" against an expected "http://localhost:7070" would report drift that is not
        // drift. Presence is what can be verified without guessing at equivalent spellings.
        try
        {
            var records = await client.ListDnsRecordsAsync(token, target.ZoneId, seed.Hostname, cancellationToken);
            if (records.Count == 0)
            {
                return seed with { State = CloudflareDiagnosticStates.DnsMissing };
            }

            return records.Any(record => string.Equals(record.Content, seed.ExpectedDnsContent, StringComparison.OrdinalIgnoreCase))
                ? seed with { State = CloudflareDiagnosticStates.Ok }
                : seed with { State = CloudflareDiagnosticStates.DnsForeign };
        }
        catch (Exception exception) when (exception is not OperationCanceledException)
        {
            logger.LogDebug(exception, "Cloudflare diagnostics could not read the DNS record for Core's own hostname.");
            return seed;
        }
    }

    // One publication's verdict, most-broken first: an app that is gone explains everything else, a
    // missing route means the hostname resolves to nothing, and a repointed DNS record means someone
    // else's server answers for it.
    private async Task<string> ClassifyAsync(
        CloudflarePublication publication,
        string token,
        CloudflareIngressTarget target,
        IReadOnlyDictionary<string, string?> routed,
        IReadOnlySet<string> installed,
        IReadOnlyDictionary<(string AppId, string EndpointKey), string?> publicEndpoints,
        string expectedDnsContent,
        CancellationToken cancellationToken)
    {
        if (!installed.Contains(publication.AppId))
        {
            return CloudflareDiagnosticStates.AppMissing;
        }

        // The app is here but no longer declares this endpoint as public — an update dropped it and the
        // best-effort cleanup did not finish. The hostname now fronts something the app cannot serve.
        if (!publicEndpoints.TryGetValue((publication.AppId, publication.EndpointKey), out var localUrl))
        {
            return CloudflareDiagnosticStates.EndpointMissing;
        }

        if (!routed.TryGetValue(publication.Hostname, out var routedService))
        {
            return CloudflareDiagnosticStates.RouteMissing;
        }

        // The route survives a port reassignment; its target does not. Compared against the endpoint's
        // current URL rather than the publication's stored one, which is only what was true at publish.
        if (!string.IsNullOrWhiteSpace(localUrl) &&
            !string.IsNullOrWhiteSpace(routedService) &&
            !string.Equals(routedService, localUrl, StringComparison.OrdinalIgnoreCase))
        {
            return CloudflareDiagnosticStates.RouteStale;
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

    // Hostname -> the local service the tunnel currently forwards it to. Rules with no hostname (the
    // catch-all) are not routes to anything Hosty published.
    private static IReadOnlyDictionary<string, string?> ReadRoutes(JsonObject? config)
    {
        var routes = new Dictionary<string, string?>(StringComparer.OrdinalIgnoreCase);
        if (config?["ingress"] is not JsonArray ingress)
        {
            return routes;
        }

        foreach (var rule in ingress.OfType<JsonObject>())
        {
            var hostname = (string?)rule["hostname"];
            if (!string.IsNullOrWhiteSpace(hostname))
            {
                routes[hostname] = (string?)rule["service"];
            }
        }

        return routes;
    }
}

internal static class CloudflareDiagnosticStates
{
    public const string Ok = "ok";
    // The owning app was uninstalled without the cleanup completing, so the hostname is an orphan.
    public const string AppMissing = "app_missing";
    // The app is still installed but no longer declares this endpoint as public.
    public const string EndpointMissing = "endpoint_missing";
    // Hosty believes it published this, but the tunnel has no route for it — the hostname resolves to
    // nothing.
    public const string RouteMissing = "route_missing";
    // The route exists but forwards to a different local URL than the endpoint now has, e.g. after a port
    // reassignment that nothing re-published.
    public const string RouteStale = "route_stale";
    public const string DnsMissing = "dns_missing";
    // A DNS record exists but points somewhere other than this tunnel.
    public const string DnsForeign = "dns_foreign";
    // Core only: no HOSTY_CORE_PUBLIC_ORIGIN, so Core answers on loopback and has no public address at all.
    public const string NotConfigured = "not_configured";
    // Core only: published under a hostname outside the connected zone — someone else's proxy fronts it,
    // which is a legitimate setup this tunnel has nothing to say about.
    public const string External = "external";
    // The check itself could not complete; the publication may well be fine.
    public const string Unknown = "unknown";
}

// `Checked` is false when nothing could be compared — no API provider, no connection, or the tunnel
// configuration could not be read. `Publications` still lists what is stored in that case (with state
// `unknown`), because a provider switch leaves every published route and record in place and an operator
// needs to see that. `UnpublishedEndpoints` needs nothing from Cloudflare and is always answered.
internal sealed record CloudflareDiagnostics(
    bool Checked,
    IReadOnlyList<CloudflarePublicationDiagnostic> Publications,
    IReadOnlyList<CloudflareUnpublishedEndpoint> UnpublishedEndpoints,
    CloudflareCoreDiagnostic Core);

internal sealed record CloudflarePublicationDiagnostic(string AppId, string EndpointKey, string Hostname, string State);

// Core's own address, and the two objects an operator has to create by hand for it to work: a proxied
// CNAME to `ExpectedDnsContent`, and a tunnel rule sending `Hostname` to `ExpectedService`. Both are null
// when there is nothing to advise — no origin configured, or no connection to name a tunnel.
internal sealed record CloudflareCoreDiagnostic(
    string Origin,
    string? Hostname,
    string State,
    string? ExpectedDnsContent,
    string ExpectedService);

internal sealed record CloudflareUnpublishedEndpoint(string AppId, string DisplayName, string EndpointKey);
