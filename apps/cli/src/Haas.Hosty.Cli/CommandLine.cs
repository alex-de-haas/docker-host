namespace Haas.Hosty.Cli;

using System.Reflection;
using System.Text.Json;
using Haas.Hosty.Cli.Commands;
using Haas.Hosty.Cli.Configuration;
using Spectre.Console;

public static class CommandLine
{
    public static Task<int> RunAsync(string[] args)
        => RunAsync(args, AnsiConsole.Console, CreateErrorConsole());

    internal static Task<int> RunAsync(string[] args, IAnsiConsole console)
        => RunAsync(args, console, console);

    internal static async Task<int> RunAsync(string[] args, IAnsiConsole console, IAnsiConsole error)
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
        var commandContext = new CommandContext(console, environment, settingsStore, error);

        try
        {
            return args[0] switch
            {
                "install" => await new InstallCommand(commandContext).ExecuteAsync(args[1..]),
                "setup" => await new SetupCommand(commandContext).ExecuteAsync(args[1..]),
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
                "storage" => await new StorageCommand(commandContext).ExecuteAsync(args[1..]),
                "users" => await new UsersCommand(commandContext).ExecuteAsync(args[1..]),
                "auth" => await new AuthCommand(commandContext).ExecuteAsync(args[1..]),
                _ => UnknownCommand(error, args[0]),
            };
        }
        catch (CommandUsageException ex)
        {
            error.MarkupLine($"[red]{Markup.Escape(ex.Message)}[/]");
            if (!string.IsNullOrWhiteSpace(ex.Usage))
            {
                error.WriteLine(ex.Usage);
            }

            return 2;
        }
        catch (ConfigurationException ex)
        {
            error.MarkupLine($"[red]{Markup.Escape(ex.Message)}[/]");
            return 2;
        }
        catch (CoreNotRunningException ex)
        {
            // A down Core is an environment state, not a bad invocation — clean message + exit 1 so
            // scripts don't misclassify it as a usage error (exit 2).
            error.MarkupLine($"[red]{Markup.Escape(ex.Message)}[/]");
            error.MarkupLine("Run [grey]hosty core start[/] first.");
            return 1;
        }
        catch (CoreControlException ex)
        {
            error.MarkupLine($"[red]Hosty Core API failed:[/] {Markup.Escape(ex.Message)}");
            if (!string.IsNullOrWhiteSpace(ex.ResponseBody))
            {
                error.MarkupLine($"[grey]Response:[/] {Markup.Escape(ex.ResponseBody)}");
            }

            return 1;
        }
        catch (CoreControlTimeoutException ex)
        {
            error.MarkupLine($"[red]Hosty Core did not respond in time:[/] {Markup.Escape(ex.Message)}");
            error.MarkupLine("[grey]The operation may still be running in Hosty Core. Check it with [white]hosty core status[/] and [white]hosty apps list[/].[/]");
            return 1;
        }
        catch (JsonException ex)
        {
            // A half-started Core, or an older-schema control.json, can return a body that does not
            // deserialize. Surface a clean message instead of a raw stack-trace dump.
            error.MarkupLine("[red]Hosty Core returned an invalid response.[/]");
            error.MarkupLine($"[grey]{Markup.Escape(ex.Message)}[/]");
            return 1;
        }
        catch (Exception ex) when (ex is HttpRequestException or IOException or TaskCanceledException)
        {
            error.MarkupLine($"[red]Unable to reach Hosty Core:[/] {Markup.Escape(ex.Message)}");
            return 1;
        }
        catch (OperationCanceledException)
        {
            error.MarkupLine("[yellow]Operation cancelled.[/]");
            return 130;
        }
    }

    private static IAnsiConsole CreateErrorConsole()
        => AnsiConsole.Create(new AnsiConsoleSettings
        {
            Out = new AnsiConsoleOutput(System.Console.Error),
        });

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

    private static int UnknownCommand(IAnsiConsole error, string command)
    {
        error.MarkupLine($"[red]Unknown command:[/] {Markup.Escape(command)}");
        WriteHelp(error);
        return 2;
    }

    private static void WriteHelp(IAnsiConsole console)
    {
        console.MarkupLine("[bold]hosty[/] — manage Hosty Core, Shell, and apps");
        console.WriteLine();
        console.MarkupLine("[grey]Usage:[/] hosty <command> [[options]]");
        console.WriteLine();

        WriteCommandGroup(console, "Lifecycle",
        [
            ("install", "Install Hosty Core and Shell"),
            ("setup", "Choose which optional apps Core preinstalls"),
            ("uninstall", "Uninstall Hosty (optionally delete data)"),
            ("start", "Start the local Hosty Core process"),
            ("stop", "Stop the local Hosty Core process"),
            ("restart", "Restart the local Hosty Core process"),
            ("update", "Update the CLI, Core, and Shell"),
            ("status", "Show Hosty Core status"),
            ("logs", "Tail Hosty Core logs"),
        ]);

        WriteCommandGroup(console, "Apps & users",
        [
            ("apps", "Install, update, back up, and inspect apps"),
            ("storage", "Manage shared host-path mounts"),
            ("users", "List app users"),
            ("auth", "Create setup and recovery tokens"),
            ("open", "Open Hosty Shell in the browser"),
        ]);

        WriteCommandGroup(console, "Configuration",
        [
            ("config", "Read and write launch settings"),
            ("core", "Manage the local Core process directly"),
        ]);

        console.MarkupLine("Run [grey]hosty <command> --help[/] for command-specific options.");
    }

    private static void WriteCommandGroup(
        IAnsiConsole console,
        string title,
        (string Command, string Description)[] commands)
    {
        console.MarkupLine($"[bold]{title}[/]");
        var grid = new Grid();
        grid.AddColumn(new GridColumn().PadLeft(2).PadRight(2));
        grid.AddColumn();
        foreach (var (command, description) in commands)
        {
            grid.AddRow($"[green]{command}[/]", $"[grey]{Markup.Escape(description)}[/]");
        }

        console.Write(grid);
        console.WriteLine();
    }
}
