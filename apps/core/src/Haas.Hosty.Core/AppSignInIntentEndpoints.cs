using Microsoft.AspNetCore.WebUtilities;
using Microsoft.AspNetCore.Cors;
using System.Text.Json;
using MediaTypeHeaderValue = Microsoft.Net.Http.Headers.MediaTypeHeaderValue;

namespace Haas.Hosty.Core;

internal static class AppSignInIntentEndpoints
{
    private const string SecurePrefix = "__Host-hosty-signin-";
    private const string LocalPrefix = "hosty_signin_";

    internal static void Map(WebApplication app)
    {
        app.MapGet("/api/auth/apps/protocol", (HttpResponse response) =>
        {
            response.Headers.CacheControl = "no-store";
            return CoreJson.Json(new AppAuthProtocolResponse(2));
        });
        app.MapPost("/api/apps/{appId}/sign-in-intent", async (string appId, HttpContext context, AppIdentityService identity,
            AppRegistryStore apps, AppSignInIntentStore intents, AuditStore audit, IClock clock)
            => await CreateAsync(appId, context, identity, apps, intents, audit, clock)).WithMetadata(new DisableCorsAttribute());
        app.MapGet("/api/apps/{appId}/open", async (string appId, HttpContext context, AppIdentityService identity,
            AppRegistryStore apps, AppSignInIntentStore intents, UserDirectoryStore users, AuditStore audit, IClock clock)
            => await OpenAsync(appId, context, identity, apps, intents, users, audit, clock)).WithMetadata(new DisableCorsAttribute());
        app.MapPost("/api/apps/{appId}/open", async (string appId, HttpContext context, AppIdentityService identity,
            AppRegistryStore apps, AppSignInIntentStore intents, UserDirectoryStore users, AuditStore audit, IClock clock)
            => await OpenAsync(appId, context, identity, apps, intents, users, audit, clock)).WithMetadata(new DisableCorsAttribute());
    }

    private static async Task<IResult> CreateAsync(string appId, HttpContext context, AppIdentityService identity,
        AppRegistryStore apps, AppSignInIntentStore intents, AuditStore audit, IClock clock)
    {
        var request = context.Request;
        Protect(context.Response);
        var auditAppId = (await apps.GetAppAsync(appId, context.RequestAborted))?.Id;
        try
        {
            if (!request.HasFormContentType)
                return await RefuseAsync(auditAppId, "sign_in_intent_invalid", "Sign-in must start with an app-origin navigation form.", 400, audit, clock, context.RequestAborted);
            var form = await request.ReadFormAsync(context.RequestAborted);
            if (form.Any(field => field.Value.Count != 1 || field.Key is not
                ("redirectUri" or "state" or "codeChallenge" or "codeChallengeMethod" or "prompt" or "responseMode")))
                return await RefuseAsync(auditAppId, "sign_in_intent_invalid", "Sign-in form fields are invalid.", 400, audit, clock, context.RequestAborted);
            var redirect = form["redirectUri"].ToString();
            await identity.RequireAllowedRedirectUriAsync(appId, redirect, context.RequestAborted);
            if (!MatchesOrigin(request, redirect))
                return await RefuseAsync(auditAppId, "sign_in_origin_invalid", "Sign-in must start on the destination app origin.", 403, audit, clock, context.RequestAborted);
            AppCodeProof.RequireChallenge(form["codeChallenge"].ToString(), form["codeChallengeMethod"].ToString());
            var mode = ReadMode(form["prompt"].ToString(), form["responseMode"].ToString(), form["state"].ToString());
            var callbackQuery = QueryHelpers.ParseQuery(new Uri(redirect).Query);
            if (callbackQuery.TryGetValue("state", out var callbackState) &&
                (callbackState.Count != 1 || callbackState.ToString() != form["state"].ToString()))
                throw new AppIdentityException("state_invalid", "Callback state must match the app's sign-in attempt.");
            if (!IsNavigation(request, mode))
                return await RefuseAsync(auditAppId, "sign_in_intent_invalid", "Sign-in requires its browser navigation context.", 403, audit, clock, context.RequestAborted);
            if (!await AppSignInCookieHost.IsSafeAsync(request, apps, context.RequestAborted))
                return await RefuseAsync(auditAppId, "sign_in_cookie_host_unsafe", "Use a Core hostname separate from every app: HTTPS, localhost over HTTP, or a literal IP host over HTTP.", 409, audit, clock, context.RequestAborted);
            var storage = AppSignInCookieHost.UsesBrowserStorage(request);
            var created = intents.Create(appId, redirect, form["state"].ToString(), form["codeChallenge"].ToString(), mode,
                request.HttpContext.Connection.RemoteIpAddress?.ToString() ?? "unknown",
                storage ? 0 : request.Cookies.Keys.Count(name => name.StartsWith(SecurePrefix, StringComparison.Ordinal) || name.StartsWith(LocalPrefix, StringComparison.Ordinal)));
            if (created is null)
                return await RefuseAsync(auditAppId, "sign_in_intent_capacity", "Too many pending sign-in attempts. Complete an existing attempt or wait five minutes.", 429, audit, clock, context.RequestAborted);
            if (storage) return AppSignInStorageResponse.RenderBootstrap(context.Response, created);
            context.Response.Cookies.Append(CookieName(request, created.Intent.Id), created.Nonce, CookieOptions(request, expires: false));
            context.Response.Headers.Location = $"/api/apps/{Uri.EscapeDataString(appId)}/open?requestId={created.Intent.Id}";
            return Results.StatusCode(StatusCodes.Status303SeeOther);
        }
        catch (AppIdentityException exception)
        {
            return await RefuseAsync(auditAppId, exception.Code, exception.Message, AuthEndpoints.MapIdentityErrorStatus(exception.Code), audit, clock, context.RequestAborted);
        }
    }

