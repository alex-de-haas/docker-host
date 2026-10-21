using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Cors;

namespace Haas.Hosty.Core;

internal sealed record SettingsChangeView(string Id, string Status, string ApprovalUrl, string? Error = null);
internal sealed class ProtectedSettingsChange
{
    public string Id { get; } = Guid.NewGuid().ToString("N");
    public required string UserId { get; init; }
    public required string Caller { get; init; }
    public required string CallerName { get; init; }
    public required string RequestHash { get; init; }
    public required string Revision { get; init; }
    public required string Title { get; init; }
    public required string Summary { get; init; }
    public required DateTimeOffset ExpiresAt { get; init; }
    public string Status { get; set; } = "pending";
    public string? Error { get; set; }
    public string? Nonce { get; set; }
    public string? Session { get; set; }
    public int ResponseStatus { get; set; }
    public string? ResponseType { get; set; }
    public byte[]? ResponseBody { get; set; }
}

// A review authorizes one exact API request, not a reusable permission. The original caller
// applies it through the original authenticated endpoint, whose domain checks still run.
internal sealed class ProtectedSettingsChanges(IClock clock, CorePublicOriginResolver origins)
{
    private readonly Dictionary<string, ProtectedSettingsChange> entries = new(StringComparer.Ordinal);
    private readonly object sync = new();
    private readonly SemaphoreSlim applyGate = new(1, 1);
    internal const string Header = "X-Hosty-Settings-Change";
    private const int Capacity = 128;
    private const int MaxBody = 128 * 1024;

    // Endpoint routing already resolved casing, trailing slashes and parameter decoding. Use the
    // same route identity for protection and summaries as app authorization and the actual handler.
    private static string Route(HttpRequest request) =>
        (request.HttpContext.GetEndpoint() as RouteEndpoint)?.RoutePattern.RawText ?? "";
    private static string? Parameter(HttpRequest request, string name) => request.RouteValues[name]?.ToString();

    private static bool Protected(HttpRequest request)
    {
        var path = Route(request);
        if (path == "/api/auth/invitations/accept") return false;
        if (HttpMethods.IsGet(request.Method) || HttpMethods.IsHead(request.Method) || HttpMethods.IsOptions(request.Method)) return false;
        return path is "/api/core/settings" or "/api/core/source" or "/api/core/cloudflare/connect" or "/api/core/cloudflare/disconnect"
            or "/api/core/public-origin/publish" or "/api/core/public-origin/unpublish"
            || path.StartsWith("/api/auth/users/", StringComparison.Ordinal)
            || path is "/api/auth/invitations" || path.StartsWith("/api/auth/invitations/", StringComparison.Ordinal)
            || path == "/api/auth/background-grants/revoke-all-authorizations"
            || HttpMethods.IsDelete(request.Method) && (path.StartsWith("/api/auth/credentials/", StringComparison.Ordinal)
                || path.StartsWith("/api/auth/background-grants/", StringComparison.Ordinal)
                || path.StartsWith("/api/auth/oauth/clients/", StringComparison.Ordinal));
    }

    public static async Task InvokeAsync(HttpContext context, RequestDelegate next)
    {
        if (!Protected(context.Request)) { await next(context); return; }
        var services = context.RequestServices;
        var result = await CoreSessionAuthorization.RequireSessionAsync(context.Request,
            services.GetRequiredService<UserDirectoryStore>(), services.GetRequiredService<IClock>(),
            user => services.GetRequiredService<ProtectedSettingsChanges>().HandleAsync(context, next, user),
            requireCsrf: true, cancellationToken: context.RequestAborted);
        await result.ExecuteAsync(context);
    }

    private static string Caller(HttpRequest request) => AppManagementAuthorization.Caller(request) is { } app
        ? $"{app.App.Id}:{app.App.InstalledAt:O}" : "operator";

