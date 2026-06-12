namespace Haas.Hosty.Cli;

using System.Reflection;
using Haas.Hosty.Cli.Commands;
using Haas.Hosty.Cli.Configuration;
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

        var environment = HostyEnvironment.Current();
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
        catch (CoreControlException ex)
        {
            console.MarkupLine($"[red]Hosty Core API failed:[/] {Markup.Escape(ex.Message)}");
            if (!string.IsNullOrWhiteSpace(ex.ResponseBody))
            {
                console.MarkupLine($"[grey]Response:[/] {Markup.Escape(ex.ResponseBody)}");
            }

            return 1;
        }
        catch (CoreControlTimeoutException ex)
        {
            console.MarkupLine($"[red]Hosty Core did not respond in time:[/] {Markup.Escape(ex.Message)}");
            console.MarkupLine("[grey]The operation may still be running in Hosty Core. Check it with [white]hosty core status[/] and [white]hosty apps list[/].[/]");
            return 1;
        }
        catch (Exception ex) when (ex is HttpRequestException or IOException or TaskCanceledException)
        {
            console.MarkupLine($"[red]Unable to reach Hosty Core:[/] {Markup.Escape(ex.Message)}");
            return 1;
        }
        catch (OperationCanceledException)
        {
            console.MarkupLine("[yellow]Operation cancelled.[/]");
            return 130;
        }
    }

    public static string Version { get; } = ResolveVersion(
        typeof(CommandLine).Assembly.GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion);

    internal static string ResolveVersion(string? informationalVersion)
    {
        if (string.IsNullOrWhiteSpace(informationalVersion))
        {
            return "0.0.0";
        }

        var metadataSeparator = informationalVersion.IndexOf('+', StringComparison.Ordinal);
        return metadataSeparator < 0 ? informationalVersion : informationalVersion[..metadataSeparator];
    }

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

        Run hosty config --help for configuration commands.
        Run hosty core --help for local Core process commands.
        Run hosty apps --help for app commands.
        Run hosty users --help for user commands.
        Run hosty auth --help for authentication commands.
        """;
}
