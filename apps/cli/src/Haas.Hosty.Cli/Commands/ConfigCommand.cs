namespace Haas.Hosty.Cli.Commands;

using Haas.Hosty.Cli.Configuration;
using Spectre.Console;

internal sealed class ConfigCommand(CommandContext context)
{
    private const string Usage = """
        Usage:
          hosty config list
          hosty config get <KEY>
          hosty config set <KEY> <VALUE>
          hosty config set <KEY>=<VALUE>
          hosty config reset <KEY>
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
            "list" => Task.FromResult(List()),
            "get" => Task.FromResult(Get(args[1..])),
            "set" => Task.FromResult(Set(args[1..])),
            "reset" => Task.FromResult(Reset(args[1..])),
            _ => throw new CommandUsageException($"Unknown config command '{args[0]}'.", Usage),
        };
    }

    private int List()
    {
        var settings = context.SettingsStore.EnsureInstalled();
        var table = ConsoleUi.CreateTable("Key", "Value", "Editable");

        foreach (var definition in LaunchSettingDefinitions.All)
        {
            table.AddRow(
                definition.IsDeprecated
                    ? $"{Markup.Escape(definition.Key)} [grey](deprecated)[/]"
                    : Markup.Escape(definition.Key),
                Markup.Escape(settings[definition.Key]),
                ConsoleUi.YesNo(definition.IsEditable));
        }

        context.Console.Write(table);
        return 0;
    }

    private int Get(string[] args)
    {
        if (args.Length != 1)
        {
            throw new CommandUsageException("config get requires exactly one KEY.", Usage);
        }

        var key = args[0];
        LaunchSettingDefinitions.Get(key);
        context.Console.WriteLine(context.SettingsStore.Load()[key]);
        return 0;
    }

    private int Set(string[] args)
    {
        if (args.Length == 1)
        {
            var separator = args[0].IndexOf('=', StringComparison.Ordinal);
            if (separator <= 0)
            {
                throw new CommandUsageException("config set requires KEY VALUE or KEY=VALUE.", Usage);
            }

            context.SettingsStore.Set(args[0][..separator], args[0][(separator + 1)..]);
            WarnWhenDeprecated(args[0][..separator]);
            return 0;
        }

        if (args.Length != 2)
        {
            throw new CommandUsageException("config set requires KEY VALUE or KEY=VALUE.", Usage);
        }

        context.SettingsStore.Set(args[0], args[1]);
        WarnWhenDeprecated(args[0]);
        return 0;
    }

    private int Reset(string[] args)
    {
        if (args.Length != 1)
        {
            throw new CommandUsageException("config reset requires exactly one KEY.", Usage);
        }

        context.SettingsStore.Reset(args[0]);
        return 0;
    }

    // Deprecated bootstrap overrides keep working for one release, but the operator should hear
    // about the replacement at the moment they reach for the old knob.
    private void WarnWhenDeprecated(string key)
    {
        if (LaunchSettingDefinitions.Contains(key) && LaunchSettingDefinitions.Get(key).IsDeprecated)
        {
            context.Error.MarkupLine(
                $"[yellow]{Markup.Escape(key)} is deprecated:[/] manifest locations come from the release's distribution list, and which apps bootstrap is chosen with [grey]hosty setup[/]. This override will stop working in a future release.");
        }
    }
}
