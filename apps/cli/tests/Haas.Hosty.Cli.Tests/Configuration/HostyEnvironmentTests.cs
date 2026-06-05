using Haas.Hosty.Cli.Configuration;

namespace Haas.Hosty.Cli.Tests.Configuration;

public sealed class HostyEnvironmentTests : IDisposable
{
    private const string RootVariable = "HOSTY_HOME";
    private readonly string? previousRoot;

    public HostyEnvironmentTests()
    {
        previousRoot = Environment.GetEnvironmentVariable(RootVariable);
    }

    [Fact]
    public void Current_WhenHostyHomeIsSet_UsesOverrideRoot()
    {
        var rootDirectory = Path.Combine(Path.GetTempPath(), $"hosty-root-test-{Guid.NewGuid():N}");
        Environment.SetEnvironmentVariable(RootVariable, rootDirectory);

        var environment = HostyEnvironment.Current();

        Assert.Equal(Path.GetFullPath(rootDirectory), environment.RootDirectory);
        Assert.True(environment.HasRootOverride);
    }

    [Fact]
    public void Current_WhenHostyHomeIsUnset_UsesPreferredHostyRoot()
    {
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
    }
}
