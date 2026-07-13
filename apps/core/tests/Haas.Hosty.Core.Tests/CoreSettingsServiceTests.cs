using System.Text.Json;
using Haas.Hosty.Core;
using Microsoft.Extensions.Logging.Abstractions;

namespace Haas.Hosty.Core.Tests;

public sealed class CoreSettingsServiceTests : IDisposable
{
    private readonly string root = Path.Combine(Path.GetTempPath(), $"hosty-core-settings-tests-{Guid.NewGuid():N}");

    private CoreDataPaths Paths => new(
        DataRoot: root,
        CoreRoot: Path.Combine(root, "core"),
        AppsRoot: Path.Combine(root, "apps"),
        BackupsRoot: Path.Combine(root, "backups"),
        SourcesRoot: Path.Combine(root, "sources"),
        AuthRoot: Path.Combine(root, "core", "auth"),
        AuditLogPath: Path.Combine(root, "core", "audit", "audit.ndjson"));

    private CoreSettingsService CreateService()
        => new(new CoreSettingsStore(Paths, NullLogger<CoreSettingsStore>.Instance));

    [Fact]
    public void AuthLifetimes_NoOverrides_MatchesEnvironmentBaseline()
    {
        var service = CreateService();

        // With no persisted file the effective lifetimes are exactly the env-or-default baseline.
        Assert.Equal(AuthLifetimes.FromEnvironment(), service.AuthLifetimes);

        var rows = service.GetAuthRows();
        Assert.Equal(CoreAuthSettings.All.Count, rows.Count);
        Assert.All(rows, row => Assert.False(row.Overridden));
        var idle = rows.Single(r => r.Definition.Key == "HOSTY_AUTH_CORE_SESSION_IDLE_HOURS");
        Assert.Equal(AuthLifetimes.Defaults.CoreSessionIdle.TotalHours, idle.Definition.DefaultHours);
    }

    [Fact]
    public async Task UpdateAsync_AppliesLiveAndPersists()
    {
        var service = CreateService();

        await service.UpdateAsync(new Dictionary<string, double?>
        {
            ["HOSTY_AUTH_CORE_SESSION_IDLE_HOURS"] = 1,
            ["HOSTY_AUTH_APP_GRANT_ABSOLUTE_HOURS"] = 240,
        });

        // Live: the in-memory record reflects the change immediately, and the row is marked overridden.
        Assert.Equal(TimeSpan.FromHours(1), service.AuthLifetimes.CoreSessionIdle);
        Assert.Equal(TimeSpan.FromHours(240), service.AuthLifetimes.AppGrantAbsolute);
        Assert.True(service.GetAuthRows().Single(r => r.Definition.Key == "HOSTY_AUTH_CORE_SESSION_IDLE_HOURS").Overridden);

        // Persisted: a fresh service over the same data root reads the override back.
        var reloaded = CreateService();
        Assert.Equal(TimeSpan.FromHours(1), reloaded.AuthLifetimes.CoreSessionIdle);
        Assert.Equal(TimeSpan.FromHours(240), reloaded.AuthLifetimes.AppGrantAbsolute);
        // An untouched setting still follows the default.
        Assert.Equal(AuthLifetimes.Defaults.SystemGrantIdle, reloaded.AuthLifetimes.SystemGrantIdle);
        Assert.False(reloaded.GetAuthRows().Single(r => r.Definition.Key == "HOSTY_AUTH_SYSTEM_GRANT_IDLE_HOURS").Overridden);
    }

    [Fact]
    public async Task UpdateAsync_NullValueClearsOverride()
    {
        var service = CreateService();
        await service.UpdateAsync(new Dictionary<string, double?> { ["HOSTY_AUTH_CLI_GRANT_HOURS"] = 1 });
        Assert.Equal(TimeSpan.FromHours(1), service.AuthLifetimes.CliGrantLifetime);
        Assert.True(service.GetAuthRows().Single(r => r.Definition.Key == "HOSTY_AUTH_CLI_GRANT_HOURS").Overridden);

        // Null clears the override -> the key falls back to env/default, persisted so a fresh service agrees.
        await service.UpdateAsync(new Dictionary<string, double?> { ["HOSTY_AUTH_CLI_GRANT_HOURS"] = null });
        Assert.Equal(AuthLifetimes.FromEnvironment().CliGrantLifetime, service.AuthLifetimes.CliGrantLifetime);
        Assert.False(service.GetAuthRows().Single(r => r.Definition.Key == "HOSTY_AUTH_CLI_GRANT_HOURS").Overridden);
        Assert.False(CreateService().GetAuthRows().Single(r => r.Definition.Key == "HOSTY_AUTH_CLI_GRANT_HOURS").Overridden);
    }

