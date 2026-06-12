using Haas.Hosty.Cli;
using Spectre.Console;

namespace Haas.Hosty.Cli.Tests;

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
    public async Task RunAsync_CoreHelpCommand_RoutesToCoreCommand()
    {
        var exitCode = await CommandLine.RunAsync(["core", "--help"]);

        Assert.Equal(0, exitCode);
    }

    [Fact]
    public async Task RunAsync_AppsHelpCommand_RoutesToCoreAppsCommand()
    {
        var exitCode = await CommandLine.RunAsync(["apps", "--help"]);

        Assert.Equal(0, exitCode);
    }

    [Fact]
    public async Task RunAsync_UsersHelpCommand_RoutesToUsersCommand()
    {
        var exitCode = await CommandLine.RunAsync(["users", "--help"]);

        Assert.Equal(0, exitCode);
    }

    [Fact]
    public async Task RunAsync_AuthHelpCommand_RoutesToAuthCommand()
    {
        var exitCode = await CommandLine.RunAsync(["auth", "--help"]);

        Assert.Equal(0, exitCode);
    }

    [Fact]
    public async Task RunAsync_DeveloperHarnessCommand_IsNotRouted()
    {
        var exitCode = await CommandLine.RunAsync(["dev", "--help"]);

        Assert.Equal(2, exitCode);
    }

    [Fact]
    public async Task RunAsync_VersionFlag_PrintsResolvedVersion()
    {
        var output = new StringWriter();
        var console = AnsiConsole.Create(new AnsiConsoleSettings
        {
            Out = new AnsiConsoleOutput(output),
            Interactive = InteractionSupport.No,
        });

        var exitCode = await CommandLine.RunAsync(["--version"], console);

        Assert.Equal(0, exitCode);
        Assert.Contains(CommandLine.Version, output.ToString());
    }

    [Fact]
    public void Version_ComesFromAssemblyMetadataWithoutBuildMetadata()
    {
        Assert.Matches(@"^\d+\.\d+\.\d+", CommandLine.Version);
        Assert.DoesNotContain("+", CommandLine.Version);
    }

    [Theory]
    [InlineData("0.3.0", "0.3.0")]
    [InlineData("0.3.0+4f8a9c1", "0.3.0")]
    [InlineData("0.3.0-beta.1+4f8a9c1", "0.3.0-beta.1")]
    [InlineData(null, "0.0.0")]
    [InlineData("  ", "0.0.0")]
    public void ResolveVersion_TrimsBuildMetadata(string? informationalVersion, string expected)
    {
        Assert.Equal(expected, CommandLine.ResolveVersion(informationalVersion));
    }
}
