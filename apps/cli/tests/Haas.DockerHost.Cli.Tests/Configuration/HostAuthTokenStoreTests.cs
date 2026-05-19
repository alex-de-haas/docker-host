using Haas.DockerHost.Cli.Configuration;

namespace Haas.DockerHost.Cli.Tests.Configuration;

public sealed class HostAuthTokenStoreTests : IDisposable
{
    private const string RootVariable = "DOCKER_HOST_HOME";
    private readonly string? previousRoot;
    private readonly string rootDirectory;

    public HostAuthTokenStoreTests()
    {
        previousRoot = Environment.GetEnvironmentVariable(RootVariable);
        rootDirectory = Path.Combine(Path.GetTempPath(), $"docker-host-auth-token-tests-{Guid.NewGuid():N}");
        Environment.SetEnvironmentVariable(RootVariable, rootDirectory);
    }

    [Fact]
    public void Save_TokenCredential_LoadsForMatchingHostOnly()
    {
        var environment = DockerHostEnvironment.Current();
        var store = new HostAuthTokenStore(environment);

        store.Save(new HostAuthTokenCredential(
            "http://127.0.0.1:3000/",
            "dhcli_test",
            "cli_123",
            "Local CLI",
            DateTimeOffset.UtcNow));

        var credential = store.Load();

        Assert.Equal("http://127.0.0.1:3000", credential?.HostUrl);
        Assert.Equal("dhcli_test", store.GetTokenForHost(new Uri("http://127.0.0.1:3000")));
        Assert.Null(store.GetTokenForHost(new Uri("http://127.0.0.1:4000")));

        if (!OperatingSystem.IsWindows())
        {
            Assert.Equal(
                UnixFileMode.UserRead | UnixFileMode.UserWrite,
                File.GetUnixFileMode(environment.AuthConfigPath));
        }
    }

    public void Dispose()
    {
        Environment.SetEnvironmentVariable(RootVariable, previousRoot);

        if (Directory.Exists(rootDirectory))
        {
            Directory.Delete(rootDirectory, recursive: true);
        }
    }
}