    private static async Task<IResult> OpenAsync(string appId, HttpContext context, AppIdentityService identity,
        AppRegistryStore apps, AppSignInIntentStore intents, UserDirectoryStore users, AuditStore audit, IClock clock)
    {
        var request = context.Request;
        Protect(context.Response);
        var auditAppId = (await apps.GetAppAsync(appId, context.RequestAborted))?.Id;
        AppSignInIntent? claimedStorageIntent = null;
        try
        {
            var storage = AppSignInCookieHost.UsesBrowserStorage(request);
            var post = HttpMethods.IsPost(request.Method);
            if (post && !storage) return await InvalidIntentAsync(auditAppId, audit, clock, context.RequestAborted);
            if (!request.Query.ContainsKey("requestId"))
            {
                if (post) return await InvalidIntentAsync(auditAppId, audit, clock, context.RequestAborted);
                if (request.Query.Keys.Any(key => key != "redirectUri"))
                    return await RefuseLegacyAttemptAsync(appId, context, identity, auditAppId, audit, clock);
                var redirect = request.Query["redirectUri"].ToString();
                if (string.IsNullOrWhiteSpace(redirect))
                    throw new AppIdentityException("redirect_uri_missing", "Redirect URI is required.");
                await identity.RequireAllowedRedirectUriAsync(appId, redirect, context.RequestAborted);
                return Results.Redirect(redirect);
            }
            var id = request.Query["requestId"].ToString();
            if (request.Query.Count != 1 || request.Query["requestId"].Count != 1 || id.Length != 64 || !id.All(Uri.IsHexDigit))
                return await InvalidIntentAsync(auditAppId, audit, clock, context.RequestAborted);
            Dictionary<string, string>? browserProofs = null;
            string? nonce;
            if (storage)
            {
                var pending = intents.FindCallback(appId, id);
                if (pending is null || !IsNavigation(request, pending.Mode))
                    return await InvalidIntentAsync(auditAppId, audit, clock, context.RequestAborted);
                if (!post)
                {
                    if (!await AppSignInCookieHost.IsSafeAsync(request, apps, context.RequestAborted))
                        return await RefuseAsync(auditAppId, "sign_in_cookie_host_unsafe", "Core's browser host is no longer isolated from apps.", 409, audit, clock, context.RequestAborted);
                    // A relayed public URL can read only this browser context's existing nonce.
                    // It never initializes storage or authorizes an issuance by itself.
                    return AppSignInStorageResponse.RenderContinuation(context.Response, pending);
                }
                if (request.Headers.Origin.Count != 1 || !InstallationApprovalEndpoints.IsSameOriginDecision(request) ||
                    request.ContentLength > 8192)
                    return await InvalidIntentAsync(auditAppId, audit, clock, context.RequestAborted);
                IFormCollection? form;
                try
                {
                    form = await ReadStorageFormAsync(request, context.RequestAborted);
                }
                catch (InvalidDataException)
                { return await InvalidIntentAsync(auditAppId, audit, clock, context.RequestAborted); }
                if (form is null || form.Count != 2 || form.Any(field => field.Value.Count != 1 || field.Key is not ("nonce" or "browserProofs")) ||
                    !IsCanonicalNonce(form["nonce"].ToString()) || !TryReadBrowserProofs(form["browserProofs"].ToString(), out browserProofs))
                    return await InvalidIntentAsync(auditAppId, audit, clock, context.RequestAborted);
                nonce = form["nonce"].ToString();
            }
            else nonce = request.Cookies[CookieName(request, id)];
            var intent = intents.Find(appId, id, nonce);
            if (intent is null)
            {
                // Third-party cookie policy can reject a silent frame's nonce cookie. Return only
                // its immutable public error callback so the app can offer its own popup. A relayed
                // request learns no code and cannot consume the rightful browser's attempt.
                var callback = intents.FindCallback(appId, id);
                if (callback is { Mode: AppSignInMode.Silent } && IsNavigation(request, callback.Mode))
                {
                    await identity.RequireAllowedRedirectUriAsync(appId, callback.RedirectUri, context.RequestAborted);
                    await RecordRefusalAsync(auditAppId, "sign_in_intent_invalid", audit, clock, context.RequestAborted);
                    return storage ? StorageErrorRedirect(context.Response, callback, "login_required", terminal: false)
                        : AppErrorRedirect(callback, "login_required");
                }
                if (!storage && !intents.Contains(id)) ClearCookie(context, id);
                return await InvalidIntentAsync(auditAppId, audit, clock, context.RequestAborted);
            }
            if (!IsNavigation(request, intent.Mode))
                return await InvalidIntentAsync(auditAppId, audit, clock, context.RequestAborted);
            // A cross-site form POST may omit Lax cookies. Recheck when this Core navigation
            // can see them, without evicting any other live browser attempt.
            if (!intents.WithinBrowserCapacity(intent, other => storage
                ? browserProofs!.GetValueOrDefault(other.Id) : request.Cookies[CookieName(request, other.Id)]))
            {
                intents.TryClaim(intent);
                if (!storage) ClearCookie(context, id);
                if (storage)
                {
                    await RecordRefusalAsync(auditAppId, "sign_in_intent_capacity", audit, clock, context.RequestAborted);
                    return AppSignInStorageResponse.RenderRefusal(context.Response, intent,
                        "Too many pending sign-in attempts in this browser. Complete an existing attempt or wait five minutes.", 429);
                }
                return await RefuseAsync(auditAppId, "sign_in_intent_capacity", "Too many pending sign-in attempts in this browser. Complete an existing attempt or wait five minutes.", 429, audit, clock, context.RequestAborted);
            }
            if (!await AppSignInCookieHost.IsSafeAsync(request, apps, context.RequestAborted))
            {
                intents.TryClaim(intent);
                if (!storage) ClearCookie(context, id);
                if (storage)
                {
                    await RecordRefusalAsync(auditAppId, "sign_in_cookie_host_unsafe", audit, clock, context.RequestAborted);
                    return AppSignInStorageResponse.RenderRefusal(context.Response, intent, "Core's browser host is no longer isolated from apps.", 409);
                }
                return await RefuseAsync(auditAppId, "sign_in_cookie_host_unsafe", "Core's browser cookie host is no longer isolated from apps.", 409, audit, clock, context.RequestAborted);
            }

            var navigation = await CoreSessionAuthorization.ResolveNavigationSessionAsync(request, users, clock, context.RequestAborted);
            if (navigation.User is null || (intent.Mode == AppSignInMode.Popup &&
                await InstallationApprovalEndpoints.BrowserActorAsync(request, users, clock, context.RequestAborted) is null))
            {
                if (intent.Mode == AppSignInMode.Silent)
                {
                    intents.TryClaim(intent);
                    if (!storage) ClearCookie(context, id);
                    var reason = navigation.Denied is null ? "login_required" : "access_denied";
                    await RecordRefusalAsync(auditAppId, reason, audit, clock, context.RequestAborted);
                    return storage ? StorageErrorRedirect(context.Response, intent, reason) : AppErrorRedirect(intent, reason);
                }
                if (navigation.Denied is not null)
                {
                    intents.TryClaim(intent);
                    if (!storage) ClearCookie(context, id);
                    await RecordRefusalAsync(auditAppId, "access_denied", audit, clock, context.RequestAborted);
                    if (storage)
                        return AppSignInStorageResponse.RenderRefusal(context.Response, intent, "This Core session cannot authorize app sign-in.",
                            (navigation.Denied as IStatusCodeHttpResult)?.StatusCode ?? 403);
                    return navigation.Denied;
                }
                var login = $"/login?returnTo={Uri.EscapeDataString(request.Path + request.QueryString)}";
                return storage ? AppSignInStorageResponse.RenderRedirect(context.Response, intent, login, terminal: false) : Results.Redirect(login);
            }
            // Recheck access before claim. A successful claim is terminal even if persistence fails:
            // a lost response requires a fresh attempt, never a second issuance from this intent.
            try { await identity.RequireAccessibleUserAsync(appId, navigation.User.Id, context.RequestAborted); }
            catch (AppIdentityException exception)
            {
                intents.TryClaim(intent);
                if (!storage) ClearCookie(context, id);
                if (intent.Mode == AppSignInMode.Silent && exception.Code is "user_not_found" or "user_disabled" or "app_access_denied" or "system_app_admin_required")
                {
                    await RecordRefusalAsync(auditAppId, exception.Code, audit, clock, context.RequestAborted);
                    return storage ? StorageErrorRedirect(context.Response, intent, "access_denied") : AppErrorRedirect(intent, "access_denied");
                }
                if (storage)
                {
                    await RecordRefusalAsync(auditAppId, exception.Code, audit, clock, context.RequestAborted);
                    return AppSignInStorageResponse.RenderRefusal(context.Response, intent, exception.Message, AuthEndpoints.MapIdentityErrorStatus(exception.Code));
                }
                throw;
            }
            if (!intents.TryClaim(intent)) return await InvalidIntentAsync(auditAppId, audit, clock, context.RequestAborted);
            if (!storage) ClearCookie(context, id);
            else claimedStorageIntent = intent;
            var authorization = await identity.CreateAuthorizationCodeAsync(appId, navigation.User.Id, intent.RedirectUri,
                intent.CodeChallenge, "S256", CoreSessionAuthorization.ReadSessionId(request), context.RequestAborted,
                activityAuthorized: intent.Mode != AppSignInMode.Silent && InstallationApprovalEndpoints.IsPageNavigation(request)
                    && await InstallationApprovalEndpoints.BrowserActorAsync(request, users, clock, context.RequestAborted) is not null);
            if (intent.Mode == AppSignInMode.Popup)
                return storage ? AppSignInStorageResponse.RenderPopup(context.Response, intent, "code", authorization.Code, close: true)
                    : AppPopupResponse.Render(context.Response, intent.RedirectUri, intent.State, authorization.Code);
            var destination = QueryHelpers.ParseQuery(new Uri(authorization.RedirectUri).Query).ContainsKey("state")
                ? authorization.RedirectUri : QueryHelpers.AddQueryString(authorization.RedirectUri, "state", intent.State);
            return storage ? AppSignInStorageResponse.RenderRedirect(context.Response, intent, destination, terminal: true) : Results.Redirect(destination);
        }
        catch (AppIdentityException exception)
        {
            if (claimedStorageIntent is not null)
            {
                await RecordRefusalAsync(auditAppId, exception.Code, audit, clock, context.RequestAborted);
                return AppSignInStorageResponse.RenderRefusal(context.Response, claimedStorageIntent, exception.Message, AuthEndpoints.MapIdentityErrorStatus(exception.Code));
            }
            return await RefuseAsync(auditAppId, exception.Code, exception.Message, AuthEndpoints.MapIdentityErrorStatus(exception.Code), audit, clock, context.RequestAborted);
        }
    }

