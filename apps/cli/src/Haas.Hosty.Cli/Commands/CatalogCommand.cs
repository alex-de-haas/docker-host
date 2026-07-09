namespace Haas.Hosty.Cli.Commands;

using System.Net;
using System.Text.Json.Serialization;
using Spectre.Console;

// Browses the marketplace catalog and manages catalog sources (WS4 + WS7). Talks to the Core control
// endpoints (/control/v1/catalog/*). Install reuses the existing reviewed install path: it resolves a
// feed's manifestRef from the catalog entry, then posts it to apps/install — the catalog installs
// nothing itself. Source edits are runtime-mutable and take effect on the next fetch, no Core restart.
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
        if (detail.Installed)
        {
            table.Field("Feed", detail.FollowedFeedId ?? "not set");
        }

        if (detail.UpdateAvailable)
        {
            table.Field("Update", $"available (feed {detail.FollowedFeedId})");
        }

        context.Console.Write(table);

        if (detail.Feeds.Count == 0)
        {
            context.Console.MarkupLine("[grey]No feeds declared — the app is not installable from the catalog.[/]");
            return 0;
        }

        var feeds = ConsoleUi.CreateTable("Feed", "Default", "Manifest");
        foreach (var feed in detail.Feeds)
        {
            feeds.AddRow(
                Markup.Escape(feed.Id),
                feed.Default ? "yes" : "[grey]—[/]",
                Markup.Escape(feed.ManifestRef));
        }

        context.Console.Write(feeds);
        context.Console.MarkupLine($"[grey]Install with [white]hosty catalog install {Markup.Escape(detail.Id)}[/].[/]");
        return 0;
    }

    private async Task<int> InstallAsync(string[] args)
    {
        var options = ParseInstallOptions(args);
        using var core = await OpenCoreAsync();
        var detail = await GetDetailAsync(core, options.Id);
        var feed = ResolveFeed(detail, options.Feed);

        var response = await core.PostAsync<AppsCommand.AppLifecycleResponse>(
            "apps/install",
            new AppsCommand.AppInstallRequest(
                ManifestPath: feed.ManifestRef,
                SelectedRuntime: options.SelectedRuntime,
                System: false,
                Autostart: options.Autostart,
                CatalogFeedId: feed.Id));
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

    // Resolves the feed to install from (catalog-hosted-app-feeds.md A4): an explicit --feed, else the
    // default-flagged feed, else the sole one. Refuses to guess among several unflagged feeds.
    private static CatalogAppFeed ResolveFeed(CatalogAppDetailResponse detail, string? requestedFeed)
    {
        if (detail.Feeds.Count == 0)
        {
            throw new CommandUsageException($"Catalog app '{detail.Id}' declares no feeds.");
        }

        if (requestedFeed is { Length: > 0 })
        {
            return detail.Feeds.FirstOrDefault(feed => string.Equals(feed.Id, requestedFeed, StringComparison.Ordinal))
                ?? throw new CommandUsageException(
                    $"Feed '{requestedFeed}' is not declared for '{detail.Id}'. Available: {string.Join(", ", detail.Feeds.Select(feed => feed.Id))}.");
        }

        var fallback = detail.Feeds.FirstOrDefault(feed => feed.Default);
        return fallback
            ?? throw new CommandUsageException(
                $"'{detail.Id}' declares several feeds and none is the default; pass --feed. Available: {string.Join(", ", detail.Feeds.Select(feed => feed.Id))}.");
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

    private InstallOptions ParseInstallOptions(string[] args)
    {
        string? id = null;
        string? feed = null;
        string? selectedRuntime = null;
        bool? autostart = null;

        for (var index = 0; index < args.Length; index++)
        {
            switch (args[index])
            {
                case "--feed":
                    feed = RequireOptionValue(args, ref index, "--feed");
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

        return new InstallOptions(id, feed, selectedRuntime, autostart);
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
          show <id>                  Show one app's detail and declared feeds
          install <id> [--feed <id>] [--runtime <key>] [--autostart|--no-autostart]

        Sources (federation):
          sources [list]             List configured catalog sources
          sources add <url>          Add an http(s) URL or absolute path to a catalog.json
          sources remove <url>       Remove a configured source

        Sources are seeded from HOSTY_CATALOG_SOURCES and become runtime-managed on the first
        add/remove (no Core restart). Install resolves a feed's manifest head (the default feed
        when --feed is omitted) and reuses the normal reviewed install path.
        """;

    private sealed record InstallOptions(string Id, string? Feed, string? SelectedRuntime, bool? Autostart);

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
        IReadOnlyList<CatalogAppFeed> Feeds,
        bool Installed,
        string? InstalledVersion,
        string? FollowedFeedId,
        bool UpdateAvailable);

    internal sealed record CatalogAppFeed(string Id, string ManifestRef, bool Default);

    internal sealed record CatalogSourcesResponse(IReadOnlyList<CatalogSourceSummary> Sources, bool Managed);

    internal sealed record CatalogSourceSummary(string Url, string Name);

    internal sealed record CatalogSourceUpsertRequest(string Url);
}
