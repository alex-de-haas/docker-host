namespace Haas.Hosty.Cli.Commands;

using System.Text.Json;
using System.Text.Json.Serialization;
using Haas.Hosty.Cli.Configuration;
using Spectre.Console;

/// <summary>
/// `hosty setup` — choose which optional first-party apps Core preinstalls at boot. Reads the
/// release-owned distribution list (never persisted) and writes only the operator's intent into
/// {dataRoot}/core/bootstrap-choices.json, which Core's boot reconcile consumes. See
/// docs/ideas/generic-bootstrap.md (Phase 2).
/// </summary>
internal sealed partial class SetupCommand(CommandContext context)
{
    private const string Usage = """
        Usage:
          hosty setup                          Interactive checklist of optional apps
          hosty setup --with <APP_ID>[,..]     Enable app(s) without prompting
          hosty setup --without <APP_ID>[,..]  Disable app(s) without prompting
          hosty setup --yes                    Accept the current selection without prompting
          hosty setup --list                   Show the distribution list and current selection
        """;

    // Mirrors Core's DistributionAppsSchema/BootstrapChoicesSchema constants (no shared library —
    // both binaries are Native AOT and the contract is two stable strings).
    private const string DistributionSchemaVersion = "distribution-apps.0.1";
    private const string DistributionFileName = "distribution-apps.json";
    private const string DistributionPathEnvVar = "HOSTY_DISTRIBUTION_APPS_PATH";
    private const string ChoicesSchemaVersion = "bootstrap-choices.0.1";
    private const string ChoicesFileName = "bootstrap-choices.json";

    // Official distribution for standalone binary installs — the same set Core embeds
    // (DistributionAppsProvider.EmbeddedDefaultJson); a source tree wins via the walked repo file.
    // Setup only consumes id/title/description/defaultEnabled; manifest refs are Core's concern.
    private const string EmbeddedDefaultJson = /*lang=json,strict*/ """
        {
          "schemaVersion": "distribution-apps.0.1",
          "apps": [
            {
              "id": "hosty.shell",
              "title": "Hosty Shell",
              "description": "Web UI client for this host.",
              "manifestRef": "https://raw.githubusercontent.com/alex-de-haas/docker-host/main/apps/shell/manifest.json",
              "defaultEnabled": true
            },
            {
              "id": "hosty.telemetry",
              "title": "Telemetry",
              "description": "OpenTelemetry collector and observability backend.",
              "manifestRef": "https://raw.githubusercontent.com/alex-de-haas/docker-host/main/apps/telemetry/manifest.json",
              "defaultEnabled": false
            },
            {
              "id": "hosty.marketplace",
              "title": "Marketplace",
              "description": "App discovery storefront.",
              "manifestRef": "https://raw.githubusercontent.com/alex-de-haas/docker-host/main/apps/marketplace/manifest.json",
              "defaultEnabled": true
            }
          ]
        }
        """;

