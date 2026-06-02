namespace Haas.DockerHost.Cli.Commands;

using System.Text.Json;
using Spectre.Console;

internal sealed class UpdateCommand(CommandContext context)
{
    public async Task<int> ExecuteAsync(string[] args)
    {
        var options = ParseOptions(args);
        if (options.ListChannels)
        {
            return await ListChannelsAsync(options);
        }

        ProductChannel? selectedChannel = null;
        if (!string.IsNullOrWhiteSpace(options.Channel))
        {
            selectedChannel = await SelectChannelAsync(options);
        }

        try
        {
            await new SelfUpdateService(context).UpdateAsync();
        }
        catch (Exception ex) when (ex is HttpRequestException or IOException or InvalidOperationException or UnauthorizedAccessException or PlatformNotSupportedException)
        {
            context.Console.MarkupLine($"[red]CLI update failed:[/] {Markup.Escape(ex.Message)}");
            context.Console.MarkupLine("The Host container was not changed. Retry later, then restart the Host with [grey]hosty stop[/] and [grey]hosty start[/].");
            return 1;
        }

        context.Console.MarkupLine("[green]Bootstrap CLI update step completed.[/]");
        await CheckCoreAndShellAsync(selectedChannel);

        return 0;
    }

    private async Task<int> ListChannelsAsync(UpdateOptions options)
    {
        var index = await LoadProductChannelsAsync(options.IndexPath);
        var table = new Table();
        table.AddColumn("Channel");
        table.AddColumn("Label");
        table.AddColumn("CLI");
        table.AddColumn("Shell manifest");
        foreach (var channel in index.Channels)
        {
            table.AddRow(
                Markup.Escape(channel.Id),
                Markup.Escape(channel.Label),
                Markup.Escape(channel.CliVersion ?? ""),
                Markup.Escape(channel.ShellManifestPath ?? ""));
        }

        context.Console.Write(table);
        return 0;
    }

    private async Task<ProductChannel> SelectChannelAsync(UpdateOptions options)
    {
        var index = await LoadProductChannelsAsync(options.IndexPath);
        var channel = index.Channels.FirstOrDefault(candidate => string.Equals(candidate.Id, options.Channel, StringComparison.Ordinal)) ??
            throw new CommandUsageException($"Product channel '{options.Channel}' was not found.", Usage);
        var statePath = Path.Combine(context.Environment.RootDirectory, "core", "product-channel.json");
        Directory.CreateDirectory(Path.GetDirectoryName(statePath) ?? context.Environment.RootDirectory);
        await File.WriteAllTextAsync(statePath, JsonSerializer.Serialize(channel, JsonOptions));
        context.Console.MarkupLine($"[green]Selected product channel:[/] {Markup.Escape(channel.Id)}");
        return channel;
    }

