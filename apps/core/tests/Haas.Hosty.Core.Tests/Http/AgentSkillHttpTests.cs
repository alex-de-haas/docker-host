using System.Net;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.DependencyInjection;

namespace Haas.Hosty.Core.Tests.Http;

public sealed class AgentSkillHttpTests
{
    private const string Reader = "example.reader";
    private const string Root = "/api/internal/apps/example.reader/skills";

    private static async Task Seed(CoreHttpHarness host, string permission = CoreAppPermissions.ReadSkills)
    {
        var now = host.Services.GetRequiredService<IClock>().UtcNow;
        await host.Services.GetRequiredService<AppRegistryStore>().UpsertAppAsync(
            AssistantMcpAccessHttpTests.Record(Reader, now) with { GrantedCorePermissions = [permission] });
        var package = AgentSkillPackages.Validate([
            new("SKILL.md", Encoding.UTF8.GetBytes("---\nname: test-guide\ndescription: Test guide.\n---\nRead references/details.md.")),
            new("references/details.md", Encoding.UTF8.GetBytes("Complete reference content."))
        ]);
        await host.Services.GetRequiredService<AgentSkillLibrary>().ReplaceAppAsync("example.producer", "1", new Dictionary<string, AgentSkillPackage>
            { ["default"] = package }, default);
    }

    private static HttpClient AppClient(CoreHttpHarness host)
    {
        var client = host.CreateClient();
        client.DefaultRequestHeaders.Authorization = new("Bearer", host.Services.GetRequiredService<AppServiceTokenService>().CreateToken(Reader));
        return client;
    }

    [Fact]
    public async Task ReadsRequireCurrentAppPermissionAndMatchingServiceToken()
    {
        await using var host = await CoreHttpHarness.StartAsync();
        await Seed(host);
        using var anonymous = host.CreateClient();
        Assert.Equal(HttpStatusCode.Unauthorized, (await anonymous.GetAsync(Root + "/")).StatusCode);
        using var client = AppClient(host);
        var catalog = await client.GetFromJsonAsync<JsonElement>(Root + "/");
        var id = catalog.GetProperty("skills")[0].GetProperty("id").GetString();
        var file = await client.GetFromJsonAsync<JsonElement>($"{Root}/{id}/content?path=references%2Fdetails.md");
        Assert.Equal("Complete reference content.", Encoding.UTF8.GetString(file.GetProperty("content").GetBytesFromBase64()));
        Assert.False(catalog.GetProperty("skills")[0].TryGetProperty("sourceGrant", out _));
        Assert.Equal(HttpStatusCode.Unauthorized, (await client.GetAsync("/api/internal/apps/other.app/skills/")).StatusCode);
        var apps = host.Services.GetRequiredService<AppRegistryStore>();
        await apps.UpsertAppAsync((await apps.GetAppAsync(Reader))! with { GrantedCorePermissions = [] });
        Assert.Equal(HttpStatusCode.Forbidden, (await client.GetAsync(Root + "/")).StatusCode);
    }

    [Fact]
    public async Task AppCanPrepareOwnExportsButCannotManageLibraryWithItsServiceToken()
    {
        await using var host = await CoreHttpHarness.StartAsync();
        await Seed(host);
        using var client = AppClient(host);
        var id = AgentSkillLibrary.Id("app", "example.producer", "default");
        using var response = await client.PostAsJsonAsync(Root + "/exports", new { contextId = "session-one", skillIds = new[] { id, "removed" } });
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var export = await response.Content.ReadFromJsonAsync<JsonElement>();
        var directory = export.GetProperty("path").GetString()!;
        Assert.True(File.Exists(Path.Combine(directory, "test-guide/references/details.md")));
        Assert.Contains(AgentSkillLibrary.Id("app:" + Reader), directory);
        Assert.Equal(HttpStatusCode.Unauthorized, (await client.PostAsJsonAsync("/api/skills/update", new { skillIds = new[] { id } })).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await client.PostAsJsonAsync(Root + "/install", new { })).StatusCode);
        await host.Services.GetRequiredService<AgentSkillLibrary>().ReplaceAppAsync("example.producer", "2", new Dictionary<string, AgentSkillPackage>(), default);
        Assert.Empty(Directory.GetDirectories(directory));
    }

    [Fact]
    public async Task CoreControlSupportsExternalNativeConsumersWithoutHarness()
    {
        await using var host = await CoreHttpHarness.StartAsync();
        await Seed(host);
        using var client = host.CreateClient();
        Assert.Equal(HttpStatusCode.Unauthorized, (await client.GetAsync("/control/v1/skills/")).StatusCode);
        client.DefaultRequestHeaders.Add("X-Hosty-Control-Secret", host.Services.GetRequiredService<ControlSecret>().Value);
        var catalog = await client.GetFromJsonAsync<JsonElement>("/control/v1/skills/");
        var id = catalog.GetProperty("skills")[0].GetProperty("id").GetString();
        var export = await client.PostAsJsonAsync("/control/v1/skills/exports", new { contextId = "external-codex", skillIds = new[] { id } });
        Assert.Equal(HttpStatusCode.OK, export.StatusCode);
        var value = await export.Content.ReadFromJsonAsync<JsonElement>();
        Assert.True(File.Exists(Path.Combine(value.GetProperty("path").GetString()!, "test-guide/SKILL.md")));
        Assert.Equal(HttpStatusCode.OK, (await client.DeleteAsync("/control/v1/skills/exports/" + value.GetProperty("id").GetString())).StatusCode);
        Assert.False(Directory.Exists(value.GetProperty("path").GetString()));
    }

    [Theory]
    [InlineData("host.admin", true, HttpStatusCode.OK)]
    [InlineData("host.admin", false, HttpStatusCode.Forbidden)]
    [InlineData("host.user", true, HttpStatusCode.Forbidden)]
    public async Task ManagementRequiresBothAdministratorAndAppGrant(string role, bool permission, HttpStatusCode expected)
    {
        await using var host = await CoreHttpHarness.StartAsync();
        await Seed(host, permission ? CoreAppPermissions.ManageSkills : CoreAppPermissions.ReadSkills);
        var now = host.Services.GetRequiredService<IClock>().UtcNow;
        await host.Services.GetRequiredService<UserDirectoryStore>().WriteAsync(new(1,
            [new("operator", "operator@example.test", "Operator", "host.admin", false, now, now)], [], [], []));
        var grant = await BrowserAuthorityFixture.Grant(host, Reader, "operator");
        if (role != "host.admin") await host.Services.GetRequiredService<UserDirectoryStore>().UpdateAsync(state => state with { Users = state.Users.Select(u => u with { Role = role }).ToArray() });
        using var client = AppClient(host);
        client.DefaultRequestHeaders.Add(AppManagementAuthorization.IdentityHeader, grant.AccessToken);
        using var response = await client.PostAsJsonAsync("/api/skills/check-updates", new { skillIds = Array.Empty<string>() });
        Assert.Equal(expected, response.StatusCode);
    }

    [Fact]
    public async Task LegacySingleFileEndpointIsRetiredAndTraversalIsRefused()
    {
        await using var host = await CoreHttpHarness.StartAsync();
        await Seed(host);
        using var client = AppClient(host);
        Assert.Equal(HttpStatusCode.NotFound, (await client.GetAsync("/api/internal/apps/example.reader/agent-skills/example.producer")).StatusCode);
        var id = AgentSkillLibrary.Id("app", "example.producer", "default");
        Assert.Equal(HttpStatusCode.BadRequest, (await client.GetAsync($"{Root}/{id}/content?path=..%2Fsecret")).StatusCode);
    }
}
