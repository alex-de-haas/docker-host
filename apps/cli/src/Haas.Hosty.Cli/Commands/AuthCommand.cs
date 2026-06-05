namespace Haas.Hosty.Cli.Commands;

using Spectre.Console;

internal sealed class AuthCommand(CommandContext context)
{
    private const string Usage = """
        Usage:
          hosty auth setup-token
          hosty auth recovery-token

        Commands:
          setup-token    Create a Core-owned first-administrator setup token.
          recovery-token Create a Core-owned local administrator recovery token.
        """;

    public async Task<int> ExecuteAsync(string[] args)
    {
        if (args.Length == 0 || args is ["--help"] or ["-h"] or ["help"])
        {
            context.Console.WriteLine(Usage);
            return 0;
        }

        try
        {
            return args[0] switch
            {
                "setup-token" => await ExecuteTokenAsync(args[1..], "auth setup-token does not accept arguments.", "Usage: hosty auth setup-token", "auth/setup-token", "Setup"),
                "recovery-token" => await ExecuteTokenAsync(args[1..], "auth recovery-token does not accept arguments.", "Usage: hosty auth recovery-token", "auth/recovery-token", "Recovery"),
                _ => throw new CommandUsageException($"Unknown auth command '{args[0]}'.", Usage),
            };
        }
        catch (CoreControlException ex)
        {
            context.Console.MarkupLine($"[red]Hosty Core API failed:[/] {Markup.Escape(ex.Message)}");
            if (!string.IsNullOrWhiteSpace(ex.ResponseBody))
            {
                context.Console.MarkupLine($"[grey]Response:[/] {Markup.Escape(ex.ResponseBody)}");
            }

            return 1;
        }
        catch (Exception ex) when (ex is HttpRequestException or IOException or TaskCanceledException)
        {
            context.Console.MarkupLine($"[red]Unable to reach Hosty Core:[/] {Markup.Escape(ex.Message)}");
            return 1;
        }
    }

    private async Task<int> ExecuteTokenAsync(
        string[] args,
        string usageError,
        string usage,
        string path,
        string label)
    {
        if (args.Length > 0)
        {
            throw new CommandUsageException(usageError, usage);
        }

        using var core = await CoreControlClient.TryCreateAsync(context);
        if (core is null)
        {
            context.Console.MarkupLine("[red]Hosty Core is not running or local control discovery is unavailable.[/]");
            context.Console.MarkupLine("Run [grey]hosty core start[/] first.");
            return 1;
        }

        var response = await core.PostAsync<AuthTokenResponse>(path);
        if (response is null || string.IsNullOrWhiteSpace(response.Token))
        {
            context.Console.MarkupLine("[red]Hosty Core returned an empty auth token response.[/]");
            return 1;
        }

        var url = label == "Setup" ? response.SetupUrl : response.RecoveryUrl;
        context.Console.MarkupLine($"[green]{Markup.Escape(label)} token created.[/]");
        context.Console.MarkupLine($"{Markup.Escape(label)} token: [grey]{Markup.Escape(response.Token)}[/]");
        if (!string.IsNullOrWhiteSpace(url))
        {
            context.Console.MarkupLine($"{Markup.Escape(label)} URL: [grey]{Markup.Escape(url)}[/]");
        }

        context.Console.MarkupLine($"Expires: [grey]{Markup.Escape(response.ExpiresAt.ToString("O"))}[/]");
        return 0;
    }

    private sealed record AuthTokenResponse(
        string Token,
        string? SetupUrl,
        string? RecoveryUrl,
        DateTimeOffset ExpiresAt);
}
