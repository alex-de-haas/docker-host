using Haas.Hosty.Core;
using Microsoft.Extensions.Logging.Abstractions;

namespace Haas.Hosty.Core.Tests;

// The public origin as a live setting: what it accepts, how the store layers over the environment
// baseline, and that clearing it falls back rather than blanking the value.
public sealed class CorePublicOriginTests : IDisposable
{
    private readonly string root = Path.Combine(Path.GetTempPath(), $"hosty-core-public-origin-tests-{Guid.NewGuid():N}");

    private CoreDataPaths Paths => CoreOriginTestFactory.PathsFor(root);

    private static HostyCoreRuntimeConfig Config(string? envBaseline, string listenUrl = "http://localhost:7070")
        => new(
            DataRoot: "/tmp/hosty",
            RunDirectory: "/tmp/hosty/core/run",
            ControlDiscoveryPath: "/tmp/hosty/core/run/control.json",
            CorePort: 7070,
            ListenUrl: listenUrl,
            CorePublicOrigin: envBaseline,
            RuntimePublicHost: "127.0.0.1",
            ShellSourceOverridePath: null,
            ShellAutostart: false);

    [Fact]
    public void Effective_FallsBackToTheListenUrlWhenNothingNamesAnOrigin()
    {
        var config = Config(envBaseline: null);
        var (origins, _) = CoreOriginTestFactory.Create(config, Paths);

        Assert.Null(origins.Configured);
        Assert.Equal("http://localhost:7070", origins.Effective);
        Assert.Equal("http://localhost:7070", origins.Baseline);
        Assert.False(origins.GetRow().Overridden);
    }

    [Fact]
    public async Task PersistedValueWinsOverTheEnvironmentBaseline()
    {
        var config = Config(envBaseline: "https://env.example.test");
        var (origins, settings) = CoreOriginTestFactory.Create(config, Paths);
        Assert.Equal("https://env.example.test", origins.Effective);

        await CoreOriginTestFactory.SetAsync(settings, "https://stored.example.test");

        Assert.Equal("https://stored.example.test", origins.Effective);
        Assert.True(origins.GetRow().Overridden);
        // What a reset would land on, which is the environment baseline rather than the listen URL.
        Assert.Equal("https://env.example.test", origins.GetRow().BaselineOrigin);
    }

    [Fact]
    public async Task ClearingTheOverrideFallsBackToTheEnvironmentBaseline()
    {
        var config = Config(envBaseline: "https://env.example.test");
        var (origins, settings) = CoreOriginTestFactory.Create(config, Paths);
        await CoreOriginTestFactory.SetAsync(settings, "https://stored.example.test");

        await CoreOriginTestFactory.SetAsync(settings, null);

        Assert.Equal("https://env.example.test", origins.Effective);
        Assert.False(origins.GetRow().Overridden);
    }

    // The headless recovery path: `hosty core settings reset HOSTY_CORE_PUBLIC_ORIGIN` sends a blank
    // value, and with no environment baseline that has to leave Core advertising its listen URL again
    // rather than an empty string.
    [Fact]
    public async Task ResettingWithNoBaselineReturnsToTheListenUrl()
    {
        var config = Config(envBaseline: null);
        var (origins, settings) = CoreOriginTestFactory.Create(config, Paths);
        await CoreOriginTestFactory.SetAsync(settings, "https://unreachable.example.test");
        Assert.Equal("https://unreachable.example.test", origins.Effective);

        await CoreOriginTestFactory.SetAsync(settings, "   ");

        Assert.Equal("http://localhost:7070", origins.Effective);
    }

    [Fact]
    public async Task PersistedValueSurvivesAReload()
    {
        var config = Config(envBaseline: null);
        var (_, settings) = CoreOriginTestFactory.Create(config, Paths);
        await CoreOriginTestFactory.SetAsync(settings, "https://core.example.test");

        var reloaded = CoreOriginTestFactory.CreateResolver(config, Paths);

        Assert.Equal("https://core.example.test", reloaded.Effective);
    }

