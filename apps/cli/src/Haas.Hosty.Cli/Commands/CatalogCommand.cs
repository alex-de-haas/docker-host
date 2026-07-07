namespace Haas.Hosty.Cli.Commands;

using System.Net;
using System.Text.Json.Serialization;
using Spectre.Console;

// Browses the marketplace catalog and manages catalog sources (WS4 + WS7). Talks to the Core control
// endpoints (/control/v1/catalog/*). Install reuses the existing reviewed install path: it resolves a
// version's manifestRef from the catalog, then posts it to apps/install — the catalog installs nothing
// itself. Source edits are runtime-mutable and take effect on the next fetch, no Core restart.
internal sealed partial class CatalogCommand(CommandContext context)
{
    [JsonSourceGenerationOptions(
        PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase,
        PropertyNameCaseInsensitive = true,
        NumberHandling = JsonNumberHandling.AllowReadingFromString)]
    [JsonSerializable(typeof(CatalogAppsResponse))]
    [JsonSerializable(typeof(CatalogAppDetailResponse))]
    [JsonSerializable(typeof(CatalogSourcesResponse))]
    [JsonSerializable(typeof(CatalogSourceUpsertRequest))]
    internal partial class CatalogJsonContext : JsonSerializerContext;

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
            "show" => await ShowAsync(args[1..]),
            "install" => await InstallAsync(args[1..]),
            "sources" => await SourcesAsync(args[1..]),
            _ => throw new CommandUsageException($"Unknown catalog command '{args[0]}'.", Usage),
        };
    }

    private async Task<int> ListAsync(string[] args)
    {
        if (args.Length > 0)
        {
            throw new CommandUsageException("catalog list does not accept arguments.", Usage);
        }

        using var core = await OpenCoreAsync();
        var response = await core.GetAsync<CatalogAppsResponse>("catalog/apps");
        var apps = response?.Apps ?? [];
        if (apps.Count == 0)
        {
            context.Console.MarkupLine("[grey]No catalog apps found. Configure a source with [white]hosty catalog sources add <url>[/].[/]");
            return 0;
        }

        var table = ConsoleUi.CreateTable("Name", "Id", "Source", "Category", "Installed");
        foreach (var app in apps)
        {
            table.AddRow(
                Markup.Escape(app.Name),
                Markup.Escape(app.Id),
                Markup.Escape(app.SourceName),
                Markup.Escape(app.Category ?? ""),
                app.Installed ? Markup.Escape(app.InstalledVersion ?? "yes") : "[grey]—[/]");
        }

        context.Console.Write(table);
        return 0;
    }

    private async Task<int> ShowAsync(string[] args)
    {
        var id = RequireSingleId(args, "catalog show");
        using var core = await OpenCoreAsync();
        var detail = await GetDetailAsync(core, id);

        var table = ConsoleUi.CreateDetail();
        table.Field("Name", detail.Name);
        table.Field("Id", detail.Id);
        table.Field("Source", detail.SourceName);
        if (detail.Publisher?.Name is { Length: > 0 } publisher)
        {
            table.Field("Publisher", publisher);
        }

        if (detail.Category is { Length: > 0 } category)
        {
            table.Field("Category", category);
        }

        if (detail.Tags.Count > 0)
        {
            table.Field("Tags", string.Join(", ", detail.Tags));
        }

        if (detail.Summary is { Length: > 0 } summary)
        {
            table.Field("Summary", summary);
        }

        table.Field("Installed", detail.Installed ? detail.InstalledVersion ?? "yes" : "no");
        if (detail.UpdateAvailable)
        {
            table.Field("Update", $"available (stable {detail.StableVersion})");
        }

        if (detail.StableVersion is { Length: > 0 } stable)
        {
            table.Field("Stable", stable);
        }

        if (detail.BetaVersion is { Length: > 0 } beta)
        {
            table.Field("Beta", beta);
        }

        context.Console.Write(table);

        if (detail.Versions.Count == 0)
        {
            context.Console.MarkupLine("[grey]No installable versions in the feed.[/]");
            return 0;
        }

        var versions = ConsoleUi.CreateTable("Version", "Artifact", "Manifest");
        foreach (var version in detail.Versions)
        {
            versions.AddRow(
                Markup.Escape(version.Version),
                Markup.Escape(DescribeArtifact(version.Artifact)),
                Markup.Escape(version.ManifestRef));
        }

        context.Console.Write(versions);
        context.Console.MarkupLine($"[grey]Install with [white]hosty catalog install {Markup.Escape(detail.Id)}[/].[/]");
        return 0;
    }

    private async Task<int> InstallAsync(string[] args)
    {
        var options = ParseInstallOptions(args);
        using var core = await OpenCoreAsync();
        var detail = await GetDetailAsync(core, options.Id);
        var manifestRef = ResolveManifestRef(detail, options.Version);

        var response = await core.PostAsync<AppsCommand.AppLifecycleResponse>(
            "apps/install",
            new AppsCommand.AppInstallRequest(
                ManifestPath: manifestRef,
                SelectedRuntime: options.SelectedRuntime,
                System: false,
                Autostart: options.Autostart));
        RenderLifecycle(response);
        return 0;
    }

    private async Task<int> SourcesAsync(string[] args)
    {
        if (args.Length == 0)
        {
            return await SourcesListAsync([]);
        }

        return args[0] switch
        {
            "list" => await SourcesListAsync(args[1..]),
            "add" => await SourcesAddAsync(args[1..]),
            "remove" or "rm" => await SourcesRemoveAsync(args[1..]),
            _ => throw new CommandUsageException($"Unknown catalog sources command '{args[0]}'.", Usage),
        };
    }

    private async Task<int> SourcesListAsync(string[] args)
    {
        if (args.Length > 0)
        {
            throw new CommandUsageException("catalog sources list does not accept arguments.", Usage);
        }

        using var core = await OpenCoreAsync();
        var response = await core.GetAsync<CatalogSourcesResponse>("catalog/sources");
        RenderSources(response);
        return 0;
    }

    private async Task<int> SourcesAddAsync(string[] args)
    {
        var url = RequireSingleId(args, "catalog sources add");
        using var core = await OpenCoreAsync();
        var response = await core.PostAsync<CatalogSourcesResponse>("catalog/sources", new CatalogSourceUpsertRequest(url));
        context.Console.MarkupLine($"[green]added:[/] {Markup.Escape(url)}");
        RenderSources(response);
        return 0;
    }

    private async Task<int> SourcesRemoveAsync(string[] args)
    {
        var url = RequireSingleId(args, "catalog sources remove");
        using var core = await OpenCoreAsync();
        var response = await core.DeleteAsync<CatalogSourcesResponse>($"catalog/sources?url={Uri.EscapeDataString(url)}");
        context.Console.MarkupLine($"[green]removed:[/] {Markup.Escape(url)}");
        RenderSources(response);
        return 0;
    }

    private void RenderSources(CatalogSourcesResponse? response)
    {
        var sources = response?.Sources ?? [];
        if (sources.Count == 0)
        {
            context.Console.MarkupLine("[grey]No catalog sources configured.[/]");
            return;
        }

        var table = ConsoleUi.CreateTable("Source", "Url");
        foreach (var source in sources)
        {
            table.AddRow(Markup.Escape(source.Name), Markup.Escape(source.Url));
        }

        context.Console.Write(table);
        if (response is { Managed: false })
        {
            context.Console.MarkupLine("[grey]Using the default source. Adding or removing one takes over management from [white]HOSTY_CATALOG_SOURCES[/].[/]");
        }
    }

    private void RenderLifecycle(AppsCommand.AppLifecycleResponse? response)
    {
        if (response?.App is null)
        {
            context.Console.MarkupLine($"[green]{Markup.Escape(response?.Status ?? "ok")}[/]");
            return;
        }

        context.Console.MarkupLine($"[green]{Markup.Escape(response.Status)}:[/] {Markup.Escape(response.App.Id)} {Markup.Escape(response.App.Version)}");
        context.Console.MarkupLine($"[grey]Runtime:[/] {Markup.Escape(response.App.SelectedRuntime ?? "none")} / {Markup.Escape(response.App.RuntimeState)}");
    }

    // Resolves the version to install: an explicit --version, else the feed's stable tag, else the sole
    // version when the feed lists exactly one. Refuses to guess among several untagged versions.
    private static string ResolveManifestRef(CatalogAppDetailResponse detail, string? requestedVersion)
    {
        if (detail.Versions.Count == 0)
        {
            throw new CommandUsageException($"Catalog app '{detail.Id}' has no installable versions in its feed.");
        }

        if (requestedVersion is { Length: > 0 })
        {
            var match = detail.Versions.FirstOrDefault(version =>
                string.Equals(version.Version, requestedVersion, StringComparison.Ordinal));
            return match?.ManifestRef
                ?? throw new CommandUsageException(
                    $"Version '{requestedVersion}' is not in the feed for '{detail.Id}'. Available: {string.Join(", ", detail.Versions.Select(version => version.Version))}.");
        }

        if (detail.StableVersion is { Length: > 0 } stable)
        {
            var match = detail.Versions.FirstOrDefault(version =>
                string.Equals(version.Version, stable, StringComparison.Ordinal));
            if (match is not null)
            {
                return match.ManifestRef;
            }
        }

        if (detail.Versions.Count == 1)
        {
            return detail.Versions[0].ManifestRef;
        }

        throw new CommandUsageException(
            $"'{detail.Id}' has no stable version; pass --version. Available: {string.Join(", ", detail.Versions.Select(version => version.Version))}.");
    }

    private async Task<CatalogAppDetailResponse> GetDetailAsync(CoreControlClient core, string id)
    {
        try
        {
            var detail = await core.GetAsync<CatalogAppDetailResponse>($"catalog/apps/{Uri.EscapeDataString(id)}");
            return detail ?? throw new CommandUsageException($"No catalog app '{id}' was found in any configured source.");
        }
        catch (CoreControlException ex) when (ex.StatusCode == HttpStatusCode.NotFound)
        {
            throw new CommandUsageException($"No catalog app '{id}' was found in any configured source.");
        }
    }

    private static string DescribeArtifact(CatalogArtifact? artifact)
    {
        if (artifact?.Kind is not { Length: > 0 } kind)
        {
            return "—";
        }

        var identity = artifact.ImageDigest ?? artifact.Commit ?? artifact.Ref;
        return identity is { Length: > 0 } ? $"{kind} ({identity})" : kind;
    }

    private InstallOptions ParseInstallOptions(string[] args)
    {
        string? id = null;
        string? version = null;
        string? selectedRuntime = null;
        bool? autostart = null;

        for (var index = 0; index < args.Length; index++)
        {
            switch (args[index])
            {
                case "--version":
                    version = RequireOptionValue(args, ref index, "--version");
                    break;
                case "--runtime":
                    selectedRuntime = RequireOptionValue(args, ref index, "--runtime");
                    break;
                case "--autostart":
                    autostart = true;
                    break;
                case "--no-autostart":
                    autostart = false;
                    break;
                default:
                    if (args[index].StartsWith('-'))
                    {
                        throw new CommandUsageException($"Unknown catalog install argument '{args[index]}'.", Usage);
                    }

                    if (id is null)
                    {
                        id = args[index];
                    }
                    else
                    {
                        throw new CommandUsageException($"Unexpected catalog install argument '{args[index]}'.", Usage);
                    }

                    break;
            }
        }

        if (string.IsNullOrWhiteSpace(id))
        {
            throw new CommandUsageException("catalog install requires an app id.", Usage);
        }

        return new InstallOptions(id, version, selectedRuntime, autostart);
    }

    private static string RequireSingleId(string[] args, string command)
    {
        if (args.Length != 1 || args[0].StartsWith('-'))
        {
            throw new CommandUsageException($"{command} requires exactly one argument.", Usage);
        }

        return args[0];
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

    private async Task<CoreControlClient> OpenCoreAsync()
    {
        var core = await CoreControlClient.TryCreateAsync(context);
        if (core is null)
        {
            throw new CoreNotRunningException();
        }

        return core;
    }

    private const string Usage =
        """
        Usage: hosty catalog <command>

        Browse:
          list                       List catalog apps across all configured sources
          show <id>                  Show one app's detail and available versions
          install <id> [--version <v>] [--runtime <key>] [--autostart|--no-autostart]

        Sources (federation):
          sources [list]             List configured catalog sources
          sources add <url>          Add an http(s) URL or absolute path to a catalog.json
          sources remove <url>       Remove a configured source

        Sources are seeded from HOSTY_CATALOG_SOURCES and become runtime-managed on the first
        add/remove (no Core restart). Install resolves a version's manifest and reuses the normal
        reviewed install path.
        """;

    private sealed record InstallOptions(string Id, string? Version, string? SelectedRuntime, bool? Autostart);

    // ---- wire DTOs (Core /control/v1/catalog/* responses; camelCase) ------------------------------

    internal sealed record CatalogAppsResponse(IReadOnlyList<CatalogAppSummary> Apps);

    internal sealed record CatalogAppSummary(
        string Id,
        string Name,
        string? Summary,
        string? Category,
        IReadOnlyList<string> Tags,
        string? Icon,
        CatalogPublisher? Publisher,
        string SourceName,
        bool Installed,
        string? InstalledVersion);

    internal sealed record CatalogPublisher(string? Name, string? Url, string? Email);

    internal sealed record CatalogAppDetailResponse(
        string Id,
        string Name,
        string? Summary,
        string? Category,
        IReadOnlyList<string> Tags,
        string? Icon,
        IReadOnlyList<string> Screenshots,
        CatalogPublisher? Publisher,
        string SourceName,
        string? SignerIdentity,
        string? ReleasesUrl,
        IReadOnlyList<CatalogAppVersion> Versions,
        string? StableVersion,
        string? BetaVersion,
        bool Installed,
        string? InstalledVersion,
        bool UpdateAvailable);

    internal sealed record CatalogAppVersion(string Version, string ManifestRef, CatalogArtifact? Artifact);

    internal sealed record CatalogArtifact(string? Kind, string? ImageDigest, string? Commit, string? Ref, string? BundleHash);

    internal sealed record CatalogSourcesResponse(IReadOnlyList<CatalogSourceSummary> Sources, bool Managed);

    internal sealed record CatalogSourceSummary(string Url, string Name);

    internal sealed record CatalogSourceUpsertRequest(string Url);
}
