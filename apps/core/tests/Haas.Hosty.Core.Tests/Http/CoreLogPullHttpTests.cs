using System.Net;
using System.Net.Http.Headers;
using System.Text.Json;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;

namespace Haas.Hosty.Core.Tests.Http;

// The telemetry backend's pull of Core's own records. Same credential as the docker-stats exposition
// beside it — an installed app's service token — because the two are the same kind of thing: Core
// producing host-side telemetry that the backend cannot gather for itself.
public sealed class CoreLogPullHttpTests
{
    private const string PullPath = "/api/internal/telemetry/logs";
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    [Fact]
    public async Task Pull_RejectsAnAnonymousCaller()
    {
        await using var harness = await CoreHttpHarness.StartAsync();
        using var client = harness.CreateClient();

        Assert.Equal(HttpStatusCode.Unauthorized, (await client.GetAsync(PullPath)).StatusCode);
    }

    [Fact]
    public async Task Pull_RejectsAForgedBearer()
    {
        await using var harness = await CoreHttpHarness.StartAsync();
        using var client = harness.CreateClient();
        using var request = new HttpRequestMessage(HttpMethod.Get, PullPath);
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", "hosty_app_service.1.forged.forged");

        Assert.Equal(HttpStatusCode.Unauthorized, (await client.SendAsync(request)).StatusCode);
    }

    // A service token is HMAC over the app id with a durable key, so one copied before the app was
    // removed keeps verifying. Installation is what bounds it.
    [Fact]
    public async Task Pull_RejectsATokenWhoseAppIsNoLongerInstalled()
    {
        await using var harness = await CoreHttpHarness.StartAsync();
        var token = harness.Services.GetRequiredService<AppServiceTokenService>().CreateToken("hosty.telemetry");
        using var client = harness.CreateClient();
        using var request = new HttpRequestMessage(HttpMethod.Get, PullPath);
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);

        Assert.Equal(HttpStatusCode.Unauthorized, (await client.SendAsync(request)).StatusCode);
    }

    [Fact]
    public async Task Pull_ReturnsCoresOwnRecordsAndACursorThatAdvances()
    {
        await using var harness = await CoreHttpHarness.StartAsync();
        var token = await InstallTelemetryAsync(harness);
        Log(harness, "Haas.Hosty.Core.Test", LogLevel.Information, "first");

        var first = await PullAsync(harness, token, PullPath);
        Assert.Contains(first.Records, record => record.Message == "first");
        Assert.True(first.NextCursor > 0);
        Assert.NotEmpty(first.RunId);

        Log(harness, "Haas.Hosty.Core.Test", LogLevel.Information, "second");
        var second = await PullAsync(harness, token, $"{PullPath}?after={first.NextCursor}");

        Assert.Equal(["second"], second.Records.Select(record => record.Message));
        Assert.True(second.NextCursor > first.NextCursor);
    }

    // A quiet host must be idempotent: no records, and the cursor the caller already holds comes back
    // unchanged rather than resetting to zero.
    [Fact]
    public async Task Pull_HoldsTheCursorWhenNothingIsNew()
    {
        await using var harness = await CoreHttpHarness.StartAsync();
        var token = await InstallTelemetryAsync(harness);
        Log(harness, "Haas.Hosty.Core.Test", LogLevel.Information, "only");
        var first = await PullAsync(harness, token, PullPath);

        var repeat = await PullAsync(harness, token, $"{PullPath}?after={first.NextCursor}");

        Assert.Empty(repeat.Records);
        Assert.Equal(first.NextCursor, repeat.NextCursor);
        Assert.Equal(first.RunId, repeat.RunId);
    }

    // The whole point of exporting one ring: at ~96 % of all records, the request trail would drown the
    // fleet's logs in a 3-day store with a ~1 GiB ceiling.
    [Fact]
    public async Task Pull_NeverExportsTheRequestTrail()
    {
        await using var harness = await CoreHttpHarness.StartAsync();
        var token = await InstallTelemetryAsync(harness);
        Log(harness, "Microsoft.AspNetCore.Hosting.Diagnostics", LogLevel.Information, "Request finished");
        Log(harness, "Haas.Hosty.Core.Test", LogLevel.Information, "kept");

        var payload = await PullAsync(harness, token, PullPath);

        Assert.Contains(payload.Records, record => record.Message == "kept");
        Assert.DoesNotContain(payload.Records, record => record.Message == "Request finished");
    }

    [Fact]
    public async Task Pull_CapsHowMuchOneCallCanTake()
    {
        await using var harness = await CoreHttpHarness.StartAsync();
        var token = await InstallTelemetryAsync(harness);
        for (var index = 0; index < 10; index++)
        {
            Log(harness, "Haas.Hosty.Core.Test", LogLevel.Information, $"record {index}");
        }

        var payload = await PullAsync(harness, token, $"{PullPath}?limit=3");

        Assert.Equal(3, payload.Records.Count);
        Assert.Equal(payload.Records[^1].Sequence, payload.NextCursor);
    }

    private static void Log(CoreHttpHarness harness, string category, LogLevel level, string message)
        => harness.Services.GetRequiredService<ILoggerFactory>().CreateLogger(category).Log(level, "{Message}", message);

    private static async Task<string> InstallTelemetryAsync(CoreHttpHarness harness)
    {
        const string appId = "hosty.telemetry";
        await harness.Services.GetRequiredService<AppRegistryStore>().UpsertAppAsync(new AppRecord(
            Id: appId,
            DisplayName: "Telemetry",
            Description: null,
            Version: "1.0.0",
            Kind: "runtime",
            System: true,
            Source: "installed",
            ManifestPath: $"apps/{appId}/manifest.json",
            ManifestUrl: null,
            SelectedRuntime: "docker",
            OperationStatus: "installed",
            RuntimeState: "running",
            LastOperation: null,
            LastError: null,
            Capabilities: [],
            Settings: new Dictionary<string, AppSettingValue>(),
            StorageMappings: [],
            Dependencies: [],
            Endpoints: [],
            InstalledAt: DateTimeOffset.UtcNow,
            UpdatedAt: DateTimeOffset.UtcNow));
        return harness.Services.GetRequiredService<AppServiceTokenService>().CreateToken(appId);
    }

    private static async Task<PullPayload> PullAsync(CoreHttpHarness harness, string token, string path)
    {
        using var client = harness.CreateClient();
        using var request = new HttpRequestMessage(HttpMethod.Get, path);
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        using var response = await client.SendAsync(request);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        return JsonSerializer.Deserialize<PullPayload>(await response.Content.ReadAsStringAsync(), Json)
            ?? throw new InvalidOperationException("Core returned no pull payload.");
    }

    private sealed record PullPayload(string RunId, long NextCursor, IReadOnlyList<PullRecord> Records);

    private sealed record PullRecord(long Sequence, string Level, string Category, string Message, int Count);
}
