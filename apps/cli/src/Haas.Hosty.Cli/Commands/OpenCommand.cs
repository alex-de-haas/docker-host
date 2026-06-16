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
            context.Error.MarkupLine("[red]Hosty Shell origin is not configured.[/]");
            context.Error.MarkupLine("Set [grey]HOSTY_SHELL_PUBLIC_ORIGIN[/] when starting Core, or run [grey]npm run dev[/] for local Core/Shell development.");
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

    internal sealed record CoreStatusDocument(string? ShellPublicOrigin, int? ShellPort);

    private static string? ResolveShellOpenUrl(CoreStatusDocument? status)
    {
        if (!string.IsNullOrWhiteSpace(status?.ShellPublicOrigin))
        {
            return status.ShellPublicOrigin;
        }

        return status?.ShellPort is int shellPort && shellPort > 0
            ? $"http://localhost:{shellPort}"
            : null;
    }

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
