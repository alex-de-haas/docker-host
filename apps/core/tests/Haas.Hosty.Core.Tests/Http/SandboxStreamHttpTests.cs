using System.Net;
using System.Text.Json;
using Microsoft.Extensions.DependencyInjection;

namespace Haas.Hosty.Core.Tests.Http;

public sealed partial class AppManagementHttpTests
{
    [Fact]
    public async Task SandboxStream_RequiresEnvironmentInventoryPermission()
    {
        await using var host = await CoreHttpHarness.StartAsync();
        var denied = CoreAppPermissions.CoreEnvironmentsInspect;
        using var client = await CreateAppClient(host, "example.console", CoreAppPermissions.Known.Where(p => p != denied).ToArray());
        using var response = await client.GetAsync("/api/events?topics=sandboxes");
        Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
    }

    [Fact]
    public async Task SandboxStream_SendsOwnedSnapshotsForWritesRemovalAndReconnect_ThenStopsOnRevocation()
    {
        await using var host = await CoreHttpHarness.StartAsync();
        using var client = await CreateAppClient(host, "example.console", CoreAppPermissions.Known);
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(15));
        var ct = timeout.Token;
        var environments = host.Services.GetRequiredService<CoreEnvironmentStore>();
        var foreign = new CoreEnvironmentRecord(Guid.NewGuid().ToString("N"), new("other"), new(Guid.NewGuid().ToString(), "Foreign"), "hash", 7071, 1, "stopped", DateTimeOffset.UtcNow);
        await environments.WriteAsync(foreign, ct);
        using var response = await client.GetAsync("/api/events?topics=sandboxes", HttpCompletionOption.ResponseHeadersRead, ct);
        response.EnsureSuccessStatusCode();
        using var reader = new StreamReader(await response.Content.ReadAsStreamAsync(ct));
        var initial = await NextSandboxSnapshot(reader, ct);
        Assert.Empty(initial.GetProperty("environments").EnumerateArray());
        Assert.False(initial.TryGetProperty("instances", out _));
        var own = foreign with { Id = Guid.NewGuid().ToString("N"), Owner = new("actor"), Request = foreign.Request with { Label = "Owned" } };
        await environments.WriteAsync(own, ct);
        var added = await NextSandboxSnapshot(reader, ct);
        Assert.Equal("Owned", Assert.Single(added.GetProperty("environments").EnumerateArray()).GetProperty("label").GetString());
        await environments.WriteAsync(own with { State = "finished", Revision = 2 }, ct);
        Assert.Equal("finished", Assert.Single((await NextSandboxSnapshot(reader, ct)).GetProperty("environments").EnumerateArray()).GetProperty("state").GetString());
        using var reconnect = await client.GetAsync("/api/events?topics=sandboxes", HttpCompletionOption.ResponseHeadersRead, ct);
        using var second = new StreamReader(await reconnect.Content.ReadAsStreamAsync(ct));
        Assert.Single((await NextSandboxSnapshot(second, ct)).GetProperty("environments").EnumerateArray());
        await SetPermissions(host, "example.console", CoreAppPermissions.Known.Where(p => p != CoreAppPermissions.CoreEnvironmentsInspect).ToArray());
        await environments.WriteAsync(own with { Revision = 3 }, ct);
        Assert.Null(await reader.ReadLineAsync(ct));
    }

    private static async Task<JsonElement> NextSandboxSnapshot(StreamReader reader, CancellationToken ct)
    {
        while (await reader.ReadLineAsync(ct) is { } line)
        {
            if (line != "event: sandbox.snapshot") continue;
            var data = await reader.ReadLineAsync(ct);
            Assert.StartsWith("data: ", data);
            Assert.Equal("", await reader.ReadLineAsync(ct));
            return JsonDocument.Parse(data![6..]).RootElement.Clone();
        }
        throw new InvalidOperationException("The sandbox stream ended before its snapshot.");
    }
}