    private async Task<IResult> HandleAsync(HttpContext context, RequestDelegate next, HostUserRecord user)
    {
        var request = context.Request;
        var personal = Route(request).StartsWith("/api/auth/credentials/", StringComparison.Ordinal);
        if (!personal && !AppAccessPolicy.IsAdmin(user)) return Error(403, "admin_required", "A Host administrator is required.");
        if (personal)
        {
            var fingerprint = Parameter(request, "fingerprint");
            var users = await context.RequestServices.GetRequiredService<UserDirectoryStore>().ReadAsync(context.RequestAborted);
            var oauth = await context.RequestServices.GetRequiredService<OAuthStore>().ReadAsync(context.RequestAborted);
            var owner = users.Sessions.FirstOrDefault(s => s.RevokedAt is null && CoreSessionAuthorization.FingerprintSessionId(s.Id).Equals(fingerprint, StringComparison.OrdinalIgnoreCase))?.UserId
                ?? oauth.Grants.FirstOrDefault(g => g.RevokedAt is null && CoreSessionAuthorization.FingerprintSessionId(g.Id).Equals(fingerprint, StringComparison.OrdinalIgnoreCase))?.UserId;
            // A completed request may refer to the credential it just revoked. Authenticate the
            // review before resolving it, then let the replay branch return its saved response.
            var replay = false;
            lock (sync) replay = entries.TryGetValue(request.Headers[Header].ToString(), out var prior) && prior.UserId == user.Id && prior.Caller == Caller(request) && prior.Status == "succeeded";
            if (!replay && (owner is null || owner != user.Id && !AppAccessPolicy.IsAdmin(user))) return Error(404, "credential_not_found", "No such credential.");
            if (!replay && owner != user.Id && AppManagementAuthorization.RequireAdditional(request, CoreAppPermissions.ManageUsers) is { } denied) return denied;
        }
        if (request.ContentLength > MaxBody) return Error(413, "settings_change_too_large", "The proposed change is too large.");
        request.EnableBuffering(bufferThreshold: MaxBody, bufferLimit: MaxBody);
        string body;
        try { using var reader = new StreamReader(request.Body, Encoding.UTF8, leaveOpen: true); body = await reader.ReadToEndAsync(context.RequestAborted); }
        catch (IOException) { return Error(413, "settings_change_too_large", "The proposed change is too large."); }
        finally { request.Body.Position = 0; }
        JsonNode? proposed;
        try { proposed = ParseProposal(body); }
        catch (JsonException) { return Error(400, "settings_change_invalid", "The proposed settings are invalid."); }
        if (proposed is not null and not JsonObject) return Error(400, "settings_change_invalid", "The proposed change must be an object.");
        if (Route(request) == "/api/core/settings" && proposed?["settings"] is JsonObject routine && routine.Count > 0 &&
            routine.All(p => p.Key == UpdateCheckSettings.IntervalKey)) { await next(context); return Results.Empty; }
        var caller = Caller(request);
        var requestHash = Hash(request.Method + "\n" + request.Path + request.QueryString + "\n" + body);
        await applyGate.WaitAsync(context.RequestAborted);
        try
        {
            if (AppManagementAuthorization.Caller(request) is not null &&
                await AppManagementAuthorization.RevalidateCallerAsync(request, context.RequestAborted) is { } permissionError) return permissionError;
            var currentUser = await CoreSessionAuthorization.TryResolveSessionAsync(request,
                context.RequestServices.GetRequiredService<UserDirectoryStore>(), clock, context.RequestAborted);
            if (currentUser is null || currentUser.Id != user.Id || Caller(request) != caller || (!personal && !AppAccessPolicy.IsAdmin(currentUser)))
                return Error(403, "settings_authority_changed", "Your authority changed. Sign in and review again.");
            var snapshot = await SnapshotAsync(context, currentUser);
            var id = request.Headers[Header].ToString();
            ProtectedSettingsChange? entry;
            lock (sync)
            {
                foreach (var expired in entries.Values.Where(e => e.ExpiresAt <= clock.UtcNow && e.Status != "applying").ToArray()) entries.Remove(expired.Id);
                entry = string.IsNullOrEmpty(id) ? entries.Values.LastOrDefault(e => e.UserId == user.Id && e.Caller == caller &&
                    e.RequestHash == requestHash && e.Revision == snapshot.Revision && e.Status is "pending" or "approved") : entries.GetValueOrDefault(id);
                if (entry is not null && (entry.UserId != user.Id || entry.Caller != caller || entry.RequestHash != requestHash))
                    return Error(403, "settings_change_mismatch", "This confirmation does not authorize this request.");
                if (entry is null && !string.IsNullOrEmpty(id)) return Error(409, "settings_change_expired", "This confirmation expired. Review the change again.");
                if (entry is null)
                {
                    if (entries.Count >= Capacity) return Error(429, "settings_change_limit", "Finish an existing review before preparing another.");
                    entry = new() { UserId = user.Id, Caller = caller,
                        CallerName = AppManagementAuthorization.Caller(request)?.App.DisplayName ?? user.DisplayName ?? "Core operator",
                        RequestHash = requestHash, Revision = snapshot.Revision, Title = Title(request),
                        Summary = Summary(context, proposed, snapshot.Before), ExpiresAt = clock.UtcNow.AddMinutes(15) };
                    entries.Add(entry.Id, entry);
                }
                if (entry.Status is "succeeded" or "failed" && entry.ResponseBody is not null)
                    { context.Response.StatusCode = entry.ResponseStatus; return Results.Bytes(entry.ResponseBody, entry.ResponseType); }
                if (entry.Status == "denied") return Error(409, "settings_change_denied", "The change was cancelled. Your draft is preserved.");
                if (entry.Status == "failed") return Error(409, "settings_change_failed", entry.Error ?? "The request failed. Inspect current settings before retrying.");
                if (entry.Status == "approved" && entry.Revision != snapshot.Revision)
                { entry.Status = "failed"; entry.Error = "Settings changed after review. Reload and review again."; return Error(409, "settings_changed", entry.Error); }
                if (entry.Status != "approved") return CoreJson.Json(View(entry), 428);
                entry.Status = "applying";
            }
            // Response replay makes a lost success safe to recover without a second mutation.
            var original = context.Response.Body;
            await using var captured = new MemoryStream();
            context.Response.Body = captured;
            try
            {
                try { await next(context); }
                catch
                {
                    lock (sync) { entry.Status = "failed"; entry.Error = "The operation did not return a result. Inspect current settings before retrying."; }
                    throw;
                }
                lock (sync)
                {
                    entry.ResponseBody = captured.ToArray(); entry.ResponseStatus = context.Response.StatusCode;
                    entry.ResponseType = context.Response.ContentType;
                    entry.Status = context.Response.StatusCode < 400 ? "succeeded" : "failed";
                }
                // Delivery can fail after the operation completed. Keep its captured outcome so
                // the same request can recover it without executing the mutation again.
                captured.Position = 0; await captured.CopyToAsync(original, context.RequestAborted);
            }
            finally { context.Response.Body = original; }
            return Results.Empty;
        }
        finally { applyGate.Release(); }
    }