    private static bool IsCanonicalNonce(string value)
        => value.Length == 64 && value.All(character => character is >= '0' and <= '9' or >= 'a' and <= 'f');

    private static async Task<IFormCollection?> ReadStorageFormAsync(HttpRequest request, CancellationToken ct)
    {
        if (!MediaTypeHeaderValue.TryParse(request.ContentType, out var type) ||
            !string.Equals(type.MediaType.Value, "application/x-www-form-urlencoded", StringComparison.OrdinalIgnoreCase)) return null;
        // Bound actual bytes before decoding: chunked requests have no Content-Length and multipart
        // sections can exceed value limits. Only the generated URL-encoded Core form is accepted.
        var bytes = new byte[8193];
        var length = 0;
        while (length < bytes.Length)
        {
            var read = await request.Body.ReadAsync(bytes.AsMemory(length), ct);
            if (read == 0) break;
            length += read;
        }
        if (length > 8192) return null;
        using var body = new MemoryStream(bytes, 0, length, writable: false);
        // FormReader also counts percent-encoded characters. Apply the smaller decoded nonce/proof
        // limits after parsing so a valid 16-proof object still fits the URL-encoded form.
        using var reader = new FormReader(body) { ValueCountLimit = 2, KeyLengthLimit = 16, ValueLengthLimit = 8192 };
        return new FormCollection(await reader.ReadFormAsync(ct));
    }

