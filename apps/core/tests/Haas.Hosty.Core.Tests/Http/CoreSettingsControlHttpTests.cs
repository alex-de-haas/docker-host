using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.Extensions.DependencyInjection;

namespace Haas.Hosty.Core.Tests.Http;

// The loopback control-plane settings surface (`hosty core settings`): same rows and the same
// validation as the admin /api/core/settings, gated by the control secret instead of an admin
// session.
public sealed class CoreSettingsControlHttpTests
{
    private const string ControlSecretHeader = "X-Hosty-Control-Secret";

    [Fact]
    public async Task Settings_RequireTheControlSecret()
    {
        await using var harness = await CoreHttpHarness.StartAsync();
        using var client = harness.CreateClient();

        using var anonymousGet = await client.GetAsync("/control/v1/settings");
        Assert.Equal(HttpStatusCode.Unauthorized, anonymousGet.StatusCode);

        using var wrongPut = new HttpRequestMessage(HttpMethod.Put, "/control/v1/settings")
        {
            Content = JsonContent.Create(new { settings = new Dictionary<string, string?> { ["HOSTY_CORE_PORT"] = "7171" } }),
        };
        wrongPut.Headers.Add(ControlSecretHeader, new string('0', 64));
        using var wrongResponse = await client.SendAsync(wrongPut);
        Assert.Equal(HttpStatusCode.Unauthorized, wrongResponse.StatusCode);
    }

    [Fact]
    public async Task Settings_RoundTripOverTheControlPlane()
    {
        await using var harness = await CoreHttpHarness.StartAsync();
        using var client = CreateAuthorizedClient(harness);

        // The listed rows include the persisted port with its default.
        var initial = await GetRowsAsync(client);
        var portRow = FindRow(initial, "HOSTY_CORE_PORT");
        Assert.Equal("7070", portRow.GetProperty("value").GetString());
        Assert.False(portRow.GetProperty("overridden").GetBoolean());

        // Set through the control plane; the response reflects the stored override…
        using var put = await client.PutAsJsonAsync(
            "/control/v1/settings",
            new { settings = new Dictionary<string, string?> { ["HOSTY_CORE_PORT"] = "7171" } });
        Assert.Equal(HttpStatusCode.OK, put.StatusCode);

        var updated = FindRow(await GetRowsAsync(client), "HOSTY_CORE_PORT");
        Assert.Equal("7171", updated.GetProperty("value").GetString());
        Assert.True(updated.GetProperty("overridden").GetBoolean());

        // …and the persisted store is what the NEXT start reads its port from.
        var coreRoot = Path.Combine(
            harness.Services.GetRequiredService<HostyCoreRuntimeConfig>().DataRoot, "core");
        Assert.Equal(7171, CoreSettingsStore.TryReadStoredPort(coreRoot));

        // Clearing (null) falls back to the default.
        using var reset = await client.PutAsJsonAsync(
            "/control/v1/settings",
            new { settings = new Dictionary<string, string?> { ["HOSTY_CORE_PORT"] = null } });
        Assert.Equal(HttpStatusCode.OK, reset.StatusCode);
        var cleared = FindRow(await GetRowsAsync(client), "HOSTY_CORE_PORT");
        Assert.Equal("7070", cleared.GetProperty("value").GetString());
        Assert.False(cleared.GetProperty("overridden").GetBoolean());
        Assert.Null(CoreSettingsStore.TryReadStoredPort(coreRoot));
    }

    [Fact]
    public async Task Settings_ApplyTheAdminSurfacesValidation()
    {
        await using var harness = await CoreHttpHarness.StartAsync();
        using var client = CreateAuthorizedClient(harness);

        using var invalid = await client.PutAsJsonAsync(
            "/control/v1/settings",
            new { settings = new Dictionary<string, string?> { ["HOSTY_CORE_PORT"] = "70000" } });
        Assert.Equal(HttpStatusCode.BadRequest, invalid.StatusCode);

        using var unknown = await client.PutAsJsonAsync(
            "/control/v1/settings",
            new { settings = new Dictionary<string, string?> { ["HOSTY_NOT_A_SETTING"] = "1" } });
        Assert.Equal(HttpStatusCode.BadRequest, unknown.StatusCode);
    }

    private static HttpClient CreateAuthorizedClient(CoreHttpHarness harness)
    {
        var client = harness.CreateClient();
        client.DefaultRequestHeaders.Add(
            ControlSecretHeader,
            harness.Services.GetRequiredService<ControlSecret>().Value);
        return client;
    }

    private static async Task<JsonElement> GetRowsAsync(HttpClient client)
    {
        using var response = await client.GetAsync("/control/v1/settings");
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        using var document = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
        return document.RootElement.GetProperty("settings").Clone();
    }

    private static JsonElement FindRow(JsonElement rows, string key)
    {
        foreach (var row in rows.EnumerateArray())
        {
            if (string.Equals(row.GetProperty("key").GetString(), key, StringComparison.Ordinal))
            {
                return row;
            }
        }

        throw new Xunit.Sdk.XunitException($"Row '{key}' not found in the settings response.");
    }
}
