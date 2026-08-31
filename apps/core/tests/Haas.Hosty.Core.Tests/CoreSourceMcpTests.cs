using Haas.Hosty.Core;

namespace Haas.Hosty.Core.Tests;

// Telemetry attributes Core's own records to a reserved id, and the same connector exposes Core's
// app-keyed tools — so an agent that has just read the fleet's logs can arrive at tail_app_logs holding
// `hosty.core`. Before this guard the lifecycle lookup surfaced a raw "app not found", which reads like
// a broken host rather than a category error.
public sealed class CoreSourceMcpTests
{
    [Fact]
    public async Task TailAppLogs_ExplainsThatCoreIsNotAnInstalledApp()
    {
        // The guard runs before the lifecycle service is touched, which is what lets this assert the
        // refusal without booting one.
        var result = await HostyCoreTools.TailAppLogsAsync(CoreLogBuffer.CoreSourceId, lifecycle: null!, CancellationToken.None);

        Assert.Contains("host kernel", result, StringComparison.Ordinal);
        Assert.Contains("core.log", result, StringComparison.Ordinal);
        Assert.DoesNotContain("app_not_found", result, StringComparison.Ordinal);
    }
}
