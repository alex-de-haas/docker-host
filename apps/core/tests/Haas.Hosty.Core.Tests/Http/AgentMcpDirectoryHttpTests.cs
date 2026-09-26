using System.Net;
using System.Net.Http.Json;
using System.Net.Http.Headers;
using System.Text.Json;
using Microsoft.Extensions.DependencyInjection;

namespace Haas.Hosty.Core.Tests.Http;

public sealed class AgentMcpDirectoryHttpTests
{
    [Fact]
    public async Task ApprovalNamesReviewedBytes_DefaultsRevisionAndReinstallAreSafe()
    {
        await using var host = await CoreHttpHarness.StartAsync();
        var apps = host.Services.GetRequiredService<AppRegistryStore>();
        var paths = host.Services.GetRequiredService<CoreDataPaths>();
        var directory = host.Services.GetRequiredService<AgentMcpDirectory>();
        var app = CreateApp("example.notes") with {
            AgentSkillFile = "agent.md",
            Interfaces = new Dictionary<string, IReadOnlyList<AppInterfaceContract>> { ["mcp"] = [new("default", null, "/api/mcp")] }
        };
        await apps.UpsertAppAsync(app);
        var skillPath = Path.Combine(paths.AppsRoot, app.Id, "agent.md");
        await File.WriteAllTextAsync(skillPath, "Reviewed instructions");
        await SignInAsync(host, "host.admin");
        using var client = host.CreateClient();
        client.DefaultRequestHeaders.Add("Cookie", "hosty_session=agent-session; hosty_csrf=csrf");
        client.DefaultRequestHeaders.Add("X-Hosty-CSRF", "csrf");
        var first = await directory.ReadAsync(true);
        Assert.True(first.Targets.Single(t => t.Id == "hosty:core").Offered);
        var target = first.Targets.Single(t => t.Id == app.Id);
        Assert.False(target.Offered);
        Assert.Equal("Reviewed instructions", Assert.Single(target.Skills).Markdown);
        var digest = target.Skills[0].Digest!;
        using var enable = await client.PutAsJsonAsync("/api/core/agents/" + app.Id, new { revision = first.Revision, offered = true });
        Assert.Equal(HttpStatusCode.OK, enable.StatusCode);
        var enabled = await directory.ReadAsync();
        Assert.True(enabled.Targets.Single(t => t.Id == app.Id).Offered);
        Assert.Null(enabled.Targets.Single(t => t.Id == app.Id).Skills[0].ApprovedDigest);
        using var approve = await client.PutAsJsonAsync("/api/core/agents/" + app.Id,
            new { revision = enabled.Revision, offered = true, approveSkills = new Dictionary<string, string> { ["agent"] = digest } });
        Assert.Equal(HttpStatusCode.OK, approve.StatusCode);
        var approved = await directory.ReadAsync();
        Assert.Equal(digest, approved.Targets.Single(t => t.Id == app.Id).Skills[0].ApprovedDigest);
        Assert.Null(approved.Targets.Single(t => t.Id == app.Id).Skills[0].Markdown);
        await File.WriteAllTextAsync(skillPath, "Changed instructions");
        using var stale = await client.PutAsJsonAsync("/api/core/agents/" + app.Id,
            new { revision = approved.Revision, offered = true, approveSkills = new Dictionary<string, string> { ["agent"] = digest } });
        Assert.Equal(HttpStatusCode.Conflict, stale.StatusCode);
        var changed = await directory.ReadAsync();
        Assert.NotEqual(approved.Revision, changed.Revision);
        Assert.True(changed.Targets.Single(t => t.Id == app.Id).Offered);
        Assert.NotEqual(digest, changed.Targets.Single(t => t.Id == app.Id).Skills[0].Digest);
        Assert.Contains("agent.policy.updated", await File.ReadAllTextAsync(paths.AuditLogPath));
        await host.Services.GetRequiredService<CoreLifecycleService>().RemoveAsync(app.Id, new AppRemoveRequest(DeleteData: false, IgnoreRuntimeErrors: true));
        Assert.DoesNotContain(app.Id, (await host.Services.GetRequiredService<AgentPolicyStore>().ReadAsync()).Targets.Keys);
        await apps.UpsertAppAsync(app with { InstalledAt = app.InstalledAt.AddMinutes(1) });
        var reinstalled = (await directory.ReadAsync()).Targets.Single(t => t.Id == app.Id);
        Assert.False(reinstalled.Offered);
        Assert.Null(reinstalled.Skills[0].ApprovedDigest);
    }

    [Theory]
    [InlineData("host.admin", false, 403)]
    [InlineData("host.user", true, 403)]
    [InlineData(null, true, 401)]
    public async Task MutationsRequireAdministratorAndCsrf(string? role, bool csrf, int expected)
    {
        await using var host = await CoreHttpHarness.StartAsync();
        if (role is not null) await SignInAsync(host, role);
        using var client = host.CreateClient();
        client.DefaultRequestHeaders.Add("Cookie", "hosty_session=agent-session; hosty_csrf=csrf");
        if (csrf) client.DefaultRequestHeaders.Add("X-Hosty-CSRF", "csrf");
        using var response = await client.PutAsJsonAsync("/api/core/agents/hosty:core", new { revision = "stale", offered = false });
        Assert.Equal(expected, (int)response.StatusCode);
        if (role != "host.admin") Assert.False((await client.GetAsync("/api/core/agents")).IsSuccessStatusCode);
    }

    [Fact]
    public async Task ServiceDirectoryHasNoCredentialsOrTextAndUnchangedRevisionReturnsNoPayload()
    {
        await using var host = await CoreHttpHarness.StartAsync();
        await host.Services.GetRequiredService<AppRegistryStore>().UpsertAppAsync(CreateApp("example.reader"));
        using var client = host.CreateClient();
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer",
            host.Services.GetRequiredService<AppServiceTokenService>().CreateToken("example.reader"));
        const string route = "/api/internal/apps/example.reader/app-directory";
        var body = await client.GetStringAsync(route);
        var json = JsonDocument.Parse(body).RootElement;
        var revision = json.GetProperty("agents").GetProperty("revision").GetString();
        Assert.DoesNotContain("token", body, StringComparison.OrdinalIgnoreCase);
        using var unchanged = await client.GetAsync(route + "?revision=" + revision);
        Assert.Equal(HttpStatusCode.NotModified, unchanged.StatusCode);
        Assert.Empty(await unchanged.Content.ReadAsStringAsync());
    }

    private static async Task SignInAsync(CoreHttpHarness host, string role)
    {
        var now = host.Services.GetRequiredService<IClock>().UtcNow;
        var user = new HostUserRecord("agent-user", "agent@example.test", "Agent User", role, false, now, now);
        var session = new AuthSessionRecord("agent-session", user.Id, now, now.AddHours(1), null, now);
        await host.Services.GetRequiredService<UserDirectoryStore>().WriteAsync(new UserDirectoryState(1, [user], [], [], [session]));
    }
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
