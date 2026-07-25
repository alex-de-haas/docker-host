namespace Haas.Hosty.Cli.Commands;

using System.Text.Json.Serialization;
using Spectre.Console;

/// <summary>
/// `hosty setup` — install or uninstall the first-party apps this release offers. The checkboxes are
/// the host's actual installed state: ticking an entry installs it, unticking an installed entry
/// uninstalls it. Both are ordinary lifecycle operations against a running Core, which owns the
/// catalog (manifest refs and feeds never reach the CLI). This is also the recovery path for an app
/// removed from the Shell or by mistake — including the Shell itself.
/// See docs/features/removable-system-apps/.
/// </summary>
internal sealed partial class SetupCommand(CommandContext context)
{
    private const string Usage = """
        Usage:
          hosty setup                          Interactive checklist of first-party apps
          hosty setup --with <APP_ID>[,..]     Install app(s) without prompting
          hosty setup --without <APP_ID>[,..]  Uninstall app(s) without prompting
          hosty setup --yes                    Apply the current selection without prompting
          hosty setup --list                   Show the catalog and what is installed
          hosty setup --delete-data            Also delete app data when uninstalling
        """;

    public async Task<int> ExecuteAsync(string[] args)
    {
        if (args is ["--help"] or ["-h"] or ["help"])
        {
            context.Console.WriteLine(Usage);
            return 0;
        }

        var options = ParseArguments(args);
        using var core = await OpenCoreAsync();
        var state = await LoadStateAsync(core);
        foreach (var problem in state.Problems ?? [])
        {
            context.Error.MarkupLine($"[yellow]Warning:[/] {Markup.Escape(problem)}");
        }

        var entries = state.Apps ?? [];
        if (entries.Count == 0)
        {
            context.Error.MarkupLine("[red]This release offers no first-party apps; nothing to set up.[/]");
            return 1;
        }

        ValidateRequestedIds(options, entries);

        var installed = entries.ToDictionary(entry => entry.Id, entry => entry.Installed, StringComparer.Ordinal);
        IReadOnlyDictionary<string, bool> selection;
        if (options.With.Count > 0 || options.Without.Count > 0 || options.Yes)
        {
            var adjusted = new Dictionary<string, bool>(installed, StringComparer.Ordinal);
            foreach (var id in options.With)
            {
                adjusted[id] = true;
            }

            foreach (var id in options.Without)
            {
                adjusted[id] = false;
            }

            selection = adjusted;
        }
        else if (options.List)
        {
            WriteSelectionTable(entries, installed, state.Source);
            return 0;
        }
        else
        {
            if (!context.Console.Profile.Capabilities.Interactive)
            {
                throw new CommandUsageException(
                    "Interactive setup needs a terminal. Use --with/--without/--yes for scripted runs.",
                    Usage);
            }

            selection = PromptSelection(entries, installed);
        }

        if (options.List)
        {
            WriteSelectionTable(entries, selection, state.Source);
            return 0;
        }

        var failures = await ApplySelectionAsync(core, entries, installed, selection, options.DeleteData);
        WriteSelectionTable(entries, (await LoadStateAsync(core)).Apps ?? [], state.Source);
        return failures == 0 ? 0 : 1;
    }

    // Installs and uninstalls only where the selection differs from what is installed, so re-running
    // setup with the same answers touches nothing.
    private async Task<int> ApplySelectionAsync(
        CoreControlClient core,
        IReadOnlyList<BootstrapAppResponse> entries,
        IReadOnlyDictionary<string, bool> installed,
        IReadOnlyDictionary<string, bool> selection,
        bool deleteData)
    {
        var failures = 0;
        foreach (var entry in entries)
        {
            var want = selection[entry.Id];
            if (want == installed[entry.Id])
            {
                continue;
            }

            try
            {
                if (want)
                {
                    context.Console.MarkupLine($"Installing [bold]{Markup.Escape(entry.Title)}[/]…");
                    await core.PostAsync($"core/bootstrap/{Uri.EscapeDataString(entry.Id)}/install");
                }
                else
                {
                    context.Console.MarkupLine($"Uninstalling [bold]{Markup.Escape(entry.Title)}[/]…");
                    // The ordinary remove, sharing AppsCommand's contract: setup has no lifecycle
                    // powers of its own. App data is kept unless the operator asks otherwise, so a
                    // reinstall picks up where it left off.
                    await core.PostAsync<AppsCommand.AppLifecycleResponse>(
                        $"apps/{Uri.EscapeDataString(entry.Id)}/remove",
                        new AppsCommand.AppRemoveRequest(
                            DeleteRuntimeState: true,
                            DeleteData: deleteData,
                            DeleteBackups: false,
                            DeleteSource: false,
                            IgnoreRuntimeErrors: false));
                }
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                // One app's failure must not abandon the rest of the selection; the exit code reports it.
                failures++;
                context.Error.MarkupLine($"[red]{Markup.Escape(entry.Id)}:[/] {Markup.Escape(ex.Message)}");
            }
        }

        return failures;
    }

    private sealed record SetupOptions(
        IReadOnlyList<string> With,
        IReadOnlyList<string> Without,
        bool Yes,
        bool List,
        bool DeleteData);

