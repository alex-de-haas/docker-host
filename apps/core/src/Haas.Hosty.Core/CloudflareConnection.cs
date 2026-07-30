using System.Net;
using System.Net.Sockets;
using Microsoft.Extensions.Logging;

namespace Haas.Hosty.Core;

// Cloudflare ingress: the connect/discover flow. Verifies a pasted scoped token
// by a resource probe, discovers the account/zone/tunnel/connectors, auto-selects the single healthy
// remotely managed tunnel, runs the advisory connector-locality check, and persists the token (private)
// plus the non-secret connection state. No DNS/tunnel mutation happens here — that is the publication
// path (CloudflarePublicationReconciler). Kept behind
// the existing IIngressController seam so this can move into an ingress-provider system app later.
// See docs/features/cloudflare-ingress/feature.md.
internal sealed class CloudflareConnectionService(
    ICloudflareApiClient client,
    CloudflareCredentialStore credentials,
    CloudflareIntegrationStore integration,
    ILogger<CloudflareConnectionService> logger,
    IClock? clock = null)
{
    private readonly IClock clock = clock ?? new SystemClock();

    // `selection` carries the operator's answers to any ambiguity a previous attempt reported. Connecting
    // is one call either way: the token is already in the browser at that moment, so a second round trip
    // repeats it rather than parking an unverified token server-side.
    public async Task<CloudflareConnectionStatus> ConnectAsync(
        string token,
        CloudflareConnectSelection? selection = null,
        CancellationToken cancellationToken = default)
    {
        token = token?.Trim() ?? "";
        if (token.Length == 0)
        {
            throw new CloudflareConnectionException("cloudflare_token_missing", "Paste a Cloudflare API token to connect.");
        }

        // 1. Verify by a resource probe (account-owned tokens can't use /user/tokens/verify).
        var accounts = await ProbeAsync(() => client.ListAccountsAsync(token, cancellationToken));
        var account = Choose(accounts, "account", selection?.AccountId, item => item.Id, item => item.Name, detail: _ => null);

        // 2. Discover the zone / base domain.
        var zones = await ProbeAsync(() => client.ListZonesAsync(token, cancellationToken));
        var zone = Choose(zones, "zone", selection?.ZoneId, item => item.Id, item => item.Name, detail: _ => null);

        // 3. Discover the healthy remotely managed tunnel to adopt.
        var tunnels = await ProbeAsync(() => client.ListTunnelsAsync(token, account.Id, cancellationToken));
        var eligible = tunnels.Where(tunnel => tunnel.IsRemotelyManaged && tunnel.IsHealthy).ToArray();
        if (eligible.Length == 0)
        {
            throw new CloudflareConnectionException(
                "cloudflare_no_healthy_tunnel",
                "No healthy remotely managed Cloudflare tunnel was found. Start a remotely managed connector, then reconnect.");
        }

        var tunnel = Choose(eligible, "tunnel", selection?.TunnelId, item => item.Id, item => item.Name, item => item.Status);

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

    // Records that the stored token no longer works, without touching the token, the discovery state, or
    // anything Hosty published. Called from the publication path, which is where a revoked, expired, or
    // permission-reduced token is actually discovered — Cloudflare pushes nothing, so a connection can only
    // be found broken at the moment it is used. Local intent survives: reconnecting a fresh token with the
    // same permissions makes every existing publication work again.
    public async Task MarkReconnectRequiredAsync(string reason, CancellationToken cancellationToken = default)
    {
        var state = await integration.LoadAsync(cancellationToken);
        if (state is null || string.Equals(state.Status, CloudflareConnectionStatuses.ReconnectRequired, StringComparison.Ordinal))
        {
            return;
        }

        logger.LogWarning("The stored Cloudflare token stopped working ({Reason}); the connection now needs reconnecting.", reason);
        await integration.SaveAsync(
            state with
            {
                Status = CloudflareConnectionStatuses.ReconnectRequired,
                ReconnectReason = reason,
                UpdatedAt = clock.UtcNow,
            },
            cancellationToken);
    }

    // Drops the stored token and the discovery state, and nothing else. Whether the published routes and
    // records go with it is the operator's Keep-or-Remove answer, and it is applied by the endpoint before
    // this runs — the removal needs the token, so it cannot happen after, and it must be able to stop the
    // disconnect when it fails (see CloudflareConnectionEndpoints).
    //
    // The scoped token cannot revoke itself, so the local copy is deleted and the operator is pointed at
    // the dashboard. Objects Hosty never created are never touched.
    public async Task<CloudflareConnectionStatus> DisconnectAsync(CancellationToken cancellationToken = default)
    {
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

    // Resolves one candidate: the only one when there is only one, the operator's pick when they made one,
    // and otherwise an ambiguity error that carries the candidates so the client can ask. Selection is not
    // a hard failure — the account with two zones is an ordinary account, not a misconfiguration.
    private static T Choose<T>(
        IReadOnlyList<T> items,
        string what,
        string? selectedId,
        Func<T, string> id,
        Func<T, string> name,
        Func<T, string?> detail)
    {
        if (items.Count == 0)
        {
            throw new CloudflareConnectionException($"cloudflare_no_{what}", $"The Cloudflare token can access no {what}.");
        }

        if (items.Count == 1)
        {
            return items[0];
        }

        if (!string.IsNullOrWhiteSpace(selectedId))
        {
            var picked = items.FirstOrDefault(item => string.Equals(id(item), selectedId, StringComparison.Ordinal));
            if (picked is not null)
            {
                return picked;
            }
            // A selection that no longer matches anything falls through to a fresh ambiguity error rather
            // than failing opaquely: the list may have changed between the two calls.
        }

        throw new CloudflareConnectionException(
            $"cloudflare_{what}_ambiguous",
            $"This token can access more than one {what}. Choose the one Hosty should use.",
            new CloudflareSelectionRequired(
                what,
                items.Select(item => new CloudflareSelectionOption(id(item), name(item), detail(item))).ToArray()));
    }
}

// Connect/discover failures with a stable code the endpoint maps to a 4xx and the Shell branches on.
// `Selection` is present only on an ambiguity: it carries the candidates so the client can ask rather than
// dead-end.
internal sealed class CloudflareConnectionException(string code, string message, CloudflareSelectionRequired? selection = null)
    : Exception(message)
{
    public string Code { get; } = code;

    public CloudflareSelectionRequired? Selection { get; } = selection;
}

// One candidate the operator can pick. `Detail` is a secondary line (a tunnel's health, say) or null.
internal sealed record CloudflareSelectionOption(string Id, string Name, string? Detail);

// What has to be chosen ("account", "zone", "tunnel") and the candidates for it.
internal sealed record CloudflareSelectionRequired(string Kind, IReadOnlyList<CloudflareSelectionOption> Options);

// The error body for an ambiguity: the ordinary code/message plus the candidates.
internal sealed record CloudflareSelectionErrorResponse(string Code, string Message, CloudflareSelectionRequired Selection);

// POST /api/core/cloudflare/disconnect body. Absent or false means Keep: nothing published is touched.
internal sealed record CloudflareDisconnectRequest(bool RemovePublished = false);

// The operator's answers to a previous ambiguity, echoed back with the token on the next connect attempt.
internal sealed record CloudflareConnectSelection(string? AccountId, string? ZoneId, string? TunnelId);

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
// CloudflareCredentialStore). Per-publication ownership lives in CloudflarePublicationStore.
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

    // True when a usable connection is stored. Read by the status warning and by the one-time provider
    // migration, both of which only need "is there a connection", not the discovery details.
    public async Task<bool> IsConnectedAsync(CancellationToken cancellationToken = default)
    {
        var state = await LoadAsync(cancellationToken);
        return state is not null &&
            string.Equals(state.Status, CloudflareConnectionStatuses.Connected, StringComparison.Ordinal);
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

// POST /api/core/cloudflare/connect body. The three ids are the operator's answers to an ambiguity the
// previous attempt reported; all null on a first attempt.
internal sealed record CloudflareConnectRequest(string Token, string? AccountId = null, string? ZoneId = null, string? TunnelId = null)
{
    public CloudflareConnectSelection Selection => new(AccountId, ZoneId, TunnelId);
}

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
