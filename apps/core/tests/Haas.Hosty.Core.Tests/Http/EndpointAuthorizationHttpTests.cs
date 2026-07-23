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
        // Auth handshake and login surface — public by definition.
        "/api/auth/csrf",
        "/api/auth/session",
        "/api/auth/logout",
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
        // Service-token authenticated app->Core endpoints (bearer token is the credential).
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

            if (AnonymousAllowedApiPatterns.Any(allowed => pattern.StartsWith(allowed, StringComparison.Ordinal)))
            {
                continue;
            }

            foreach (var method in HttpMethodsFor(endpoint))
            {
                var status = await SendAnonymousAsync(client, method, ConcretePath(endpoint.RoutePattern));
                // Anonymous callers must be turned away: 401 (no session) or 403 (CSRF checked first on
                // a session mutation). Anything 2xx means the route served an unauthenticated request.
                if ((int)status is >= 200 and < 300)
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