    public async Task<int> ExecuteAsync(string[] args)
    {
        if (args is ["--help"] or ["-h"] or ["help"])
        {
            context.Console.WriteLine(Usage);
            return 0;
        }

        var options = ParseArguments(args);
        var settings = context.SettingsStore.EnsureInstalled();
        var (entries, listSource, listWarnings) = LoadDistributionList();
        foreach (var warning in listWarnings)
        {
            context.Error.MarkupLine($"[yellow]Warning:[/] {Markup.Escape(warning)}");
        }

        if (entries.Count == 0)
        {
            context.Error.MarkupLine("[red]No usable distribution list entries were found; nothing to set up.[/]");
            return 1;
        }

        ValidateRequestedIds(options, entries);

        var dataRoot = settings.ResolveHostDataRoot(context.Environment);
        var choicesPath = Path.Combine(dataRoot, "core", ChoicesFileName);
        var (existingChoices, existingUnreadable) = ReadChoices(choicesPath);
        if (existingUnreadable)
        {
            context.Error.MarkupLine(
                $"[yellow]Warning:[/] existing {Markup.Escape(ChoicesFileName)} could not be parsed; it will be rewritten from this selection.");
        }

        var effective = entries.ToDictionary(
            entry => entry.Id,
            entry => EffectiveEnabled(entry, existingChoices, settings, dataRoot),
            StringComparer.Ordinal);

        if (options.List)
        {
            WriteSelectionTable(entries, effective, listSource);
            return 0;
        }

        IReadOnlyDictionary<string, bool> selection;
        if (options.With.Count > 0 || options.Without.Count > 0 || options.Yes)
        {
            var adjusted = new Dictionary<string, bool>(effective, StringComparer.Ordinal);
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
        else
        {
            if (!context.Console.Profile.Capabilities.Interactive)
            {
                throw new CommandUsageException(
                    "Interactive setup needs a terminal. Use --with/--without/--yes for scripted runs.",
                    Usage);
            }

            selection = PromptSelection(entries, effective);
        }

        WriteChoices(choicesPath, entries, selection, existingChoices);
        WriteSelectionTable(entries, selection, listSource);
        context.Console.MarkupLine($"[grey]Saved to {Markup.Escape(choicesPath)}[/]");

        // Core loads choices once at boot; a live process keeps reconciling yesterday's selection.
        using var control = await CoreControlClient.TryCreateAsync(context);
        if (control is not null)
        {
            context.Console.MarkupLine("[yellow]Hosty Core is running — the new selection applies on the next 'hosty core restart'.[/]");
        }

        return 0;
    }

    private sealed record SetupOptions(IReadOnlyList<string> With, IReadOnlyList<string> Without, bool Yes, bool List);

    private static SetupOptions ParseArguments(string[] args)
    {
        var with = new List<string>();
        var without = new List<string>();
        var yes = false;
        var list = false;

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
                default:
                    throw new CommandUsageException($"Unknown setup option '{args[index]}'.", Usage);
            }
        }

        var conflict = with.Intersect(without, StringComparer.Ordinal).FirstOrDefault();
        if (conflict is not null)
        {
            throw new CommandUsageException($"App id '{conflict}' appears in both --with and --without.", Usage);
        }

