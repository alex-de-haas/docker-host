using Microsoft.Extensions.Logging;

namespace Haas.Hosty.Core;

// Cloudflare ingress: the publication API that ties the connection, the reconciler,
// and app lifecycle together. Publishing a public origin for an app endpoint synchronizes DNS + the tunnel
// route (via the reconciler) and then records the resolved `https://<hostname>` into the app's
// HOSTY_PUBLIC_ORIGIN_<endpoint> setting, so a running app is flagged restart-required and a stopped app
// receives it on next start. Install-time port reservations guarantee the endpoint already has a local URL,
// so a stopped app can be published. See docs/features/cloudflare-ingress/feature.md.
internal sealed class CloudflarePublicationService(
    CoreSettingsService settings,
    CloudflareIntegrationStore integration,
    CloudflareCredentialStore credentials,
    CloudflareConnectionService connection,
    CloudflarePublicationReconciler reconciler,
    CloudflarePublicationStore publications,
    AppRegistryStore apps,
    ICloudflareApiClient client,
    ILogger<CloudflarePublicationService> logger,
    // Publication outcomes reach the host administrator's notification feed. Optional only for unit
    // fixtures; production DI always supplies it, and a notification failure never fails a publish.
    NotificationService? notifications = null)
{
    public async Task<CloudflarePublicationResult> PublishAsync(string appId, string endpointKey, string label, bool adopt = false, CancellationToken cancellationToken = default)
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

        // Locality is re-checked here rather than only at connect: a connector can be moved to another
        // machine long after the token was pasted, and a hostname routed to a connector that is not on this
        // host reaches the wrong machine. Advisory — it is reported, never a refusal, because the check
        // compares observed egress addresses and can legitimately be inconclusive.
        var locality = await RefreshLocalityAsync(token, target, cancellationToken);

        CloudflarePublication publication;
        try
        {
            publication = await WithReconnectDetectionAsync(
                () => reconciler.PublishAsync(token, target, appId, endpointKey, label, endpoint.Url, adopt, cancellationToken),
                cancellationToken);
        }
        catch (Exception exception) when (exception is not OperationCanceledException)
        {
            await NotifyAsync(
                "error",
                $"Publishing '{app.DisplayName}' failed",
                exception.Message,
                $"cloudflare-publish-failed:{appId}:{endpointKey}",
                cancellationToken);
            throw;
        }

        var publicOrigin = $"https://{publication.Hostname}";
        var updated = await apps.UpdateAppAsync(appId, record => WithPublicOrigin(record, endpointKey, publicOrigin), cancellationToken);
        // A running app is still serving the previous origin until it restarts. Recorded on the publication
        // rather than only returned, so the state survives the toast that reported it.
        var restartRequired = IsRunning(updated.App);
        await publications.UpdateAsync(appId, endpointKey, entry => entry with { PendingRestart = restartRequired }, cancellationToken);
        await NotifyAsync(
            "success",
            $"'{app.DisplayName}' published at {publication.Hostname}",
            restartRequired
                ? $"Restart '{app.DisplayName}' to serve the new address."
                : $"The address is live the next time '{app.DisplayName}' starts.",
            $"cloudflare-published:{appId}:{endpointKey}",
            cancellationToken);
        return new CloudflarePublicationResult(appId, endpointKey, publication.Hostname, publicOrigin, restartRequired, locality);
    }

    public async Task<CloudflarePublicationResult> UnpublishAsync(string appId, string endpointKey, CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrWhiteSpace(endpointKey))
        {
            throw new CloudflareConnectionException("cloudflare_endpoint_invalid", "An endpoint key is required.");
        }

        var (token, target) = await RequireConnectionAsync(cancellationToken);
        // Clean the Cloudflare resources regardless (the reconciler tolerates an already-deleted record). Only
        // clear the managed setting when the app still exists: an already-uninstalled app has nothing to
        // update and must not surface as a 500 from UpdateAppAsync.
        await WithReconnectDetectionAsync(
            async () =>
            {
                await reconciler.UnpublishAsync(token, target, appId, endpointKey, cancellationToken);
                return true;
            },
            cancellationToken);
        var app = await apps.GetAppAsync(appId, cancellationToken);
        if (app is null)
        {
            return new CloudflarePublicationResult(appId, endpointKey, null, null, false, null);
        }

        var updated = await apps.UpdateAppAsync(appId, record => WithoutPublicOrigin(record, endpointKey), cancellationToken);
        return new CloudflarePublicationResult(appId, endpointKey, null, null, IsRunning(updated.App), null);
    }

    public async Task<CloudflareAppPublications> ListForAppAsync(string appId, CancellationToken cancellationToken = default)
    {
        var app = await apps.GetAppAsync(appId, cancellationToken);
        var running = app is not null && IsRunning(app);
        var state = await integration.LoadAsync(cancellationToken);
        var reconnectRequired = state is not null &&
            string.Equals(state.Status, CloudflareConnectionStatuses.ReconnectRequired, StringComparison.Ordinal);

        var summaries = (await publications.ListForAppAsync(appId, cancellationToken))
            .Select(publication => new CloudflarePublicationSummary(
                publication.EndpointKey,
                publication.Label,
                publication.Hostname,
                $"https://{publication.Hostname}",
                publication.OwnershipState,
                ResolveState(publication, running, reconnectRequired)))
            .ToArray();
        return new CloudflareAppPublications(summaries);
    }

    // What an operator needs to know about one published endpoint, in the order the answers matter.
    // "Not configured" is the absence of a publication, so it is never produced here — a caller with no
    // summary for an endpoint has it. There is no "syncing": publishing is synchronous, and inventing a
    // state nothing can produce would be a promise the UI cannot keep.
    private static string ResolveState(CloudflarePublication publication, bool appRunning, bool reconnectRequired)
    {
        if (reconnectRequired)
        {
            // The routes and the record are still there; what is gone is Hosty's ability to manage them.
            return CloudflarePublicationStates.Error;
        }

        if (!appRunning)
        {
            // A stopped app picks the origin up on its next start, so this is not "restart required".
            return CloudflarePublicationStates.AppStopped;
        }

        return publication.PendingRestart ? CloudflarePublicationStates.RestartRequired : CloudflarePublicationStates.Active;
    }

    // Clears the pending-restart flag for every publication of an app that is starting: the process about
    // to come up reads the current HOSTY_PUBLIC_ORIGIN_* values, which is exactly what the flag was
    // waiting for. Best-effort — this runs inside the start path and must never fail a start.
    public Task ClearPendingRestartAsync(string appId, CancellationToken cancellationToken = default)
        => publications.UpdateForAppAsync(appId, publication => publication with { PendingRestart = false }, cancellationToken);

    // Removes everything Hosty has published, for a disconnect answered with Remove. Returns how many
    // publications could NOT be removed: the caller keeps the connection when that is non-zero, because
    // the token is the only way to finish the job and throwing it away would strand the leftovers.
    public async Task<int> RemoveAllAsync(CancellationToken cancellationToken = default)
    {
        var all = await publications.ListAsync(cancellationToken);
        return all.Count - await RemoveAsync(all, "the Cloudflare connection was removed", cancellationToken);
    }

    // Removes every Hosty-owned route and DNS record for an app, for uninstall. Best-effort per
    // publication: a failure keeps the stored entry, because that entry is the only remaining pointer to
    // what Hosty created in Cloudflare — dropping it would turn a retryable leftover into a permanent one.
    public async Task<int> RemoveAllForAppAsync(string appId, CancellationToken cancellationToken = default)
        => await RemoveAsync(
            await publications.ListForAppAsync(appId, cancellationToken),
            "the app was uninstalled",
            cancellationToken);

    // Removes publications for endpoints the app no longer declares. Called after an update applies a new
    // manifest: an endpoint that is gone (or no longer public) can never serve the hostname again, so
    // leaving the route and record behind would publish a name that resolves to nothing.
    public async Task<int> RemoveOrphanedAsync(string appId, IReadOnlyCollection<string> publicEndpointKeys, CancellationToken cancellationToken = default)
    {
        var orphaned = (await publications.ListForAppAsync(appId, cancellationToken))
            .Where(publication => !publicEndpointKeys.Contains(publication.EndpointKey, StringComparer.Ordinal))
            .ToArray();
        return await RemoveAsync(orphaned, "the endpoint is no longer published by the app", cancellationToken);
    }

    private async Task<int> RemoveAsync(IReadOnlyList<CloudflarePublication> targets, string reason, CancellationToken cancellationToken)
    {
        if (targets.Count == 0)
        {
            return 0;
        }

        var removed = 0;
        foreach (var publication in targets)
        {
            try
            {
                await UnpublishAsync(publication.AppId, publication.EndpointKey, cancellationToken);
                removed++;
            }
            catch (Exception exception) when (exception is not OperationCanceledException)
            {
                logger.LogWarning(
                    exception,
                    "Could not remove the Cloudflare publication for '{Hostname}' ({Reason}); the route, the DNS record, and the stored publication are left in place for a retry.",
                    publication.Hostname,
                    reason);
            }
        }

        return removed;
    }

    // Re-observes where the connector runs and persists the verdict, so the connection card and the next
    // publish agree. Best-effort in both directions: a failed probe degrades to "unknown" rather than
    // blocking, exactly as it does at connect.
    private async Task<string> RefreshLocalityAsync(string token, CloudflareIngressTarget target, CancellationToken cancellationToken)
    {
        try
        {
            var connections = await client.GetTunnelConnectionsAsync(token, target.AccountId, target.TunnelId, cancellationToken);
            var connectorIps = connections.Select(connection => connection.OriginIp).OfType<string>().ToArray();
            var egress = await client.GetEgressIpAsync(cancellationToken);
            var locality = ConnectorLocality.Evaluate(connectorIps, egress is null ? [] : [egress]);

            var state = await integration.LoadAsync(cancellationToken);
            if (state is not null && !string.Equals(state.Locality, locality, StringComparison.Ordinal))
            {
                await integration.SaveAsync(state with { Locality = locality }, cancellationToken);
            }

            if (locality == ConnectorLocality.NotLocal)
            {
                logger.LogWarning(
                    "The Cloudflare connector does not appear to run on this host; a hostname published now would reach a different machine.");
            }

            return locality;
        }
        catch (Exception exception) when (exception is not OperationCanceledException)
        {
            logger.LogDebug(exception, "Connector locality could not be re-checked before the mutation; treating it as unknown.");
            return ConnectorLocality.Unknown;
        }
    }

    private async Task NotifyAsync(string level, string title, string body, string dedupeKey, CancellationToken cancellationToken)
    {
        if (notifications is null)
        {
            return;
        }

        try
        {
            await notifications.PublishAsync(
                new CoreScope(), NotificationService.BroadcastTarget, NotificationService.AudienceHostAdmin,
                level, title, body, link: null, dedupeKey, cancellationToken);
        }
        catch (Exception exception) when (exception is not OperationCanceledException)
        {
            logger.LogWarning(exception, "Failed to publish the Cloudflare publication notification '{Title}'.", title);
        }
    }

    // Cloudflare tells nobody that a token was revoked, expired, or had a permission removed — it is found
    // out here, on the next call that uses it. Recording it turns a repeated opaque failure into a state
    // Shell can prompt on, and it deliberately deletes nothing: routes, DNS, and the stored publications
    // stay, so reconnecting a fresh token makes them all work again.
    private async Task<T> WithReconnectDetectionAsync<T>(Func<Task<T>> action, CancellationToken cancellationToken)
    {
        try
        {
            return await action();
        }
        catch (CloudflareApiException exception) when (exception.StatusCode is 401 or 403)
        {
            var reason = exception.StatusCode == 401
                ? "The Cloudflare token is invalid or revoked."
                : "The Cloudflare token is missing a required permission.";
            await connection.MarkReconnectRequiredAsync(reason, cancellationToken);
            throw new CloudflareConnectionException("cloudflare_reconnect_required", $"{reason} Reconnect Cloudflare under Settings → Ingress.");
        }
    }

    private async Task<(string Token, CloudflareIngressTarget Target)> RequireConnectionAsync(CancellationToken cancellationToken)
    {
        // The provider is checked here rather than only in the client: publication and the local-config
        // provider are two ways to own the same HOSTY_PUBLIC_ORIGIN_* value, so allowing a publish while
        // another provider is selected is what let a published label be overwritten on the next start.
        if (!settings.Ingress.PublishesThroughApi)
        {
            throw new CloudflareConnectionException(
                "cloudflare_provider_inactive",
                $"Set the ingress provider to '{IngressSettings.ProviderCloudflareRemote}' before publishing a public origin.");
        }

        var state = await integration.LoadAsync(cancellationToken);
        // Distinct from "never connected": the discovery state and every publication are still here, and
        // the fix is a fresh token rather than a first-time setup.
        if (state is not null && string.Equals(state.Status, CloudflareConnectionStatuses.ReconnectRequired, StringComparison.Ordinal))
        {
            throw new CloudflareConnectionException(
                "cloudflare_reconnect_required",
                $"The stored Cloudflare token stopped working ({state.ReconnectReason ?? "reason unknown"}). Reconnect Cloudflare under Settings → Ingress.");
        }

        if (state is null ||
            !string.Equals(state.Status, CloudflareConnectionStatuses.Connected, StringComparison.Ordinal) ||
            string.IsNullOrWhiteSpace(state.AccountId) ||
            string.IsNullOrWhiteSpace(state.ZoneId) ||
            string.IsNullOrWhiteSpace(state.TunnelId) ||
            string.IsNullOrWhiteSpace(state.BaseDomain))
        {
            throw new CloudflareConnectionException("cloudflare_not_connected", "Connect Cloudflare before publishing a public origin.");
        }

        var credential = await credentials.LoadAsync(cancellationToken);
        if (credential is null || string.IsNullOrWhiteSpace(credential.Token))
        {
            throw new CloudflareConnectionException("cloudflare_not_connected", "The Cloudflare token is missing; reconnect Cloudflare.");
        }

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

    private static bool IsRunning(AppRecord app) => AppRuntimeStates.IsUp(app.RuntimeState);
}