    private static bool TryReadBrowserProofs(string value, out Dictionary<string, string>? proofs)
    {
        proofs = null;
        if (value.Length > 2300) return false;
        try
        {
            using var json = JsonDocument.Parse(value, new JsonDocumentOptions { MaxDepth = 2 });
            if (json.RootElement.ValueKind != JsonValueKind.Object) return false;
            var result = new Dictionary<string, string>(StringComparer.Ordinal);
            foreach (var property in json.RootElement.EnumerateObject())
            {
                if (result.Count >= AppSignInIntentStore.MaxPerBrowser || !IsCanonicalNonce(property.Name) ||
                    property.Value.ValueKind != JsonValueKind.String || !IsCanonicalNonce(property.Value.GetString()!) ||
                    !result.TryAdd(property.Name, property.Value.GetString()!)) return false;
            }
            proofs = result;
            return true;
        }
        catch (JsonException) { return false; }
    }

    private static IResult StorageErrorRedirect(HttpResponse response, AppSignInIntent intent, string error, bool terminal = true)
    {
        var destination = QueryHelpers.AddQueryString(intent.RedirectUri, "error", error);
        if (!QueryHelpers.ParseQuery(new Uri(intent.RedirectUri).Query).ContainsKey("state"))
            destination = QueryHelpers.AddQueryString(destination, "state", intent.State);
        return AppSignInStorageResponse.RenderRedirect(response, intent, destination, terminal);
    }

