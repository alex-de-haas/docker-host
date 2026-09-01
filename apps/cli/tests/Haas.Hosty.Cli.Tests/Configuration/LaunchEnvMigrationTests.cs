using System.Text.Json;
using Haas.Hosty.Cli.Configuration;

namespace Haas.Hosty.Cli.Tests.Configuration;

public sealed class LaunchEnvMigrationTests : IDisposable
{
    private const string RootVariable = "HOSTY_HOME";
    private readonly string? previousRoot;
    private readonly string rootDirectory;

    public LaunchEnvMigrationTests()
    {
        previousRoot = Environment.GetEnvironmentVariable(RootVariable);
        rootDirectory = Path.Combine(Path.GetTempPath(), $"hosty-launch-env-migration-tests-{Guid.NewGuid():N}");
        Environment.SetEnvironmentVariable(RootVariable, rootDirectory);
    }

    [Fact]
    public void Run_WithoutLaunchEnv_IsSilent()
        => Assert.Empty(LaunchEnvMigration.Run(HostyEnvironment.Current()));

    [Fact]
    public void Run_FoldsANonDefaultPortIntoThePerRootStoreAndDeletesTheFile()
    {
        var environment = HostyEnvironment.Current();
        WriteLaunchEnv(environment, "HOSTY_CORE_PORT=7171\n");

        var notices = LaunchEnvMigration.Run(environment);

        // The port landed in the store Core reads at startup…
        var settingsPath = Path.Combine(environment.RootDirectory, "core", "settings.json");
        using var document = JsonDocument.Parse(File.ReadAllText(settingsPath));
        Assert.Equal("core-settings.0.1", document.RootElement.GetProperty("schemaVersion").GetString());
        Assert.Equal("7171", document.RootElement.GetProperty("server").GetProperty("HOSTY_CORE_PORT").GetString());
        // …and the legacy file is gone (read-and-delete).
        Assert.False(File.Exists(environment.LaunchConfigPath));
        Assert.Contains(notices, notice => notice.Contains("HOSTY_CORE_PORT=7171"));
        Assert.Contains(notices, notice => notice.Contains("hosty core settings set"));
    }

    [Fact]
    public void Run_MergesIntoAnExistingSettingsFileWithoutDisturbingOtherGroups()
    {
        var environment = HostyEnvironment.Current();
        var coreRoot = Path.Combine(environment.RootDirectory, "core");
        Directory.CreateDirectory(coreRoot);
        File.WriteAllText(
            Path.Combine(coreRoot, "settings.json"),
            """{"schemaVersion":"core-settings.0.1","ingress":{"HOSTY_INGRESS_PROVIDER":"cloudflared"}}""");
        WriteLaunchEnv(environment, "HOSTY_CORE_PORT=7171\n");

        LaunchEnvMigration.Run(environment);

        using var document = JsonDocument.Parse(File.ReadAllText(Path.Combine(coreRoot, "settings.json")));
        Assert.Equal("cloudflared", document.RootElement.GetProperty("ingress").GetProperty("HOSTY_INGRESS_PROVIDER").GetString());
        Assert.Equal("7171", document.RootElement.GetProperty("server").GetProperty("HOSTY_CORE_PORT").GetString());
    }

    [Fact]
    public void Run_DefaultPortIsNotWorthAStoreEntry()
    {
        var environment = HostyEnvironment.Current();
        WriteLaunchEnv(environment, "HOSTY_CORE_PORT=7070\nHOSTY_DATA_ROOT=$HOME/.hosty\n");

        var notices = LaunchEnvMigration.Run(environment);

        Assert.False(File.Exists(Path.Combine(environment.RootDirectory, "core", "settings.json")));
        Assert.False(File.Exists(environment.LaunchConfigPath));
        // Defaults all around: the only notice is the removal itself.
        Assert.Contains(notices, notice => notice.Contains("Removed the legacy launch config"));
        Assert.DoesNotContain(notices, notice => notice.Contains("--data-root"));
    }

    [Fact]
    public void Run_NonDefaultDataRoot_PrintsThePointerNoticeAndFoldsThePortIntoThatRoot()
    {
        var environment = HostyEnvironment.Current();
        var externalRoot = Path.Combine(Path.GetTempPath(), $"hosty-migrated-root-{Guid.NewGuid():N}");
        WriteLaunchEnv(environment, $"HOSTY_DATA_ROOT={externalRoot}\nHOSTY_CORE_PORT=7171\n");

        try
        {
            var notices = LaunchEnvMigration.Run(environment);

            // The pointer cannot live inside the root it points to, so it becomes a notice…
            Assert.Contains(notices, notice =>
                notice.Contains("--data-root") && notice.Contains(Path.GetFullPath(externalRoot)));
            // …and the port belongs to THAT root's store.
            var settingsPath = Path.Combine(Path.GetFullPath(externalRoot), "core", "settings.json");
            using var document = JsonDocument.Parse(File.ReadAllText(settingsPath));
            Assert.Equal("7171", document.RootElement.GetProperty("server").GetProperty("HOSTY_CORE_PORT").GetString());
            Assert.False(File.Exists(environment.LaunchConfigPath));
        }
        finally
        {
            if (Directory.Exists(externalRoot))
            {
                Directory.Delete(externalRoot, recursive: true);
            }
        }
    }

    [Fact]
    public void Run_PublicOrigin_IsEchoedAsAPlainEnvVarNotice()
    {
        var environment = HostyEnvironment.Current();
        WriteLaunchEnv(environment, "HOSTY_CORE_PUBLIC_ORIGIN=https://core.example\n");

        var notices = LaunchEnvMigration.Run(environment);

        Assert.Contains(notices, notice =>
            notice.Contains("HOSTY_CORE_PUBLIC_ORIGIN=https://core.example") &&
            notice.Contains("environment variable"));
        Assert.False(File.Exists(environment.LaunchConfigPath));
    }

    private static void WriteLaunchEnv(HostyEnvironment environment, string content)
    {
        Directory.CreateDirectory(environment.ConfigDirectory);
        File.WriteAllText(environment.LaunchConfigPath, "# hosty launch settings\n" + content);
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
