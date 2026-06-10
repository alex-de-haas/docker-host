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
