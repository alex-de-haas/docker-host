namespace Haas.Hosty.Cli.Commands;

using System.Text;
using Spectre.Console;
using System.Text.Json;
using System.Text.Json.Serialization;

/// <summary>Local operator access to Core's native skill export contract.</summary>
internal sealed partial class SkillsCommand(CommandContext context)
{
    [JsonSourceGenerationOptions(PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase, PropertyNameCaseInsensitive = true)]
    [JsonSerializable(typeof(ExportRequest))]
    [JsonSerializable(typeof(ExportResult))]
    [JsonSerializable(typeof(SelectionRequest))]
    [JsonSerializable(typeof(SelectedInstallRequest))]
    [JsonSerializable(typeof(SelectionResult))]
    internal partial class SkillsJsonContext : JsonSerializerContext;
    internal sealed record ExportRequest(string ContextId, string[] SkillIds);
    internal sealed record ExportResult(string Id, string Path, JsonElement[] Skills);
    internal sealed record GitSource(string Repository, string Ref, string Path);
    internal sealed record SelectionRequest(GitSource Source, string[] Names);
    internal sealed record SelectedInstallRequest(GitSource Source, string Commit, string[] Names);
    internal sealed record SelectionResult(string Repository, string Ref, string Commit, JsonElement[] Skills);
    private const string Usage = """
        hosty skills list [--format table|json]
        hosty skills add <repository-url> --skill <name> [--skill <name> ...]
                         [--ref <branch-tag-or-commit>] [--path <directory>] [--format table|json]
        hosty skills read <skill-id> [relative-file]
        hosty skills export --context <name> [--skill <skill-id> ...] [--link <directory>]
        hosty skills release <export-id>

        Exports contain current installed files. Missing skill IDs are omitted.
        To provision Codex, link an export to a dedicated HOME/.agents/skills directory.
        An existing directory or unrelated link is never replaced.
        Lists show skill names, sources and short descriptions. Use --format json for full metadata and IDs.
        Add imports selected public Git packages into this Core's shared library. It does not select agent profiles.
        """;

    public async Task<int> ExecuteAsync(string[] args)
    {
        if (args.Length == 0 || args is ["--help"] or ["-h"] or ["help"])
        { context.Console.WriteLine(Usage); return 0; }
        if (args[0] == "list") return await ListAsync(args[1..]);
        if (args[0] == "add") return await AddAsync(args[1..]);
        using var core = await CoreControlClient.TryCreateAsync(context) ?? throw new CoreNotRunningException();
        switch (args[0])
        {
            case "read" when args.Length is 2 or 3:
                var content = await core.GetAsync<JsonElement>($"skills/{Uri.EscapeDataString(args[1])}/content?path={Uri.EscapeDataString(args.Length == 3 ? args[2] : "SKILL.md")}");
                context.Console.Profile.Out.Writer.WriteLine(Encoding.UTF8.GetString(content.GetProperty("content").GetBytesFromBase64()));
                return 0;
            case "export":
                string? name = null, link = null;
                var skills = new List<string>();
                for (var i = 1; i < args.Length; i += 2)
                {
                    if (i + 1 >= args.Length) throw new CommandUsageException("A value is required.", Usage);
                    switch (args[i])
                    {
                        case "--context": name = args[i + 1]; break;
                        case "--skill": skills.Add(args[i + 1]); break;
                        case "--link": link = System.IO.Path.GetFullPath(args[i + 1]); break;
                        default: throw new CommandUsageException($"Unknown option '{args[i]}'.", Usage);
                    }
                }
                if (string.IsNullOrWhiteSpace(name)) throw new CommandUsageException("An export context is required.", Usage);
                if (link is not null && (File.Exists(link) || Directory.Exists(link)) && new DirectoryInfo(link).LinkTarget is null)
                    throw new CommandUsageException("The link destination already exists; select an unused directory.", Usage);
                var export = await core.PostAsync<ExportResult>("skills/exports", new ExportRequest(name, skills.Distinct(StringComparer.Ordinal).ToArray()))
                    ?? throw new InvalidOperationException("Core did not return a skill export.");
                if (link is not null)
                {
                    var info = new DirectoryInfo(link);
                    if (info.LinkTarget is { } previous)
                    {
                        if (System.IO.Path.GetFullPath(previous, System.IO.Path.GetDirectoryName(link)!) != System.IO.Path.GetFullPath(export.Path))
                            throw new CommandUsageException("The link destination belongs to another export. Choose a different path.", Usage);
                    }
                    else
                    {
                        Directory.CreateDirectory(System.IO.Path.GetDirectoryName(link)!);
                        Directory.CreateSymbolicLink(link, export.Path);
                    }
                }
                context.Console.Profile.Out.Writer.WriteLine(CliJson.Serialize(export));
                return 0;
            case "release" when args.Length == 2:
                _ = await core.DeleteAsync<JsonElement>($"skills/exports/{Uri.EscapeDataString(args[1])}");
                return 0;
            default: throw new CommandUsageException("Unknown skills command.", Usage);
        }
    }

