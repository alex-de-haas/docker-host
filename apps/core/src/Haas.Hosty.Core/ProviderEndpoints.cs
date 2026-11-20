using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace Haas.Hosty.Core;

internal sealed record ProviderDescriptor(string AppId, string DisplayName, string Kind, string Key,
    int? Version, IReadOnlyList<string> Capabilities, string? Url, bool Available,
    IReadOnlyList<ProviderUiSurface>? UiSurfaces = null, string? InstallationId = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? ImplementationId = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? ImplementationName = null)
{
    [JsonIgnore]
    internal string? Incarnation { get; init; }
}
internal sealed record ProviderUiSurface(string? Endpoint, string Path, string? Url, string? Kind = null, string? PanelId = null);
internal sealed record ProviderDirectory(IReadOnlyList<ProviderDescriptor> Providers);
internal sealed record AppPermissionState(IReadOnlyList<string> Required, IReadOnlyList<string> Optional, IReadOnlyList<string> Granted, bool ReviewAvailable = true, IReadOnlyList<string>? UnsupportedRequired = null, string Status = "known");
internal sealed record ProviderTokenRequest(string ProviderAppId, string Key = "default", string? InstallationId = null, string? ImplementationId = null);
internal sealed record ProviderTokenResponse(string Token, DateTimeOffset ExpiresAt, ProviderDescriptor Provider);
internal sealed record ProviderIntrospectionRequest(string Token, string Kind, string Key = "default");
internal sealed record ProviderInvocation(string CallerAppId, string CallerInstallation, string? UserId, string? HostRole, string Kind, string Key,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? ImplementationId = null);
internal sealed record ProviderTokenClaims(string Caller, string Audience, string Kind, string Key,
    DateTimeOffset CallerInstalledAt, DateTimeOffset ProviderInstalledAt, string? CallerRevision,
    string? ProviderRevision, string? UserId, long Expires, string? ActivityGrantHash = null, string? ImplementationId = null, string? Incarnation = null);

