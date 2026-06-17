using Haas.Hosty.Core;

namespace Haas.Hosty.Core.Tests;

public sealed class CloudflaredIngressPlannerTests
{
    [Theory]
    [InlineData("pm", null, "pm")]
    [InlineData("com.haas.media-server", null, "com-haas-media-server")]
    [InlineData("anything", "pm", "pm")]
    [InlineData("anything", "  My App!! ", "my-app")]
    [InlineData("anything", "--weird__name--", "weird-name")]
    public void ResolveSubdomain_SanitizesAndHonorsOverride(string appId, string? @override, string expected)
        => Assert.Equal(expected, CloudflaredIngressPlanner.ResolveSubdomain(appId, @override));

    [Fact]
    public void ToLabel_CollapsesNonAlphanumericsAndFallsBack()
    {
        Assert.Equal("web-http", CloudflaredIngressPlanner.ToLabel("web.http", "x"));
        Assert.Equal("fallback", CloudflaredIngressPlanner.ToLabel("***", "fallback"));
    }

    [Fact]
    public void Hostname_IsSingleLevelForWildcardCertificateCoverage()
    {
        Assert.Equal("media.example.com", CloudflaredIngressPlanner.Hostname("media", "example.com", endpointLabel: null));
        Assert.Equal("media-jellyfin.example.com", CloudflaredIngressPlanner.Hostname("media", "example.com", "jellyfin"));
    }

    [Fact]
    public void ResolveOrigins_SinglePublicEndpoint_UsesBareSubdomain()
    {
        var origins = CloudflaredIngressPlanner.ResolveOrigins("example.com", "media", ["web.http"]);

        Assert.Equal("https://media.example.com", origins["HOSTY_PUBLIC_ORIGIN_WEB_HTTP"]);
        Assert.Single(origins);
    }

    [Fact]
    public void ResolveOrigins_MultiplePublicEndpoints_SuffixEachWithEndpointLabel()
    {
        var origins = CloudflaredIngressPlanner.ResolveOrigins("example.com", "media", ["ui", "jellyfin"]);

        Assert.Equal("https://media-ui.example.com", origins["HOSTY_PUBLIC_ORIGIN_UI"]);
        Assert.Equal("https://media-jellyfin.example.com", origins["HOSTY_PUBLIC_ORIGIN_JELLYFIN"]);
    }

    [Fact]
    public void BuildRoutes_SeedsCoreFirstThenAppsOrderedDeterministically()
    {
        var routes = CloudflaredIngressPlanner.BuildRoutes(
            "example.com",
            7070,
            [
                new IngressApp("media",
                [
                    new IngressEndpoint("ui", "http://localhost:8080"),
                    new IngressEndpoint("jellyfin", "http://localhost:8096"),
                ]),
                new IngressApp("pm", [new IngressEndpoint("web.http", "http://localhost:5000")]),
            ]);

        Assert.Equal("core.example.com", routes[0].Hostname);
        Assert.Equal("http://localhost:7070", routes[0].Service);
        // Apps ordered by subdomain; endpoints by key; single-endpoint app gets the bare subdomain.
        Assert.Equal(
            ["core.example.com", "media-jellyfin.example.com", "media-ui.example.com", "pm.example.com"],
            routes.Select(route => route.Hostname).ToArray());
        Assert.Equal("http://localhost:5000", routes.Single(route => route.Hostname == "pm.example.com").Service);
    }

    [Fact]
    public void BuildRoutes_DropsDuplicateHostnamesKeepingCoreSeed()
    {
        var routes = CloudflaredIngressPlanner.BuildRoutes(
            "example.com",
            7070,
            [new IngressApp("core", [new IngressEndpoint("web", "http://localhost:9999")])]);

        // The app's bare "core.example.com" collides with the seed, which was added first and wins.
        Assert.Single(routes);
        Assert.Equal("http://localhost:7070", routes[0].Service);
    }

    [Fact]
    public void RenderConfig_ProducesTunnelCredentialsAndCatchAll()
    {
        var yaml = CloudflaredIngressPlanner.RenderConfig(
            "tunnel-123",
            "/etc/hosty/creds.json",
            [new CloudflaredRoute("media.example.com", "http://localhost:8080")]);

        Assert.Contains("tunnel: \"tunnel-123\"", yaml);
        Assert.Contains("credentials-file: \"/etc/hosty/creds.json\"", yaml);
        Assert.Contains("  - hostname: media.example.com", yaml);
        Assert.Contains("    service: \"http://localhost:8080\"", yaml);
        // cloudflared requires the catch-all to be the final ingress rule.
        Assert.EndsWith($"  - service: http_status:404{Environment.NewLine}", yaml);
    }
}