    private static AppSignInMode ReadMode(string prompt, string responseMode, string state)
    {
        var validState = state.Length == 64 && state.All(Uri.IsHexDigit);
        if (prompt.Length > 0)
        {
            if (prompt != "none" || responseMode.Length > 0 || !validState)
                throw new AppIdentityException("prompt_invalid", "Silent sign-in requires a 256-bit state and no popup mode.");
            return AppSignInMode.Silent;
        }
        if (responseMode.Length > 0)
        {
            if (responseMode != "web_message" || !validState)
                throw new AppIdentityException("response_mode_invalid", "Popup sign-in requires a 256-bit state.");
            return AppSignInMode.Popup;
        }
        if (!validState) throw new AppIdentityException("state_invalid", "A 256-bit sign-in state is required.");
        return AppSignInMode.Standalone;
    }

    // A client can discover protocol 1 immediately before Core is upgraded. Return only
    // its validated public error callback; caller-supplied proof never authorizes issuance.
    private static async Task<IResult> RefuseLegacyAttemptAsync(string appId, HttpContext context,
        AppIdentityService identity, string? auditAppId, AuditStore audit, IClock clock)
    {
        var request = context.Request;
        try
        {
            if (request.Query.Any(field => field.Value.Count != 1 || field.Key is not
                ("redirectUri" or "state" or "codeChallenge" or "codeChallengeMethod" or "prompt" or "responseMode")))
                return await InvalidIntentAsync(auditAppId, audit, clock, context.RequestAborted);
            var redirect = request.Query["redirectUri"].ToString();
            await identity.RequireAllowedRedirectUriAsync(appId, redirect, context.RequestAborted);
            AppCodeProof.RequireChallenge(request.Query["codeChallenge"].ToString(), request.Query["codeChallengeMethod"].ToString());
            var state = request.Query["state"].ToString();
            var mode = ReadMode(request.Query["prompt"].ToString(), request.Query["responseMode"].ToString(), state);
            var callbackQuery = QueryHelpers.ParseQuery(new Uri(redirect).Query);
            if (request.Query.Count != (mode == AppSignInMode.Standalone ? 4 : 5) || !IsNavigation(request, mode) ||
                (request.Headers.ContainsKey("Origin") && !MatchesOrigin(request, redirect)) ||
                (callbackQuery.TryGetValue("state", out var callbackState) && (callbackState.Count != 1 || callbackState.ToString() != state)))
                return await InvalidIntentAsync(auditAppId, audit, clock, context.RequestAborted);
            await RecordRefusalAsync(auditAppId, "protocol_required", audit, clock, context.RequestAborted);
            return mode == AppSignInMode.Popup
                ? AppPopupResponse.RenderProtocolRequired(context.Response, redirect, state)
                : AppErrorRedirect(redirect, state, "protocol_required");
        }
        catch (AppIdentityException)
        {
            return await InvalidIntentAsync(auditAppId, audit, clock, context.RequestAborted);
        }
    }

