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
    public void Run_PointerAtAThirdRootUnderAnExplicitTarget_IsNotThisInvocationsToMigrate()
    {
        // The operator explicitly targeted THIS root; the file's pointer names another
        // installation. Migrating (or deleting) it here would act on the wrong root, so the file
        // is left exactly as it was.
        var environment = HostyEnvironment.Current();
        var externalRoot = Path.Combine(Path.GetTempPath(), $"hosty-migrated-root-{Guid.NewGuid():N}");
        WriteLaunchEnv(environment, $"HOSTY_DATA_ROOT={externalRoot}\nHOSTY_CORE_PORT=7171\n");

        var notices = LaunchEnvMigration.Run(environment);

        Assert.Empty(notices);
        Assert.True(File.Exists(environment.LaunchConfigPath));
        Assert.False(Directory.Exists(externalRoot));
    }

    [Fact]
    public void Run_PointerAtAnotherRootOnADefaultInvocation_AbortsAndKeepsTheFile()
    {
        if (OperatingSystem.IsWindows())
        {
            // GetFolderPath(UserProfile) ignores a faked HOME on Windows, so a default-root
            // invocation cannot be simulated there; the branch itself is platform-neutral.
            return;
        }

        // A bare invocation lands on the default root only because nothing selected one; the
        // legacy pointer says the installation lives elsewhere. Acting would hit the wrong root
        // and deleting the pointer would erase the only record of the right one — so the command
        // must stop, keep the file, and say how to rerun.
        var previousHome = Environment.GetEnvironmentVariable("HOME");
        var home = Path.Combine(Path.GetTempPath(), $"hosty-fake-home-{Guid.NewGuid():N}");
        Environment.SetEnvironmentVariable(RootVariable, null);
        Environment.SetEnvironmentVariable("HOME", home);
        try
        {
            var environment = HostyEnvironment.Current();
            var legacyRoot = Path.Combine(Path.GetTempPath(), $"hosty-legacy-root-{Guid.NewGuid():N}");
            WriteLaunchEnv(environment, $"HOSTY_DATA_ROOT={legacyRoot}\nHOSTY_CORE_PORT=7171\n");

            var exception = Assert.Throws<ConfigurationException>(() => LaunchEnvMigration.Run(environment));

            Assert.Contains(legacyRoot, exception.Message);
            Assert.Contains("--data-root", exception.Message);
            Assert.True(File.Exists(environment.LaunchConfigPath));
            Assert.False(Directory.Exists(legacyRoot));
        }
        finally
        {
            Environment.SetEnvironmentVariable("HOME", previousHome);
            Environment.SetEnvironmentVariable(RootVariable, rootDirectory);
            if (Directory.Exists(home))
            {
                Directory.Delete(home, recursive: true);
            }
        }
    }

    [Fact]
    public void Run_PointerAtTheExplicitlyTargetedRoot_FoldsThereAndRemindsToExport()
    {
        // The operator followed the abort instructions: the explicit target IS the pointer's
        // root. The port folds into that root's store, the file goes, and — since the pointer was
        // the only thing selecting this root — the operator is reminded to keep selecting it.
        var environment = HostyEnvironment.Current();
        WriteLaunchEnv(environment, $"HOSTY_DATA_ROOT={environment.RootDirectory}\nHOSTY_CORE_PORT=7171\n");

        var notices = LaunchEnvMigration.Run(environment);

        var settingsPath = Path.Combine(environment.RootDirectory, "core", "settings.json");
        using var document = JsonDocument.Parse(File.ReadAllText(settingsPath));
        Assert.Equal("7171", document.RootElement.GetProperty("server").GetProperty("HOSTY_CORE_PORT").GetString());
        Assert.False(File.Exists(environment.LaunchConfigPath));
        Assert.Contains(notices, notice =>
            notice.Contains("--data-root") && notice.Contains("HOSTY_DATA_ROOT"));
    }

    [Fact]
    public void Run_PublicOrigin_IsFoldedIntoTheStoreInCanonicalForm()
    {
        // The regression this replaces: an earlier revision only echoed the value and deleted the
        // file with it, so Core fell back to its listen URL and handed http://localhost:7070 to every
        // app — Shell's browser dialled loopback and sign-in links left the machine unreachable.
        var environment = HostyEnvironment.Current();
        WriteLaunchEnv(environment, "HOSTY_CORE_PUBLIC_ORIGIN=  HTTPS://Core.Example/  \n");

        var notices = LaunchEnvMigration.Run(environment);

        var settingsPath = Path.Combine(environment.RootDirectory, "core", "settings.json");
        using var document = JsonDocument.Parse(File.ReadAllText(settingsPath));
        Assert.Equal(
            "https://core.example",
            document.RootElement.GetProperty("server").GetProperty("HOSTY_CORE_PUBLIC_ORIGIN").GetString());
        Assert.False(File.Exists(environment.LaunchConfigPath));
        Assert.Contains(notices, notice => notice.Contains("HOSTY_CORE_PUBLIC_ORIGIN=https://core.example"));
    }

    [Fact]
    public void Run_PortAndOriginTogether_BothLandInOneWrite()
    {
        var environment = HostyEnvironment.Current();
        WriteLaunchEnv(environment, "HOSTY_CORE_PORT=7171\nHOSTY_CORE_PUBLIC_ORIGIN=https://core.example\n");

        LaunchEnvMigration.Run(environment);

        using var document = JsonDocument.Parse(
            File.ReadAllText(Path.Combine(environment.RootDirectory, "core", "settings.json")));
        var server = document.RootElement.GetProperty("server");
        Assert.Equal("7171", server.GetProperty("HOSTY_CORE_PORT").GetString());
        Assert.Equal("https://core.example", server.GetProperty("HOSTY_CORE_PUBLIC_ORIGIN").GetString());
        Assert.False(File.Exists(environment.LaunchConfigPath));
    }

    [Fact]
    public void Run_ValueTheStoreAlreadyHas_IsNotOverwritten()
    {
        // The operator set it after the fact — quite possibly to recover from the loss above — so
        // that choice is newer than the retired file's and wins.
        var environment = HostyEnvironment.Current();
        var coreRoot = Path.Combine(environment.RootDirectory, "core");
        Directory.CreateDirectory(coreRoot);
        File.WriteAllText(
            Path.Combine(coreRoot, "settings.json"),
            """{"schemaVersion":"core-settings.0.1","server":{"HOSTY_CORE_PUBLIC_ORIGIN":"https://new.example"}}""");
        WriteLaunchEnv(environment, "HOSTY_CORE_PUBLIC_ORIGIN=https://old.example\n");

        var notices = LaunchEnvMigration.Run(environment);

        using var document = JsonDocument.Parse(File.ReadAllText(Path.Combine(coreRoot, "settings.json")));
        Assert.Equal(
            "https://new.example",
            document.RootElement.GetProperty("server").GetProperty("HOSTY_CORE_PUBLIC_ORIGIN").GetString());
        Assert.Contains(notices, notice => notice.Contains("already has a value"));
        Assert.False(File.Exists(environment.LaunchConfigPath));
    }

    [Theory]
    [InlineData("https://core.example/path")]
    [InlineData("http://user:pw@core.example")]
    [InlineData("http://0.0.0.0:7070")]
    [InlineData("not-a-url")]
    public void Run_UnusableOrigin_KeepsTheFileAndSaysSo(string origin)
    {
        // Silently dropping the value an operator signs in through is what caused the outage this
        // fix exists for; an unusable one keeps the file as the record of it.
        var environment = HostyEnvironment.Current();
        WriteLaunchEnv(environment, $"HOSTY_CORE_PUBLIC_ORIGIN={origin}\n");

        var notices = LaunchEnvMigration.Run(environment);

        Assert.True(File.Exists(environment.LaunchConfigPath));
        Assert.False(File.Exists(Path.Combine(environment.RootDirectory, "core", "settings.json")));
        Assert.Contains(notices, notice => notice.Contains("not a usable origin"));
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