    private static JsonNode? ParseProposal(string body)
    {
        if (string.IsNullOrWhiteSpace(body)) return null;
        using var document = JsonDocument.Parse(body);
        RejectAmbiguousProperties(document.RootElement);
        // Match the endpoint's Web property binding for both routine-change detection and review
        // summaries. Reject duplicates first instead of choosing a different value than the binder.
        return JsonNode.Parse(body, new JsonNodeOptions { PropertyNameCaseInsensitive = true });
    }

    private static void RejectAmbiguousProperties(JsonElement element)
    {
        if (element.ValueKind == JsonValueKind.Object)
        {
            var names = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (var property in element.EnumerateObject())
            {
                if (!names.Add(property.Name)) throw new JsonException("Duplicate or ambiguous property name.");
                RejectAmbiguousProperties(property.Value);
            }
        }
        else if (element.ValueKind == JsonValueKind.Array)
            foreach (var item in element.EnumerateArray()) RejectAmbiguousProperties(item);
    }

    private static string Hash(string value) => Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(value)));
    private static IResult Error(int status, string code, string message) => CoreJson.Json(new ErrorResponse(code, message), status);
    private SettingsChangeView View(ProtectedSettingsChange entry) => new(entry.Id, entry.Status,
        $"{origins.Effective.TrimEnd('/')}/settings/confirm/{entry.Id}", entry.Error);

    private static async Task<(string Revision, JsonObject Before)> SnapshotAsync(HttpContext context, HostUserRecord actor)
    {
        var services = context.RequestServices; var ct = context.RequestAborted; var path = Route(context.Request);
        var before = new JsonObject(); var version = new List<string>();
        if (path.StartsWith("/api/core/", StringComparison.Ordinal))
        {
            foreach (var row in CoreSettingsEndpoints.Build(services.GetRequiredService<CoreSettingsService>(), services.GetRequiredService<CorePublicOriginResolver>()).Settings)
                before[row.Key] = row.Value;
            version.Add(before.ToJsonString());
            if (path == "/api/core/source")
            {
                var source = await services.GetRequiredService<CoreDevelopmentService>().SourceSettingsAsync(ct);
                version.Add(source.Revision);
                before.Clear();
                before["overridePath"] = source.OverridePath;
                before["repository"] = new JsonObject { ["repositoryUrl"] = source.RepositoryUrl, ["ref"] = source.Ref,
                    ["projectPath"] = source.ProjectPath, ["connectionId"] = source.ConnectionId };
            }
            if (path.Contains("cloudflare", StringComparison.Ordinal))
            {
                var connection = await services.GetRequiredService<CloudflareIntegrationStore>().LoadAsync(ct);
                version.Add(connection?.UpdatedAt.ToString() ?? ""); version.Add(connection?.Status ?? "");
                before["connection"] = connection?.Status ?? "Not connected";
            }
        }
        else
        {
            var users = await services.GetRequiredService<UserDirectoryStore>().ReadAsync(ct);
            if (path.StartsWith("/api/auth/background-grants/", StringComparison.Ordinal))
            {
                var state = await services.GetRequiredService<BackgroundGrantService>().ReadAsync(ct);
                var id = Parameter(context.Request, "id") ?? path.Split('/').Last();
                foreach (var grant in (state?.Grants ?? []).Where(g => g.UserId == actor.Id && (id == "revoke-all-authorizations" || g.Id == id)))
                { version.Add(CoreJson.Text(grant)); before[grant.Label] = grant.AppId + " · " + string.Join(", ", grant.Scopes.SelectMany(s => s.Actions)); }
                if (id == "revoke-all-authorizations") before["effect"] = "End all your browser sessions, tokens, OAuth authorizations and background grants";
            }
            else if (path.StartsWith("/api/auth/oauth/clients/", StringComparison.Ordinal))
            {
                var client = (await services.GetRequiredService<OAuthStore>().ReadAsync(ct)).Clients.FirstOrDefault(c => c.ClientId == Parameter(context.Request, "clientId"));
                if (client is not null) { version.Add(client.ClientId); version.Add(client.DeletedAt?.ToString() ?? ""); before["client"] = client.Name; before["effect"] = "Remove this OAuth client and revoke all its authorizations"; }
            }
            else if (path.StartsWith("/api/auth/credentials/", StringComparison.Ordinal))
            {
                var fingerprint = Parameter(context.Request, "fingerprint");
                var session = users.Sessions.FirstOrDefault(s => CoreSessionAuthorization.FingerprintSessionId(s.Id).Equals(fingerprint, StringComparison.OrdinalIgnoreCase));
                var oauth = await services.GetRequiredService<OAuthStore>().ReadAsync(ct);
                var grant = oauth.Grants.FirstOrDefault(g => CoreSessionAuthorization.FingerprintSessionId(g.Id).Equals(fingerprint, StringComparison.OrdinalIgnoreCase));
                var owner = session?.UserId ?? grant?.UserId;
                // Do not leak another user's credential metadata while preparing an unauthorized request.
                if (owner is not null && (owner == actor.Id || AppAccessPolicy.IsAdmin(actor)))
                {
                    before["credential"] = session?.Label ?? grant?.Label ?? fingerprint;
                    before["fingerprint"] = fingerprint;
                    before["access"] = (session?.Audience ?? grant?.Audience ?? "User host role") +
                        ((session?.Scopes ?? grant?.Scopes) is { Count: > 0 } scopes ? " · " + string.Join(", ", scopes) : "");
                    before["owner"] = users.Users.FirstOrDefault(u => u.Id == owner)?.DisplayName ?? owner;
                    version.Add(session?.RevokedAt?.ToString() ?? ""); version.Add(grant?.RevokedAt?.ToString() ?? ""); version.Add(owner);
                }
                else before["credential"] = "Unavailable";
            }
            else
            {
                foreach (var user in users.Users.OrderBy(u => u.Id, StringComparer.Ordinal))
                    version.Add(new JsonArray(user.Id, user.Role, user.Disabled, user.UpdatedAt.ToString("O")).ToJsonString());
                foreach (var invite in users.Invitations.OrderBy(i => i.Id, StringComparer.Ordinal))
                    version.Add(new JsonArray(invite.Id, invite.Status, invite.Role, invite.Email).ToJsonString());
                foreach (var assignment in users.Assignments.OrderBy(a => a.AppId, StringComparer.Ordinal).ThenBy(a => a.UserId, StringComparer.Ordinal))
                    version.Add(new JsonArray(assignment.AppId, assignment.UserId).ToJsonString());
                var targetId = Parameter(context.Request, "userId");
                var target = users.Users.FirstOrDefault(u => u.Id == targetId);
                if (target is not null) { before["user"] = target.DisplayName ?? target.Email ?? target.Id; before["role"] = target.Role; before["disabled"] = target.Disabled; }
            }
        }
        return (Hash(string.Join("\n", version)), before);
    }

    private static string Title(HttpRequest request) => Route(request).StartsWith("/api/auth/credentials/", StringComparison.Ordinal) ? "Revoke access"
        : Route(request).StartsWith("/api/auth/", StringComparison.Ordinal) ? "Confirm user access change" : "Confirm host settings";
    private static string Summary(HttpContext context, JsonNode? proposed, JsonObject before)
    {
        var labels = CoreSettingsEndpoints.Build(context.RequestServices.GetRequiredService<CoreSettingsService>(),
            context.RequestServices.GetRequiredService<CorePublicOriginResolver>()).Settings.ToDictionary(s => s.Key,
                s => $"{s.Group} · {s.Label ?? s.Key}{(s.Unit is { } unit ? $" ({unit})" : "")}");
        string Label(string key) => labels.GetValueOrDefault(key) ?? key switch {
            "role" => "Role", "disabled" => "Account disabled", "appIds" => "Applications", "email" => "Email", "displayName" => "Name",
            "overridePath" => "Local source folder", "repository" => "Source repository", "apiToken" => "Cloudflare API token", "token" => "Token",
            "zoneId" => "DNS zone", "accountId" => "Cloudflare account", "hostname" => "Public hostname", "credential" => "Credential",
            "fingerprint" => "Fingerprint", "access" => "Access", "owner" => "Owner", "client" => "OAuth client", "effect" => "Effect", "connection" => "Connection", _ => key };

        static string E(string? value) => WebUtility.HtmlEncode(value ?? "Default");
        static bool Secret(string key) => (key.Equals("token", StringComparison.OrdinalIgnoreCase) || key.Equals("apiToken", StringComparison.OrdinalIgnoreCase) || key.EndsWith("_API_KEY", StringComparison.OrdinalIgnoreCase)) || key.Contains("secret", StringComparison.OrdinalIgnoreCase) || key.Contains("password", StringComparison.OrdinalIgnoreCase);
        var rows = new List<string>();
        var fields = proposed?["settings"] as JsonObject ?? proposed as JsonObject;
        if (fields is not null)
            foreach (var (key, value) in fields)
            {
                if (key is "revision" or "expectedRevision" or "expectedInstance" or "expectedSourceRevision" or "requestId") continue;
                var oldValue = Secret(key) ? "Hidden" : before[key]?.ToString();
                rows.Add($"<dt>{E(Label(key))}</dt><dd>{E(oldValue)} → {E(Secret(key) ? value is null ? "Remove secret" : "Replace secret" : value?.ToString())}</dd>");
            }
        if (rows.Count == 0) foreach (var (key, value) in before) rows.Add($"<dt>{E(Label(key))}</dt><dd>{E(Secret(key) ? "Hidden" : value?.ToString())}</dd>");
        return $"{(before["user"] is { } user ? $"<p>{E(user.ToString())}</p>" : "")}<dl>{string.Join("", rows)}</dl>";
    }

    internal static void Map(WebApplication app)
    {
        app.MapGet("/api/settings/changes/{id}", async (string id, HttpRequest request, ProtectedSettingsChanges changes,
            UserDirectoryStore users, IClock clock, CancellationToken ct) =>
            await CoreSessionAuthorization.RequireSessionAsync(request, users, clock, user => {
                lock (changes.sync)
                {
                    var entry = changes.entries.GetValueOrDefault(id);
                    return Task.FromResult(entry is null || entry.ExpiresAt <= clock.UtcNow ? Error(404, "settings_change_missing", "The review expired.")
                        : entry.UserId != user.Id || entry.Caller != Caller(request) ? Error(403, "settings_change_forbidden", "This review belongs to another caller.")
                        : CoreJson.Json(changes.View(entry)));
                }
            }, cancellationToken: ct));
        app.MapDelete("/api/settings/changes/{id}", async (string id, HttpRequest request, ProtectedSettingsChanges changes,
            UserDirectoryStore users, IClock clock, CancellationToken ct) =>
            await CoreSessionAuthorization.RequireSessionAsync(request, users, clock, user => {
                lock (changes.sync)
                {
                    var entry = changes.entries.GetValueOrDefault(id);
                    if (entry is null || entry.UserId != user.Id || entry.Caller != Caller(request))
                        return Task.FromResult(Error(404, "settings_change_missing", "This review is unavailable."));
                    if (entry.Status is "applying" or "succeeded") return Task.FromResult(Error(409, "settings_change_started", "This change already started. Read its result."));
                    if (entry.Status is "pending" or "approved") { entry.Status = "denied"; entry.Nonce = null; entry.Session = null; }
                    return Task.FromResult(CoreJson.Json(changes.View(entry)));
                }
            }, requireCsrf: true, cancellationToken: ct));
        app.MapMethods("/settings/confirm/{id}", ["GET", "POST"], async (string id, HttpContext context,
            ProtectedSettingsChanges changes, UserDirectoryStore users, AppRegistryStore apps, IClock clock) =>
        {
            InstallationApprovalEndpoints.ProtectPage(context.Response);
            if (!await InstallationApprovalEndpoints.HasIsolatedCookieHostAsync(context.Request, apps, context.RequestAborted))
                return Results.Text("Open confirmation on Core's isolated origin.", statusCode: 409);
            var post = HttpMethods.IsPost(context.Request.Method);
            if (post ? !InstallationApprovalEndpoints.IsSameOriginDecision(context.Request) : !InstallationApprovalEndpoints.IsPageNavigation(context.Request)) return Results.StatusCode(403);
            var actor = await InstallationApprovalEndpoints.BrowserActorAsync(context.Request, users, clock, context.RequestAborted);
            if (actor is null) return Results.Redirect($"/login?returnTo={Uri.EscapeDataString(context.Request.Path)}");
            var form = post ? await context.Request.ReadFormAsync(context.RequestAborted) : null;
            lock (changes.sync)
            {
                var entry = changes.entries.GetValueOrDefault(id);
                if (entry is null || entry.ExpiresAt <= clock.UtcNow) return Results.Text("This confirmation expired.", statusCode: 410);
                if (entry.UserId != actor.Id) return Results.StatusCode(403);
                var session = CoreSessionAuthorization.ReadSessionId(context.Request)!;
                if (post)
                {
                    if (entry.Status != "pending" || entry.Nonce is null || entry.Session != session ||
                        !CryptographicOperations.FixedTimeEquals(Encoding.UTF8.GetBytes(entry.Nonce), Encoding.UTF8.GetBytes(form!["nonce"].ToString()))) return Results.StatusCode(403);
                    entry.Status = form!["decision"] == "approve" ? "approved" : "denied"; entry.Nonce = null; entry.Session = null;
                }
                else if (entry.Status == "pending") { entry.Nonce = Convert.ToHexString(RandomNumberGenerator.GetBytes(32)); entry.Session = session; }
                var body = entry.Status == "pending" ? entry.Summary + $"<form method=post><input type=hidden name=nonce value=\"{entry.Nonce}\"><div class=actions><button name=decision value=deny>Cancel</button><button class=primary name=decision value=approve>Confirm change</button></div></form>"
                    : $"<p role=status>{WebUtility.HtmlEncode(entry.Status == "approved" ? "Confirmed. Return to the app to finish saving." : entry.Status == "denied" ? "Cancelled. Nothing was changed." : entry.Error ?? "The app has received your decision.")}</p>";
                return Results.Content(CoreBrowserPages.Approval(entry.Title, null, null, entry.CallerName, body), "text/html");
            }
        }).WithMetadata(new DisableCorsAttribute());
    }
}
