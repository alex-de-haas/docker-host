namespace Haas.Hosty.Cli.Commands;

using System.Text.Json;
using Spectre.Console;

internal sealed class UsersCommand(CommandContext context)
{
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
            _ => throw new CommandUsageException($"Unknown users command '{args[0]}'.", Usage),
        };
    }

    private async Task<int> ListAsync(string[] args)
    {
        string? appId = null;
        var format = "table";
        for (var index = 0; index < args.Length; index++)
        {
            switch (args[index])
            {
                case "--app":
                    appId = RequireOptionValue(args, ref index, "--app");
                    break;
                case "--format":
                    format = RequireOptionValue(args, ref index, "--format");
                    break;
                default:
                    throw new CommandUsageException($"Unknown users list argument '{args[index]}'.", Usage);
            }
        }

        using var core = await OpenCoreAsync();
        var path = string.IsNullOrWhiteSpace(appId)
            ? "users/summaries"
            : $"users/summaries?appId={Uri.EscapeDataString(appId)}";
        var response = await core.GetAsync<HostUsersSummaryResponse>(path);
        var users = response?.Users ?? [];

        if (format == "json")
        {
            context.Console.WriteLine(JsonSerializer.Serialize(response ?? new HostUsersSummaryResponse(users), JsonOptions));
            return 0;
        }

        if (format != "table")
        {
            throw new CommandUsageException("users list --format must be table or json.", Usage);
        }

        var table = new Table();
        table.AddColumn("User");
        table.AddColumn("Email");
        table.AddColumn("Role");
        table.AddColumn("Disabled");
        if (!string.IsNullOrWhiteSpace(appId))
        {
            table.AddColumn("Assigned");
        }

        foreach (var user in users)
        {
            var row = new List<string>
            {
                Markup.Escape(user.Id),
                Markup.Escape(user.Email),
                Markup.Escape(user.Role),
                user.Disabled ? "yes" : "no",
            };
            if (!string.IsNullOrWhiteSpace(appId))
            {
                row.Add(user.Assigned == true ? "yes" : "no");
            }

            table.AddRow(row.ToArray());
        }

        context.Console.Write(table);
        return 0;
    }

    private async Task<CoreControlClient> OpenCoreAsync()
    {
        var core = await CoreControlClient.TryCreateAsync(context);
        if (core is null)
        {
            throw new CommandUsageException(
                "Hosty Core is not running or local control discovery is unavailable. Run `hosty core start` first.",
                Usage);
        }

        return core;
    }

    private static string RequireOptionValue(string[] args, ref int index, string option)
    {
        if (index + 1 >= args.Length)
        {
            throw new CommandUsageException($"{option} requires a value.", Usage);
        }

        index++;
        return args[index];
    }

    private sealed record HostUsersSummaryResponse(IReadOnlyList<HostUserSummary> Users);

    private sealed record HostUserSummary(
        string Id,
        string Email,
        string? DisplayName,
        string Role,
        bool Disabled,
        bool? Assigned);

    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);

    private const string Usage = """
        hosty users

        Usage:
          hosty users <command> [options]

        Commands:
          list [--app <app-id>] [--format table|json]

        Description:
          Calls Hosty Core user APIs with sanitized user projections.
        """;
}
