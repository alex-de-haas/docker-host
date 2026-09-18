using Haas.Hosty.Core;
using Haas.Hosty.Launch;

namespace Haas.Hosty.Core.Tests;

[CollectionDefinition("CliPathMutation", DisableParallelization = true)]
public sealed class CliPathMutationCollection;

[Collection("CliPathMutation")]
public sealed class CoreManageabilityTests
{
    [Theory]
    [InlineData("dev", false, false)]
    [InlineData("release", false, false)]
    [InlineData("dev", true, true)]
    [InlineData("release", true, true)]
    [InlineData("unmanaged", true, false)]
    public async Task ManageabilityRequiresBothManagedModeAndAvailableCli(string mode, bool cliAvailable, bool expected)
    {
        var root = Path.Combine(Path.GetTempPath(), "hosty-manageability-" + Guid.NewGuid().ToString("N"));
        var previousCli = Environment.GetEnvironmentVariable("HOSTY_CLI_PATH");
        var previousPath = Environment.GetEnvironmentVariable("PATH");
        Directory.CreateDirectory(root);
        try
        {
            var cli = Path.Combine(root, "hosty-fixture");
            if (cliAvailable) File.WriteAllText(cli, "fixture");
            Environment.SetEnvironmentVariable("HOSTY_CLI_PATH", cli);
            Environment.SetEnvironmentVariable("PATH", root);
            var config = new HostyCoreRuntimeConfig(root, Path.Combine(root, "run"), Path.Combine(root, "run", "control.json"),
                7070, "http://localhost:7070", null, "localhost", null, false);
            var service = new CoreDevelopmentService(config, new CoreLaunchIdentity(mode, null, null, 4321, DateTimeOffset.UtcNow));
            Assert.Equal(expected, (await service.GetAsync()).Manageable);
        }
        finally
        {
            Environment.SetEnvironmentVariable("HOSTY_CLI_PATH", previousCli);
            Environment.SetEnvironmentVariable("PATH", previousPath);
            Directory.Delete(root, true);
        }
    }
}
