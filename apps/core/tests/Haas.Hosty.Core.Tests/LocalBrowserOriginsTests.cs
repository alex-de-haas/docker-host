namespace Haas.Hosty.Core.Tests;

public sealed class LocalBrowserOriginsTests
{
    [Theory]
    [InlineData("http://localhost:7070", "http://core.hosty.localhost:7070")]
    [InlineData("http://127.0.0.1:8080", "http://core.hosty.localhost:8080")]
    [InlineData("http://[::1]:7070", "http://core.hosty.localhost:7070")]
    [InlineData("https://localhost:7070", "https://localhost:7070")]
    [InlineData("https://core.example.com", "https://core.example.com")]
    [InlineData("http://192.168.1.2:7070", "http://192.168.1.2:7070")]
    public void CoreBrowserOriginPreservesPortsAndExplicitNonLocalOrigins(string input, string expected)
        => Assert.Equal(expected, LocalBrowserOrigins.Core(input));

    [Fact]
    public void AppNamesAreDistinctAcrossPunctuationAndInstances_AndFitDnsLabels()
    {
        var ids = new[] { "example.app", "example-app", "example_app", "example-dapp", new string('a', 49) + "." + new string('_', 13) };
        var names = ids.Select(id => LocalBrowserOrigins.AppHost(id)).ToArray();
        Assert.Equal(ids.Length, names.Distinct().Count());
        foreach (var name in names)
        {
            Assert.True(name.Length <= 253);
            foreach (var label in name.Split('.'))
            {
                Assert.InRange(label.Length, 1, 63);
                Assert.Matches("^[a-z0-9]([a-z0-9-]*[a-z0-9])?$", label);
            }
        }
        Assert.NotEqual(LocalBrowserOrigins.AppHost(ids[0]), LocalBrowserOrigins.AppHost(ids[0], "1234567890abcdef"));
        Assert.Equal("http://core.i-1234567890abcdef.hosty.localhost:7070", LocalBrowserOrigins.Core("http://localhost:7070", "1234567890abcdef"));
    }

    [Fact]
    public void BrowserEnvironmentAndSummaryAgree_WithoutChangingTransportOrPublication()
    {
        var endpoint = new AppEndpointContract("web", "http", "http://127.0.0.1:3210", true);
        var app = new AppRecord("example.app", "App", null, "1.0.0", "runtime", false, "manifest", null, null,
            "dev", "installed", "stopped", null, null, [], new Dictionary<string, AppSettingValue>(), [], [],
            [endpoint], DateTimeOffset.UtcNow, DateTimeOffset.UtcNow) { BrowserOriginScope = "1234567890abcdef" };
        var summary = AppSummary.From(app);
        var projected = summary.Endpoints.Single();
        Assert.Equal(endpoint.Url, projected.Url);
        Assert.Null(projected.PublicOrigin);
        Assert.Equal($"http://{LocalBrowserOrigins.AppHost(app.Id, app.BrowserOriginScope)}:3210", projected.BrowserOrigin);
        Assert.Equal(projected.BrowserOrigin, LocalBrowserOrigins.Environment(app, app.Endpoints)["HOSTY_PUBLIC_ORIGIN_WEB"]);
        Assert.Empty(app.Settings);
        Assert.Null(endpoint.BrowserOrigin);
        Assert.Equal(endpoint.Url, LocalBrowserOrigins.App(app, endpoint with { Public = false }));
    }
}
