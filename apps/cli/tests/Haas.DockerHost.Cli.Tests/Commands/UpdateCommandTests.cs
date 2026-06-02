using Haas.DockerHost.Cli.Commands;
using Haas.DockerHost.Cli.Configuration;
using Haas.DockerHost.Cli.Docker;
using Haas.DockerHost.Cli.HostApi;
using Spectre.Console;

namespace Haas.DockerHost.Cli.Tests.Commands;

public sealed class UpdateCommandTests
{
    [Fact]
    public async Task ExecuteAsync_HostOnlyArgumentIsRejected()
    {
        var context = new CommandContext(
            CreateConsole(),
            DockerHostEnvironment.Current(),
            new LaunchSettingsStore(DockerHostEnvironment.Current()),
            new DockerEngineClientFactory(),
            new HostControlClientFactory());

        var exception = await Assert.ThrowsAsync<CommandUsageException>(
            async () => await new UpdateCommand(context).ExecuteAsync(["--host-only"]));

        Assert.Contains("hosty update [--list-channels]", exception.Usage);
    }

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
