using System.Net;
using System.Net.Http.Headers;
using System.Text.Json;
using Microsoft.Extensions.DependencyInjection;

namespace Haas.Hosty.Core.Tests.Http;

// Reading one app's agent skill from another app (docs/features/app-provided-skills/plan.md).
//
// Every other /api/internal/apps/{appId}/… route answers about the caller itself — the service token
// is validated against the id in the path — and that is what stops an app asking Core about its
// neighbours. This route crosses that line deliberately, so the crossing is asserted rather than
// assumed: who may cross, who may not, and that nothing but the declared skill comes back.
public sealed class AgentSkillHttpTests
{
    [Fact]
    public async Task AnAssistantReadsADeclaredSkill_AndAnOrdinaryAppCannot()
    {
        // The pair. Either half alone is satisfied by a route that answers everyone, or by one that
        // answers nobody — and the second is the failure that looks like security while being a bug.
        await using var harness = await CoreHttpHarness.StartAsync();
        var apps = harness.Services.GetRequiredService<AppRegistryStore>();
        var paths = harness.Services.GetRequiredService<CoreDataPaths>();

        await apps.UpsertAppAsync(CreateApp("hosty.ai-gateway", system: true) with
        {
            Interfaces = new Dictionary<string, IReadOnlyList<AppInterfaceContract>>
            {
                ["ai-gateway"] = [new AppInterfaceContract("default", null, "/api")],
            },
        });
        await apps.UpsertAppAsync(CreateApp("com.haas.torrent-engine"));
        await apps.UpsertAppAsync(CreateApp("com.haas.demo-app") with { AgentSkillFile = "docs/agent.md" });
        WriteSkill(paths, "com.haas.demo-app", "docs/agent.md", "# Demo App\n\nCall list_people before roles.");

        using var client = harness.CreateClient();

        using var allowed = await SendAsync(
            client,
            "/api/internal/apps/hosty.ai-gateway/agent-skills/com.haas.demo-app",
            IssueServiceToken(harness, "hosty.ai-gateway"));
        Assert.Equal(HttpStatusCode.OK, allowed.StatusCode);
        var payload = JsonDocument.Parse(await allowed.Content.ReadAsStringAsync()).RootElement;
        Assert.Equal("com.haas.demo-app", payload.GetProperty("appId").GetString());
        // The text travels with whose it is: prose reaching a model without attribution invites the
        // confusion this feature is careful about everywhere else.
        Assert.Contains("Call list_people before roles.", payload.GetProperty("markdown").GetString());

        // An installed app with a valid token of its own, and no reason to read a neighbour's
        // instructions. "Cheap to allow" is how a torrent client ends up reading the media server's.
        using var refused = await SendAsync(
            client,
            "/api/internal/apps/com.haas.torrent-engine/agent-skills/com.haas.demo-app",
            IssueServiceToken(harness, "com.haas.torrent-engine"));
        Assert.Equal(HttpStatusCode.Forbidden, refused.StatusCode);
    }

    [Fact]
    public async Task RefusesAnAnonymousCallerAndAForeignToken()
    {
        await using var harness = await CoreHttpHarness.StartAsync();
        var apps = harness.Services.GetRequiredService<AppRegistryStore>();
        await apps.UpsertAppAsync(CreateApp("hosty.ai-gateway", system: true) with
        {
            Interfaces = new Dictionary<string, IReadOnlyList<AppInterfaceContract>>
            {
                ["ai-gateway"] = [new AppInterfaceContract("default", null, "/api")],
            },
        });
        await apps.UpsertAppAsync(CreateApp("com.haas.demo-app") with { AgentSkillFile = "docs/agent.md" });
        using var client = harness.CreateClient();

        using var anonymous = await client.GetAsync("/api/internal/apps/hosty.ai-gateway/agent-skills/com.haas.demo-app");
        Assert.Equal(HttpStatusCode.Unauthorized, anonymous.StatusCode);

        // Someone else's token, presented against the assistant's path: the caller is who the token
        // says, never who the URL says.
        using var foreign = await SendAsync(
            client,
            "/api/internal/apps/hosty.ai-gateway/agent-skills/com.haas.demo-app",
            IssueServiceToken(harness, "com.haas.demo-app"));
        Assert.Equal(HttpStatusCode.Unauthorized, foreign.StatusCode);
    }

    [Fact]
    public async Task ADeclaredButUnpackagedSkillIsAnAbsence_NotAServerError()
    {
        // The path is validated at install; whether the file was actually packaged is the app's
        // business, and an operator should see "no skill" rather than a 500.
        await using var harness = await CoreHttpHarness.StartAsync();
        var apps = harness.Services.GetRequiredService<AppRegistryStore>();
        await apps.UpsertAppAsync(CreateApp("hosty.ai-gateway", system: true) with
        {
            Interfaces = new Dictionary<string, IReadOnlyList<AppInterfaceContract>>
            {
                ["ai-gateway"] = [new AppInterfaceContract("default", null, "/api")],
            },
        });
        await apps.UpsertAppAsync(CreateApp("com.haas.demo-app") with { AgentSkillFile = "docs/missing.md" });
        using var client = harness.CreateClient();

        using var response = await SendAsync(
            client,
            "/api/internal/apps/hosty.ai-gateway/agent-skills/com.haas.demo-app",
            IssueServiceToken(harness, "hosty.ai-gateway"));

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
    }

    private static void WriteSkill(CoreDataPaths paths, string appId, string relative, string markdown)
    {
        var full = Path.Combine(paths.AppsRoot, appId, relative.Replace('/', Path.DirectorySeparatorChar));
        Directory.CreateDirectory(Path.GetDirectoryName(full)!);
        File.WriteAllText(full, markdown);
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
