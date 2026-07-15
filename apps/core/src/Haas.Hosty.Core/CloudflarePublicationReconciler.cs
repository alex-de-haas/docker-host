using System.Text.Json.Nodes;
using Microsoft.Extensions.Logging;

namespace Haas.Hosty.Core;

// One-click Cloudflare public ingress, phase 2b: the read-modify-write reconciler that publishes or
// unpublishes one Hosty-owned hostname on the adopted remotely managed tunnel. It touches only the exact
// hostname it owns and preserves everything else (via CloudflareTunnelConfigPatcher). Ordering follows the
// plan: on publish the tunnel route is written before DNS (public DNS never points at a missing route); on
// unpublish DNS is removed before the route (a partial failure leaves at worst an unreachable stale rule).
// Every mutation is followed by a read-back, and a failure rolls back only what THIS operation created. No
// operator/third-party route is ever changed. See docs/planning/one-click-cloudflare-public-ingress.md.
internal sealed class CloudflarePublicationReconciler(
    ICloudflareApiClient client,
    CloudflarePublicationStore publications,
    ILogger<CloudflarePublicationReconciler> logger)
{
    public async Task<CloudflarePublication> PublishAsync(
        string token,
        CloudflareIngressTarget target,
        string appId,
        string endpointKey,
        string label,
        string serviceUrl,
        CancellationToken cancellationToken = default)
    {
        var hostname = BuildHostname(label, target.BaseDomain);
        var existing = await publications.GetAsync(appId, endpointKey, cancellationToken);

        // Ownership: reject a hostname another Hosty endpoint already owns, or a pre-existing DNS record we
        // do not own (adoption is an explicit later action, not implicit here).
        var conflictingOwner = (await publications.ListAsync(cancellationToken))
            .FirstOrDefault(publication => HostnameEquals(publication.Hostname, hostname) &&
                !(string.Equals(publication.AppId, appId, StringComparison.Ordinal) && string.Equals(publication.EndpointKey, endpointKey, StringComparison.Ordinal)));
        if (conflictingOwner is not null)
        {
            throw new CloudflareConnectionException("cloudflare_hostname_owned", $"'{hostname}' is already published by another app endpoint ('{conflictingOwner.AppId}').");
        }

        var ownedRecordId = existing?.DnsRecordId;
        var foreignRecord = (await client.ListDnsRecordsAsync(token, target.ZoneId, hostname, cancellationToken))
            .FirstOrDefault(record => !string.Equals(record.Id, ownedRecordId, StringComparison.Ordinal));
        if (foreignRecord is not null && existing is null)
        {
            throw new CloudflareConnectionException("cloudflare_hostname_conflict", $"A DNS record for '{hostname}' already exists and is not managed by Hosty. Remove it or adopt it explicitly first.");
        }

        var cfTarget = $"{target.TunnelId}.cfargotunnel.com";
        var routeAdded = false;
        string? createdDnsId = null;
        try
        {
            // 1. Tunnel route first. On a label change (rename) the old hostname's route is removed in the
            // same PUT, so a rename never leaks the previous route.
            var config = await RequireConfigAsync(token, target, cancellationToken);
            var oldHostname = existing is not null && !HostnameEquals(existing.Hostname, hostname) ? existing.Hostname : null;
            var unrelatedBefore = UnrelatedProjection(config, hostname, oldHostname);
            var alreadyRouted = CloudflareTunnelConfigPatcher.IngressHostnames(config).Any(host => HostnameEquals(host, hostname));
            var patched = CloudflareTunnelConfigPatcher.UpsertIngress(config, hostname, serviceUrl);
            if (oldHostname is not null)
            {
                patched = CloudflareTunnelConfigPatcher.RemoveIngress(patched, oldHostname);
            }

            await client.PutTunnelConfigurationAsync(token, target.AccountId, target.TunnelId, patched, cancellationToken);
            routeAdded = !alreadyRouted;

            // 2. Read-back: our rule landed with the intended service, and nothing unrelated changed (the
            // old hostname, if any, is excluded from the comparison since we removed it on purpose).
            var readback = await RequireConfigAsync(token, target, cancellationToken);
            VerifyReadback(readback, hostname, serviceUrl, unrelatedBefore, oldHostname);

            // 3. DNS: proxied CNAME to the tunnel (create, or update an existing owned record).
            var record = ownedRecordId is not null
                ? await client.UpdateCnameAsync(token, target.ZoneId, ownedRecordId, hostname, cfTarget, proxied: true, cancellationToken)
                : await client.CreateCnameAsync(token, target.ZoneId, hostname, cfTarget, proxied: true, cancellationToken);
            if (ownedRecordId is null)
            {
                createdDnsId = record?.Id;
            }

            // 4. Persist ownership only after both remote changes verified.
            var publication = new CloudflarePublication(
                appId,
                endpointKey,
                NormalizeLabel(label),
                hostname,
                record?.Id ?? ownedRecordId,
                serviceUrl,
                CloudflareOwnershipStates.Owned,
                DateTimeOffset.UtcNow);
            await publications.UpsertAsync(publication, cancellationToken);
            return publication;
        }
        catch (Exception exception) when (exception is not OperationCanceledException)
        {
            await RollbackPublishAsync(token, target, hostname, routeAdded, createdDnsId, cancellationToken);
            throw;
        }
    }

    public async Task UnpublishAsync(
        string token,
        CloudflareIngressTarget target,
        string appId,
        string endpointKey,
        CancellationToken cancellationToken = default)
    {
        var publication = await publications.GetAsync(appId, endpointKey, cancellationToken);
        if (publication is null)
        {
            return;
        }

        // DNS first: a partial failure then leaves at worst an unreachable stale route, never a public DNS
        // name pointing at a removed route. Only a Hosty-owned record is deleted.
        if (publication.DnsRecordId is not null && string.Equals(publication.OwnershipState, CloudflareOwnershipStates.Owned, StringComparison.Ordinal))
        {
            try
            {
                await client.DeleteDnsRecordAsync(token, target.ZoneId, publication.DnsRecordId, cancellationToken);
            }
            catch (CloudflareApiException exception) when (exception.StatusCode == 404)
            {
                // Already gone (e.g. deleted from the dashboard) — treat as success and continue the cleanup
                // so the route and local record don't get stuck.
                logger.LogDebug("Cloudflare DNS record for '{Hostname}' was already absent during unpublish.", publication.Hostname);
            }
        }

        var config = await RequireConfigAsync(token, target, cancellationToken);
        var patched = CloudflareTunnelConfigPatcher.RemoveIngress(config, publication.Hostname);
        await client.PutTunnelConfigurationAsync(token, target.AccountId, target.TunnelId, patched, cancellationToken);

        await publications.RemoveAsync(appId, endpointKey, cancellationToken);
    }

    private async Task RollbackPublishAsync(string token, CloudflareIngressTarget target, string hostname, bool routeAdded, string? createdDnsId, CancellationToken cancellationToken)
    {
        // Reverse only what this operation created, re-reading current state so we never overwrite newer
        // dashboard changes with a cached document.
        if (createdDnsId is not null)
        {
            try
            {
                await client.DeleteDnsRecordAsync(token, target.ZoneId, createdDnsId, cancellationToken);
            }
            catch (Exception exception) when (exception is not OperationCanceledException)
            {
                logger.LogWarning(exception, "Cloudflare publish rollback could not delete the DNS record it created for '{Hostname}'.", hostname);
            }
        }

        if (routeAdded)
        {
            try
            {
                var config = await client.GetTunnelConfigurationAsync(token, target.AccountId, target.TunnelId, cancellationToken);
                if (config?.Config is { } current)
                {
                    await client.PutTunnelConfigurationAsync(token, target.AccountId, target.TunnelId, CloudflareTunnelConfigPatcher.RemoveIngress(current, hostname), cancellationToken);
                }
            }
            catch (Exception exception) when (exception is not OperationCanceledException)
            {
                logger.LogWarning(exception, "Cloudflare publish rollback could not remove the tunnel route it added for '{Hostname}'.", hostname);
            }
        }
    }

    private async Task<JsonObject> RequireConfigAsync(string token, CloudflareIngressTarget target, CancellationToken cancellationToken)
        => (await client.GetTunnelConfigurationAsync(token, target.AccountId, target.TunnelId, cancellationToken))?.Config
            ?? throw new CloudflareConnectionException("cloudflare_config_unavailable", "Could not read the tunnel configuration.");

    private static void VerifyReadback(JsonObject readback, string hostname, string serviceUrl, string unrelatedBefore, string? oldHostname)
    {
        var rule = (readback["ingress"] as JsonArray)?
            .OfType<JsonObject>()
            .FirstOrDefault(entry => HostnameEquals((string?)entry["hostname"], hostname));
        if (rule is null || !string.Equals((string?)rule["service"], serviceUrl, StringComparison.Ordinal))
        {
            throw new CloudflareConnectionException("cloudflare_readback_failed", $"The tunnel route for '{hostname}' did not read back as expected.");
        }

        if (!string.Equals(UnrelatedProjection(readback, hostname, oldHostname), unrelatedBefore, StringComparison.Ordinal))
        {
            throw new CloudflareConnectionException("cloudflare_readback_unrelated_changed", "The tunnel configuration changed unexpectedly during the update; retry.");
        }
    }

    // A stable string of everything OTHER than the target hostname's rule (and, on a rename, the old
    // hostname's rule): all sibling top-level keys and every other ingress rule in order. Comparing this
    // before/after proves the mutation touched only the target(s) and preserved warp-routing, other apps'
    // rules, order, and the catch-all. Rules with no hostname (the catch-all) are never excluded.
    private static string UnrelatedProjection(JsonObject config, string hostname, string? oldHostname)
    {
        var clone = (JsonObject)config.DeepClone();
        if (clone["ingress"] is JsonArray ingress)
        {
            for (var index = ingress.Count - 1; index >= 0; index--)
            {
                if (ingress[index] is JsonObject rule &&
                    !string.IsNullOrEmpty((string?)rule["hostname"]) &&
                    (HostnameEquals((string?)rule["hostname"], hostname) ||
                        (oldHostname is not null && HostnameEquals((string?)rule["hostname"], oldHostname))))
                {
                    ingress.RemoveAt(index);
                }
            }
        }

        return clone.ToJsonString();
    }

    private static string BuildHostname(string label, string baseDomain) => $"{NormalizeLabel(label)}.{baseDomain}";

    private static string NormalizeLabel(string label)
    {
        var normalized = label?.Trim().ToLowerInvariant() ?? "";
        if (normalized.Length == 0 || normalized.Contains('.') || normalized.Contains(' '))
        {
            throw new CloudflareConnectionException("cloudflare_label_invalid", "The public origin label must be a single DNS label (no dots or spaces).");
        }

        return normalized;
    }

    private static bool HostnameEquals(string? left, string? right)
        => string.Equals(left, right, StringComparison.OrdinalIgnoreCase);
}

// The adopted tunnel's coordinates, resolved from the persisted connection state.
internal sealed record CloudflareIngressTarget(string AccountId, string ZoneId, string TunnelId, string BaseDomain);
