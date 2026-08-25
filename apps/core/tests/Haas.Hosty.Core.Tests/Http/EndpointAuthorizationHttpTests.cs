using System.Net;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using Microsoft.AspNetCore.Routing.Patterns;
using Microsoft.Extensions.DependencyInjection;

namespace Haas.Hosty.Core.Tests.Http;

// The A4 guardrail, done over real HTTP instead of a source regex: enumerate every mapped endpoint and
// prove that an unauthenticated caller cannot reach any /api route except the ones explicitly declared
// public or service-token-authenticated. A new protected route that forgets its session guard would
// answer 2xx here and fail; a new intentionally-public route must be added to the allowlist below,
// which is the point — the exemption becomes a conscious, reviewed decision instead of an accident.
public sealed class EndpointAuthorizationHttpTests
{
    // Routes under /api that are public or authenticated by something other than a Core session
    // (service token, bootstrap/recovery token, trusted-proxy secret). Matched against the raw route
    // pattern. Anything not here MUST reject an anonymous caller.
    private static readonly string[] AnonymousAllowedApiPatterns =
    [
        // Auth handshake and login surface — public by definition. (Logout is intentionally NOT here:
        // it now requires CSRF, so it answers 403 to an anonymous caller like any other mutation.)
        "/api/auth/csrf",
        "/api/auth/session",
        "/api/auth/bootstrap",
        "/api/auth/recovery",
        "/api/auth/trusted-proxy/session",
        // App identity exchange: the code/token are the credential, no session.
        "/api/auth/apps/token",
        "/api/auth/apps/revalidate",
        // Invitation accept: the invitation token is the credential (the list/create routes at
        // /api/auth/invitations are admin-gated and deliberately NOT covered by this prefix).
        "/api/auth/invitations/accept",
        // Core status is intentionally readable pre-login (reveals more to a signed-in caller).
        "/api/core/status",
        // OAuth/OIDC callback: the IdP redirects an unauthenticated user here with a code+state, so
        // it is public by construction — it establishes the session rather than requiring one.
        "/api/auth/callback/",
        // Device authorization: the caller has no credential yet, which is the entire point. Only the
        // two flow endpoints are public — the approval and credential routes under
        // /api/auth/device/requests and /api/auth/credentials are session-gated and must stay in the
        // loop above, so this lists them exactly rather than opening the /api/auth/device/ prefix.
        "/api/auth/device/code",
        "/api/auth/device/token",
        // The OAuth flow's public half (docs/features/mcp-oauth/plan.md). /authorize is where an
        // anonymous browser lands from a client — consent itself is behind Shell's session. /token
        // and /register authenticate by their own protocol means (PKCE / the DCR toggle plus rate
        // limit), not by a session; /api/auth/oauth/requests and /clients are session-gated and
        // must stay OUT of this list, so the oauth prefix is not opened wholesale.
        "/api/auth/oauth/authorize",
        "/api/auth/oauth/token",
        "/api/auth/oauth/register",
    ];

    // Browser-navigation endpoints: still protected, but they DENY an anonymous caller by redirecting
    // to /login (a top-level GET the browser can act on) rather than a JSON 401. Excluded from the
    // 401/403 loop and asserted precisely below (AppOpenNavigation_RedirectsAnonymousToLogin) so their
    // redirect denial can't hide a dropped guard either.
    private static readonly string[] NavigationApiPatterns =
    [
        "/api/apps/{appId}/open",
    ];

    // Service-token (bearer) app->Core routes. The no-credential loop already proves they reject a
    // missing token, but that only exercises the null-token half of their guard — a dropped
    // ValidateToken would slip through. These are additionally probed with a present-but-invalid bearer
    // (see EveryServiceTokenEndpoint_RejectsAnInvalidBearer) so the signature check itself is covered.
    private static readonly string[] ServiceTokenApiPrefixes =
    [
        "/api/internal/",
    ];

    [Fact]
    public async Task EveryApiEndpoint_RejectsAnAnonymousCaller_UnlessExplicitlyPublic()
    {
        await using var harness = await CoreHttpHarness.StartAsync();
        using var client = harness.CreateClient();
        var source = harness.Services.GetRequiredService<EndpointDataSource>();

        var offenders = new List<string>();
        foreach (var endpoint in source.Endpoints.OfType<RouteEndpoint>())
        {
            var pattern = endpoint.RoutePattern.RawText ?? "";
            if (!pattern.StartsWith("/api/", StringComparison.Ordinal) && pattern != "/api")
            {
                continue;
            }

            if (AnonymousAllowedApiPatterns.Any(allowed => pattern.StartsWith(allowed, StringComparison.Ordinal)) ||
                NavigationApiPatterns.Contains(pattern))
            {
                continue;
            }

            foreach (var method in HttpMethodsFor(endpoint))
            {
                var status = await SendAnonymousAsync(client, method, ConcretePath(endpoint.RoutePattern));
                // Require a positive authorization denial, not merely a non-success. A session route
                // rejects an anonymous caller with 401 (no session) or 403 (CSRF checked first on a
                // mutation); a service-token route with 401 (no bearer). The auth check runs BEFORE the
                // handler resolves the route's resource, so a protected resource-scoped route (bogus id)
                // still answers 401/403 up front — whereas a route whose guard was dropped would fall
                // through to its handler and answer 200/400/404, all of which fail here.
                if ((int)status is not (401 or 403))
                {
                    offenders.Add($"{method} {pattern} -> {(int)status}");
                }
            }
        }

        Assert.True(
            offenders.Count == 0,
            "These /api routes served an anonymous request (add a session guard, or add to the public allowlist):\n"
                + string.Join("\n", offenders));
    }

