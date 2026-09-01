namespace Haas.Hosty.Cli.Commands;

using System.Text.Json.Serialization;
using Spectre.Console;

// `hosty core settings` — Core behavior settings over the loopback control plane
// (/control/v1/settings). The settings live in the addressed instance, not in the CLI, so a running
// Core is required; on a headless host (Shell optional) this is the only way to edit them at all,
// and the recovery path for a value that broke the UI. Validation is Core's: the endpoint applies
// the exact same per-key parsing as the admin /api/core/settings PUT.
internal sealed partial class CoreSettingsCommand(CommandContext context)
{
    [JsonSourceGenerationOptions(
        PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase,
        PropertyNameCaseInsensitive = true,
        NumberHandling = JsonNumberHandling.AllowReadingFromString)]
    [JsonSerializable(typeof(SettingsDocument))]
    [JsonSerializable(typeof(SettingsUpdateRequest))]
    internal partial class SettingsJsonContext : JsonSerializerContext;

    private const string Usage = """
        Usage:
          hosty core settings list
          hosty core settings get <KEY>
          hosty core settings set <KEY> <VALUE>
          hosty core settings set <KEY>=<VALUE>
          hosty core settings reset <KEY>
        """;

    public async Task<int> ExecuteAsync(string[] args)
    {
        if (args.Length == 0 || args is ["--help"] or ["-h"] or ["help"])
        {
            context.Console.WriteLine(Usage);
            return 0;
        }

        return args[0] switch
        {
            "list" => await ListAsync(args[1..]),
            "get" => await GetAsync(args[1..]),
            "set" => await SetAsync(args[1..]),
            "reset" => await ResetAsync(args[1..]),
            _ => throw new CommandUsageException($"Unknown core settings command '{args[0]}'.", Usage),
        };
    }

    private async Task<int> ListAsync(string[] args)
    {
        if (args.Length > 0)
        {
            throw new CommandUsageException("core settings list does not accept arguments.", Usage);
        }

        var document = await FetchAsync();
        var table = ConsoleUi.CreateTable("Key", "Value", "Default", "Overridden", "Group");
        foreach (var row in document.Settings)
        {
            table.AddRow(
                Markup.Escape(row.Key),
                Markup.Escape(row.Value + (row.Unit is { } unit ? $" {unit}" : string.Empty)),
                Markup.Escape(row.Default),
                ConsoleUi.YesNo(row.Overridden),
                Markup.Escape(row.Group));
        }

        context.Console.Write(table);
        return 0;
    }

    private async Task<int> GetAsync(string[] args)
    {
        if (args.Length != 1)
        {
            throw new CommandUsageException("core settings get requires exactly one KEY.", Usage);
        }

        var row = FindRow(await FetchAsync(), args[0]);
        context.Console.WriteLine(row.Value);
        return 0;
    }

    private async Task<int> SetAsync(string[] args)
    {
        var (key, value) = args switch
        {
            [var pair] when pair.IndexOf('=', StringComparison.Ordinal) > 0 =>
                (pair[..pair.IndexOf('=', StringComparison.Ordinal)], pair[(pair.IndexOf('=', StringComparison.Ordinal) + 1)..]),
            [var k, var v] => (k, v),
            _ => throw new CommandUsageException("core settings set requires KEY VALUE or KEY=VALUE.", Usage),
        };

        var row = FindRow(await UpdateAsync(key, value), key);
        context.Console.MarkupLine($"[green]{Markup.Escape(key)} set.[/] Effective value: {Markup.Escape(row.Value)}");
        if (string.Equals(key, "HOSTY_CORE_PORT", StringComparison.Ordinal))
        {
            context.Console.MarkupLine("[grey]The port change takes effect on the next Core start.[/]");
        }

        return 0;
    }

    private async Task<int> ResetAsync(string[] args)
    {
        if (args.Length != 1)
        {
            throw new CommandUsageException("core settings reset requires exactly one KEY.", Usage);
        }

        var key = args[0];
        var row = FindRow(await UpdateAsync(key, value: null), key);
        context.Console.MarkupLine($"[green]{Markup.Escape(key)} reset to default.[/] Effective value: {Markup.Escape(row.Value)}");
        return 0;
    }

    private async Task<SettingsDocument> FetchAsync()
    {
        using var core = await RequireCoreAsync();
        return await core.GetAsync<SettingsDocument>("settings")
            ?? throw new CoreNotRunningException();
    }

    // A null value clears the key's override (falls back to env/default) — the same contract the
    // admin PUT applies.
    private async Task<SettingsDocument> UpdateAsync(string key, string? value)
    {
        using var core = await RequireCoreAsync();
        var request = new SettingsUpdateRequest(new Dictionary<string, string?>(StringComparer.Ordinal)
        {
            [key] = value,
        });
        return await core.PutAsync<SettingsDocument>("settings", request)
            ?? throw new CoreNotRunningException();
    }

    private async Task<CoreControlClient> RequireCoreAsync()
        => await CoreControlClient.TryCreateAsync(context) ?? throw new CoreNotRunningException();

    private static SettingRow FindRow(SettingsDocument document, string key)
        => document.Settings.FirstOrDefault(row => string.Equals(row.Key, key, StringComparison.Ordinal))
            ?? throw new CommandUsageException(
                $"Unknown Core setting '{key}'. Run 'hosty core settings list' to see supported settings.",
                Usage);

    internal sealed record SettingRow(
        string Key,
        string Type,
        string Value,
        string Default,
        string Group,
        string? Label,
        string? Description,
        bool Overridden,
        string? Unit = null,
        IReadOnlyList<SettingOption>? Options = null);

    internal sealed record SettingOption(string Value, string Label);

    internal sealed record SettingsDocument(IReadOnlyList<SettingRow> Settings);

    internal sealed record SettingsUpdateRequest(IReadOnlyDictionary<string, string?> Settings);
}
