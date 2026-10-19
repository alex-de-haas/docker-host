using System.Net;
using System.Net.Http.Json;
using Haas.Hosty.Launch;
using Microsoft.Extensions.DependencyInjection;

namespace Haas.Hosty.Core.Tests.Http;

public sealed class WorkspaceActivationControlHttpTests
{
    [Theory]
    [InlineData("")]
    [InlineData("/start")]
    [InlineData("/cancel")]
    [InlineData("/verify-apps")]
    public async Task ActivationControl_RequiresLocalControlAuthority(string suffix)
    {
        await using var host = await CoreHttpHarness.StartAsync();
        using var client = host.CreateClient();
        var route = "/control/v1/workspace-activations/" + Guid.NewGuid() + suffix;
        var response = suffix == "" ? await client.GetAsync(route) : await client.PostAsJsonAsync(route, new { });
        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
    }

    [Fact]
    public async Task StatusAndCancellation_ReadDurableSelectionWithoutStartingHelper()
    {
        await using var host = await CoreHttpHarness.StartAsync();
        var paths = host.Services.GetRequiredService<CoreDataPaths>();
        var id = Guid.NewGuid().ToString();
        var record = new WorkspaceRuntimeActivation(id, "workspace", "owner", "fingerprint", "instance", "revision",
            null, null, new("release", null, null, 123, DateTimeOffset.UtcNow), [], "prepared");
        WorkspaceRuntimeFiles.Save(paths.DataRoot, record);
        var retained = await File.ReadAllTextAsync(WorkspaceRuntimeFiles.PathFor(paths.DataRoot, id));
        using var client = host.CreateClient();
        client.DefaultRequestHeaders.Add("X-Hosty-Control-Secret", host.Services.GetRequiredService<ControlSecret>().Value);
        var route = "/control/v1/workspace-activations/" + id;
        var status = (await client.GetFromJsonAsync<WorkspaceActivationDetail>(route))!;
        Assert.Equal(id, status.Status.Activation.Id);
        Assert.Empty(status.Children);
        using var cancelled = await client.PostAsJsonAsync(route + "/cancel", new { });
        Assert.True(cancelled.IsSuccessStatusCode, await cancelled.Content.ReadAsStringAsync());
        Assert.True((await cancelled.Content.ReadFromJsonAsync<WorkspaceActivationStatus>())!.CancellationRequested);
        Assert.Equal(retained, await File.ReadAllTextAsync(WorkspaceRuntimeFiles.PathFor(paths.DataRoot, id)));
        Assert.Null(WorkspaceActivationSupervisor.Read(paths.DataRoot, id));
    }
}
