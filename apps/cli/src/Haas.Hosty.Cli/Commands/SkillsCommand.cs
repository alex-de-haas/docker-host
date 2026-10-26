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
    internal partial class SkillsJsonContext : JsonSerializerContext;
    internal sealed record ExportRequest(string ContextId, string[] SkillIds);
    internal sealed record ExportResult(string Id, string Path, JsonElement[] Skills);
    private const string Usage = """
        hosty skills list
        hosty skills read <skill-id> [relative-file]
        hosty skills export --context <name> [--skill <skill-id> ...] [--link <directory>]
        hosty skills release <export-id>

        Exports contain current installed files. Missing skill IDs are omitted.
        To provision Codex, link an export to a dedicated HOME/.agents/skills directory.
        An existing directory or unrelated link is never replaced.
        """;

    public async Task<int> ExecuteAsync(string[] args)
    {
        if (args.Length == 0 || args is ["--help"] or ["-h"] or ["help"])
        { context.Console.WriteLine(Usage); return 0; }
        using var core = await CoreControlClient.TryCreateAsync(context) ?? throw new CoreNotRunningException();
        switch (args[0])
        {
            case "list" when args.Length == 1:
                context.Console.Profile.Out.Writer.WriteLine((await core.GetAsync<JsonElement>("skills/")).GetRawText());
                return 0;
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
}
