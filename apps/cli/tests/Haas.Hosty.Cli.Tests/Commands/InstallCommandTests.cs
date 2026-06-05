using Haas.Hosty.Cli.Commands;
using Haas.Hosty.Cli.Configuration;
using Spectre.Console;

namespace Haas.Hosty.Cli.Tests.Commands;

public sealed class InstallCommandTests : IDisposable
{
    private const string RootVariable = "HOSTY_HOME";
    private readonly string? previousRoot;
    private readonly string rootDirectory;

    public InstallCommandTests()
    {
        previousRoot = Environment.GetEnvironmentVariable(RootVariable);
        rootDirectory = Path.Combine(Path.GetTempPath(), $"hosty-install-tests-{Guid.NewGuid():N}");
        Environment.SetEnvironmentVariable(RootVariable, rootDirectory);
    }

    [Fact]
    public async Task ExecuteAsync_PreparesLocalHostyDirectories()
    {
        var environment = HostyEnvironment.Current();
        var context = CreateContext(environment);

        var exitCode = await new InstallCommand(context).ExecuteAsync([]);

        Assert.Equal(0, exitCode);
        Assert.True(Directory.Exists(environment.RootDirectory));
        Assert.True(Directory.Exists(environment.ConfigDirectory));
        Assert.True(Directory.Exists(environment.BinDirectory));
        Assert.True(Directory.Exists(environment.AppsDirectory));
        Assert.True(Directory.Exists(Path.GetDirectoryName(CoreInstallationService.GetInstalledExecutablePath(environment))));
        Assert.False(File.Exists(environment.LaunchConfigPath));
    }

    [Fact]
    public async Task ExecuteAsync_WithArgumentsThrowsUsageError()
    {
        var environment = HostyEnvironment.Current();
        var context = CreateContext(environment);

        await Assert.ThrowsAsync<CommandUsageException>(
            async () => await new InstallCommand(context).ExecuteAsync(["--pull"]));
    }

    public void Dispose()
    {
        Environment.SetEnvironmentVariable(RootVariable, previousRoot);

        if (Directory.Exists(rootDirectory))
        {
            Directory.Delete(rootDirectory, recursive: true);
        }
    }

    private static CommandContext CreateContext(HostyEnvironment environment)
        => new(
            CreateConsole(),
            environment,
            new LaunchSettingsStore(environment));

    private static IAnsiConsole CreateConsole()
    {
        var output = new StringWriter();
        return AnsiConsole.Create(new AnsiConsoleSettings
        {
            Out = new AnsiConsoleOutput(output),
            Interactive = InteractionSupport.No,
        });
    }
}
