using System.Text.RegularExpressions;

namespace Haas.Hosty.Core;

internal sealed class UserConnectionService(UserDirectoryStore users, UserConnectionProvider provider, IClock clock, AuditStore audit, CoreSettingsService settings)
{
    // Serializes refresh rotation and disconnect. User deletion is additionally fenced inside the
    // auth store's atomic mutation, so an in-flight provider response cannot resurrect an account.
    private readonly SemaphoreSlim gate = new(1, 1);
    private readonly Dictionary<string, Pending> pending = [];
    private sealed record Pending(string Id, string UserId, string SessionId, UserConnectionInput Input,
        string ClientId, ProviderDevice Device, DateTimeOffset ExpiresAt, DateTimeOffset NextPoll, int Interval);

    public async Task<UserProfileResponse> ProfileAsync(string userId, CancellationToken ct)
    {
        var state = await users.ReadAsync(ct);
        var user = RequireUser(state, userId);
        return new(user.Id, user.Email, user.DisplayName,
            (state.ProviderConnections ?? []).Where(c => c.UserId == userId).Select(Summary).ToArray(), provider.Availability);
    }
    public async Task<UserProfileResponse> UpdateProfileAsync(string userId, string name, CancellationToken ct)
    {
        name = BoundedName(name);
        await users.UpdateAsync(state =>
        {
            var user = RequireUser(state, userId);
            return state with { Users = state.Users.Select(u => u.Id == userId ? user with { DisplayName = name, UpdatedAt = clock.UtcNow } : u).ToArray() };
        }, ct);
        await Audit(userId, "profile.updated", userId, ct);
        return await ProfileAsync(userId, ct);
    }
    public Task<UserConnectionSummary> AddPatAsync(string userId, UserConnectionInput input, CancellationToken ct)
        => Locked(async () =>
        {
            input = Validate(input);
            if (string.IsNullOrWhiteSpace(input.Token) || input.Token.Length > 16384 || input.Token.Any(char.IsControl))
                throw new UserConnectionException("connection_token_invalid", "Enter a valid provider token.");
            RequireUser(await users.ReadAsync(ct), userId);
            var identity = await provider.IdentityAsync(input.Provider, input.Organization!, "pat", input.Token.Trim(), ct);
            var c = NewConnection(userId, input, identity, "pat", new(input.Token.Trim(), null, null), null);
            await SaveNew(c, ct);
            await Audit(userId, "connection.added", c.Id, ct);
            return Summary(c);
        }, ct);
    public Task<UserDeviceResponse> StartDeviceAsync(string userId, string sessionId, UserConnectionInput input, CancellationToken ct)
        => Locked(async () =>
        {
            input = Validate(input) with { Token = null };
            var state = await users.ReadAsync(ct);
            RequireUser(state, userId); RequireSession(state, userId, sessionId);
            Prune(state);
            if (pending.Count >= 256 || pending.Values.Count(p => p.UserId == userId) >= 3)
                throw new UserConnectionException("connection_attempt_limit", "Finish or cancel an existing connection attempt first.", 409);
            if ((state.ProviderConnections ?? []).Count(c => c.UserId == userId) >= 32)
                throw new UserConnectionException("connection_limit", "Remove an unused connection first.", 409);
            var clientId = provider.ClientId(input.Provider) ?? throw new UserConnectionException("provider_not_configured", "The host operator must configure the provider's OAuth client ID.", 409);
            var device = await provider.StartAsync(input, clientId, ct);
            var p = new Pending(Guid.NewGuid().ToString("N"), userId, sessionId, input, clientId, device,
                clock.UtcNow.AddSeconds(device.ExpiresIn), clock.UtcNow.AddSeconds(device.Interval), device.Interval);
            pending[p.Id] = p;
            return DeviceResponse(p);
        }, ct);
    public Task<UserDeviceResponse> PollAsync(string userId, string id, CancellationToken ct)
        => Locked(async () =>
        {
            Prune();
            if (!pending.TryGetValue(id, out var p) || p.UserId != userId)
                throw new UserConnectionException("connection_attempt_missing", "This connection attempt expired or was canceled. Start again.", 404);
            var state = await users.ReadAsync(ct);
            RequireUser(state, userId); RequireSession(state, userId, p.SessionId);
            if (p.NextPoll > clock.UtcNow) return DeviceResponse(p);
            // Reserve the interval before HTTP, including on a transport failure.
            pending[id] = p = p with { NextPoll = clock.UtcNow.AddSeconds(p.Interval) };
            try
            {
                var result = await provider.PollAsync(p.Input.Provider, p.Input.Tenant!, p.ClientId, p.Device.DeviceCode, ct);
                if (result.Pending is not null)
                {
                    if (result.Pending == "slow_down") pending[id] = p = p with { Interval = Math.Min(int.MaxValue - 5, p.Interval) + 5, NextPoll = clock.UtcNow.AddSeconds(Math.Min(int.MaxValue - 5, p.Interval) + 5) };
                    return DeviceResponse(p);
                }
                // OAuth authorization codes are consumed once. Do not repeat the exchange if identity
                // verification or persistence fails; a new explicit authorization is then required.
                pending.Remove(id);
                var token = result.Token!;
                var identity = await provider.IdentityAsync(p.Input.Provider, p.Input.Organization!, "oauth", token.AccessToken, ct);
                var c = NewConnection(userId, p.Input, identity, "oauth", token, p.ClientId);
                await users.UpdateAsync(s =>
                {
                    RequireSession(s, userId, p.SessionId);
                    return Add(s, c);
                }, ct);
                await Audit(userId, "connection.added", c.Id, ct);
                return new UserDeviceResponse(id, "connected", Connection: Summary(c));
            }
            catch (UserConnectionException ex) when (ex.Status != 502)
            {
                pending.Remove(id); throw;
            }
        }, ct);
    public Task<bool> CancelAsync(string userId, string id, CancellationToken ct)
        => Locked(() =>
        {
            if (pending.TryGetValue(id, out var p) && p.UserId == userId) pending.Remove(id);
            return Task.FromResult(true);
        }, ct);
    public Task<UserConnectionSummary> RenameAsync(string userId, string id, string label, CancellationToken ct)
        => Locked(async () =>
        {
            label = BoundedName(label);
            var updated = await users.UpdateAsync(s =>
            {
                var c = RequireConnection(s, userId, id) with { Label = label, Revision = Guid.NewGuid().ToString("N") };
                return (Replace(s, c), c);
            }, ct);
            await Audit(userId, "connection.renamed", id, ct);
            return Summary(updated);
        }, ct);
    public Task<bool> DisconnectAsync(string userId, string id, CancellationToken ct)
        => Locked(async () =>
        {
            await users.UpdateAsync(s =>
            {
                RequireUser(s, userId);
                return s with { ProviderConnections = (s.ProviderConnections ?? []).Where(c => c.UserId != userId || c.Id != id).ToArray() };
            }, ct);
            await Audit(userId, "connection.disconnected", id, ct);
            return true;
        }, ct);
    public Task<UserConnectionSummary> CheckAsync(string userId, string id, CancellationToken ct)
        => Locked(async () =>
        {
            var c = RequireConnection(await users.ReadAsync(ct), userId, id);
            try
            {
                if (c.Method == "oauth" && c.ExpiresAt <= clock.UtcNow.AddMinutes(2))
                {
                    var token = await provider.RefreshAsync(c, ct);
                    c = c with { AccessToken = token.AccessToken, RefreshToken = token.RefreshToken, ExpiresAt = token.ExpiresAt };
                    // Save token rotation even if the subsequent identity check is interrupted.
                    c = await SaveExisting(c, ct);
                }
                var identity = await provider.IdentityAsync(c.Provider, c.Organization, c.Method, c.AccessToken, ct);
                if (identity.Id != c.AccountId)
                    throw new UserConnectionException("provider_account_changed", "The external account changed. Disconnect and reconnect explicitly.", 409);
                c = await SaveExisting(c with { AccountName = identity.Name, CheckedAt = clock.UtcNow, Status = "connected" }, ct);
                await Audit(userId, "connection.checked", id, ct);
                return Summary(c);
            }
            catch (UserConnectionException ex)
            {
                await SaveExisting(c with { CheckedAt = clock.UtcNow, Status = ex.Status == 502 ? "unavailable" : "reconnect-required" }, ct);
                throw;
            }
        }, ct);
    private Task<UserProviderConnection> SaveExisting(UserProviderConnection c, CancellationToken ct)
        => users.UpdateAsync(s =>
        {
            var current = RequireConnection(s, c.UserId, c.Id);
            if (current.Revision != c.Revision) throw new UserConnectionException("connection_changed", "The connection changed. Reload and try again.", 409);
            var next = c with { Revision = Guid.NewGuid().ToString("N") };
            return (Replace(s, next), next);
        }, ct);
    private Task SaveNew(UserProviderConnection c, CancellationToken ct) => users.UpdateAsync(s => Add(s, c), ct);
    private static UserDirectoryState Add(UserDirectoryState s, UserProviderConnection c)
    {
        RequireUser(s, c.UserId);
        var all = s.ProviderConnections ?? [];
        if (all.Count(item => item.UserId == c.UserId) >= 32) throw new UserConnectionException("connection_limit", "Remove an unused connection first.", 409);
        return s with { ProviderConnections = [.. all, c] };
    }
    private static UserDirectoryState Replace(UserDirectoryState s, UserProviderConnection c)
        => s with { ProviderConnections = (s.ProviderConnections ?? []).Select(item => item.Id == c.Id ? c : item).ToArray() };
    private UserProviderConnection NewConnection(string userId, UserConnectionInput input, ProviderIdentity identity, string method, ProviderToken token, string? clientId)
        => new(Guid.NewGuid().ToString("N"), userId, input.Label, input.Provider, input.Organization!, input.Tenant!, identity.Id, identity.Name,
            method, token.AccessToken, token.RefreshToken, token.ExpiresAt, clientId, clock.UtcNow, clock.UtcNow, "connected", Guid.NewGuid().ToString("N"));
    internal static UserConnectionSummary Summary(UserProviderConnection c)
        => new(c.Id, c.Label, c.Provider, c.Organization, c.AccountId, c.AccountName, c.Method, c.ExpiresAt, c.CheckedAt, c.Status);
    private UserDeviceResponse DeviceResponse(Pending p)
        => new(p.Id, "pending", p.Device.UserCode, p.Device.VerificationUri, p.ExpiresAt, Math.Max(p.Interval, (int)Math.Ceiling((p.NextPoll - clock.UtcNow).TotalSeconds)));
    private void Prune(UserDirectoryState? state = null)
    {
        foreach (var id in pending.Values.Where(p => p.ExpiresAt <= clock.UtcNow || state is not null &&
            (!state.Users.Any(u => u.Id == p.UserId && !u.Disabled) ||
             !state.Sessions.Any(s => s.Id == p.SessionId && s.UserId == p.UserId && s.Kind is null && s.Audience is null &&
                 CoreSessionAuthorization.IsSessionLive(s, clock.UtcNow, settings.AuthLifetimes.IdleFor(null)))))
            .Select(p => p.Id).ToArray()) pending.Remove(id);
    }
    internal static HostUserRecord RequireUser(UserDirectoryState s, string userId)
        => s.Users.FirstOrDefault(u => u.Id == userId && !u.Disabled) ?? throw new UserConnectionException("user_unavailable", "This Hosty user is no longer active.", 403);
    private void RequireSession(UserDirectoryState s, string userId, string id)
    {
        var session = s.Sessions.FirstOrDefault(item => item.Id == id && item.UserId == userId && item.Kind is null && item.Audience is null);
        if (session is null || !CoreSessionAuthorization.IsSessionLive(session, clock.UtcNow, settings.AuthLifetimes.IdleFor(null)))
            throw new UserConnectionException("connection_session_expired", "Sign in and start the connection again.", 403);
    }
    private static UserProviderConnection RequireConnection(UserDirectoryState s, string userId, string id)
    {
        RequireUser(s, userId);
        return (s.ProviderConnections ?? []).FirstOrDefault(c => c.Id == id && c.UserId == userId)
            ?? throw new UserConnectionException("connection_not_found", "Connection not found.", 404);
    }
    private static string BoundedName(string? name)
    {
        if (string.IsNullOrWhiteSpace(name) || name.Trim().Length > 100 || name.Any(char.IsControl))
            throw new UserConnectionException("name_invalid", "Enter a name between 1 and 100 characters without control characters.");
        return name.Trim();
    }
    private static UserConnectionInput Validate(UserConnectionInput input)
    {
        var provider = input.Provider;
        if (provider is not ("github" or "azure-devops")) throw new UserConnectionException("provider_invalid", "Choose a supported provider.");
        var org = input.Organization?.Trim() ?? "";
        var tenant = input.Tenant?.Trim() ?? "organizations";
        if (provider == "azure-devops" && !Regex.IsMatch(org, "^[a-zA-Z0-9][a-zA-Z0-9-]{0,49}$", RegexOptions.CultureInvariant))
            throw new UserConnectionException("organization_invalid", "Enter the Azure DevOps organization name, not a URL.");
        if (tenant != "organizations" && !Guid.TryParse(tenant, out _))
            throw new UserConnectionException("tenant_invalid", "Enter the tenant UUID or organizations.");
        return input with { Label = BoundedName(input.Label), Organization = provider == "github" ? "" : org.ToLowerInvariant(), Tenant = provider == "github" ? "" : tenant.ToLowerInvariant() };
    }
    private Task Audit(string userId, string action, string target, CancellationToken ct)
        => audit.AppendAsync(new AuditRecord("audit_" + Guid.NewGuid().ToString("N"), "auth." + action, "user.connection", target, "succeeded", userId, clock.UtcNow, new Dictionary<string, string>()), ct);
    private async Task<T> Locked<T>(Func<Task<T>> action, CancellationToken ct)
    {
        await gate.WaitAsync(ct);
        try { return await action(); } finally { gate.Release(); }
    }
}