// A separate token format prevents a provider invocation from becoming an administrator session.
// Providers introspect every request: signed claims alone are insufficient after grant revocation.
internal sealed class ProviderAccessService(AppRegistryStore apps, AppServiceTokenService serviceTokens,
    DelegatedTokenSigningKey signing, DelegatedTokenService delegated, AppIdentityService identity, IClock clock)
{
    private const string Prefix = "hosty_provider.1.";
    internal static string Permission(string kind) => kind switch
    {
        "speech-to-text" => CoreAppPermissions.SpeechProviders,
        "text-to-speech" => CoreAppPermissions.TextToSpeechProviders,
        "translation" => CoreAppPermissions.TranslationProviders,
        "assistant" => CoreAppPermissions.AssistantProviders,
        "tasks" => CoreAppPermissions.TaskProviders,
        "task-executor" => CoreAppPermissions.TaskExecutors,
        "conversation-history" => CoreAppPermissions.HistoryProviders,
        "agent-sessions" => CoreAppPermissions.AgentSessionProviders,
        "agent" => CoreAppPermissions.AgentProviders,
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

    internal async Task<ProviderDirectory> ListAsync(AppRecord caller, string kind, CancellationToken ct, bool named = false)
    {
        RequireGrant(caller, kind);
        return new((await apps.ListAppRecordsAsync(ct)).SelectMany(p => Describe(p, kind, named)).ToArray());
    }

    internal static IEnumerable<ProviderDescriptor> Describe(AppRecord provider, string kind, bool named = false)
    {
        if (provider.ConfirmedRoles?.Contains(kind, StringComparer.Ordinal) != true) yield break;
        var summary = AppSummary.From(provider);
        // Provider credentials are consumed by backends. Browser origins (including *.localhost)
        // need not resolve there and must not route audio through an app's public ingress.
        var interfaces = AppSummary.BuildInterfaceSummaries(provider.Interfaces, provider.Endpoints, useTransportUrls: true);
        if (interfaces is null || !interfaces.TryGetValue(kind, out var entries)) yield break;
        // Browser destinations use declared UI endpoints, which can differ from the provider API.
        // Consumers need no wider apps.read grant to validate a handoff's returned destination.
        ProviderUiSurface[]? surfaces = kind == "assistant"
            ? summary.PanelSurfaces.Select(s => new ProviderUiSurface(s.Endpoint, s.Path, s.EmbeddedUrl, "panel", s.PanelId))
                .Concat(summary.Navigation.Select(s => new ProviderUiSurface(s.Endpoint, s.Path, s.EmbeddedUrl, "navigation")))
                .Concat(summary.EntryPath is { } path
                    ? [new ProviderUiSurface(summary.EntryEndpoint, path, summary.EmbeddedUrl, "entrypoint")] : [])
                .Where(s => s.Url is not null).Distinct().ToArray()
            : null;
        var declarations = provider.Interfaces![kind];
        var snapshots = named ? provider.NamedProviders?.Snapshots.Where(s => s.Kind == kind
            && declarations.Any(e => e.Key == s.Key && s.Declaration == NamedProviderImplementations.Declaration(e))).ToDictionary(s => s.Key) : null;
        var duplicateNames = snapshots?.Values.SelectMany(s => s.Members)
            .GroupBy(m => m.Implementation.DisplayName, StringComparer.OrdinalIgnoreCase)
            .Where(g => g.Count() > 1).Select(g => g.Key).ToHashSet(StringComparer.OrdinalIgnoreCase);
        foreach (var entry in entries)
        {
            var healthy = summary.Health is null || summary.Health.Services.Where(s => s.Service == entry.Service).All(s => s.Status == "running" && s.Health is not "unhealthy" and not "starting");
            var descriptor = new ProviderDescriptor(provider.Id, provider.DisplayName, kind, entry.Key, entry.Version,
                entry.Capabilities ?? [], entry.Url,
                provider.RuntimeState == "running" && healthy && entry.Url is not null, surfaces, PanelIdentity.Installation(provider));
            if (!descriptor.Capabilities.Contains(NamedProviderImplementations.Capability)) { yield return descriptor; continue; }
            if (snapshots?.GetValueOrDefault(entry.Key) is not { } snapshot) continue;
            foreach (var member in snapshot.Members)
            {
                var implementation = member.Implementation;
                var label = $"{provider.DisplayName} · {implementation.DisplayName}";
                if (duplicateNames!.Contains(implementation.DisplayName)) label += $" ({entry.Key}/{implementation.Id})";
                yield return descriptor with { DisplayName = label, ImplementationId = implementation.Id,
                    ImplementationName = implementation.DisplayName, Available = descriptor.Available && implementation.Available,
                    Incarnation = snapshot.Declaration + ":" + member.Incarnation.ToString(System.Globalization.CultureInfo.InvariantCulture) };
            }
        }
    }

    internal static ProviderDescriptor? Find(AppRecord provider, string kind, string key, string? implementationId)
        => Describe(provider, kind, implementationId is not null)
            .SingleOrDefault(p => p.Key == key && p.ImplementationId == implementationId);

    internal async Task<ProviderTokenResponse> IssueAsync(AppRecord caller, string kind, ProviderTokenRequest input,
        string? userCredential, CancellationToken ct)
    {
        RequireGrant(caller, kind);
        if (kind is "conversation-history" or "agent-sessions" or "agent")
            throw new AppIdentityException("version_unsupported", "Use the canonical Core API with operation-bound mediated provider credentials.");
        if (string.IsNullOrWhiteSpace(input.ProviderAppId) || string.IsNullOrWhiteSpace(input.Key))
            throw new AppIdentityException("provider_selection_invalid", "Select a provider and interface key.");
        var provider = await apps.GetAppAsync(input.ProviderAppId, ct)
            ?? throw new AppIdentityException("provider_unavailable", "Provider is not installed.");
        if (input.InstallationId is not null && input.InstallationId != PanelIdentity.Installation(provider)
            || input.ImplementationId is not null && (input.InstallationId is null || !NamedProviderImplementations.ValidId(input.ImplementationId)))
            throw new AppIdentityException("provider_selection_invalid", "Select an exact current provider installation and implementation.");
        var descriptor = Find(provider, kind, input.Key, input.ImplementationId)
            ?? throw new AppIdentityException("provider_unavailable", "The app does not provide this interface.");
        if (!descriptor.Available) throw new AppIdentityException("provider_unavailable", "The selected provider is not ready.");
        string? activityHash = null;
        string? userId = null;
        if (!string.IsNullOrEmpty(userCredential))
        {
            var delegatedClaims = delegated.ValidateToken(userCredential, caller.Id);
            if (delegatedClaims is not null && kind != "assistant") userId = delegatedClaims.Sub;
            else
            {
                var actor = await identity.RequireOperationHashAsync(AppIdentityService.HashToken(userCredential), caller.Id,
                    s => s.AllowsProvider(kind, provider.Id, input.Key, input.ImplementationId),
                    ct, requireActivity: kind == "assistant");
                userId = actor.UserId;
                activityHash = AppIdentityService.HashToken(userCredential);
            }
            await identity.RequireAccessibleUserAsync(caller.Id, userId, ct);
        }
        if (kind == "assistant")
        {
            if (userId is null) throw new AppIdentityException("app_identity_required", "Assistant requests require the acting user's credential.");
            await identity.RequireAccessibleUserAsync(provider.Id, userId, ct);
        }
        if (kind is "tasks" or "task-executor" && userId is not null)
            await identity.RequireAccessibleUserAsync(provider.Id, userId, ct);
        var expires = clock.UtcNow.AddMinutes(2);
        var claims = new ProviderTokenClaims(caller.Id, provider.Id, kind, input.Key, caller.InstalledAt,
            provider.InstalledAt, caller.PermissionRevision, provider.PermissionRevision, userId, expires.ToUnixTimeSeconds(), activityHash, descriptor.ImplementationId, descriptor.Incarnation);
        var data = Prefix + Encode(JsonSerializer.SerializeToUtf8Bytes(claims, CoreJson.TypeInfo<ProviderTokenClaims>()));
        return new(data + "." + Encode(signing.Sign(Encoding.UTF8.GetBytes(data))), expires, descriptor);
    }

    internal async Task<ProviderInvocation> ValidateAsync(AppRecord provider, ProviderIntrospectionRequest input, CancellationToken ct)
    {
        if (input.Kind is "conversation-history" or "agent-sessions" or "agent")
            throw new AppIdentityException("version_unsupported", "This interface requires version-two mediated introspection.");
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
        if (claims.Kind == "assistant" || claims.ActivityGrantHash is not null)
        {
            if (claims.ActivityGrantHash is null) throw new AppIdentityException("reauth_required", "Renew assistant authority through Core.");
            var actor = await identity.RequireOperationHashAsync(claims.ActivityGrantHash, claims.Caller,
                s => s.AllowsProvider(input.Kind, provider.Id, input.Key, claims.ImplementationId),
                ct, requireActivity: claims.Kind == "assistant");
            if (actor.UserId != claims.UserId) throw new AppIdentityException("token_invalid", "Provider actor changed.");
        }
        var caller = await apps.GetAppAsync(claims.Caller, ct);
        if (caller is null || caller.InstalledAt != claims.CallerInstalledAt || caller.PermissionRevision != claims.CallerRevision)
            throw new AppIdentityException("app_access_denied", "The caller's installation or grants changed.");
        RequireGrant(caller, input.Kind);
        if (Find(provider, input.Kind, input.Key, claims.ImplementationId) is not { Available: true } target || target.Incarnation != claims.Incarnation)
            throw new AppIdentityException("provider_unavailable", "The provider is not available.");
        string? role = null;
        if (claims.UserId is { } userId)
        {
            var actor = await identity.RequireAccessibleUserAsync(caller.Id, userId, ct);
            role = actor.User.Role;
            if (input.Kind is "assistant" or "tasks" or "task-executor") await identity.RequireAccessibleUserAsync(provider.Id, userId, ct);
        }
        return new(caller.Id, caller.InstalledAt.ToString("O"), claims.UserId, role, input.Kind, input.Key, claims.ImplementationId);
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
        app.MapGet(root + "/permissions", async (string appId, HttpRequest request, ProviderAccessService access, CoreLifecycleService lifecycle, CancellationToken ct) =>
            await Handle(async () =>
            {
                var caller = await access.AuthenticateAsync(appId, request, ct);
                var state = await lifecycle.ObservePermissionsAsync(caller.Id, true, ct);
                return CoreJson.Json(new AppPermissionState(state.Required, state.Optional, state.Granted,
                    state.Status == "known", state.UnsupportedRequired, state.Status));
            }));
        app.MapGet(root + "/providers/{kind}", async (string appId, string kind, HttpRequest request, ProviderAccessService access, CancellationToken ct) =>
            await Handle(async () => CoreJson.Json(await access.ListAsync(await access.AuthenticateAsync(appId, request, ct), kind, ct,
                CoreProviderApi.Named(request)))));
        app.MapPost(root + "/providers/{kind}/implementations", async (string appId, string kind,
            ProviderImplementationPublication input, HttpRequest request, ProviderAccessService access, AppServiceTokenService tokens,
            AppRegistryStore apps, CancellationToken ct) => await Handle(async () =>
            {
                var publisher = await access.AuthenticateAsync(appId, request, ct);
                if (!tokens.IsInstallationToken(publisher, CoreSessionAuthorization.ReadBearerToken(request) ?? ""))
                    throw new AppIdentityException("provider_publication_denied", "A current installation-bound publisher credential is required.");
                return CoreJson.Json(await apps.PublishImplementationsAsync(publisher, kind, input, ct));
            })).WithMetadata(new Microsoft.AspNetCore.Mvc.RequestSizeLimitAttribute(512 * 1024));
        app.MapPost(root + "/providers/{kind}/token", async (string appId, string kind, ProviderTokenRequest input,
            HttpRequest request, ProviderAccessService access, CancellationToken ct) =>
            await Handle(async () => CoreJson.Json(await access.IssueAsync(await access.AuthenticateAsync(appId, request, ct), kind,
                input, request.Headers["X-Hosty-User-Token"].ToString(), ct))));
        app.MapPost(root + "/task-workspace", async (string appId, CoreTaskWorkspaceRequest input,
            HttpRequest request, ProviderAccessService access, CoreTaskWorkspace workspace, CancellationToken ct) =>
            await Handle(async () =>
            {
                try
                {
                    var value = await workspace.Run(await access.AuthenticateAsync(appId, request, ct), input, ct);
                    return value switch { CoreTaskWorkspaceView view => CoreJson.Json(view), WorkspaceActivityReceipt activity => CoreJson.Json(activity),
                        _ => CoreJson.Json(new ErrorResponse("workspace_response_invalid", "Invalid task workspace response."), 502) };
                }
                catch (AppLifecycleException ex) { return CoreJson.Json(new ErrorResponse(ex.Code, ex.Message), ex.Code == "workspace_forbidden" ? 403 : 409); }
            }));
        app.MapPost(root + "/task-mcp", async (string appId, CoreTaskMcpRequest input,
            HttpRequest request, ProviderAccessService access, CoreTaskMcp mcp, CancellationToken ct) =>
            await Handle(async () => CoreJson.Json(await mcp.Issue(await access.AuthenticateAsync(appId, request, ct), input, ct))));
        app.MapPost(root + "/task-workflow", async (string appId, CoreTaskWorkflowRequest input,
            HttpRequest request, ProviderAccessService access, CoreTaskWorkflow workflow, CancellationToken ct) =>
            await Handle(async () => CoreJson.Json(await workflow.Run(await access.AuthenticateAsync(appId, request, ct), input, ct))));
        app.MapPost(root + "/task-dispatch-authority", async (string appId, CoreTaskDispatchAuthorityRequest input,
            HttpRequest request, ProviderAccessService access, CoreProviderMediation mediation, CancellationToken ct) =>
            await Handle(async () => CoreJson.Json(await mediation.TaskDispatchAuthorityAsync(await access.AuthenticateAsync(appId, request, ct), input.Dispatch, ct))));
        app.MapPost(root + "/task-dispatch", async (string appId, CoreTaskDispatchRequest input,
            HttpRequest request, ProviderAccessService access, CoreProviderMediation mediation, CancellationToken ct) =>
            await Handle(async () => CoreJson.Json(await mediation.DispatchTaskAsync(await access.AuthenticateAsync(appId, request, ct), input, ct))));
        app.MapPost(root + "/provider/introspect-v2", async (string appId, CoreProviderIntrospectionRequest input,
            HttpRequest request, ProviderAccessService access, CoreProviderMediation mediation, CancellationToken ct) =>
            await Handle(async () => CoreJson.Json(await mediation.IntrospectAsync(await access.AuthenticateAsync(appId, request, ct), input, ct))));
        app.MapPost(root + "/provider/introspect", async (string appId, ProviderIntrospectionRequest input,
            HttpRequest request, ProviderAccessService access, CancellationToken ct) =>
            await Handle(async () => CoreJson.Json(await access.ValidateAsync(await access.AuthenticateAsync(appId, request, ct), input, ct))));
    }

    private static async Task<IResult> Handle(Func<Task<IResult>> action)
    {
        try { return await action(); }
        catch (CoreProviderException ex) { return CoreJson.Json(new CoreProviderFailure(ex.Error), ex.Status); }
        catch (AppIdentityException ex)
        {
            return CoreJson.Json(new ErrorResponse(ex.Code, ex.Message), ex.Code switch
            {
                "token_invalid" or "app_identity_required" or "reauth_required" => 401,
                "provider_unavailable" or "provider_catalog_unavailable" => 503,
                "provider_publication_invalid" => 400,
                "provider_publication_conflict" => 409,
                "provider_kind_invalid" or "provider_selection_invalid" => 400,
                _ => 403,
            });
        }
    }
}
