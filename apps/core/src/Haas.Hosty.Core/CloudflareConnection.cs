using System.Net;
using System.Net.Sockets;
using Microsoft.Extensions.Logging;

namespace Haas.Hosty.Core;

// One-click Cloudflare public ingress, phase 1b: the connect/discover flow. Verifies a pasted scoped token
// by a resource probe, discovers the account/zone/tunnel/connectors, auto-selects the single healthy
// remotely managed tunnel, runs the advisory connector-locality check, and persists the token (private)
// plus the non-secret connection state. No DNS/tunnel mutation happens here (that is phase 2). Kept behind
// the existing IIngressController seam so this can move into an ingress-provider system app later.
// See docs/planning/one-click-cloudflare-public-ingress.md.
internal sealed class CloudflareConnectionService(
    ICloudflareApiClient client,
    CloudflareCredentialStore credentials,
    CloudflareIntegrationStore integration,
    ILogger<CloudflareConnectionService> logger,
    IClock? clock = null)
{
    private readonly IClock clock = clock ?? new SystemClock();

    public async Task<CloudflareConnectionStatus> ConnectAsync(string token, CancellationToken cancellationToken = default)
    {
        token = token?.Trim() ?? "";
        if (token.Length == 0)
        {
            throw new CloudflareConnectionException("cloudflare_token_missing", "Paste a Cloudflare API token to connect.");
        }

        // 1. Verify by a resource probe (account-owned tokens can't use /user/tokens/verify).
        var accounts = await ProbeAsync(() => client.ListAccountsAsync(token, cancellationToken));
        var account = Single(accounts, "account", "cloudflare_account_ambiguous",
            "This token can access more than one Cloudflare account; account selection is not supported yet.");

        // 2. Discover the zone / base domain.
        var zones = await ProbeAsync(() => client.ListZonesAsync(token, cancellationToken));
        var zone = Single(zones, "zone", "cloudflare_zone_ambiguous",
            "This token can access more than one zone; zone selection is not supported yet.");

        // 3. Discover the healthy remotely managed tunnel to adopt.
        var tunnels = await ProbeAsync(() => client.ListTunnelsAsync(token, account.Id, cancellationToken));
        var eligible = tunnels.Where(tunnel => tunnel.IsRemotelyManaged && tunnel.IsHealthy).ToArray();
        if (eligible.Length == 0)
        {
            throw new CloudflareConnectionException(
                "cloudflare_no_healthy_tunnel",
                "No healthy remotely managed Cloudflare tunnel was found. Start a remotely managed connector, then reconnect.");
        }

        var tunnel = Single(eligible, "tunnel", "cloudflare_tunnel_ambiguous",
            "More than one healthy remotely managed tunnel exists; tunnel selection is not supported yet.");

        // 4. Connector locality (advisory; degrades to unknown, never blocks).
        var connections = await ProbeAsync(() => client.GetTunnelConnectionsAsync(token, account.Id, tunnel.Id, cancellationToken));
        var connectorIps = connections.Select(connection => connection.OriginIp).OfType<string>().ToArray();
        var egress = await client.GetEgressIpAsync(cancellationToken);
        var locality = ConnectorLocality.Evaluate(connectorIps, egress is null ? [] : [egress]);
        if (locality == ConnectorLocality.NotLocal)
        {
            logger.LogWarning(
                "Cloudflare connector for tunnel '{Tunnel}' appears to run on a different host (connector IPs do not match this host's egress); public routes would target the wrong host.",
                tunnel.Name);
        }

        // 5. Token status/expiry (best-effort; the probe already proved validity).
        DateTimeOffset? expiresOn = null;
        string? tokenId = null;
        try
        {
            var status = await client.VerifyAccountTokenAsync(token, account.Id, cancellationToken);
            expiresOn = status?.ExpiresOn;
            tokenId = status?.Id;
        }
        catch (Exception exception) when (exception is not OperationCanceledException)
        {
            // Best-effort: validity is already proven by the resource probe, so any failure here (including
            // a transient network/transport error) must not fail the connection.
            logger.LogDebug(exception, "Cloudflare account token verify did not return status; continuing (validity already proven by the resource probe).");
        }

        // 6. Persist: token (private) + non-secret connection state.
        await credentials.SaveAsync(new CloudflareCredential(token, tokenId, $"Hosty {zone.Name}", expiresOn), cancellationToken);
        var now = clock.UtcNow;
        var state = new CloudflareIntegrationState(
            Status: CloudflareConnectionStatuses.Connected,
            ReconnectReason: null,
            AccountId: account.Id,
            AccountName: account.Name,
            ZoneId: zone.Id,
            ZoneName: zone.Name,
            BaseDomain: zone.Name,
            TunnelId: tunnel.Id,
            TunnelName: tunnel.Name,
            ConnectorStatus: tunnel.Status,
            Locality: locality,
            ConnectedAt: now,
            UpdatedAt: now);
        await integration.SaveAsync(state, cancellationToken);

        return await ProjectAsync(state, cancellationToken);
    }

    public async Task<CloudflareConnectionStatus> StatusAsync(CancellationToken cancellationToken = default)
    {
        var state = await integration.LoadAsync(cancellationToken)
            ?? new CloudflareIntegrationState(CloudflareConnectionStatuses.Disconnected, null, null, null, null, null, null, null, null, null, null, null, null);
        return await ProjectAsync(state, cancellationToken);
    }

    public async Task<CloudflareConnectionStatus> DisconnectAsync(CancellationToken cancellationToken = default)
    {
        // The scoped token cannot revoke itself, so we delete the local copy and point the operator at the
        // dashboard. No Hosty-owned Cloudflare resources exist yet in this phase, so there is nothing to
        // clean up remotely.
        await credentials.DeleteAsync(cancellationToken);
        await integration.DeleteAsync(cancellationToken);
        return await StatusAsync(cancellationToken);
    }

    private async Task<CloudflareConnectionStatus> ProjectAsync(CloudflareIntegrationState state, CancellationToken cancellationToken)
    {
        var token = await credentials.GetSummaryAsync(cancellationToken);
        return new CloudflareConnectionStatus(
            state.Status,
            state.ReconnectReason,
            token,
            state.AccountName,
            state.BaseDomain,
            state.TunnelName,
            state.ConnectorStatus,
            state.Locality,
            state.ConnectedAt);
    }

    // Classify the auth failures the plan turns into connection errors; a 401 is an invalid/revoked token,
    // a 403 is a missing permission group.
    private static async Task<T> ProbeAsync<T>(Func<Task<T>> call)
    {
        try
        {
            return await call();
        }
        catch (CloudflareApiException exception)
        {
            var code = exception.StatusCode switch
            {
                401 => "cloudflare_token_invalid",
                403 => "cloudflare_token_forbidden",
                _ => "cloudflare_discovery_failed",
            };
            var detail = exception.CloudflareErrors.Count > 0 ? $" ({string.Join("; ", exception.CloudflareErrors)})" : "";
            throw new CloudflareConnectionException(code, exception.StatusCode switch
            {
                401 => $"The Cloudflare token is invalid or revoked{detail}.",
                403 => $"The Cloudflare token is missing a required permission{detail}. It needs Cloudflare Tunnel (Edit), DNS (Edit), and Zone (Read).",
                _ => $"Cloudflare discovery failed with status {exception.StatusCode}{detail}.",
            });
        }
    }

    private static T Single<T>(IReadOnlyList<T> items, string what, string ambiguousCode, string ambiguousMessage)
    {
        if (items.Count == 0)
        {
            throw new CloudflareConnectionException($"cloudflare_no_{what}", $"The Cloudflare token can access no {what}.");
        }

        if (items.Count > 1)
        {
            throw new CloudflareConnectionException(ambiguousCode, ambiguousMessage);
        }

        return items[0];
    }
}

