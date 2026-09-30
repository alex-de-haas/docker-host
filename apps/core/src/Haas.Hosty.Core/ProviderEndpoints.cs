using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace Haas.Hosty.Core;

internal sealed record ProviderDescriptor(string AppId, string DisplayName, string Kind, string Key,
    int? Version, IReadOnlyList<string> Capabilities, string? Url, bool Available);
internal sealed record ProviderDirectory(IReadOnlyList<ProviderDescriptor> Providers);
internal sealed record AppPermissionState(IReadOnlyList<string> Required, IReadOnlyList<string> Optional, IReadOnlyList<string> Granted);
internal sealed record ProviderTokenRequest(string ProviderAppId, string Key = "default");
internal sealed record ProviderTokenResponse(string Token, DateTimeOffset ExpiresAt, ProviderDescriptor Provider);
internal sealed record ProviderIntrospectionRequest(string Token, string Kind, string Key = "default");
internal sealed record ProviderInvocation(string CallerAppId, string CallerInstallation, string? UserId, string? HostRole, string Kind, string Key);
internal sealed record ProviderTokenClaims(string Caller, string Audience, string Kind, string Key,
    DateTimeOffset CallerInstalledAt, DateTimeOffset ProviderInstalledAt, string? CallerRevision,
    string? ProviderRevision, string? UserId, long Expires);

// A separate token format prevents a provider invocation from becoming an administrator session.
// Providers introspect every request: signed claims alone are insufficient after grant revocation.
internal sealed class ProviderAccessService(AppRegistryStore apps, AppServiceTokenService serviceTokens,
    DelegatedTokenSigningKey signing, DelegatedTokenService delegated, AppIdentityService identity, IClock clock)
{
    private const string Prefix = "hosty_provider.1.";
    internal static string Permission(string kind) => kind switch
    {
        "speech-to-text" => CoreAppPermissions.SpeechProviders,
        "assistant" => CoreAppPermissions.AssistantProviders,
        _ => throw new AppIdentityException("provider_kind_invalid", "Unknown provider category."),
    };

    internal async Task<AppRecord> AuthenticateAsync(string appId, HttpRequest request, CancellationToken ct)
    {
        if (!serviceTokens.ValidateToken(appId, CoreSessionAuthorization.ReadBearerToken(request) ?? ""))
            throw new AppIdentityException("token_invalid", "An app service token is required.");
        return await apps.GetAppAsync(appId, ct)
            ?? throw new AppIdentityException("app_access_denied", "The calling app is not installed.");
    }

    private static void RequireGrant(AppRecord caller, string kind)
    {
        if (caller.GrantedCorePermissions?.Contains(Permission(kind), StringComparer.Ordinal) != true)
            throw new AppIdentityException("app_permission_required", $"The app needs the '{Permission(kind)}' permission.");
    }

    internal async Task<ProviderDirectory> ListAsync(AppRecord caller, string kind, CancellationToken ct)
    {
        RequireGrant(caller, kind);
        return new((await apps.ListAppRecordsAsync(ct)).SelectMany(p => Describe(p, kind)).ToArray());
    }

    private static IEnumerable<ProviderDescriptor> Describe(AppRecord provider, string kind)
    {
        if (provider.ConfirmedRoles?.Contains(kind, StringComparer.Ordinal) != true) yield break;
        var summary = AppSummary.From(provider);
        if (summary.Interfaces is null || !summary.Interfaces.TryGetValue(kind, out var entries)) yield break;
        foreach (var entry in entries)
        {
            var healthy = summary.Health is null || summary.Health.Services.Where(s => s.Service == entry.Service).All(s => s.Status == "running" && s.Health is not "unhealthy" and not "starting");
            yield return new(provider.Id, provider.DisplayName, kind, entry.Key, entry.Version,
                entry.Capabilities ?? [], entry.Url,
                provider.RuntimeState == "running" && healthy && entry.Url is not null);
        }
    }

    internal async Task<ProviderTokenResponse> IssueAsync(AppRecord caller, string kind, ProviderTokenRequest input,
        string? userCredential, CancellationToken ct)
    {
        RequireGrant(caller, kind);
        if (string.IsNullOrWhiteSpace(input.ProviderAppId) || string.IsNullOrWhiteSpace(input.Key))
            throw new AppIdentityException("provider_selection_invalid", "Select a provider and interface key.");
        var provider = await apps.GetAppAsync(input.ProviderAppId, ct)
            ?? throw new AppIdentityException("provider_unavailable", "Provider is not installed.");
        var descriptor = Describe(provider, kind).SingleOrDefault(p => p.Key == input.Key)
            ?? throw new AppIdentityException("provider_unavailable", "The app does not provide this interface.");
        if (!descriptor.Available) throw new AppIdentityException("provider_unavailable", "The selected provider is not ready.");
        string? userId = null;
        if (!string.IsNullOrEmpty(userCredential))
        {
            var delegatedClaims = delegated.ValidateToken(userCredential, caller.Id);
            userId = delegatedClaims is not null ? delegatedClaims.Sub : (await identity.RevalidateAsync(userCredential, caller.Id, ct)).UserId;
            await identity.RequireAccessibleUserAsync(caller.Id, userId, ct);
        }
        if (kind == "assistant")
        {
            if (userId is null) throw new AppIdentityException("app_identity_required", "Assistant requests require the acting user's credential.");
            await identity.RequireAccessibleUserAsync(provider.Id, userId, ct);
        }
        var expires = clock.UtcNow.AddMinutes(2);
        var claims = new ProviderTokenClaims(caller.Id, provider.Id, kind, input.Key, caller.InstalledAt,
            provider.InstalledAt, caller.PermissionRevision, provider.PermissionRevision, userId, expires.ToUnixTimeSeconds());
        var data = Prefix + Encode(JsonSerializer.SerializeToUtf8Bytes(claims, CoreJson.TypeInfo<ProviderTokenClaims>()));
        return new(data + "." + Encode(signing.Sign(Encoding.UTF8.GetBytes(data))), expires, descriptor);
    }

    internal async Task<ProviderInvocation> ValidateAsync(AppRecord provider, ProviderIntrospectionRequest input, CancellationToken ct)
    {
        ProviderTokenClaims? claims;
        try
        {
            if (string.IsNullOrWhiteSpace(input.Token) || input.Token.Length > 8192 || !input.Token.StartsWith(Prefix, StringComparison.Ordinal)) throw new FormatException();
            var parts = input.Token[Prefix.Length..].Split('.');
            if (parts.Length != 2 || !signing.Verify(Encoding.UTF8.GetBytes(Prefix + parts[0]), Decode(parts[1]))) throw new FormatException();
            claims = JsonSerializer.Deserialize(Decode(parts[0]), CoreJson.TypeInfo<ProviderTokenClaims>());
        }
        catch (Exception ex) when (ex is FormatException or JsonException or CryptographicException or ArgumentException)
        {
            throw new AppIdentityException("token_invalid", "Invalid provider credential.");
        }
        if (claims is null || claims.Audience != provider.Id || claims.Kind != input.Kind || claims.Key != input.Key
            || claims.Expires <= clock.UtcNow.ToUnixTimeSeconds() || claims.ProviderInstalledAt != provider.InstalledAt
            || claims.ProviderRevision != provider.PermissionRevision)
            throw new AppIdentityException("token_invalid", "Provider credential expired or does not match this interface.");
        var caller = await apps.GetAppAsync(claims.Caller, ct);
        if (caller is null || caller.InstalledAt != claims.CallerInstalledAt || caller.PermissionRevision != claims.CallerRevision)
            throw new AppIdentityException("app_access_denied", "The caller's installation or grants changed.");
        RequireGrant(caller, input.Kind);
        if (!Describe(provider, input.Kind).Any(p => p.Key == input.Key && p.Available))
            throw new AppIdentityException("provider_unavailable", "The provider is not available.");
        string? role = null;
        if (claims.UserId is { } userId)
        {
            var actor = await identity.RequireAccessibleUserAsync(caller.Id, userId, ct);
            role = actor.User.Role;
            if (input.Kind == "assistant") await identity.RequireAccessibleUserAsync(provider.Id, userId, ct);
        }
        return new(caller.Id, caller.InstalledAt.ToString("O"), claims.UserId, role, input.Kind, input.Key);
    }

    private static string Encode(byte[] value) => Convert.ToBase64String(value).TrimEnd('=').Replace('+', '-').Replace('/', '_');
    private static byte[] Decode(string value)
    {
        var padded = value.Replace('-', '+').Replace('_', '/');
        return Convert.FromBase64String(padded.PadRight(padded.Length + (4 - padded.Length % 4) % 4, '='));
    }
}

