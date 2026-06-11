using Haas.Hosty.Core;

namespace Haas.Hosty.Core.Tests;

public sealed class LocalCommandRuntimeAdapterTests
{
    [Fact]
    public void BuildCoreEnvironment_SplitsPublicAndRuntimeOrigins()
    {
        var config = CreateConfig(
            corePort: 7070,
            listenUrl: "http://localhost:7070",
            corePublicOrigin: "https://core.example");

        var result = LocalCommandRuntimeAdapter.BuildCoreEnvironment(config);

        Assert.Equal("7070", result["HOSTY_CORE_PORT"]);
        Assert.Equal("https://core.example", result["HOSTY_CORE_PUBLIC_ORIGIN"]);
        Assert.Equal("http://localhost:7070", result["HOSTY_CORE_ORIGIN"]);
    }

    [Fact]
    public void LocalCommandLogWriter_IgnoresLateWritesAfterDispose()
    {
        var text = new StringWriter(System.Globalization.CultureInfo.InvariantCulture);
        var writer = new LocalCommandLogWriter(text);

        writer.TryWriteLine("before");
        writer.Dispose();
        var exception = Record.Exception(() => writer.TryWriteLine("after"));

        Assert.Null(exception);
        Assert.Contains("before", text.ToString(), StringComparison.Ordinal);
        Assert.DoesNotContain("after", text.ToString(), StringComparison.Ordinal);
    }

    private static HostyCoreRuntimeConfig CreateConfig(int corePort, string listenUrl, string? corePublicOrigin)
        => new(
            DataRoot: "/tmp/hosty",
            RunDirectory: "/tmp/hosty/core/run",
            ControlDiscoveryPath: "/tmp/hosty/core/run/control.json",
            CorePort: corePort,
            ShellPort: 7171,
            ListenUrl: listenUrl,
            CorePublicOrigin: corePublicOrigin,
            ShellPublicOrigin: null,
            RuntimePublicHost: "localhost",
            ShellManifestPath: null,
            ShellBootstrapRuntime: "docker",
            ShellSourceOverridePath: null,
            ShellBootstrapEnabled: false,
            ShellAutostart: false);
}