    [Fact]
    public async Task UpdateAsync_RejectsUnknownKey()
    {
        var service = CreateService();

        var exception = await Assert.ThrowsAsync<AppLifecycleException>(
            () => service.UpdateAsync(new Dictionary<string, double?> { ["HOSTY_AUTH_MADE_UP"] = 5 }));

        Assert.Equal("core_setting_unknown", exception.Code);
    }

    [Theory]
    [InlineData(0)]
    [InlineData(-5)]
    [InlineData(double.NaN)]
    [InlineData(double.PositiveInfinity)]
    [InlineData(double.MaxValue)] // finite but overflows TimeSpan — must be rejected, not persisted
    public async Task UpdateAsync_RejectsNonPositiveOrNonFinite(double hours)
    {
        var service = CreateService();

        var exception = await Assert.ThrowsAsync<AppLifecycleException>(
            () => service.UpdateAsync(new Dictionary<string, double?> { ["HOSTY_AUTH_CLI_GRANT_HOURS"] = hours }));

        Assert.Equal("core_setting_invalid", exception.Code);
    }

    [Fact]
    public void Load_CorruptFile_FallsBackToBaseline()
    {
        Directory.CreateDirectory(Path.Combine(root, "core"));
        File.WriteAllText(Path.Combine(root, "core", CoreSettingsSchema.FileName), "{ not valid json");

        var service = CreateService();

        Assert.Equal(AuthLifetimes.FromEnvironment(), service.AuthLifetimes);
    }

    [Fact]
    public void Load_OutOfRangeHandEditedValue_IsSkippedNotCrash()
    {
        // A hand-edited settings.json with a finite but TimeSpan-overflowing magnitude must not crash
        // startup: the bad entry is ignored and that key follows the baseline.
        Directory.CreateDirectory(Path.Combine(root, "core"));
        File.WriteAllText(
            Path.Combine(root, "core", CoreSettingsSchema.FileName),
            "{\"schemaVersion\":\"" + CoreSettingsSchema.Version + "\",\"auth\":{\"HOSTY_AUTH_CLI_GRANT_HOURS\":1e18}}");

        var service = CreateService();

        Assert.Equal(AuthLifetimes.FromEnvironment().CliGrantLifetime, service.AuthLifetimes.CliGrantLifetime);
    }

    [Fact]
    public void EndpointDtos_AreRegisteredInAotContext()
    {
        // The endpoint serializes these through the source-gen context; a missing registration would be
        // a runtime 500, not a compile error, so assert the round-trip here.
        var response = new CoreSettingsResponse(
        [
            new CoreSettingSummary("HOSTY_AUTH_CLI_GRANT_HOURS", "number", "12", "12", "CLI diagnostic grants", "Lifetime", "desc", Overridden: false),
        ]);

        var json = JsonSerializer.Serialize(response, CoreJsonSerializerContext.Default.CoreSettingsResponse);
        Assert.Contains("HOSTY_AUTH_CLI_GRANT_HOURS", json);

        var request = JsonSerializer.Deserialize(
            """{"settings":{"HOSTY_AUTH_CLI_GRANT_HOURS":"6"}}""",
            CoreJsonSerializerContext.Default.CoreSettingsUpdateRequest);
        Assert.Equal("6", request!.Settings!["HOSTY_AUTH_CLI_GRANT_HOURS"]);
    }

    public void Dispose()
    {
        if (Directory.Exists(root))
        {
            Directory.Delete(root, recursive: true);
        }
    }
}
