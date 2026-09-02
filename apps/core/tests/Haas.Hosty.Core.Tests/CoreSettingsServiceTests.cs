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

        await service.UpdateAsync(new Dictionary<string, string?>
        {
            ["HOSTY_AUTH_CORE_SESSION_IDLE_HOURS"] = "1",
            ["HOSTY_AUTH_APP_GRANT_ABSOLUTE_HOURS"] = "240",
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
        await service.UpdateAsync(new Dictionary<string, string?> { ["HOSTY_AUTH_CLI_GRANT_HOURS"] = "1" });
        Assert.Equal(TimeSpan.FromHours(1), service.AuthLifetimes.CliGrantLifetime);
        Assert.True(service.GetAuthRows().Single(r => r.Definition.Key == "HOSTY_AUTH_CLI_GRANT_HOURS").Overridden);

        // Null clears the override -> the key falls back to env/default, persisted so a fresh service agrees.
        await service.UpdateAsync(new Dictionary<string, string?> { ["HOSTY_AUTH_CLI_GRANT_HOURS"] = null });
        Assert.Equal(AuthLifetimes.FromEnvironment().CliGrantLifetime, service.AuthLifetimes.CliGrantLifetime);
        Assert.False(service.GetAuthRows().Single(r => r.Definition.Key == "HOSTY_AUTH_CLI_GRANT_HOURS").Overridden);
        Assert.False(CreateService().GetAuthRows().Single(r => r.Definition.Key == "HOSTY_AUTH_CLI_GRANT_HOURS").Overridden);
    }

    [Fact]
    public async Task UpdateAsync_RejectsUnknownKey()
    {
        var service = CreateService();

        var exception = await Assert.ThrowsAsync<AppLifecycleException>(
            () => service.UpdateAsync(new Dictionary<string, string?> { ["HOSTY_MADE_UP"] = "5" }));

        Assert.Equal("core_setting_unknown", exception.Code);
    }

    [Theory]
    [InlineData("0")]
    [InlineData("-5")]
    [InlineData("NaN")]
    [InlineData("Infinity")]
    [InlineData("1.7976931348623157E+308")] // finite but overflows TimeSpan — must be rejected, not persisted
    [InlineData("abc")] // non-numeric — must be rejected
    public async Task UpdateAsync_RejectsNonPositiveOrNonFiniteHours(string hours)
    {
        var service = CreateService();

        var exception = await Assert.ThrowsAsync<AppLifecycleException>(
            () => service.UpdateAsync(new Dictionary<string, string?> { ["HOSTY_AUTH_CLI_GRANT_HOURS"] = hours }));

        Assert.Equal("core_setting_invalid", exception.Code);
    }

    [Fact]
    public void Ingress_NoOverrides_MatchesEnvironmentBaseline()
    {
        var service = CreateService();

        Assert.Equal(IngressSettings.FromEnvironment(), service.Ingress);

        var rows = service.GetIngressRows();
        Assert.Equal(CoreIngressSettings.All.Count, rows.Count);
        Assert.All(rows, row => Assert.False(row.Overridden));
        var provider = rows.Single(r => r.Definition.Key == "HOSTY_INGRESS_PROVIDER");
        Assert.Equal(IngressSettings.ProviderNone, provider.EffectiveValue);
        Assert.Equal("select", provider.Definition.Type);
        Assert.Equal(IngressSettings.ProviderNone, provider.Definition.DefaultValue);
    }

    [Fact]
    public async Task UpdateAsync_Ingress_AppliesLiveAndPersists()
    {
        var service = CreateService();

        await service.UpdateAsync(new Dictionary<string, string?>
        {
            ["HOSTY_INGRESS_PROVIDER"] = "cloudflared",
            ["HOSTY_INGRESS_BASE_DOMAIN"] = "apps.example.test",
            ["HOSTY_INGRESS_TUNNEL_ID"] = "tunnel-123",
        });

        Assert.True(service.Ingress.DerivesPublicOrigins);
        Assert.Equal("apps.example.test", service.Ingress.BaseDomain);
        Assert.Equal("tunnel-123", service.Ingress.TunnelId);
        Assert.True(service.GetIngressRows().Single(r => r.Definition.Key == "HOSTY_INGRESS_PROVIDER").Overridden);

        // Persisted: a fresh service reads the ingress overrides back.
        var reloaded = CreateService();
        Assert.True(reloaded.Ingress.DerivesPublicOrigins);
        Assert.Equal("apps.example.test", reloaded.Ingress.BaseDomain);
        Assert.Equal("tunnel-123", reloaded.Ingress.TunnelId);
    }

    [Fact]
    public async Task UpdateAsync_Ingress_NormalizesCredentialsPathToAbsolute()
    {
        var service = CreateService();

        await service.UpdateAsync(new Dictionary<string, string?> { ["HOSTY_INGRESS_CREDENTIALS_FILE"] = "creds.json" });

        Assert.True(Path.IsPathRooted(service.Ingress.CredentialsFile));
        Assert.EndsWith("creds.json", service.Ingress.CredentialsFile);
    }

    [Fact]
    public async Task UpdateAsync_Ingress_NullClearsOverride()
    {
        var service = CreateService();
        await service.UpdateAsync(new Dictionary<string, string?> { ["HOSTY_INGRESS_PROVIDER"] = "cloudflared" });
        Assert.True(service.Ingress.DerivesPublicOrigins);

        await service.UpdateAsync(new Dictionary<string, string?> { ["HOSTY_INGRESS_PROVIDER"] = null });
        Assert.Equal(IngressSettings.ProviderNone, service.Ingress.Provider);
        Assert.False(service.GetIngressRows().Single(r => r.Definition.Key == "HOSTY_INGRESS_PROVIDER").Overridden);
        Assert.False(CreateService().Ingress.DerivesPublicOrigins);
    }

    [Fact]
    public async Task UpdateAsync_Ingress_AcceptsCloudflareRemote()
    {
        var service = CreateService();

        await service.UpdateAsync(new Dictionary<string, string?>
        {
            ["HOSTY_INGRESS_PROVIDER"] = IngressSettings.ProviderCloudflareRemote,
        });

        // The two Cloudflare providers are mutually exclusive: the API one publishes, and must not also
        // derive origins or render a local tunnel config.
        Assert.True(service.Ingress.PublishesThroughApi);
        Assert.False(service.Ingress.DerivesPublicOrigins);
        Assert.True(CreateService().Ingress.PublishesThroughApi);
    }

    [Fact]
    public void BuildWarnings_CloudflareRemoteWithoutConnection_Warns()
    {
        var ingress = IngressSettings.Defaults with { Provider = IngressSettings.ProviderCloudflareRemote };

        // Selected but not connected is a legitimate intermediate state, so it warns rather than failing.
        Assert.Single(ingress.BuildWarnings(cloudflareConnected: false));
        Assert.Empty(ingress.BuildWarnings(cloudflareConnected: true));
    }

    [Fact]
    public async Task UpdateAsync_Ingress_RejectsInvalidProvider()
    {
        var service = CreateService();

        var exception = await Assert.ThrowsAsync<AppLifecycleException>(
            () => service.UpdateAsync(new Dictionary<string, string?> { ["HOSTY_INGRESS_PROVIDER"] = "nginx" }));

        Assert.Equal("core_setting_invalid", exception.Code);
    }

    [Fact]
    public async Task UpdateAsync_Ingress_RejectsInvalidBaseDomain()
    {
        var service = CreateService();

        var exception = await Assert.ThrowsAsync<AppLifecycleException>(
            () => service.UpdateAsync(new Dictionary<string, string?> { ["HOSTY_INGRESS_BASE_DOMAIN"] = "Not A Domain" }));

        Assert.Equal("core_setting_invalid", exception.Code);
    }

    [Fact]
    public async Task UpdateAsync_Ingress_LowercasesBaseDomain()
    {
        var service = CreateService();

        // DNS is case-insensitive; a mixed-case domain is accepted and canonicalized to lowercase.
        await service.UpdateAsync(new Dictionary<string, string?> { ["HOSTY_INGRESS_BASE_DOMAIN"] = "Apps.Example.Test" });

        Assert.Equal("apps.example.test", service.Ingress.BaseDomain);
    }

    [Fact]
    public void TouchesIngress_TrueOnlyWhenAnIngressKeyIsPresent()
    {
        Assert.True(CoreSettingsService.TouchesIngress(new Dictionary<string, string?> { ["HOSTY_INGRESS_PROVIDER"] = "none" }));
        Assert.False(CoreSettingsService.TouchesIngress(new Dictionary<string, string?> { ["HOSTY_AUTH_CLI_GRANT_HOURS"] = "6" }));
    }

    [Fact]
    public void Load_CorruptFile_FallsBackToBaseline()
    {
        Directory.CreateDirectory(Path.Combine(root, "core"));
        File.WriteAllText(Path.Combine(root, "core", CoreSettingsSchema.FileName), "{ not valid json");

        var service = CreateService();

        Assert.Equal(AuthLifetimes.FromEnvironment(), service.AuthLifetimes);
        Assert.Equal(IngressSettings.FromEnvironment(), service.Ingress);
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
    public async Task UpdateAsync_PreservesAValueWrittenToTheFileAfterStartup()
    {
        // The launch.env migration folds values straight into settings.json, and it runs whenever the
        // upgraded CLI first executes — quite possibly behind an already-running Core. A save rewrites
        // the whole document, so merging onto the startup snapshot would erase the migrated value on
        // the next unrelated set, after launch.env had already been deleted. Same story for any hand
        // edit. The file is the state; a save must merge onto it.
        var service = CreateService();
        var coreRoot = Path.Combine(root, "core");
        Directory.CreateDirectory(coreRoot);
        File.WriteAllText(
            Path.Combine(coreRoot, CoreSettingsSchema.FileName),
            "{\"schemaVersion\":\"" + CoreSettingsSchema.Version + "\",\"server\":{" +
            "\"HOSTY_CORE_PUBLIC_ORIGIN\":\"https://core.example\"}}");

        // An unrelated key, through the same path the CLI and the admin endpoint use.
        await service.UpdateAsync(new Dictionary<string, string?> { [ServerSettings.PortKey] = "7171" });

        using var document = JsonDocument.Parse(File.ReadAllText(Path.Combine(coreRoot, CoreSettingsSchema.FileName)));
        var server = document.RootElement.GetProperty("server");
        Assert.Equal("7171", server.GetProperty("HOSTY_CORE_PORT").GetString());
        Assert.Equal("https://core.example", server.GetProperty("HOSTY_CORE_PUBLIC_ORIGIN").GetString());
        Assert.Equal("https://core.example", service.StoredCorePublicOrigin);
    }

    [Fact]
    public void Load_HandEditedNonCanonicalServerValues_AreCanonicalizedOnTheWayIn()
    {
        // A hand-edited file is the one path into the store that never went through the save-side
        // normalizer, so the read path must canonicalize too. Otherwise a stray trailing slash or
        // surrounding whitespace would reach OAuth metadata and invitation links verbatim.
        Directory.CreateDirectory(Path.Combine(root, "core"));
        File.WriteAllText(
            Path.Combine(root, "core", CoreSettingsSchema.FileName),
            "{\"schemaVersion\":\"" + CoreSettingsSchema.Version + "\",\"server\":{" +
            "\"HOSTY_CORE_PUBLIC_ORIGIN\":\"  HTTPS://Core.Example.Test/  \"," +
            "\"HOSTY_CORE_PORT\":\" 7171 \"}}");

        var service = CreateService();

        Assert.Equal("https://core.example.test", service.StoredCorePublicOrigin);
        Assert.Equal(7171, service.GetServerRow().StoredOrDefaultPort);
    }

    [Fact]
    public void Load_HandEditedInvalidProvider_IsSkippedNotCrash()
    {
        // An unrecognized provider in a hand-edited file is dropped per-entry, so the provider follows
        // the baseline ('none') rather than wedging ingress.
        Directory.CreateDirectory(Path.Combine(root, "core"));
        File.WriteAllText(
            Path.Combine(root, "core", CoreSettingsSchema.FileName),
            "{\"schemaVersion\":\"" + CoreSettingsSchema.Version + "\",\"ingress\":{\"HOSTY_INGRESS_PROVIDER\":\"bogus\"}}");

        var service = CreateService();

        Assert.Equal(IngressSettings.ProviderNone, service.Ingress.Provider);
    }

    [Fact]
    public void Load_AuthOnlyFile_StillParses()
    {
        // The ingress section is additive: an older auth-only settings.json (no `ingress` key) must still
        // load its auth overrides rather than being rejected.
        Directory.CreateDirectory(Path.Combine(root, "core"));
        File.WriteAllText(
            Path.Combine(root, "core", CoreSettingsSchema.FileName),
            "{\"schemaVersion\":\"" + CoreSettingsSchema.Version + "\",\"auth\":{\"HOSTY_AUTH_CLI_GRANT_HOURS\":3}}");

        var service = CreateService();

        Assert.Equal(TimeSpan.FromHours(3), service.AuthLifetimes.CliGrantLifetime);
        Assert.Equal(IngressSettings.ProviderNone, service.Ingress.Provider);
    }

    [Fact]
    public void EndpointDtos_AreRegisteredInAotContext()
    {
        // The endpoint serializes these through the source-gen context; a missing registration would be
        // a runtime 500, not a compile error, so assert the round-trip here — including a select-typed
        // ingress row with options and the ingress overrides section on the persisted document.
        var response = new CoreSettingsResponse(
        [
            new CoreSettingSummary("HOSTY_AUTH_CLI_GRANT_HOURS", "number", "12", "12", "CLI diagnostic grants", "Lifetime", "desc", Overridden: false, Unit: "h"),
            new CoreSettingSummary("HOSTY_INGRESS_PROVIDER", "select", "cloudflared", "none", "Public ingress", "Provider", "desc", Overridden: true,
                Options: [new CoreSettingOption("none", "Disabled"), new CoreSettingOption("cloudflared", "Cloudflare Tunnel")]),
        ]);

        var json = JsonSerializer.Serialize(response, CoreJsonSerializerContext.Default.CoreSettingsResponse);
        Assert.Contains("HOSTY_INGRESS_PROVIDER", json);
        Assert.Contains("Cloudflare Tunnel", json);

        var request = JsonSerializer.Deserialize(
            """{"settings":{"HOSTY_INGRESS_PROVIDER":"cloudflared"}}""",
            CoreJsonSerializerContext.Default.CoreSettingsUpdateRequest);
        Assert.Equal("cloudflared", request!.Settings!["HOSTY_INGRESS_PROVIDER"]);

        var document = new CoreSettingsDocument
        {
            SchemaVersion = CoreSettingsSchema.Version,
            Ingress = new Dictionary<string, string> { ["HOSTY_INGRESS_BASE_DOMAIN"] = "example.com" },
        };
        var documentJson = JsonSerializer.Serialize(document, CoreJsonSerializerContext.Default.CoreSettingsDocument);
        Assert.Contains("example.com", documentJson);
    }

    [Fact]
    public void UpdateCheck_NoOverrides_MatchesEnvironmentBaseline()
    {
        var service = CreateService();

        Assert.Equal(UpdateCheckSettings.FromEnvironment(), service.UpdateCheck);
        Assert.Equal(UpdateCheckSettings.DefaultIntervalMinutes, service.UpdateCheck.IntervalMinutes);
        Assert.True(service.UpdateCheck.Enabled);
        Assert.False(service.GetUpdateCheckRow().Overridden);
    }

    [Fact]
    public async Task UpdateAsync_UpdateCheck_AppliesLivePersistsAndClears()
    {
        var service = CreateService();

        await service.UpdateAsync(new Dictionary<string, string?>
        {
            [UpdateCheckSettings.IntervalKey] = "15",
        });
        Assert.Equal(15, service.UpdateCheck.IntervalMinutes);
        Assert.True(service.GetUpdateCheckRow().Overridden);

        // Persisted: a fresh service over the same data root reads the override back.
        var reloaded = CreateService();
        Assert.Equal(15, reloaded.UpdateCheck.IntervalMinutes);

        // 0 = disabled is a valid persisted value, not a clear.
        await reloaded.UpdateAsync(new Dictionary<string, string?> { [UpdateCheckSettings.IntervalKey] = "0" });
        Assert.False(reloaded.UpdateCheck.Enabled);
        Assert.True(reloaded.GetUpdateCheckRow().Overridden);

        // Blank clears the override back to the env/default baseline.
        await reloaded.UpdateAsync(new Dictionary<string, string?> { [UpdateCheckSettings.IntervalKey] = "" });
        Assert.Equal(UpdateCheckSettings.FromEnvironment(), reloaded.UpdateCheck);
        Assert.False(reloaded.GetUpdateCheckRow().Overridden);
    }

    [Theory]
    [InlineData("-1")]
    [InlineData("1.5")]
    [InlineData("often")]
    [InlineData("10081")]
    public async Task UpdateAsync_UpdateCheck_RejectsInvalidIntervals(string interval)
    {
        var service = CreateService();
        var error = await Assert.ThrowsAsync<AppLifecycleException>(() =>
            service.UpdateAsync(new Dictionary<string, string?> { [UpdateCheckSettings.IntervalKey] = interval }));
        Assert.Equal("core_setting_invalid", error.Code);
    }

    [Fact]
    public void UserRetention_NoOverrides_MatchesEnvironmentBaseline()
    {
        var service = CreateService();

        Assert.Equal(UserRetentionSettings.FromEnvironment(), service.UserRetention);
        Assert.Equal(UserRetentionSettings.DefaultDisabledRetentionDays, service.UserRetention.DisabledRetentionDays);
        Assert.True(service.UserRetention.AutoPurgeEnabled);
        Assert.False(service.GetUserRetentionRow().Overridden);
    }

    [Fact]
    public async Task UpdateAsync_UserRetention_AppliesLivePersistsAndClears()
    {
        var service = CreateService();

        await service.UpdateAsync(new Dictionary<string, string?>
        {
            [UserRetentionSettings.DisabledRetentionDaysKey] = "30",
        });
        Assert.Equal(30, service.UserRetention.DisabledRetentionDays);
        Assert.True(service.GetUserRetentionRow().Overridden);

        // Persisted: a fresh service over the same data root reads the override back.
        var reloaded = CreateService();
        Assert.Equal(30, reloaded.UserRetention.DisabledRetentionDays);

        // 0 = never delete is a valid persisted value, not a clear.
        await reloaded.UpdateAsync(new Dictionary<string, string?> { [UserRetentionSettings.DisabledRetentionDaysKey] = "0" });
        Assert.False(reloaded.UserRetention.AutoPurgeEnabled);
        Assert.True(reloaded.GetUserRetentionRow().Overridden);

        // Blank clears the override back to the env/default baseline.
        await reloaded.UpdateAsync(new Dictionary<string, string?> { [UserRetentionSettings.DisabledRetentionDaysKey] = "" });
        Assert.Equal(UserRetentionSettings.FromEnvironment(), reloaded.UserRetention);
        Assert.False(reloaded.GetUserRetentionRow().Overridden);
    }

    [Theory]
    [InlineData("-1")]
    [InlineData("1.5")]
    [InlineData("soon")]
    [InlineData("3651")]
    public async Task UpdateAsync_UserRetention_RejectsInvalidDays(string days)
    {
        var service = CreateService();
        var error = await Assert.ThrowsAsync<AppLifecycleException>(() =>
            service.UpdateAsync(new Dictionary<string, string?> { [UserRetentionSettings.DisabledRetentionDaysKey] = days }));
        Assert.Equal("core_setting_invalid", error.Code);
    }

    [Fact]
    public async Task UpdateAsync_ServerPort_PersistsAndClears()
    {
        var service = CreateService();

        // No override: the row shows the built-in default and startup finds no stored port.
        Assert.Equal(ServerSettings.DefaultPort, service.GetServerRow().StoredOrDefaultPort);
        Assert.False(service.GetServerRow().Overridden);
        Assert.Null(CoreSettingsStore.TryReadStoredPort(Paths.CoreRoot));

        await service.UpdateAsync(new Dictionary<string, string?> { [ServerSettings.PortKey] = " 7171 " });

        // The row reports the persisted next-start value; startup reads the same file directly.
        Assert.Equal(7171, service.GetServerRow().StoredOrDefaultPort);
        Assert.True(service.GetServerRow().Overridden);
        Assert.Equal(7171, CoreSettingsStore.TryReadStoredPort(Paths.CoreRoot));

        // A fresh service over the same root reads the override back; blank clears it.
        var reloaded = CreateService();
        Assert.Equal(7171, reloaded.GetServerRow().StoredOrDefaultPort);
        await reloaded.UpdateAsync(new Dictionary<string, string?> { [ServerSettings.PortKey] = "" });
        Assert.Equal(ServerSettings.DefaultPort, reloaded.GetServerRow().StoredOrDefaultPort);
        Assert.False(reloaded.GetServerRow().Overridden);
        Assert.Null(CoreSettingsStore.TryReadStoredPort(Paths.CoreRoot));
    }

    [Theory]
    [InlineData("0")]
    [InlineData("65536")]
    [InlineData("-7070")]
    [InlineData("port")]
    [InlineData("70.70")]
    public async Task UpdateAsync_ServerPort_RejectsInvalidPorts(string port)
    {
        var service = CreateService();
        var error = await Assert.ThrowsAsync<AppLifecycleException>(() =>
            service.UpdateAsync(new Dictionary<string, string?> { [ServerSettings.PortKey] = port }));
        Assert.Equal("core_setting_invalid", error.Code);
    }

    [Fact]
    public void TryReadStoredPort_ToleratesMissingCorruptAndForeignFiles()
    {
        // Startup must never crash on the settings file: absent, unparsable, wrong schema, or a
        // hand-edited bad value all mean "no stored port".
        Assert.Null(CoreSettingsStore.TryReadStoredPort(Paths.CoreRoot));

        Directory.CreateDirectory(Paths.CoreRoot);
        var path = Path.Combine(Paths.CoreRoot, CoreSettingsSchema.FileName);

        File.WriteAllText(path, "{not json");
        Assert.Null(CoreSettingsStore.TryReadStoredPort(Paths.CoreRoot));

        File.WriteAllText(path, """{"schemaVersion":"core-settings.9.9","server":{"HOSTY_CORE_PORT":"7171"}}""");
        Assert.Null(CoreSettingsStore.TryReadStoredPort(Paths.CoreRoot));

        File.WriteAllText(path, """{"schemaVersion":"core-settings.0.1","server":{"HOSTY_CORE_PORT":"70000"}}""");
        Assert.Null(CoreSettingsStore.TryReadStoredPort(Paths.CoreRoot));

        File.WriteAllText(path, """{"schemaVersion":"core-settings.0.1","server":{"HOSTY_CORE_PORT":"7171"}}""");
        Assert.Equal(7171, CoreSettingsStore.TryReadStoredPort(Paths.CoreRoot));
    }

    public void Dispose()
    {
        if (Directory.Exists(root))
        {
            Directory.Delete(root, recursive: true);
        }
    }
}