internal static class ProviderEndpoints
{
    public static void Map(WebApplication app)
    {
        const string root = "/api/internal/apps/{appId}";
        app.MapGet(root + "/permissions", async (string appId, HttpRequest request, ProviderAccessService access, CancellationToken ct) =>
            await Handle(async () =>
            {
                var caller = await access.AuthenticateAsync(appId, request, ct);
                return CoreJson.Json(new AppPermissionState(caller.RequiredCorePermissions ?? caller.GrantedCorePermissions ?? [],
                    caller.OptionalCorePermissions ?? [], caller.GrantedCorePermissions ?? []));
            }));
        app.MapGet(root + "/providers/{kind}", async (string appId, string kind, HttpRequest request, ProviderAccessService access, CancellationToken ct) =>
            await Handle(async () => CoreJson.Json(await access.ListAsync(await access.AuthenticateAsync(appId, request, ct), kind, ct))));
        app.MapPost(root + "/providers/{kind}/token", async (string appId, string kind, ProviderTokenRequest input,
            HttpRequest request, ProviderAccessService access, CancellationToken ct) =>
            await Handle(async () => CoreJson.Json(await access.IssueAsync(await access.AuthenticateAsync(appId, request, ct), kind,
                input, request.Headers["X-Hosty-User-Token"].ToString(), ct))));
        app.MapPost(root + "/provider/introspect", async (string appId, ProviderIntrospectionRequest input,
            HttpRequest request, ProviderAccessService access, CancellationToken ct) =>
            await Handle(async () => CoreJson.Json(await access.ValidateAsync(await access.AuthenticateAsync(appId, request, ct), input, ct))));
    }

    private static async Task<IResult> Handle(Func<Task<IResult>> action)
    {
        try { return await action(); }
        catch (AppIdentityException ex)
        {
            return CoreJson.Json(new ErrorResponse(ex.Code, ex.Message), ex.Code switch
            {
                "token_invalid" or "app_identity_required" => 401,
                "provider_unavailable" => 503,
                "provider_kind_invalid" or "provider_selection_invalid" => 400,
                _ => 403,
            });
        }
    }
}
