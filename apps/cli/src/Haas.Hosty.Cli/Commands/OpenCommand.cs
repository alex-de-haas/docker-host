namespace Haas.Hosty.Cli.Commands;

using System.Diagnostics;
using System.Text.Json.Serialization;
using Spectre.Console;

internal sealed partial class OpenCommand(CommandContext context)
{
    [JsonSourceGenerationOptions(
        PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase,
        PropertyNameCaseInsensitive = true,
        NumberHandling = JsonNumberHandling.AllowReadingFromString)]
    [JsonSerializable(typeof(CoreStatusDocument))]
    internal partial class OpenJsonContext : JsonSerializerContext;

    public async Task<int> ExecuteAsync(string[] args)
    {
        if (args.Length > 0)
        {
            throw new CommandUsageException("open does not accept arguments.", "Usage: hosty open");
        }

        using var core = await CoreControlClient.TryCreateAsync(context);
        if (core is null)
        {
            context.Error.MarkupLine("[red]Hosty Core is not running or local control discovery is unavailable.[/]");
            context.Error.MarkupLine("Run [grey]hosty start[/] first.");
            return 1;
        }

        var status = await core.GetAsync<CoreStatusDocument>("core/status");
        var url = ResolveShellOpenUrl(status);
        if (string.IsNullOrWhiteSpace(url))
        {
            // Core reports the origin from Shell's own app record and reports nothing when Shell is not
            // installed — it is an optional app. Say that, rather than the old behaviour of synthesising
            // http://localhost:{ShellPort} and opening a browser on a port nothing is listening on.
            context.Error.MarkupLine("[red]This host has no Hosty Shell to open.[/]");
            context.Error.MarkupLine("Install it with [grey]hosty setup[/], or check [grey]hosty core status[/] if you expected it to be there.");
            return 1;
        }

        if (TryOpen(url))
        {
            context.Console.MarkupLine($"Opened [grey]{Markup.Escape(url)}[/]");
        }
        else
        {
            context.Console.WriteLine(url);
        }

        return 0;
    }

    internal sealed record CoreStatusDocument(string? ShellPublicOrigin);

    // Whatever Core resolved from Shell's record — its published origin, else the loopback URL Core
    // assigned it. No local fallback of our own: Core knowing of no Shell means there is none to open.
    private static string? ResolveShellOpenUrl(CoreStatusDocument? status) => status?.ShellPublicOrigin;

    private static bool TryOpen(string url)
    {
        try
        {
            using var _ = Process.Start(new ProcessStartInfo
            {
                FileName = url,
                UseShellExecute = true,
            });

            return true;
        }
        catch
        {
            return false;
        }
    }
}