    private static SetupOptions ParseArguments(string[] args)
    {
        var with = new List<string>();
        var without = new List<string>();
        var yes = false;
        var list = false;
        var deleteData = false;

        for (var index = 0; index < args.Length; index++)
        {
            switch (args[index])
            {
                case "--with":
                case "--without":
                    var target = args[index] == "--with" ? with : without;
                    if (index + 1 >= args.Length)
                    {
                        throw new CommandUsageException($"{args[index]} requires an app id.", Usage);
                    }

                    target.AddRange(args[++index]
                        .Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries));
                    break;
                case "--yes":
                case "-y":
                    yes = true;
                    break;
                case "--list":
                    list = true;
                    break;
                case "--delete-data":
                    deleteData = true;
                    break;
                default:
                    throw new CommandUsageException($"Unknown setup option '{args[index]}'.", Usage);
            }
        }

        var conflict = with.Intersect(without, StringComparer.Ordinal).FirstOrDefault();
        if (conflict is not null)
        {
            throw new CommandUsageException($"App id '{conflict}' appears in both --with and --without.", Usage);
        }

        return new SetupOptions(with, without, yes, list, deleteData);
    }

    private static void ValidateRequestedIds(SetupOptions options, IReadOnlyList<BootstrapAppResponse> entries)
    {
        var known = entries.Select(entry => entry.Id).ToHashSet(StringComparer.Ordinal);
        var unknown = options.With.Concat(options.Without).FirstOrDefault(id => !known.Contains(id));
        if (unknown is not null)
        {
            throw new CommandUsageException(
                $"Unknown app id '{unknown}'. This release offers: {string.Join(", ", entries.Select(entry => entry.Id))}.",
                Usage);
        }
    }

    private IReadOnlyDictionary<string, bool> PromptSelection(
        IReadOnlyList<BootstrapAppResponse> entries,
        IReadOnlyDictionary<string, bool> installed)
    {
        var prompt = new MultiSelectionPrompt<string>()
            .Title("Select the first-party apps this host should have installed:")
            .NotRequired()
            .PageSize(10)
            .InstructionsText("[grey](space toggles, enter confirms; unticking an installed app uninstalls it)[/]")
            .UseConverter(id =>
            {
                var entry = entries.First(candidate => candidate.Id == id);
                return string.IsNullOrWhiteSpace(entry.Description)
                    ? $"{entry.Title} [grey]({entry.Id})[/]"
                    : $"{entry.Title} [grey]({entry.Id}) — {Markup.Escape(entry.Description)}[/]";
            });

        foreach (var entry in entries)
        {
            prompt.AddChoice(entry.Id);
            if (installed[entry.Id])
            {
                prompt.Select(entry.Id);
            }
        }

        var selected = context.Console.Prompt(prompt).ToHashSet(StringComparer.Ordinal);
        return entries.ToDictionary(entry => entry.Id, entry => selected.Contains(entry.Id), StringComparer.Ordinal);
    }

    private void WriteSelectionTable(
        IReadOnlyList<BootstrapAppResponse> entries,
        IReadOnlyList<BootstrapAppResponse> state,
        string? source)
    {
        var installed = state.ToDictionary(entry => entry.Id, entry => entry.Installed, StringComparer.Ordinal);
        WriteSelectionTable(entries, installed, source);
    }

    private void WriteSelectionTable(
        IReadOnlyList<BootstrapAppResponse> entries,
        IReadOnlyDictionary<string, bool> installed,
        string? source)
    {
        var table = ConsoleUi.CreateTable("App", "Id", "Installed");
        foreach (var entry in entries)
        {
            table.AddRow(
                Markup.Escape(entry.Title),
                Markup.Escape(entry.Id),
                ConsoleUi.YesNo(installed.GetValueOrDefault(entry.Id)));
        }

        context.Console.Write(table);
        if (!string.IsNullOrWhiteSpace(source))
        {
            context.Console.MarkupLine($"[grey]Catalog: {Markup.Escape(source)}[/]");
        }
    }

    private static async Task<BootstrapStateResponse> LoadStateAsync(CoreControlClient core)
        => await core.GetAsync<BootstrapStateResponse>("core/bootstrap")
            ?? throw new InvalidOperationException("Hosty Core returned no catalog state.");

    private async Task<CoreControlClient> OpenCoreAsync()
    {
        // Setup performs real installs and uninstalls, so it needs the running Core rather than a
        // file it could write on its own.
        var core = await CoreControlClient.TryCreateAsync(context);
        if (core is null)
        {
            throw new CoreNotRunningException();
        }

        return core;
    }

    internal sealed class BootstrapStateResponse
    {
        public string? Source { get; init; }
        public List<string>? Problems { get; init; }
        public bool Seeded { get; init; }
        public List<BootstrapAppResponse>? Apps { get; init; }
    }

    internal sealed class BootstrapAppResponse
    {
        public string Id { get; init; } = "";
        public string Title { get => field ?? Id; init; } = "";
        public string? Description { get; init; }
        public bool DefaultEnabled { get; init; }
        public bool Installed { get; init; }
        public string? RuntimeState { get; init; }
        public string? InstallOrigin { get; init; }
    }

    [JsonSourceGenerationOptions(
        PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase,
        PropertyNameCaseInsensitive = true,
        WriteIndented = true)]
    [JsonSerializable(typeof(BootstrapStateResponse))]
    internal partial class SetupJsonContext : JsonSerializerContext;
}