        return new SetupOptions(with, without, yes, list);
    }

    private void ValidateRequestedIds(SetupOptions options, IReadOnlyList<DistributionEntry> entries)
    {
        var known = entries.Select(entry => entry.Id).ToHashSet(StringComparer.Ordinal);
        var unknown = options.With.Concat(options.Without).FirstOrDefault(id => !known.Contains(id));
        if (unknown is not null)
        {
            throw new CommandUsageException(
                $"Unknown app id '{unknown}'. The distribution list declares: {string.Join(", ", entries.Select(entry => entry.Id))}.",
                Usage);
        }
    }

    // Choices win, then the explicit legacy launch settings, then the installed state, then the
    // release default — mirroring the layering Core applies at boot (whose migration also pins from
    // the installed state), so the checklist shows what the next boot would actually do.
    private static bool EffectiveEnabled(DistributionEntry entry, ChoicesDocument? choices, LaunchSettings settings, string dataRoot)
    {
        if (choices is not null &&
            choices.Apps.TryGetValue(entry.Id, out var choice) &&
            choice.Enabled is bool chosen)
        {
            return chosen;
        }

        var legacy = entry.Id switch
        {
            "hosty.marketplace" when !string.IsNullOrWhiteSpace(settings.HostyMarketplaceManifestPath) => true,
            _ => (bool?)null,
        };
        if (legacy is bool value)
        {
            return value;
        }

        // An app that is already installed counts as enabled in the base selection: without a
        // choices file that is exactly what Core's upgrade migration would pin.
        if (File.Exists(Path.Combine(dataRoot, "apps", entry.Id, "state.json")))
        {
            return true;
        }

        return entry.DefaultEnabled;
    }

    private IReadOnlyDictionary<string, bool> PromptSelection(
        IReadOnlyList<DistributionEntry> entries,
        IReadOnlyDictionary<string, bool> effective)
    {
        var prompt = new MultiSelectionPrompt<string>()
            .Title("Select the apps Hosty Core should preinstall on this host:")
            .NotRequired()
            .PageSize(10)
            .InstructionsText("[grey](space toggles, enter confirms; an empty selection is a headless host)[/]")
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
            if (effective[entry.Id])
            {
                prompt.Select(entry.Id);
            }
        }

        var selected = context.Console.Prompt(prompt).ToHashSet(StringComparer.Ordinal);
        return entries.ToDictionary(entry => entry.Id, entry => selected.Contains(entry.Id), StringComparer.Ordinal);
    }

    // An explicit setup run pins every presented entry — confirming a value that happens to match
    // today's release default is still operator intent, and a later default flip must not override it.
    private static void WriteChoices(
        string path,
        IReadOnlyList<DistributionEntry> entries,
        IReadOnlyDictionary<string, bool> selection,
        ChoicesDocument? existing)
    {
        var apps = new Dictionary<string, ChoiceEntry>(StringComparer.Ordinal);
        // Choices for apps outside the current list stay inert but preserved (a future release may
        // re-add the entry).
        foreach (var (id, choice) in existing?.Apps ?? new Dictionary<string, ChoiceEntry>(StringComparer.Ordinal))
        {
            apps[id] = choice;
        }

        foreach (var entry in entries)
        {
            apps[entry.Id] = new ChoiceEntry { Enabled = selection[entry.Id] };
        }

        var document = new ChoicesDocument { SchemaVersion = ChoicesSchemaVersion, Apps = apps };
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        var tempPath = $"{path}.{Guid.NewGuid():N}.tmp";
        try
        {
            File.WriteAllText(tempPath, JsonSerializer.Serialize(document, SetupJsonContext.Default.ChoicesDocument));
            File.Move(tempPath, path, overwrite: true);
        }
        catch
        {
            try
            {
                File.Delete(tempPath);
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                // Best-effort cleanup of the abandoned temp file.
            }

            throw;
        }
    }

    private void WriteSelectionTable(
        IReadOnlyList<DistributionEntry> entries,
        IReadOnlyDictionary<string, bool> selection,
        string listSource)
    {
        var table = ConsoleUi.CreateTable("App", "Id", "Enabled");
        foreach (var entry in entries)
        {
            table.AddRow(
                Markup.Escape(entry.Title),
                Markup.Escape(entry.Id),
                ConsoleUi.YesNo(selection[entry.Id]));
        }

        context.Console.Write(table);
        context.Console.MarkupLine($"[grey]Distribution list: {Markup.Escape(listSource)}[/]");
    }

    // --- Distribution list (read-only view: id/title/description/defaultEnabled) ---

    internal sealed record DistributionEntry(string Id, string Title, string? Description, bool DefaultEnabled);

    private (IReadOnlyList<DistributionEntry> Entries, string Source, IReadOnlyList<string> Warnings) LoadDistributionList()
    {
        var warnings = new List<string>();

        var overridePath = Environment.GetEnvironmentVariable(DistributionPathEnvVar);
        if (!string.IsNullOrWhiteSpace(overridePath))
        {
            var fromOverride = TryParseFile(overridePath.Trim(), $"{DistributionPathEnvVar} override", warnings);
            if (fromOverride is not null)
            {
                return (fromOverride, $"{DistributionPathEnvVar} override", warnings);
            }
        }

        if (ResolveWalkedPath() is { } walkedPath)
        {
            var fromWalk = TryParseFile(walkedPath, walkedPath, warnings);
            if (fromWalk is not null)
            {
                return (fromWalk, walkedPath, warnings);
            }
        }

        var embedded = ParseEntries(EmbeddedDefaultJson, "embedded default", warnings);
        return (embedded, "embedded default", warnings);
    }

    private static IReadOnlyList<DistributionEntry>? TryParseFile(string path, string source, List<string> warnings)
    {
        string json;
        try
        {
            json = File.ReadAllText(path);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            warnings.Add($"Distribution list at '{path}' ({source}) could not be read: {ex.Message}. The next available list is used instead.");
            return null;
        }

        var entries = ParseEntries(json, source, warnings);
        if (entries.Count == 0)
        {
            warnings.Add($"Distribution list at '{path}' produced no usable entries. The next available list is used instead.");
            return null;
        }

        return entries;
    }

    private static IReadOnlyList<DistributionEntry> ParseEntries(string json, string source, List<string> warnings)
    {
        DistributionDocument? document;
        try
        {
            document = JsonSerializer.Deserialize(json, SetupJsonContext.Default.DistributionDocument);
        }
        catch (JsonException ex)
        {
            warnings.Add($"Distribution list ({source}) is not valid JSON: {ex.Message}");
            return [];
        }

        if (document is null || !string.Equals(document.SchemaVersion, DistributionSchemaVersion, StringComparison.Ordinal))
        {
            warnings.Add($"Distribution list ({source}) does not declare schemaVersion '{DistributionSchemaVersion}'.");
            return [];
        }

        var entries = new List<DistributionEntry>();
        var seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (var entry in document.Apps ?? [])
        {
            var id = entry.Id?.Trim();
            if (string.IsNullOrWhiteSpace(id) || !seen.Add(id))
            {
                warnings.Add($"Distribution list ({source}) has a missing or duplicate app id ('{entry.Id}'); the entry was skipped.");
                continue;
            }

            entries.Add(new DistributionEntry(
                id,
                string.IsNullOrWhiteSpace(entry.Title) ? id : entry.Title.Trim(),
                string.IsNullOrWhiteSpace(entry.Description) ? null : entry.Description.Trim(),
                entry.DefaultEnabled ?? false));
        }

        return entries;
    }

    // Same walk Core uses: the current dir and the binary's base dir, upward — a source tree's
    // repo-root distribution-apps.json wins over the embedded copy.
    private static string? ResolveWalkedPath()
    {
        foreach (var start in new[] { Directory.GetCurrentDirectory(), AppContext.BaseDirectory })
        {
            // AppContext.BaseDirectory can be empty under custom hosts; DirectoryInfo would throw.
            if (string.IsNullOrWhiteSpace(start))
            {
                continue;
            }

            var directory = new DirectoryInfo(start);
            while (directory is not null)
            {
                var candidate = Path.Combine(directory.FullName, DistributionFileName);
                if (File.Exists(candidate))
                {
                    return candidate;
                }

                directory = directory.Parent;
            }
        }

        return null;
    }

    // --- Choices file (Core-compatible bootstrap-choices.0.1) ---

    private static (ChoicesDocument? Document, bool Unreadable) ReadChoices(string path)
    {
        if (!File.Exists(path))
        {
            return (null, false);
        }

        try
        {
            var document = JsonSerializer.Deserialize(File.ReadAllText(path), SetupJsonContext.Default.ChoicesDocument);
            return document is not null && string.Equals(document.SchemaVersion, ChoicesSchemaVersion, StringComparison.Ordinal)
                ? (document, false)
                : (null, true);
        }
        catch (Exception ex) when (ex is JsonException or IOException or UnauthorizedAccessException)
        {
            return (null, true);
        }
    }

    internal sealed class DistributionDocument
    {
        public string? SchemaVersion { get; init; }
        public List<DistributionDocumentEntry>? Apps { get; init; }
    }

    internal sealed class DistributionDocumentEntry
    {
        public string? Id { get; init; }
        public string? Title { get; init; }
        public string? Description { get; init; }
        public bool? DefaultEnabled { get; init; }
    }

    internal sealed class ChoicesDocument
    {
        public string? SchemaVersion { get; init; }
        public Dictionary<string, ChoiceEntry> Apps { get; init; } = new(StringComparer.Ordinal);
    }

    internal sealed class ChoiceEntry
    {
        public bool? Enabled { get; init; }
    }

    [JsonSourceGenerationOptions(
        PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase,
        PropertyNameCaseInsensitive = true,
        WriteIndented = true)]
    [JsonSerializable(typeof(DistributionDocument))]
    [JsonSerializable(typeof(ChoicesDocument))]
    internal partial class SetupJsonContext : JsonSerializerContext;
}
