using Haas.Hosty.Core;
using Microsoft.AspNetCore.Builder;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Configuration.EnvironmentVariables;
using Microsoft.Extensions.Configuration.Memory;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;

namespace Haas.Hosty.Core.Tests.Http;

// Core's logging defaults are two rules pulling in opposite directions: the console (which is
// `core.log`) drops the framework to Warning, while the in-memory rings keep it at Information. Both
// halves are load-bearing — the file only becomes legible if the first holds, and the dialog only
// keeps a request trail if the second does — and neither is visible by reading a single call site.
public sealed class CoreLoggingPipelineTests
{
    [Fact]
    public async Task FrameworkRecordsStillReachTheFrameworkRing()
    {
        await using var harness = await CoreHttpHarness.StartAsync();
        var buffer = harness.Services.GetRequiredService<CoreLogBuffer>();

        harness.Services.GetRequiredService<ILoggerFactory>()
            .CreateLogger("Microsoft.AspNetCore.Hosting.Diagnostics")
            .LogInformation("Request finished");

        var records = buffer.Ring(CoreLogRingKind.Framework).Read(tail: 100, minLevel: LogLevel.Trace);

        Assert.Contains(records, record => record.Message == "Request finished");
        Assert.DoesNotContain(
            buffer.Ring(CoreLogRingKind.Hosty).Read(tail: 100, minLevel: LogLevel.Trace),
            record => record.Message == "Request finished");
    }

    [Fact]
    public async Task CoresOwnRecordsReachTheHostyRing()
    {
        await using var harness = await CoreHttpHarness.StartAsync();
        var buffer = harness.Services.GetRequiredService<CoreLogBuffer>();

        harness.Services.GetRequiredService<ILoggerFactory>()
            .CreateLogger("Haas.Hosty.Core.RuntimeAppSupervisorService")
            .LogInformation("Adopted a container");

        Assert.Contains(
            buffer.Ring(CoreLogRingKind.Hosty).Read(tail: 100, minLevel: LogLevel.Trace),
            record => record.Message == "Adopted a container");
    }

    [Fact]
    public async Task ARepeatedRecordFoldsRatherThanFillingTheRing()
    {
        await using var harness = await CoreHttpHarness.StartAsync();
        var buffer = harness.Services.GetRequiredService<CoreLogBuffer>();
        var logger = harness.Services.GetRequiredService<ILoggerFactory>()
            .CreateLogger("Haas.Hosty.Core.DockerStatsExposition");

        for (var tick = 0; tick < 50; tick++)
        {
            logger.LogWarning("Docker stats exposition tick failed.");
        }

        var repeated = Assert.Single(
            buffer.Ring(CoreLogRingKind.Hosty).Read(tail: 100, minLevel: LogLevel.Warning),
            record => record.Message == "Docker stats exposition tick failed.");

        Assert.Equal(50, repeated.Count);
    }

    [Fact]
    public void TheShippedDefaultsQuietTheFrameworkOnTheConsole()
    {
        var configuration = BuildConfiguredBuilder().Configuration;

        Assert.Equal("Warning", configuration["Logging:LogLevel:Microsoft"]);
        Assert.Equal("Warning", configuration["Logging:LogLevel:System"]);
        Assert.Equal("Information", configuration["Logging:LogLevel:Default"]);
    }

    // The precedence that makes `Logging__LogLevel__Microsoft.AspNetCore=Information` still work for an
    // operator debugging an ingress problem: our defaults must be the *first* source, so every source
    // layered after them — environment variables above all — overrides rather than loses.
    [Fact]
    public void TheShippedDefaultsSitBeneathEveryOtherConfigurationSource()
    {
        var sources = BuildConfiguredBuilder().Configuration.Sources;

        Assert.IsType<MemoryConfigurationSource>(sources[0]);
        var environmentIndex = sources
            .Select((source, index) => (source, index))
            .Where(candidate => candidate.source is EnvironmentVariablesConfigurationSource)
            .Select(candidate => candidate.index)
            .DefaultIfEmpty(-1)
            .Max();
        Assert.True(environmentIndex > 0, "the environment source must be layered after the shipped defaults");
    }

    private static WebApplicationBuilder BuildConfiguredBuilder()
    {
        var dataRoot = Path.Combine(Path.GetTempPath(), $"hosty-core-logging-tests-{Guid.NewGuid():N}");
        var builder = WebApplication.CreateSlimBuilder();
        HostyCoreApplication.ConfigureServices(builder, new HostyCoreRuntimeConfig(
            DataRoot: dataRoot,
            RunDirectory: Path.Combine(dataRoot, "core", "run"),
            ControlDiscoveryPath: Path.Combine(dataRoot, "core", "run", "control.json"),
            CorePort: 7070,
            ListenUrl: "http://localhost:7070",
            CorePublicOrigin: "http://localhost:7070",
            RuntimePublicHost: "127.0.0.1",
            ShellSourceOverridePath: null,
            ShellAutostart: false));
        return builder;
    }
}
