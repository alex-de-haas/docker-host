namespace Haas.Hosty.Cli.Commands;

using System.Text.Json;
using System.Text.Json.Serialization;
using Spectre.Console;

internal sealed partial class UpdateCommand(CommandContext context)
{
    [JsonSourceGenerationOptions(
        PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase,
        PropertyNameCaseInsensitive = true,
        NumberHandling = JsonNumberHandling.AllowReadingFromString)]
    [JsonSerializable(typeof(CoreStatusDocument))]
    [JsonSerializable(typeof(AppsResponse))]
    [JsonSerializable(typeof(AppUpdatePlanRequest))]
    [JsonSerializable(typeof(AppUpdatePlan))]
    [JsonSerializable(typeof(ProductChannelIndex))]
    [JsonSerializable(typeof(ProductChannel))]
    internal partial class UpdateJsonContext : JsonSerializerContext;

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
        catch (Exception ex) when (ex is HttpRequestException or IOException or InvalidOperationException or UnauthorizedAccessException or PlatformNotSupportedException or OperationCanceledException)
        {
            context.Error.MarkupLine($"[red]CLI update failed:[/] {Markup.Escape(ex.Message)}");
            context.Error.MarkupLine("Hosty Core and Shell were not changed. Retry later, then restart Core with [grey]hosty restart[/].");
            return 1;
        }

        context.Console.MarkupLine("[green]Bootstrap CLI update step completed.[/]");
        try
        {
            await TryStopWindowsCoreBeforeExecutableUpdateAsync();
            await new CoreInstallationService(context).UpdateAsync();
        }
        catch (Exception ex) when (ex is HttpRequestException or IOException or InvalidOperationException or UnauthorizedAccessException or PlatformNotSupportedException or OperationCanceledException)
        {
            context.Error.MarkupLine($"[red]Core update failed:[/] {Markup.Escape(ex.Message)}");
            context.Error.MarkupLine("Hosty Shell was not changed. Retry later, then restart Core with [grey]hosty restart[/].");
            return 1;
        }

        context.Console.MarkupLine("[green]Hosty Core update step completed.[/]");
        await CheckCoreAndShellAsync(selectedChannel);

        return 0;
    }

    private async Task TryStopWindowsCoreBeforeExecutableUpdateAsync()
    {
        if (!OperatingSystem.IsWindows() ||
            !File.Exists(CoreInstallationService.GetInstalledExecutablePath(context.Environment)))
        {
            return;
        }

        try
        {
            using var core = await CoreControlClient.TryCreateAsync(context);
            if (core is null)
            {
                return;
            }

            var processId = core.CoreProcessId;
            await core.PostAsync("core/stop");
            context.Console.MarkupLine("[grey]Hosty Core stop requested before Windows executable update.[/]");

            // The executable cannot be replaced while the old Core still holds it open, so wait for
            // the process to actually exit (the /core/stop call only signals shutdown). Fall back to
            // a short delay for an older Core whose discovery file records no PID.
            if (processId is int pid && pid > 0)
            {
                if (!await ProcessLiveness.WaitForExitAsync(pid, TimeSpan.FromSeconds(30)))
                {
                    context.Error.MarkupLine("[yellow]Hosty Core did not exit before the Windows executable update; the update may fail if the file is locked.[/]");
                }
            }
            else
            {
                await Task.Delay(750);
            }
        }
        catch (Exception ex) when (ex is CoreControlException or HttpRequestException or IOException or JsonException or OperationCanceledException)
        {
            context.Error.MarkupLine($"[yellow]Could not stop Hosty Core before Windows executable update:[/] {Markup.Escape(ex.Message)}");
        }
    }

    private async Task<int> ListChannelsAsync(UpdateOptions options)
    {
        var index = await LoadProductChannelsAsync(options.IndexPath);
        if (index.Channels?.Count is null or 0)
        {
            context.Console.MarkupLine("[grey]No channels available.[/]");
            return 0;
        }

        var table = ConsoleUi.CreateTable("Channel", "Label", "CLI", "Shell manifest");
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
        await File.WriteAllTextAsync(statePath, CliJson.Serialize(channel));
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
            context.Console.MarkupLine("[grey]A running Core process uses the updated executable after the next Core restart.[/]");

            var apps = await core.GetAsync<AppsResponse>("apps");
            var shell = apps?.Apps.FirstOrDefault(app => string.Equals(app.Id, "hosty.shell", StringComparison.Ordinal));
            if (shell is null)
            {
                context.Console.MarkupLine("[yellow]Hosty Shell update step skipped because hosty.shell is not installed.[/]");
                return;
            }

            var shellManifestPath = selectedChannel?.ShellManifestPath is null
                ? null
                : NormalizeManifestReference(selectedChannel.ShellManifestPath);
            var plan = await core.PostAsync<AppUpdatePlan>("apps/hosty.shell/update/plan", new AppUpdatePlanRequest(shellManifestPath, shell.SelectedRuntime));
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
        return await CliJson.DeserializeAsync<ProductChannelIndex>(stream) ??
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

    internal static string NormalizeManifestReference(string manifestPath)
    {
        var manifestReference = manifestPath.Trim();
        if (Uri.TryCreate(manifestReference, UriKind.Absolute, out var uri) &&
            !string.IsNullOrWhiteSpace(uri.Scheme) &&
            (uri.IsFile || uri.Scheme == Uri.UriSchemeHttp || uri.Scheme == Uri.UriSchemeHttps))
        {
            return manifestReference;
        }

        return Path.GetFullPath(manifestReference);
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

    internal sealed record CoreStatusDocument(string? Status);

    internal sealed record AppsResponse(IReadOnlyList<AppSummary> Apps);

    internal sealed record AppSummary(string Id, string? SelectedRuntime);

    internal sealed record AppUpdatePlanRequest(string? ManifestPath, string? SelectedRuntime);

    internal sealed record AppUpdatePlan(string PlanDigest);

    internal sealed record UpdateOptions(bool ListChannels, string? Channel, string? IndexPath);

    internal sealed record ProductChannelIndex(IReadOnlyList<ProductChannel> Channels);

    internal sealed record ProductChannel(
        string Id,
        string Label,
        string? CliVersion,
        string? CoreArtifactPrefix,
        string? ShellManifestPath);

    private const string Usage = """
        Usage:
          hosty update [--list-channels] [--channel <channel-id>] [--index <path>]
        """;
}
