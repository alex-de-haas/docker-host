using Haas.Hosty.Cli.Configuration;

namespace Haas.Hosty.Cli.Tests.Configuration;

public sealed class HostyEnvironmentTests : IDisposable
{
    private const string RootVariable = "HOSTY_HOME";
    private const string DataRootVariable = "HOSTY_DATA_ROOT";
    private readonly string? previousRoot;
    private readonly string? previousDataRoot;

    public HostyEnvironmentTests()
    {
        previousRoot = Environment.GetEnvironmentVariable(RootVariable);
        previousDataRoot = Environment.GetEnvironmentVariable(DataRootVariable);
    }

    [Fact]
    public void Current_DataRootOverrideBeatsEveryEnvironmentVariable()
    {
        // The global --data-root flag lands here; it outranks both env vars.
        var flagRoot = Path.Combine(Path.GetTempPath(), $"hosty-flag-root-{Guid.NewGuid():N}");
        Environment.SetEnvironmentVariable(DataRootVariable, Path.Combine(Path.GetTempPath(), "hosty-env-root"));
        Environment.SetEnvironmentVariable(RootVariable, Path.Combine(Path.GetTempPath(), "hosty-home-root"));

        var environment = HostyEnvironment.Current(flagRoot);

        Assert.Equal(Path.GetFullPath(flagRoot), environment.RootDirectory);
        Assert.True(environment.HasRootOverride);
    }

    [Fact]
    public void Current_HostyDataRootBeatsTheLegacyHostyHome()
    {
        var dataRoot = Path.Combine(Path.GetTempPath(), $"hosty-data-root-{Guid.NewGuid():N}");
        Environment.SetEnvironmentVariable(DataRootVariable, dataRoot);
        Environment.SetEnvironmentVariable(RootVariable, Path.Combine(Path.GetTempPath(), "hosty-home-root"));

        var environment = HostyEnvironment.Current();

        Assert.Equal(Path.GetFullPath(dataRoot), environment.RootDirectory);
    }

    [Fact]
    public void Current_WhenHostyHomeIsSet_UsesOverrideRoot()
    {
        var rootDirectory = Path.Combine(Path.GetTempPath(), $"hosty-root-test-{Guid.NewGuid():N}");
        Environment.SetEnvironmentVariable(DataRootVariable, null);
        Environment.SetEnvironmentVariable(RootVariable, rootDirectory);

        var environment = HostyEnvironment.Current();

        Assert.Equal(Path.GetFullPath(rootDirectory), environment.RootDirectory);
        Assert.True(environment.HasRootOverride);
    }

    [Fact]
    public void Current_WhenHostyHomeIsUnset_UsesPreferredHostyRoot()
    {
        Environment.SetEnvironmentVariable(DataRootVariable, null);
        Environment.SetEnvironmentVariable(RootVariable, null);

        var environment = HostyEnvironment.Current();

        Assert.Equal(environment.PreferredRootDirectory, environment.RootDirectory);
        Assert.False(environment.HasRootOverride);
        Assert.EndsWith($"{Path.DirectorySeparatorChar}.hosty", environment.RootDirectory);
    }

    [Fact]
    public void ResolvePath_ExpandsHomeTokens()
    {
        var rootDirectory = Path.Combine(Path.GetTempPath(), $"hosty-root-test-{Guid.NewGuid():N}");
        Environment.SetEnvironmentVariable(RootVariable, rootDirectory);
        var environment = HostyEnvironment.Current();

        var resolved = environment.ResolvePath("~/apps");

        Assert.Equal(Path.Combine(environment.HomeDirectory, "apps"), resolved);
    }

    public void Dispose()
    {
        Environment.SetEnvironmentVariable(RootVariable, previousRoot);
        Environment.SetEnvironmentVariable(DataRootVariable, previousDataRoot);
    }
}
