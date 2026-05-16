namespace Haas.DockerHost.Cli;

using Haas.DockerHost.Cli.Commands;
using Haas.DockerHost.Cli.Configuration;
using Haas.DockerHost.Cli.Docker;
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
        var dockerFactory = new DockerEngineClientFactory();
        var commandContext = new CommandContext(console, environment, settingsStore, dockerFactory);

        try
        {
            return args[0] switch
            {
                "install" => await new InstallCommand(commandContext).ExecuteAsync(args[1..]),
                "uninstall" => await new UninstallCommand(commandContext).ExecuteAsync(args[1..]),
                "start" => await new StartCommand(commandContext).ExecuteAsync(args[1..]),
                "stop" => await new StopCommand(commandContext).ExecuteAsync(args[1..]),
                "restart" => await new RestartCommand(commandContext).ExecuteAsync(args[1..]),
                "update" => await new UpdateCommand(commandContext).ExecuteAsync(args[1..]),
                "status" => await new StatusCommand(commandContext).ExecuteAsync(args[1..]),
                "logs" => await new LogsCommand(commandContext).ExecuteAsync(args[1..]),
                "open" => await new OpenCommand(commandContext).ExecuteAsync(args[1..]),
                "config" => await new ConfigCommand(commandContext).ExecuteAsync(args[1..]),
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
        catch (DockerEngineException ex)
        {
            WriteDockerError(console, ex);
            return 1;
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

    private static void WriteDockerError(IAnsiConsole console, DockerEngineException ex)
    {
        console.MarkupLine($"[red]Docker operation failed:[/] {Markup.Escape(ex.Operation)}");
        console.MarkupLine($"[grey]Error:[/] {Markup.Escape(ex.Message)}");

        if (ex.StatusCode is not null)
        {
            console.MarkupLine($"[grey]HTTP status:[/] {(int)ex.StatusCode} {ex.StatusCode}");
        }

        if (!string.IsNullOrWhiteSpace(ex.DockerMessage))
        {
            console.MarkupLine($"[grey]Docker message:[/] {Markup.Escape(ex.DockerMessage)}");
        }

        if (!string.IsNullOrWhiteSpace(ex.NextStep))
        {
            console.MarkupLine($"[grey]Next step:[/] {Markup.Escape(ex.NextStep)}");
        }
    }

    private static void WriteHelp(IAnsiConsole console)
    {
        console.WriteLine(HelpText);
    }

    public const string HelpText = """
        docker-host

        Usage:
          docker-host <command> [options]

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
          config

        Run docker-host config --help for configuration commands.
        """;
}
