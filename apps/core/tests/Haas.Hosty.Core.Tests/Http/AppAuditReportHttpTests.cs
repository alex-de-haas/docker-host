using System.Net;
using System.Net.Http.Json;
using Microsoft.Extensions.DependencyInjection;

namespace Haas.Hosty.Core.Tests.Http;

// App-reported audit over real HTTP: the AI gateway reports session lifecycle/approvals with its
// service token; the record lands namespaced in the shared audit log, and the endpoint rejects
// callers without a valid token, unknown apps, and malformed action names.
public sealed class AppAuditReportHttpTests
{
    private const string AppId = "hosty.ai-gateway";

    [Fact]
    public async Task RecordsANamespacedAuditEventForAValidServiceToken()
    {
        await using var harness = await CoreHttpHarness.StartAsync();
        var apps = harness.Services.GetRequiredService<AppRegistryStore>();
        await apps.UpsertAppAsync(CreateApp(AppId));
        var serviceToken = harness.Services.GetRequiredService<AppServiceTokenService>().CreateToken(AppId);
        using var client = harness.CreateClient();

        using var request = new HttpRequestMessage(HttpMethod.Post, $"/api/internal/apps/{AppId}/audit");
        request.Headers.Add("Authorization", $"Bearer {serviceToken}");
        request.Content = JsonContent.Create(new
        {
            action = "ai_action_approved",
            details = new Dictionary<string, string> { ["sessionId"] = "s1", ["toolName"] = "Write" },
        });
        using var response = await client.SendAsync(request);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var audit = harness.Services.GetRequiredService<AuditStore>();
        var records = await audit.ReadRecentAsync(10);
        var record = Assert.Single(records, candidate => candidate.Action == "app.ai_action_approved");
        Assert.Equal(AppId, record.ResourceId);
        Assert.Equal("Write", record.Details["toolName"]);
    }

    [Fact]
    public async Task RejectsMissingTokenUnknownAppAndBadAction()
    {
        await using var harness = await CoreHttpHarness.StartAsync();
        var apps = harness.Services.GetRequiredService<AppRegistryStore>();
        await apps.UpsertAppAsync(CreateApp(AppId));
        var tokens = harness.Services.GetRequiredService<AppServiceTokenService>();
        using var client = harness.CreateClient();

        // No token at all.
        using var anonymous = await client.PostAsJsonAsync($"/api/internal/apps/{AppId}/audit", new { action = "x" });
        Assert.Equal(HttpStatusCode.Unauthorized, anonymous.StatusCode);

        // A valid token for a different app must not authorize this app's report path.
        using var foreign = new HttpRequestMessage(HttpMethod.Post, $"/api/internal/apps/{AppId}/audit");
        foreign.Headers.Add("Authorization", $"Bearer {tokens.CreateToken("com.example.other")}");
        foreign.Content = JsonContent.Create(new { action = "x" });
        using var foreignResponse = await client.SendAsync(foreign);
        Assert.Equal(HttpStatusCode.Unauthorized, foreignResponse.StatusCode);

        // An uninstalled app with a technically valid signature is still refused.
        using var ghost = new HttpRequestMessage(HttpMethod.Post, "/api/internal/apps/com.example.ghost/audit");
        ghost.Headers.Add("Authorization", $"Bearer {tokens.CreateToken("com.example.ghost")}");
        ghost.Content = JsonContent.Create(new { action = "x" });
        using var ghostResponse = await client.SendAsync(ghost);
        Assert.Equal(HttpStatusCode.NotFound, ghostResponse.StatusCode);

        // Action names are shape-checked.
        using var bad = new HttpRequestMessage(HttpMethod.Post, $"/api/internal/apps/{AppId}/audit");
        bad.Headers.Add("Authorization", $"Bearer {tokens.CreateToken(AppId)}");
        bad.Content = JsonContent.Create(new { action = "Not Valid!" });
        using var badResponse = await client.SendAsync(bad);
        Assert.Equal(HttpStatusCode.BadRequest, badResponse.StatusCode);
    }

    private static AppRecord CreateApp(string id)
        => new(
            Id: id,
            DisplayName: "AI Gateway",
            Description: null,
            Version: "0.1.0",
            Kind: "runtime",
            System: true,
            Source: "installed",
            ManifestPath: $"apps/{id}/manifest.json",
            ManifestUrl: null,
            SelectedRuntime: "local",
            OperationStatus: "installed",
            RuntimeState: "running",
            LastOperation: null,
            LastError: null,
            Capabilities: ["logs"],
            Settings: new Dictionary<string, AppSettingValue>(),
            StorageMappings: [],
            Dependencies: [],
            Endpoints: [],
            InstalledAt: DateTimeOffset.UtcNow,
            UpdatedAt: DateTimeOffset.UtcNow);
}
