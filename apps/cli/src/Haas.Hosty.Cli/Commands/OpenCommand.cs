namespace Haas.Hosty.Cli.Commands;

using System.Diagnostics;
using Spectre.Console;

internal sealed class OpenCommand(CommandContext context)
{
    public async Task<int> ExecuteAsync(string[] args)
    {
        if (args.Length > 0)
        {
            throw new CommandUsageException("open does not accept arguments.", "Usage: hosty open");
        }

        using var core = await CoreControlClient.TryCreateAsync(context);
        if (core is null)
        {
            context.Console.MarkupLine("[red]Hosty Core is not running or local control discovery is unavailable.[/]");
            context.Console.MarkupLine("Run [grey]hosty start[/] first.");
            return 1;
        }

        var status = await core.GetAsync<CoreStatusDocument>("core/status");
        var url = ResolveShellOpenUrl(status);
        if (string.IsNullOrWhiteSpace(url))
        {
            context.Console.MarkupLine("[red]Hosty Shell origin is not configured.[/]");
            context.Console.MarkupLine("Set [grey]HOSTY_SHELL_PUBLIC_ORIGIN[/] when starting Core, or run [grey]npm run dev[/] for local Core/Shell development.");
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

    private sealed record CoreStatusDocument(string? ShellPublicOrigin, int? ShellPort);

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