// Connect/discover failures with a stable code the endpoint maps to a 4xx and the Shell branches on.
internal sealed class CloudflareConnectionException(string code, string message) : Exception(message)
{
    public string Code { get; } = code;
}

internal static class CloudflareConnectionStatuses
{
    public const string Connected = "connected";
    public const string Disconnected = "disconnected";
    public const string ReconnectRequired = "reconnect_required";
}

// Advisory connector-locality verdict. Dual-stack aware (the spike's connector reported an IPv6 origin_ip):
// a cross-family comparison with no same-family overlap is "unknown", never a false "not_local".
internal static class ConnectorLocality
{
    public const string Local = "local";
    public const string NotLocal = "not_local";
    public const string Unknown = "unknown";

    public static string Evaluate(IReadOnlyList<string> connectorIps, IReadOnlyList<string> egressIps)
    {
        var connectors = Normalize(connectorIps);
        var egress = Normalize(egressIps);
        if (connectors.Count == 0 || egress.Count == 0)
        {
            return Unknown;
        }

        // Any exact match (same address) means the connector runs on this host.
        if (connectors.Keys.Any(egress.ContainsKey))
        {
            return Local;
        }

        // Otherwise only compare within address families we actually observed an egress address for; a
        // connector family with no egress counterpart is inconclusive, not a mismatch.
        var egressFamilies = egress.Values.ToHashSet();
        var comparable = connectors.Values.Any(family => egressFamilies.Contains(family));
        return comparable ? NotLocal : Unknown;
    }

