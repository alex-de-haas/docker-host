namespace Haas.DockerHost.Cli.Commands;

using Spectre.Console;

internal sealed class AuthCommand(CommandContext context)
{
    private const string Usage = """
        Usage:
          hosty auth setup-token
          hosty auth recovery-token

        Commands:
          setup-token    Reserved for Core-compatible first-administrator bootstrap.
          recovery-token Reserved for Core-compatible local administrator recovery.
        """;

    public Task<int> ExecuteAsync(string[] args)
    {
        if (args.Length == 0 || args is ["--help"] or ["-h"] or ["help"])
        {
            context.Console.WriteLine(Usage);
            return Task.FromResult(0);
        }

        return args[0] switch
        {
            "setup-token" => ExecuteUnavailableAsync(args[1..], "auth setup-token does not accept arguments.", "Usage: hosty auth setup-token"),
            "recovery-token" => ExecuteUnavailableAsync(args[1..], "auth recovery-token does not accept arguments.", "Usage: hosty auth recovery-token"),
            _ => throw new CommandUsageException($"Unknown auth command '{args[0]}'.", Usage),
        };
    }

    private Task<int> ExecuteUnavailableAsync(string[] args, string usageError, string usage)
    {
        if (args.Length > 0)
        {
            throw new CommandUsageException(usageError, usage);
        }

        context.Console.MarkupLine("[yellow]Core-compatible auth bootstrap is not implemented by this command yet.[/]");
        context.Console.MarkupLine("[grey]The retired Legacy Host auth state writer was removed because Core uses core/auth/state.json with a different schema.[/]");
        return Task.FromResult(1);
    }
}
