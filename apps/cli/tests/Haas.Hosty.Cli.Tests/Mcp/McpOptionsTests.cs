namespace Haas.Hosty.Cli.Tests.Mcp;

using Haas.Hosty.Cli;
using Haas.Hosty.Cli.Commands;
using Haas.Hosty.Cli.Mcp;
using Spectre.Console;

// Argument handling, including the help path the root command advertises.
public class McpOptionsTests
{
    [Fact]
    public async Task HelpIsAnsweredRatherThanRejectedAsAnUnknownArgument()
    {
        // `hosty --help` tells the operator to run `hosty <command> --help`, so this has to work; it
        // used to fall through to the unknown-argument branch and exit 2.
        foreach (var form in new[] { "--help", "-h", "help" })
        {
            var output = new StringWriter();
            var exit = await CommandLine.RunAsync(["mcp", form], AnsiConsole.Create(new AnsiConsoleSettings
            {
                Out = new AnsiConsoleOutput(output),
                Interactive = InteractionSupport.No,
            }));

            Assert.Equal(0, exit);
            Assert.Contains("--user", output.ToString(), StringComparison.Ordinal);
        }
    }

    [Fact]
    public void TheActorIsRequiredAndTheMessageSaysWhy()
    {
        // There is nothing to default it to, and an operator hitting this needs to know that rather
        // than assume the flag is optional.
        var error = Assert.Throws<CommandUsageException>(() => McpCommand.ParseOptions([]));

        Assert.Contains("identifies no user", error.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void ARemoteContextIsRefusedAndPointedAtTheAlternative()
    {
        // The CLI is local-only by decision, not by omission, so this is not a feature pending
        // arrival. Accepting the flag and talking to the local host anyway would let someone believe
        // they were reaching a remote one; refusing without naming SSH would leave them stuck.
        var error = Assert.Throws<CommandUsageException>(
            () => McpCommand.ParseOptions(["--user", "a@b.test", "--context", "prod"]));

        Assert.Contains("local-only", error.Message, StringComparison.Ordinal);
        Assert.Contains("ssh", error.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void TheNameCeilingIsParsedAndBounded()
    {
        Assert.Equal(40, McpCommand.ParseOptions(["--user", "a@b.test", "--max-tool-name", "40"]).MaxToolNameChars);
        Assert.Equal(
            ToolKey.DefaultMaxToolNameChars,
            McpCommand.ParseOptions(["--user", "a@b.test"]).MaxToolNameChars);
        // A ceiling under the key width alone would export nothing at all, which is worse than an error.
        Assert.Throws<CommandUsageException>(
            () => McpCommand.ParseOptions(["--user", "a@b.test", "--max-tool-name", "4"]));
    }
}