// `Adopt` answers a cloudflare_hostname_conflict: take over the DNS record that already exists for this
// hostname instead of refusing. False on a first attempt.
internal sealed record CloudflarePublishRequest(string EndpointKey, string Label, bool Adopt = false);

internal sealed record CloudflareUnpublishRequest(string EndpointKey);

// `RestartRequired` is true when the owning app is running: the public origin is an environment value that
// takes effect on the app's next start, so a running app must be restarted to pick it up.
// `Locality` is the connector-locality verdict observed just before the mutation ("local", "not_local",
// "unknown"), or null when the operation performs no mutation. A "not_local" publish succeeded but points
// at a connector that is not on this host, which the client warns about.
internal sealed record CloudflarePublicationResult(
    string AppId,
    string EndpointKey,
    string? Hostname,
    string? PublicOrigin,
    bool RestartRequired,
    string? Locality);

// `State` is what an operator asks about a published endpoint; see ResolveState for what each value means
// and which ones Core can honestly produce.
internal sealed record CloudflarePublicationSummary(
    string EndpointKey,
    string Label,
    string Hostname,
    string? PublicOrigin,
    string OwnershipState,
    string State);

internal static class CloudflarePublicationStates
{
    // No publication exists for the endpoint. Produced by a caller finding no summary, never by Core.
    public const string NotConfigured = "not_configured";
    public const string Active = "active";
    public const string AppStopped = "app_stopped";
    public const string RestartRequired = "restart_required";
    public const string Error = "error";
}

internal sealed record CloudflareAppPublications(IReadOnlyList<CloudflarePublicationSummary> Publications);