    private static bool IsNavigation(HttpRequest request, AppSignInMode mode)
        => request.Headers["Sec-Fetch-Mode"] == "navigate" &&
           request.Headers["Sec-Fetch-Dest"] == (mode == AppSignInMode.Silent ? "iframe" : "document");

    private static bool MatchesOrigin(HttpRequest request, string redirect)
    {
        var origin = request.Headers.Origin.ToString();
        if (request.Headers.Origin.Count != 1 || !Uri.TryCreate(origin, UriKind.Absolute, out var source) ||
            source.Scheme is not ("http" or "https") || source.UserInfo.Length != 0 || source.AbsolutePath != "/" ||
            source.Query.Length != 0 || source.Fragment.Length != 0) return false;
        var target = new Uri(redirect);
        var host = AppSignInCookieHost.CanonicalHost(source.Host);
        return host is not null && source.Scheme == target.Scheme && source.Port == target.Port &&
            host == AppSignInCookieHost.CanonicalHost(target.Host);
    }

    private static IResult AppErrorRedirect(AppSignInIntent intent, string error)
        => AppErrorRedirect(intent.RedirectUri, intent.State, error);
    private static IResult AppErrorRedirect(string redirectUri, string state, string error)
        => Results.Redirect(QueryHelpers.AddQueryString(redirectUri,
            QueryHelpers.ParseQuery(new Uri(redirectUri).Query).ContainsKey("state")
                ? new Dictionary<string, string?> { ["error"] = error }
                : new Dictionary<string, string?> { ["error"] = error, ["state"] = state }));

    private static string CookieName(HttpRequest request, string id) => (request.IsHttps ? SecurePrefix : LocalPrefix) + id;
    private static CookieOptions CookieOptions(HttpRequest request, bool expires) => new()
    {
        HttpOnly = true, Secure = request.IsHttps, Path = "/", SameSite = SameSiteMode.Lax,
        MaxAge = expires ? TimeSpan.Zero : AppSignInIntentStore.Lifetime,
    };
    private static void ClearCookie(HttpContext context, string id)
        => context.Response.Cookies.Delete(CookieName(context.Request, id), CookieOptions(context.Request, expires: true));
    private static void Protect(HttpResponse response)
    {
        response.Headers.CacheControl = "no-store";
        response.Headers["Referrer-Policy"] = "no-referrer";
    }
    private static Task<IResult> InvalidIntentAsync(string? appId, AuditStore audit, IClock clock, CancellationToken ct)
        => RefuseAsync(appId, "sign_in_intent_invalid", "Sign-in intent is missing, expired, already used, or belongs to another browser. Start sign-in again from the app.", 403, audit, clock, ct);
    private static Task RecordRefusalAsync(string? appId, string reason, AuditStore audit, IClock clock, CancellationToken ct)
        => audit.AppendAsync(new AuditRecord($"audit_{Guid.NewGuid():N}", "auth.app-sign-in", "app", appId, reason, null,
            clock.UtcNow, new Dictionary<string, string> { ["reason"] = reason }), ct);
    private static async Task<IResult> RefuseAsync(string? appId, string reason, string message, int status, AuditStore audit, IClock clock, CancellationToken ct)
    {
        await RecordRefusalAsync(appId, reason, audit, clock, ct);
        return CoreJson.Json(new ErrorResponse(reason, message), statusCode: status);
    }
}

internal sealed record AppAuthProtocolResponse(int Version);