    // Canonical address -> address family, dropping anything unparseable.
    private static Dictionary<string, AddressFamily> Normalize(IReadOnlyList<string> values)
    {
        var result = new Dictionary<string, AddressFamily>(StringComparer.OrdinalIgnoreCase);
        foreach (var value in values)
        {
            if (!string.IsNullOrWhiteSpace(value) && IPAddress.TryParse(value.Trim(), out var address))
            {
                result[address.ToString()] = address.AddressFamily;
            }
        }

        return result;
    }
}

// Non-secret connection state, persisted under the private core data root (the token itself lives only in
// CloudflareCredentialStore). Per-publication ownership is added in a later phase.
internal sealed record CloudflareIntegrationState(
    string Status,
    string? ReconnectReason,
    string? AccountId,
    string? AccountName,
    string? ZoneId,
    string? ZoneName,
    string? BaseDomain,
    string? TunnelId,
    string? TunnelName,
    string? ConnectorStatus,
    string? Locality,
    DateTimeOffset? ConnectedAt,
    DateTimeOffset? UpdatedAt);

internal sealed class CloudflareIntegrationStore(CoreDataPaths paths)
{
    private readonly SemaphoreSlim gate = new(1, 1);

    private string StatePath => Path.Combine(paths.CoreRoot, "cloudflare-integration.json");

    public async Task<CloudflareIntegrationState?> LoadAsync(CancellationToken cancellationToken = default)
    {
        await gate.WaitAsync(cancellationToken);
        try
        {
            return await JsonStorage.ReadAsync<CloudflareIntegrationState>(StatePath, cancellationToken);
        }
        finally
        {
            gate.Release();
        }
    }

    public async Task SaveAsync(CloudflareIntegrationState state, CancellationToken cancellationToken = default)
    {
        await gate.WaitAsync(cancellationToken);
        try
        {
            // Owner-only: not the token, but account/zone/tunnel metadata and timestamps that should not be
            // world-readable.
            await JsonStorage.WriteAsync(StatePath, state, restrictToOwner: true, cancellationToken);
        }
        finally
        {
            gate.Release();
        }
    }

    public async Task DeleteAsync(CancellationToken cancellationToken = default)
    {
        await gate.WaitAsync(cancellationToken);
        try
        {
            if (File.Exists(StatePath))
            {
                File.Delete(StatePath);
            }
        }
        finally
        {
            gate.Release();
        }
    }
}

// POST /api/core/cloudflare/connect body.
internal sealed record CloudflareConnectRequest(string Token);

// The user-facing connection projection: masked token summary + non-secret discovery. Never carries the
// raw token.
internal sealed record CloudflareConnectionStatus(
    string Status,
    string? ReconnectReason,
    CloudflareCredentialSummary Token,
    string? AccountName,
    string? BaseDomain,
    string? TunnelName,
    string? ConnectorStatus,
    string? Locality,
    DateTimeOffset? ConnectedAt);

// GET /api/core/cloudflare/token-template: the dashboard URL to create the token plus the permission set to
// grant. The prefilled permission-group keys are a later UX refinement; the names are authoritative today.
internal sealed record CloudflareTokenTemplate(string Url, IReadOnlyList<string> RequiredPermissions);
