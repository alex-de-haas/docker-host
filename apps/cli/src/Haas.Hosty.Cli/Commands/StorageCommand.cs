namespace Haas.Hosty.Cli.Commands;

using System.Text.Json.Serialization;
using Spectre.Console;

// Manages the host-level shared-mounts library: named operator host paths that apps attach by
// reference (apps mounts set --ref <key>=<name>). Talks to the Core control endpoints.
internal sealed partial class StorageCommand(CommandContext context)
{
    [JsonSourceGenerationOptions(
        PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase,
        PropertyNameCaseInsensitive = true,
        NumberHandling = JsonNumberHandling.AllowReadingFromString)]
    [JsonSerializable(typeof(GlobalMountListResponse))]
    [JsonSerializable(typeof(GlobalMountUpsertRequest))]
    internal partial class StorageJsonContext : JsonSerializerContext;

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
            "add" => await AddAsync(args[1..]),
            "rm" => await RemoveAsync(args[1..]),
            _ => throw new CommandUsageException($"Unknown storage command '{args[0]}'.", Usage),
        };
    }

    private async Task<int> ListAsync(string[] args)
    {
        if (args.Length > 0)
        {
            throw new CommandUsageException("storage list does not accept arguments.", Usage);
        }

        using var core = await OpenCoreAsync();
        var response = await core.GetAsync<GlobalMountListResponse>("global-mounts");
        RenderMounts(response);
        return 0;
    }

    private async Task<int> AddAsync(string[] args)
    {
        var options = ParseAddOptions(args);
        using var core = await OpenCoreAsync();
        var response = await core.PostAsync<GlobalMountListResponse>(
            "global-mounts",
            new GlobalMountUpsertRequest(options.Name, options.HostPath, options.Mode, options.Description));
        context.Console.MarkupLine($"[green]saved:[/] {Markup.Escape(options.Name)}");
        RenderMounts(response);
        return 0;
    }

    private async Task<int> RemoveAsync(string[] args)
    {
        string? name = null;
        var force = false;
        foreach (var arg in args)
        {
            if (arg == "--force")
            {
                force = true;
            }
            else if (name is null)
            {
                name = arg;
            }
            else
            {
                throw new CommandUsageException($"Unknown storage rm argument '{arg}'.", Usage);
            }
        }

        if (string.IsNullOrWhiteSpace(name))
        {
            throw new CommandUsageException("storage rm requires a shared mount name.", Usage);
        }

        using var core = await OpenCoreAsync();
        var path = $"global-mounts/{Uri.EscapeDataString(name)}{(force ? "?force=true" : string.Empty)}";
        var response = await core.DeleteAsync<GlobalMountListResponse>(path);
        context.Console.MarkupLine($"[green]removed:[/] {Markup.Escape(name)}");
        RenderMounts(response);
        return 0;
    }

    private void RenderMounts(GlobalMountListResponse? response)
    {
        var mounts = response?.Mounts ?? [];
        if (mounts.Count == 0)
        {
            context.Console.MarkupLine("[grey]No shared mounts registered.[/]");
            return;
        }

        var table = ConsoleUi.CreateTable("Name", "Host path", "Mode", "Used by", "Description");
        foreach (var mount in mounts)
        {
            table.AddRow(
                Markup.Escape(mount.Name),
                Markup.Escape(mount.HostPath),
                Markup.Escape(mount.Mode),
                Markup.Escape(mount.UsedBy.ToString()),
                Markup.Escape(mount.Description ?? string.Empty));
        }

        context.Console.Write(table);
    }

    private static AddOptions ParseAddOptions(string[] args)
    {
        string? name = null;
        string? hostPath = null;
        string? mode = null;
        string? description = null;
        for (var index = 0; index < args.Length; index++)
        {
            switch (args[index])
            {
                case "--mode":
                    mode = RequireOptionValue(args, ref index, "--mode");
                    break;
                case "--description":
                    description = RequireOptionValue(args, ref index, "--description");
                    break;
                default:
                    if (args[index].StartsWith('-'))
                    {
                        throw new CommandUsageException($"Unknown storage add argument '{args[index]}'.", Usage);
                    }

                    if (name is null)
                    {
                        name = args[index];
                    }
                    else if (hostPath is null)
                    {
                        hostPath = args[index];
                    }
                    else
                    {
                        throw new CommandUsageException($"Unexpected storage add argument '{args[index]}'.", Usage);
                    }

                    break;
            }
        }

        if (string.IsNullOrWhiteSpace(name) || string.IsNullOrWhiteSpace(hostPath))
        {
            throw new CommandUsageException("storage add requires <name> and <host-path>.", Usage);
        }

        return new AddOptions(name, hostPath, mode, description);
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

    private const string Usage =
        """
        Usage: hosty storage <command>

        Commands:
          list
          add <name> <host-path> [--mode ro|rw] [--description <text>]
          rm <name> [--force]

        Shared mounts are host folders apps attach by reference (apps mounts set --ref <key>=<name>).
        """;

    private sealed record AddOptions(string Name, string HostPath, string? Mode, string? Description);

    internal sealed record GlobalMountListResponse(IReadOnlyList<GlobalMountSummary> Mounts);

    internal sealed record GlobalMountSummary(string Name, string HostPath, string Mode, string? Description, int UsedBy);

    internal sealed record GlobalMountUpsertRequest(string Name, string HostPath, string? Mode, string? Description);
}
