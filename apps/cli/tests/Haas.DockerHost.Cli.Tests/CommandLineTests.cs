using Haas.DockerHost.Cli;

namespace Haas.DockerHost.Cli.Tests;

public sealed class CommandLineTests
{
    [Theory]
    [InlineData("--help")]
    [InlineData("-h")]
    [InlineData("help")]
    [InlineData("--version")]
    [InlineData("-v")]
    [InlineData("version")]
    public async Task RunAsync_BuiltInMetadataCommand_ReturnsSuccess(string argument)
    {
        var exitCode = await CommandLine.RunAsync([argument]);

        Assert.Equal(0, exitCode);
    }

    [Fact]
    public async Task RunAsync_UnknownCommand_ReturnsUsageError()
    {
        var exitCode = await CommandLine.RunAsync(["unknown-command"]);

        Assert.Equal(2, exitCode);
    }

    [Fact]
    public async Task RunAsync_ConfigHelpCommand_RoutesToConfigCommand()
    {
        var exitCode = await CommandLine.RunAsync(["config", "--help"]);

        Assert.Equal(0, exitCode);
    }

    [Fact]
    public async Task RunAsync_ModulesHelpCommand_RoutesToModulesCommand()
    {
        var exitCode = await CommandLine.RunAsync(["modules", "--help"]);

        Assert.Equal(0, exitCode);
    }

    [Fact]
    public async Task RunAsync_AppsHelpCommand_RoutesToModulesCompatibilityCommand()
    {
        var exitCode = await CommandLine.RunAsync(["apps", "--help"]);

        Assert.Equal(0, exitCode);
    }

    [Fact]
    public async Task RunAsync_AuthHelpCommand_RoutesToAuthCommand()
    {
        var exitCode = await CommandLine.RunAsync(["auth", "--help"]);

        Assert.Equal(0, exitCode);
    }

    [Fact]
    public async Task RunAsync_DevHelpCommand_RoutesToDevCommand()
    {
        var exitCode = await CommandLine.RunAsync(["dev", "--help"]);

        Assert.Equal(0, exitCode);
    }

    [Fact]
    public async Task RunAsync_ModulesUnknownCommand_ReturnsUsageError()
    {
        var exitCode = await CommandLine.RunAsync(["modules", "unknown"]);

        Assert.Equal(2, exitCode);
    }
}
