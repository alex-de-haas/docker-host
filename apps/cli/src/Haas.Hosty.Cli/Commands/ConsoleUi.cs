namespace Haas.Hosty.Cli.Commands;

using System.Globalization;
using Spectre.Console;

/// <summary>
/// Shared console formatting helpers so every command renders tables, statuses, and
/// sizes consistently. Keeps Spectre markup details in one place.
/// </summary>
internal static class ConsoleUi
{
    /// <summary>Creates a list/grid table with a rounded grey border and bold headers.</summary>
    public static Table CreateTable(params string[] headers)
    {
        var table = new Table()
            .RoundedBorder()
            .BorderColor(Color.Grey);
        foreach (var header in headers)
        {
            table.AddColumn($"[bold]{Markup.Escape(header)}[/]");
        }

        return table;
    }

    /// <summary>
    /// Creates a borderless two-column "definition list" table for single-record detail
    /// views (status, plans, source). Use <see cref="Field"/> to add rows.
    /// </summary>
    public static Table CreateDetail()
        => new Table()
            .NoBorder()
            .HideHeaders()
            .AddColumn(new TableColumn(string.Empty).PadRight(2))
            .AddColumn(new TableColumn(string.Empty));

    /// <summary>
    /// Adds a greyed "label" / value row to a detail table. The value is written as-is,
    /// so callers must escape or colorize it themselves (e.g. via <see cref="State"/>).
    /// </summary>
    public static Table Field(this Table table, string label, string value)
    {
        table.AddRow($"[grey]{Markup.Escape(label)}[/]", value);
        return table;
    }

    /// <summary>
    /// Colorizes a status/state token using common lifecycle semantics. The returned
    /// string is markup-safe (the original text is escaped).
    /// </summary>
    public static string State(string? value)
    {
        if (string.IsNullOrEmpty(value))
        {
            return string.Empty;
        }

        var escaped = Markup.Escape(value);
        return value.ToLowerInvariant() switch
        {
            "running" or "active" or "ok" or "healthy" or "ready" or "succeeded" or "completed" or "installed"
                => $"[green]{escaped}[/]",
            "error" or "failed" or "faulted" or "unhealthy" or "crashed"
                => $"[red]{escaped}[/]",
            "starting" or "pending" or "updating" or "restarting" or "degraded" or "stopping"
                => $"[yellow]{escaped}[/]",
            "stopped" or "inactive" or "exited" or "disabled" or "none" or "unknown"
                => $"[grey]{escaped}[/]",
            _ => escaped,
        };
    }

    /// <summary>Colored yes/no where <c>true</c> is the desirable state (green) and <c>false</c> is grey.</summary>
    public static string Enabled(bool value) => value ? "[green]yes[/]" : "[grey]no[/]";

    /// <summary>Plain yes/no for booleans without a good/bad polarity.</summary>
    public static string YesNo(bool value) => value ? "yes" : "no";

    /// <summary>Formats a byte count as a human-readable size (B, KB, MB, ...).</summary>
    public static string Bytes(long bytes)
    {
        if (bytes < 1024)
        {
            return string.Create(CultureInfo.InvariantCulture, $"{bytes} B");
        }

        string[] units = ["KB", "MB", "GB", "TB", "PB"];
        double size = bytes;
        var unit = -1;
        do
        {
            size /= 1024;
            unit++;
        }
        while (size >= 1024 && unit < units.Length - 1);

        return string.Create(CultureInfo.InvariantCulture, $"{size:0.#} {units[unit]}");
    }
}
