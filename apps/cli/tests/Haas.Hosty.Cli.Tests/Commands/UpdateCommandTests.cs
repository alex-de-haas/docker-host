using Haas.Hosty.Cli.Commands;
using Haas.Hosty.Cli.Configuration;
using Spectre.Console;

namespace Haas.Hosty.Cli.Tests.Commands;

public sealed class UpdateCommandTests
{
    [Fact]
    public async Task ExecuteAsync_HostOnlyArgumentIsRejected()
    {
        var context = new CommandContext(
            CreateConsole(),
            HostyEnvironment.Current(),
            new LaunchSettingsStore(HostyEnvironment.Current()));

        var exception = await Assert.ThrowsAsync<CommandUsageException>(
            async () => await new UpdateCommand(context).ExecuteAsync(["--host-only"]));

        Assert.Contains("hosty update [--list-channels]", exception.Usage);
    }

    [Fact]
    public void NormalizeManifestReference_TrimsUrlAndLocalPathValues()
    {
        Assert.Equal(
            "https://raw.githubusercontent.com/example/shell/main/manifest.json",
            UpdateCommand.NormalizeManifestReference(" https://raw.githubusercontent.com/example/shell/main/manifest.json "));
        Assert.Equal(
            Path.GetFullPath("apps/shell/manifest.json"),
            UpdateCommand.NormalizeManifestReference(" apps/shell/manifest.json "));
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
