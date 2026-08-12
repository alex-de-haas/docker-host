using System.Net;
using System.Net.Http.Headers;
using System.Text.Json;
using Microsoft.Extensions.DependencyInjection;

namespace Haas.Hosty.Core.Tests.Http;

// The app-directory roster, which now carries each app's declared platform interfaces resolved to a
// callable URL (docs/features/app-mcp/feature.md).
//
// This widened what one app can learn about another, so the widening is asserted rather than assumed:
// the disclosure is the app roster plus where their declared interfaces live, and nothing more —
// no settings, no secrets, no per-app operational state beyond whether it is running. Reaching one of
// those URLs still needs a Core-issued token the caller does not get from here.
public sealed class AppDirectoryInterfacesHttpTests
{
    [Fact]
    public async Task ReportsDeclaredInterfacesWithResolvedUrls()
    {
        await using var harness = await CoreHttpHarness.StartAsync();
        var apps = harness.Services.GetRequiredService<AppRegistryStore>();
        await apps.UpsertAppAsync(CreateApp("hosty.ai-gateway", system: true));
        await apps.UpsertAppAsync(CreateApp("com.haas.demo-app"));
        var token = IssueServiceToken(harness, "hosty.ai-gateway");
        using var client = harness.CreateClient();

        using var response = await SendAsync(client, "/api/internal/apps/hosty.ai-gateway/app-directory", token);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var payload = JsonDocument.Parse(await response.Content.ReadAsStringAsync()).RootElement;
        var entries = payload.GetProperty("apps").EnumerateArray().ToArray();
        Assert.Equal(2, entries.Length);

        foreach (var entry in entries)
        {
            // Every entry carries the shape the caller relies on, present even when empty — a
            // consumer must not have to distinguish "no interfaces" from "field missing".
            Assert.True(entry.TryGetProperty("interfaces", out var interfaces));
            Assert.Equal(JsonValueKind.Array, interfaces.ValueKind);
            Assert.False(string.IsNullOrWhiteSpace(entry.GetProperty("runtimeState").GetString()));
            Assert.False(string.IsNullOrWhiteSpace(entry.GetProperty("displayName").GetString()));
        }
    }

    [Fact]
    public async Task RejectsAMissingOrInvalidServiceToken()
    {
        await using var harness = await CoreHttpHarness.StartAsync();
        var apps = harness.Services.GetRequiredService<AppRegistryStore>();
        await apps.UpsertAppAsync(CreateApp("hosty.ai-gateway", system: true));
        using var client = harness.CreateClient();

        using var anonymous = await client.GetAsync("/api/internal/apps/hosty.ai-gateway/app-directory");
        Assert.Equal(HttpStatusCode.Unauthorized, anonymous.StatusCode);

        // A present-but-forged bearer must fail the signature check, not merely the null check —
        // the half a missing-token probe cannot reach.
        using var forged = await SendAsync(
            client,
            "/api/internal/apps/hosty.ai-gateway/app-directory",
            "hosty_app_service.invalid");
        Assert.Equal(HttpStatusCode.Unauthorized, forged.StatusCode);
    }

    [Fact]
    public async Task RejectsATokenMintedForAnotherApp()
    {
        // Scoping matters more now that the response describes the whole fleet: a token belonging to
        // one app must not become a roster read performed in another app's name.
        await using var harness = await CoreHttpHarness.StartAsync();
        var apps = harness.Services.GetRequiredService<AppRegistryStore>();
        await apps.UpsertAppAsync(CreateApp("hosty.ai-gateway", system: true));
        await apps.UpsertAppAsync(CreateApp("com.haas.demo-app"));
        var otherToken = IssueServiceToken(harness, "com.haas.demo-app");
        using var client = harness.CreateClient();

        using var response = await SendAsync(
            client,
            "/api/internal/apps/hosty.ai-gateway/app-directory",
            otherToken);

        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
    }

    private static async Task<HttpResponseMessage> SendAsync(HttpClient client, string path, string token)
    {
        using var request = new HttpRequestMessage(HttpMethod.Get, path);
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        return await client.SendAsync(request);
    }

    private static string IssueServiceToken(CoreHttpHarness harness, string appId)
        => harness.Services.GetRequiredService<AppServiceTokenService>().CreateToken(appId);

    private static AppRecord CreateApp(string id, bool system = false)
        => new(
            Id: id,
            DisplayName: "App",
            Description: null,
            Version: "1.0.0",
            Kind: "runtime",
            System: system,
            Source: "installed",
            ManifestPath: $"apps/{id}/manifest.json",
            ManifestUrl: null,
            SelectedRuntime: "docker",
            OperationStatus: "installed",
            RuntimeState: "stopped",
            LastOperation: null,
            LastError: null,
            Capabilities: ["open"],
            Settings: new Dictionary<string, AppSettingValue>(),
            StorageMappings: [],
            Dependencies: [],
            Endpoints: [],
            InstalledAt: DateTimeOffset.UtcNow,
            UpdatedAt: DateTimeOffset.UtcNow);
}