    // Loopback is the default state and the right answer for a single-machine host, so it is accepted
    // rather than treated as a mistake.
    [Theory]
    [InlineData("http://localhost:7070")]
    [InlineData("http://127.0.0.1:7070")]
    [InlineData("https://core.example.test")]
    [InlineData("http://192.168.1.10:7070")]
    public async Task ValidationAcceptsAnyWellFormedOrigin(string value)
    {
        var (_, settings) = CoreOriginTestFactory.Create(Config(envBaseline: null), Paths);

        await CoreOriginTestFactory.SetAsync(settings, value);

        Assert.Equal(value, settings.StoredCorePublicOrigin);
    }

    // Refused by form only. Reachability is never judged here — an origin that does not answer is the
    // ingress diagnostics' business, and refusing it would make a host unable to record an address it is
    // about to publish.
    [Theory]
    [InlineData("core.example.test")]
    [InlineData("ftp://core.example.test")]
    [InlineData("https://core.example.test/api")]
    [InlineData("https://core.example.test?a=b")]
    [InlineData("https://user:pass@core.example.test")]
    [InlineData("https://core.example.test#fragment")]
    [InlineData("http://0.0.0.0:7070")]
    [InlineData("http://[::]:7070")]
    public async Task ValidationRefusesWhatCannotWorkAsAnOrigin(string value)
    {
        var (origins, settings) = CoreOriginTestFactory.Create(Config(envBaseline: null), Paths);

        var failure = await Assert.ThrowsAsync<AppLifecycleException>(
            () => CoreOriginTestFactory.SetAsync(settings, value));

        Assert.Equal("core_setting_invalid", failure.Code);
        // Rejected before anything was written: a bad submission never displaces a working value.
        Assert.Null(settings.StoredCorePublicOrigin);
        Assert.Equal("http://localhost:7070", origins.Effective);
    }

    [Fact]
    public async Task StoredValueIsCanonicalized()
    {
        var (_, settings) = CoreOriginTestFactory.Create(Config(envBaseline: null), Paths);

        await CoreOriginTestFactory.SetAsync(settings, "  https://Core.Example.Test/  ");

        Assert.Equal("https://core.example.test", settings.StoredCorePublicOrigin);
    }

    // A hand-edited settings.json must not take Core down or be honored: the same per-entry tolerance the
    // other groups apply.
    [Fact]
    public async Task AHandEditedInvalidValueIsIgnoredOnLoad()
    {
        Directory.CreateDirectory(Path.Combine(root, "core"));
        var store = new CoreSettingsStore(Paths, NullLogger<CoreSettingsStore>.Instance);
        await store.SaveAsync(new CoreSettingsDocument
        {
            SchemaVersion = "core-settings.0.1",
            Server = new Dictionary<string, string>(StringComparer.Ordinal)
            {
                ["HOSTY_CORE_PUBLIC_ORIGIN"] = "not-an-origin",
                ["HOSTY_CORE_PORT"] = "7171",
            },
        });

        var origins = CoreOriginTestFactory.CreateResolver(Config(envBaseline: null), Paths);

        Assert.Equal("http://localhost:7070", origins.Effective);
        // The sibling key in the same group is unaffected.
        Assert.Equal(7171, CoreSettingsStore.TryReadStoredPort(Path.Combine(root, "core")));
    }

    // Both keys share the Server group in one document, so writing one must not drop the other.
    [Fact]
    public async Task TheOriginAndThePortShareTheGroupWithoutDisturbingEachOther()
    {
        var (_, settings) = CoreOriginTestFactory.Create(Config(envBaseline: null), Paths);
        await settings.UpdateAsync(new Dictionary<string, string?>(StringComparer.Ordinal) { ["HOSTY_CORE_PORT"] = "7171" });

        await CoreOriginTestFactory.SetAsync(settings, "https://core.example.test");

        Assert.Equal(7171, settings.GetServerRow().StoredOrDefaultPort);
        Assert.Equal("https://core.example.test", settings.StoredCorePublicOrigin);
        Assert.Equal(7171, CoreSettingsStore.TryReadStoredPort(Path.Combine(root, "core")));
    }

    public void Dispose()
    {
        try
        {
            Directory.Delete(root, recursive: true);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or DirectoryNotFoundException)
        {
        }
    }
}