    private async Task CheckCoreAndShellAsync(ProductChannel? selectedChannel)
    {
        using var core = await CoreControlClient.TryCreateAsync(context);
        if (core is null)
        {
            context.Console.MarkupLine("[yellow]Hosty Core update step skipped because Core is not running.[/]");
            context.Console.MarkupLine("[grey]Start Core with [white]hosty core start[/], then rerun [white]hosty update[/] for Core/Shell checks.[/]");
            return;
        }

        try
        {
            var status = await core.GetAsync<CoreStatusDocument>("core/status");
            context.Console.MarkupLine($"[green]Hosty Core reachable:[/] {Markup.Escape(status?.Status ?? "running")}");
            context.Console.MarkupLine("[grey]Hosty Core self-replacement is reserved for the bootstrap supervisor and is not performed by the running Core process.[/]");

            var apps = await core.GetAsync<AppsResponse>("apps");
            var shell = apps?.Apps.FirstOrDefault(app => string.Equals(app.Id, "hosty.shell", StringComparison.Ordinal));
            if (shell is null)
            {
                context.Console.MarkupLine("[yellow]Hosty Shell update step skipped because hosty.shell is not installed.[/]");
                return;
            }

            var shellManifestPath = selectedChannel?.ShellManifestPath is null
                ? null
                : Path.GetFullPath(selectedChannel.ShellManifestPath);
            var plan = await core.PostAsync<AppUpdatePlan>("apps/hosty.shell/update/plan", new AppUpdatePlanRequest(shellManifestPath, shell.SelectedRuntime, selectedChannel?.Id ?? shell.SelectedChannel));
            if (plan is null)
            {
                context.Console.MarkupLine("[yellow]Hosty Shell update plan was not returned.[/]");
                return;
            }

            context.Console.MarkupLine("[green]Hosty Shell update plan ready.[/]");
            context.Console.MarkupLine($"[grey]Plan digest:[/] {Markup.Escape(plan.PlanDigest)}");
            context.Console.MarkupLine("[grey]Apply with [white]hosty apps update hosty.shell --plan-digest <digest>[/] after reviewing the plan.[/]");
        }
        catch (CoreControlException ex)
        {
            context.Console.MarkupLine($"[yellow]Core/Shell update checks skipped:[/] {Markup.Escape(ex.Message)}");
        }
        catch (Exception ex) when (ex is HttpRequestException or IOException or TaskCanceledException)
        {
            context.Console.MarkupLine($"[yellow]Core/Shell update checks skipped:[/] {Markup.Escape(ex.Message)}");
        }
    }

    private static async Task<ProductChannelIndex> LoadProductChannelsAsync(string? indexPath)
    {
        var path = indexPath ?? Environment.GetEnvironmentVariable("HOSTY_PRODUCT_CHANNEL_INDEX") ?? FindDefaultProductChannelIndex();
        if (string.IsNullOrWhiteSpace(path) || !File.Exists(path))
        {
            throw new CommandUsageException("Product channel index was not found. Pass --index <path>.", Usage);
        }

        await using var stream = File.OpenRead(path);
        return await JsonSerializer.DeserializeAsync<ProductChannelIndex>(stream, JsonOptions) ??
            throw new CommandUsageException("Product channel index is invalid.", Usage);
    }

    private static string? FindDefaultProductChannelIndex()
    {
        foreach (var root in new[] { Directory.GetCurrentDirectory(), AppContext.BaseDirectory })
        {
            var current = new DirectoryInfo(root);
            while (current is not null)
            {
                var candidate = Path.Combine(current.FullName, "channels", "product-channels.json");
                if (File.Exists(candidate))
                {
                    return candidate;
                }

                current = current.Parent;
            }
        }

        return null;
    }

    private static UpdateOptions ParseOptions(string[] args)
    {
        var listChannels = false;
        string? channel = null;
        string? indexPath = null;
        for (var index = 0; index < args.Length; index++)
        {
            switch (args[index])
            {
                case "--list-channels":
                    listChannels = true;
                    break;
                case "--channel":
                    channel = RequireOptionValue(args, ref index, "--channel");
                    break;
                case "--index":
                    indexPath = RequireOptionValue(args, ref index, "--index");
                    break;
                default:
                    throw new CommandUsageException($"Unknown update option '{args[index]}'.", Usage);
            }
        }

        return new UpdateOptions(listChannels, channel, indexPath);
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

    private sealed record CoreStatusDocument(string? Status);

    private sealed record AppsResponse(IReadOnlyList<AppSummary> Apps);

    private sealed record AppSummary(string Id, string? SelectedChannel, string? SelectedRuntime);

    private sealed record AppUpdatePlanRequest(string? ManifestPath, string? SelectedRuntime, string? TargetChannel);

    private sealed record AppUpdatePlan(string PlanDigest);

    private sealed record UpdateOptions(bool ListChannels, string? Channel, string? IndexPath);

    private sealed record ProductChannelIndex(IReadOnlyList<ProductChannel> Channels);

    private sealed record ProductChannel(
        string Id,
        string Label,
        string? CliVersion,
        string? CoreManifestPath,
        string? ShellManifestPath);

    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);

    private const string Usage = """
        Usage:
          hosty update [--list-channels] [--channel <channel-id>] [--index <path>]
        """;
}
