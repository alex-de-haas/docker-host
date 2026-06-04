namespace Haas.DockerHost.Cli;

using Haas.DockerHost.Cli.Commands;
using Haas.DockerHost.Cli.Configuration;
using Spectre.Console;

public static class CommandLine
{
    public static Task<int> RunAsync(string[] args)
        => RunAsync(args, AnsiConsole.Console);

    internal static async Task<int> RunAsync(string[] args, IAnsiConsole console)
    {
        if (args is ["--version"] or ["-v"] or ["version"])
        {
            console.WriteLine(Version);
            return 0;
        }

        if (args.Length == 0 || args is ["--help"] or ["-h"] or ["help"])
        {
            WriteHelp(console);
            return 0;
        }

        var environment = DockerHostEnvironment.Current();
        var settingsStore = new LaunchSettingsStore(environment);
        var commandContext = new CommandContext(console, environment, settingsStore);

        try
        {
            return args[0] switch
            {
                "install" => await new InstallCommand(commandContext).ExecuteAsync(args[1..]),
                "uninstall" => await new UninstallCommand(commandContext).ExecuteAsync(args[1..]),
                "start" => await new CoreCommand(commandContext).ExecuteAsync(["start", .. args[1..]]),
                "stop" => await new CoreCommand(commandContext).ExecuteAsync(["stop", .. args[1..]]),
                "restart" => await new CoreCommand(commandContext).ExecuteAsync(["restart", .. args[1..]]),
                "update" => await new UpdateCommand(commandContext).ExecuteAsync(args[1..]),
                "status" => await new CoreCommand(commandContext).ExecuteAsync(["status", .. args[1..]]),
                "logs" => await new CoreCommand(commandContext).ExecuteAsync(["logs", .. args[1..]]),
                "open" => await new OpenCommand(commandContext).ExecuteAsync(args[1..]),
                "core" => await new CoreCommand(commandContext).ExecuteAsync(args[1..]),
                "config" => await new ConfigCommand(commandContext).ExecuteAsync(args[1..]),
                "apps" => await new AppsCommand(commandContext).ExecuteAsync(args[1..]),
                "users" => await new UsersCommand(commandContext).ExecuteAsync(args[1..]),
                "auth" => await new AuthCommand(commandContext).ExecuteAsync(args[1..]),
                _ => UnknownCommand(console, args[0]),
            };
        }
        catch (CommandUsageException ex)
        {
            console.MarkupLine($"[red]{Markup.Escape(ex.Message)}[/]");
            if (!string.IsNullOrWhiteSpace(ex.Usage))
            {
                console.WriteLine(ex.Usage);
            }

            return 2;
        }
        catch (ConfigurationException ex)
        {
            console.MarkupLine($"[red]{Markup.Escape(ex.Message)}[/]");
            return 2;
        }
        catch (OperationCanceledException)
        {
            console.MarkupLine("[yellow]Operation cancelled.[/]");
            return 130;
        }
    }

    public const string Version = "0.1.0";

    private static int UnknownCommand(IAnsiConsole console, string command)
    {
        console.MarkupLine($"[red]Unknown command:[/] {Markup.Escape(command)}");
        WriteHelp(console);
        return 2;
    }

    private static void WriteHelp(IAnsiConsole console)
    {
        console.WriteLine(HelpText);
    }

    public const string HelpText = """
        hosty

        Usage:
          hosty <command> [options]

        Commands:
          install
          uninstall
          start
          stop
          restart
          update
          status
          logs
          open
          core
          config
          apps
          users
          auth

        Compatibility:
          docker-host remains a deprecated command alias during migration.

        Run hosty config --help for configuration commands.
        Run hosty core --help for local Core process commands.
        Run hosty apps --help for app commands.
        Run hosty users --help for user commands.
        Run hosty auth --help for authentication commands.
        """;
}
