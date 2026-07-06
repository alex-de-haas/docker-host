using Haas.Hosty.Cli;
using Haas.Hosty.Cli.Commands;
using Haas.Hosty.Cli.Configuration;
using Spectre.Console;

namespace Haas.Hosty.Cli.Tests.Commands;

public sealed class UninstallCommandTests : IDisposable
{
    private const string RootVariable = "HOSTY_HOME";
    private readonly string? previousRoot;
    private readonly string rootDirectory;

    public UninstallCommandTests()
    {
        previousRoot = Environment.GetEnvironmentVariable(RootVariable);
        rootDirectory = Path.Combine(Path.GetTempPath(), $"hosty-uninstall-tests-{Guid.NewGuid():N}");
        Environment.SetEnvironmentVariable(RootVariable, rootDirectory);
    }

    [Fact]
    public async Task RunAsync_WithoutConfirmation_ReturnsUsageError()
    {
        // Data destruction must be explicit: no --yes means a usage error, not a silent wipe.
        Assert.Equal(2, await CommandLine.RunAsync(["uninstall"]));
        Assert.Equal(2, await CommandLine.RunAsync(["uninstall", "--delete-data"]));
    }

    [Fact]
    public async Task RunAsync_UnknownArgument_ReturnsUsageError()
    {
        var exitCode = await CommandLine.RunAsync(["uninstall", "--yes", "--bogus"]);

        Assert.Equal(2, exitCode);
    }

    [Fact]
    public void Delete_DefaultRootWithDeleteData_RemovesHostyFilesAndPreservesCliBin()
    {
        var environment = HostyEnvironment.Current();
        Directory.CreateDirectory(environment.BinDirectory);
        Directory.CreateDirectory(environment.ConfigDirectory);
        Directory.CreateDirectory(Path.Combine(environment.RootDirectory, "core"));
        Directory.CreateDirectory(Path.Combine(environment.RootDirectory, "apps"));
        Directory.CreateDirectory(Path.Combine(environment.RootDirectory, "backups"));
        Directory.CreateDirectory(Path.Combine(environment.RootDirectory, "sources"));
        File.WriteAllText(Path.Combine(environment.BinDirectory, "hosty"), "binary");
        File.WriteAllText(Path.Combine(environment.RootDirectory, "apps.json"), "{}");
        File.WriteAllText(Path.Combine(environment.RootDirectory, "host-cache.txt"), "cache");

        var result = HostUninstallFileCleanup.Delete(environment, environment.RootDirectory, deleteData: true);

        Assert.Contains(Path.Combine(environment.RootDirectory, "apps.json"), result.DeletedPaths);
        Assert.True(File.Exists(Path.Combine(environment.BinDirectory, "hosty")));
        Assert.False(Directory.Exists(environment.ConfigDirectory));
        Assert.False(Directory.Exists(Path.Combine(environment.RootDirectory, "core")));
        Assert.False(Directory.Exists(Path.Combine(environment.RootDirectory, "apps")));
        Assert.False(Directory.Exists(Path.Combine(environment.RootDirectory, "backups")));
        Assert.False(Directory.Exists(Path.Combine(environment.RootDirectory, "sources")));
        Assert.False(File.Exists(Path.Combine(environment.RootDirectory, "host-cache.txt")));
    }

    [Fact]
    public void Delete_DefaultRootWithoutDeleteData_PreservesAppData()
    {
        var environment = HostyEnvironment.Current();
        Directory.CreateDirectory(environment.BinDirectory);
        Directory.CreateDirectory(environment.ConfigDirectory);
        Directory.CreateDirectory(Path.Combine(environment.RootDirectory, "core"));
        Directory.CreateDirectory(Path.Combine(environment.RootDirectory, "apps"));
        Directory.CreateDirectory(Path.Combine(environment.RootDirectory, "backups"));
        File.WriteAllText(Path.Combine(environment.RootDirectory, "apps.json"), "{}");

        HostUninstallFileCleanup.Delete(environment, environment.RootDirectory, deleteData: false);

        // Install state (config + Core runtime dir) is removed; user data survives.
        Assert.False(Directory.Exists(environment.ConfigDirectory));
        Assert.False(Directory.Exists(Path.Combine(environment.RootDirectory, "core")));
        Assert.True(File.Exists(Path.Combine(environment.RootDirectory, "apps.json")));
        Assert.True(Directory.Exists(Path.Combine(environment.RootDirectory, "apps")));
        Assert.True(Directory.Exists(Path.Combine(environment.RootDirectory, "backups")));
    }