    [Fact]
    public async Task EveryServiceTokenEndpoint_RejectsAnInvalidBearer()
    {
        await using var harness = await CoreHttpHarness.StartAsync();
        using var client = harness.CreateClient();
        var source = harness.Services.GetRequiredService<EndpointDataSource>();

        var probed = 0;
        var offenders = new List<string>();
        foreach (var endpoint in source.Endpoints.OfType<RouteEndpoint>())
        {
            var pattern = endpoint.RoutePattern.RawText ?? "";
            if (!ServiceTokenApiPrefixes.Any(prefix => pattern.StartsWith(prefix, StringComparison.Ordinal)))
            {
                continue;
            }

            foreach (var method in HttpMethodsFor(endpoint))
            {
                probed++;
                using var request = new HttpRequestMessage(new HttpMethod(method), ConcretePath(endpoint.RoutePattern));
                request.Headers.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", "hosty_app_service.invalid");
                if (!HttpMethods.IsGet(method) && !HttpMethods.IsDelete(method))
                {
                    request.Content = new StringContent("{}", System.Text.Encoding.UTF8, "application/json");
                }

                using var response = await client.SendAsync(request);
                // A garbage bearer must be rejected by the token signature check (401), not accepted
                // and served — this is the half a missing-token probe cannot reach.
                if ((int)response.StatusCode != 401)
                {
                    offenders.Add($"{method} {pattern} -> {(int)response.StatusCode}");
                }
            }
        }

        Assert.True(probed > 0, "No service-token endpoints were probed; the prefix list is stale.");
        Assert.True(offenders.Count == 0, "Service-token routes accepting an invalid bearer:\n" + string.Join("\n", offenders));
    }

    [Fact]
    public async Task AppOpenNavigation_RedirectsAnonymousToLogin()
    {
        // The one navigation endpoint's denial contract: an anonymous caller is sent to /login (302),
        // never served the resource. Asserted directly so the generic loop's exclusion above cannot
        // hide a dropped guard here. redirectUri is supplied so the request clears input validation and
        // actually reaches the session check.
        await using var harness = await CoreHttpHarness.StartAsync();
        // TestServer's client does not auto-follow redirects, so the 302 is observed directly.
        using var client = harness.CreateClient();

        using var response = await client.GetAsync(
            "/api/apps/com.example.notes/open?redirectUri=https://app.example.test/");

        Assert.Equal(HttpStatusCode.Redirect, response.StatusCode);
        Assert.StartsWith("/login", response.Headers.Location?.OriginalString ?? "");
    }

    private static async Task<HttpStatusCode> SendAnonymousAsync(HttpClient client, string method, string path)
    {
        using var request = new HttpRequestMessage(new HttpMethod(method), path);
        if (!HttpMethods.IsGet(method) && !HttpMethods.IsDelete(method))
        {
            // An empty JSON object binds to the endpoint's body record (missing members default to
            // null), so the request reaches the handler's auth check rather than failing model binding.
            request.Content = new StringContent("{}", System.Text.Encoding.UTF8, "application/json");
        }

        using var response = await client.SendAsync(request);
        return response.StatusCode;
    }

    private static IEnumerable<string> HttpMethodsFor(RouteEndpoint endpoint)
    {
        var methods = endpoint.Metadata.GetMetadata<HttpMethodMetadata>()?.HttpMethods;
        return methods is { Count: > 0 } ? methods : ["GET"];
    }

    // Replaces route parameters with a placeholder so the path is concrete (a catch-all becomes one
    // segment). The value is irrelevant — the request is rejected before the handler reads it.
    private static string ConcretePath(RoutePattern pattern)
    {
        var segments = new List<string>();
        foreach (var segment in pattern.PathSegments)
        {
            foreach (var part in segment.Parts)
            {
                switch (part)
                {
                    case RoutePatternLiteralPart literal:
                        segments.Add(literal.Content);
                        break;
                    case RoutePatternParameterPart:
                        segments.Add("x");
                        break;
                }
            }
        }

        return "/" + string.Join('/', segments);
    }
}
