using Haas.DockerHost.Cli;

namespace Haas.DockerHost.Cli.Tests.Commands;

public sealed class AuthCommandTests : IDisposable
{
    private const string RootVariable = "DOCKER_HOST_HOME";
    private readonly string? previousRoot;
    private readonly string rootDirectory;

    public AuthCommandTests()
    {
        previousRoot = Environment.GetEnvironmentVariable(RootVariable);
        rootDirectory = Path.Combine(Path.GetTempPath(), $"docker-host-auth-tests-{Guid.NewGuid():N}");
        Environment.SetEnvironmentVariable(RootVariable, rootDirectory);
    }

    [Theory]
    [InlineData("setup-token")]
    [InlineData("recovery-token")]
    public async Task RunAsync_TokenCommand_DoesNotWriteLegacyAuthState(string command)
    {
        var exitCode = await CommandLine.RunAsync(["auth", command]);

        Assert.Equal(1, exitCode);
        Assert.False(File.Exists(Path.Combine(rootDirectory, "auth", "state.json")));
        Assert.False(File.Exists(Path.Combine(rootDirectory, "auth", "audit.ndjson")));
        Assert.False(File.Exists(Path.Combine(rootDirectory, "core", "auth", "state.json")));
    }

    [Fact]
    public async Task RunAsync_TokenCommand_WithArguments_ReturnsUsageError()
    {
        var exitCode = await CommandLine.RunAsync(["auth", "setup-token", "extra"]);

        Assert.Equal(2, exitCode);
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