    [Fact]
    public void Delete_ExternalDataRootWithDeleteData_RemovesKnownHostyStateOnly()
    {
        var environment = HostyEnvironment.Current();
        var externalDataRoot = Path.Combine(Path.GetTempPath(), $"hosty-data-{Guid.NewGuid():N}");
        Directory.CreateDirectory(environment.BinDirectory);
        Directory.CreateDirectory(environment.ConfigDirectory);
        Directory.CreateDirectory(Path.Combine(externalDataRoot, "core"));
        Directory.CreateDirectory(Path.Combine(externalDataRoot, "apps"));
        Directory.CreateDirectory(Path.Combine(externalDataRoot, "backups"));
        Directory.CreateDirectory(Path.Combine(externalDataRoot, "sources"));
        File.WriteAllText(Path.Combine(environment.BinDirectory, "hosty"), "binary");
        File.WriteAllText(Path.Combine(externalDataRoot, "apps.json"), "{}");
        File.WriteAllText(Path.Combine(externalDataRoot, "keep.txt"), "not owned by hosty");

        try
        {
            HostUninstallFileCleanup.Delete(environment, externalDataRoot, deleteData: true);

            Assert.True(File.Exists(Path.Combine(environment.BinDirectory, "hosty")));
            Assert.False(Directory.Exists(environment.ConfigDirectory));
            Assert.False(File.Exists(Path.Combine(externalDataRoot, "apps.json")));
            Assert.False(Directory.Exists(Path.Combine(externalDataRoot, "core")));
            Assert.False(Directory.Exists(Path.Combine(externalDataRoot, "apps")));
            Assert.False(Directory.Exists(Path.Combine(externalDataRoot, "backups")));
            Assert.False(Directory.Exists(Path.Combine(externalDataRoot, "sources")));
            Assert.True(File.Exists(Path.Combine(externalDataRoot, "keep.txt")));
        }
        finally
        {
            if (Directory.Exists(externalDataRoot))
            {
                Directory.Delete(externalDataRoot, recursive: true);
            }
        }
    }

    [Fact]
    public async Task ExecuteAsync_RemovesLocalStateWithoutDocker()
    {
        var environment = HostyEnvironment.Current();
        Directory.CreateDirectory(environment.BinDirectory);
        Directory.CreateDirectory(Path.Combine(environment.RootDirectory, "core"));
        File.WriteAllText(Path.Combine(environment.BinDirectory, "hosty"), "binary");
        var context = CreateContext(environment);

        var exitCode = await new UninstallCommand(context).ExecuteAsync(["--yes"]);

        Assert.Equal(0, exitCode);
        Assert.True(File.Exists(Path.Combine(environment.BinDirectory, "hosty")));
        Assert.False(Directory.Exists(Path.Combine(environment.RootDirectory, "core")));
    }

    [Fact]
    public async Task ExecuteAsync_WithConfiguredExternalDataRoot_DeletesResolvedDataRoot()
    {
        var environment = HostyEnvironment.Current();
        var externalDataRoot = Path.Combine(Path.GetTempPath(), $"hosty-data-exec-{Guid.NewGuid():N}");
        Directory.CreateDirectory(environment.BinDirectory);
        Directory.CreateDirectory(environment.ConfigDirectory);
        Directory.CreateDirectory(Path.Combine(externalDataRoot, "apps"));
        File.WriteAllText(Path.Combine(externalDataRoot, "apps.json"), "{}");
        // The data root lives in launch.env, not in RootDirectory — the command must resolve it.
        File.WriteAllText(environment.LaunchConfigPath, $"{LaunchSettingDefinitions.HostyDataRoot}={externalDataRoot}\n");
        var context = CreateContext(environment);

        try
        {
            var exitCode = await new UninstallCommand(context).ExecuteAsync(["--yes", "--delete-data"]);

            Assert.Equal(0, exitCode);
            Assert.False(File.Exists(Path.Combine(externalDataRoot, "apps.json")));
            Assert.False(Directory.Exists(Path.Combine(externalDataRoot, "apps")));
        }
        finally
        {
            if (Directory.Exists(externalDataRoot))
            {
                Directory.Delete(externalDataRoot, recursive: true);
            }
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