    private async Task<int> ListAsync(string[] args)
    {
        var format = args switch
        {
            [] => "table",
            ["--format", "table"] => "table",
            ["--format", "json"] => "json",
            _ => throw new CommandUsageException("skills list accepts --format table|json.", Usage),
        };
        using var core = await CoreControlClient.TryCreateAsync(context) ?? throw new CoreNotRunningException();
        var catalog = await core.GetAsync<JsonElement>("skills/");
        if (format == "json")
        {
            context.Console.Profile.Out.Writer.WriteLine(catalog.GetRawText());
            return 0;
        }

        RenderSkills(catalog);
        return 0;
    }

    private async Task<int> AddAsync(string[] args)
    {
        if (args.Length == 0 || !Uri.TryCreate(args[0], UriKind.Absolute, out var repository) ||
            repository.Scheme is not ("http" or "https") || !string.IsNullOrEmpty(repository.UserInfo) ||
            !string.IsNullOrEmpty(repository.Query) || !string.IsNullOrEmpty(repository.Fragment))
            throw new CommandUsageException("skills add requires an HTTP(S) Git repository URL without credentials.", Usage);
        var names = new List<string>();
        var reference = "HEAD";
        var path = "";
        var format = "table";
        for (var index = 1; index < args.Length; index += 2)
        {
            var option = args[index];
            if (option is not ("--skill" or "--ref" or "--path" or "--format"))
                throw new CommandUsageException($"Unknown skills add option '{option}'.", Usage);
            if (index + 1 >= args.Length || string.IsNullOrWhiteSpace(args[index + 1]) || args[index + 1].StartsWith("--", StringComparison.Ordinal))
                throw new CommandUsageException($"{option} requires a value.", Usage);
            var value = args[index + 1];
            switch (option)
            {
                case "--skill": names.Add(value); break;
                case "--ref": reference = value; break;
                case "--path": path = value; break;
                case "--format": format = value; break;
            }
        }
        var selected = names.Distinct(StringComparer.Ordinal).ToArray();
        if (selected.Length is 0 or > 200)
            throw new CommandUsageException("skills add requires between one and 200 distinct --skill names.", Usage);
        if (format is not ("table" or "json"))
            throw new CommandUsageException("skills add --format must be table or json.", Usage);

        using var core = await CoreControlClient.TryCreateAsync(context) ?? throw new CoreNotRunningException();
        var source = new GitSource(args[0], reference, path);
        var discovery = await core.PostAsync<SelectionResult>("skills/discover", new SelectionRequest(source, selected))
            ?? throw new InvalidOperationException("Core did not return a skill selection.");
        var installed = await core.PostAsync<JsonElement>("skills/install", new SelectedInstallRequest(source, discovery.Commit, selected));
        if (format == "json") context.Console.Profile.Out.Writer.WriteLine(installed.GetRawText());
        else
        {
            context.Console.WriteLine($"Installed {installed.GetProperty("skills").GetArrayLength()} skill(s).");
            RenderSkills(installed);
        }
        return 0;
    }

    private void RenderSkills(JsonElement catalog)
    {
        var skills = catalog.GetProperty("skills");
        if (skills.GetArrayLength() == 0)
        {
            context.Console.MarkupLine("[grey]No skills installed.[/]");
            return;
        }

        var table = ConsoleUi.CreateTable("Skill", "Source", "Description");
        foreach (var skill in skills.EnumerateArray())
        {
            var description = string.Join(" ", (skill.GetProperty("description").GetString() ?? "")
                .Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries));
            if (description.Length > 120) description = description[..117] + "...";
            table.AddRow(
                Markup.Escape(skill.GetProperty("name").GetString() ?? ""),
                Markup.Escape(skill.GetProperty("sourceKind").GetString() ?? ""),
                Markup.Escape(description));
        }
        context.Console.Write(table);
    }
}
