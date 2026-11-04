using Haas.Hosty.Launch;
using Haas.Hosty.Releases;
using System.Text.Json;
using System.Text.Json.Serialization;
using Spectre.Console;

namespace Haas.Hosty.Cli.Commands;

internal sealed partial class UpdateCommand(CommandContext context)
{
    [JsonSourceGenerationOptions(PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase)]
    [JsonSerializable(typeof(CoreStatusDocument))]
    [JsonSerializable(typeof(ProductChannelIndex))]
    [JsonSerializable(typeof(ProductChannel))]
    internal partial class UpdateJsonContext : JsonSerializerContext;

    public async Task<int> ExecuteAsync(string[] args)
    {
        var options = ParseOptions(args);
        using var client = new HttpClient { Timeout = Timeout.InfiniteTimeSpan };
        var reader = new PlatformReleaseReader(client);
        if (options.ListFeeds) return await ListFeedsAsync(reader, options.IndexRef);
        var executable = Environment.ProcessPath;
        if (executable is null || !SelfUpdateService.IsManagedExecutableName(Path.GetFileName(executable)))
            throw new InvalidOperationException("Run the installed hosty executable to update the CLI/Core pair.");
        if (options.FeedId is null && options.IndexRef is null && options.OperationId is null
            && PlatformFeedFiles.ReadSource(context.Environment.RootDirectory) is null && PlatformLegacyPins.Read(executable) is { } pin)
        {
            if (!SelfUpdateService.CurrentExecutableMatches(executable, pin.CliSha256)) throw new InvalidOperationException("The CLI differs from its explicit legacy pin.");
            context.Console.WriteLine($"This installation is pinned to {pin.Repository}@{pin.Tag}. Select a feed explicitly to change its update source.");
            return 0;
        }
        using var executableLock = PlatformUpdateTransaction.LockExecutable(executable);
        using var launchLock = CoreLaunchFiles.Lock(context.Environment.RootDirectory);
        var accepted = options.OperationId is null ? PlatformAcceptedUpdates.Pending(context.Environment.RootDirectory)
            : PlatformAcceptedUpdates.Read(context.Environment.RootDirectory, options.OperationId)
                ?? throw new InvalidOperationException("The accepted platform update was not found.");
        if (accepted?.Status == "completed") { context.Console.WriteLine("This platform update already completed."); return 0; }
        var pending = PlatformUpdateTransaction.Pending(context.Environment.RootDirectory);
        CoreLaunchFiles.AssertNoPendingOperations(context.Environment.RootDirectory, ownPlatformUpdateId: pending?.Id ?? accepted?.Id);
        PlatformReleaseSelection? selection = null;
        if (pending is not null)
        {
            if (options.FeedId is not null || options.IndexRef is not null)
                throw new CommandUsageException("Resume the pending frozen update with 'hosty update' before selecting another source.", Usage);
            context.Console.WriteLine($"Resuming platform update {pending.Id} for release {pending.Selection.Release.ReleaseId}.");
        }
        else if (accepted is not null)
        {
            if (options.FeedId is not null || options.IndexRef is not null)
                throw new CommandUsageException("Resume the accepted update before selecting another source.", Usage);
            selection = accepted.Selection;
        }
        else
        {
            selection = await PlatformFeedSource.ResolveAsync(reader, context.Environment.RootDirectory,
                options.FeedId, options.IndexRef, executable, sourceLockHeld: true);
            var saved = PlatformFeedSource.PersistSelection(context.Environment.RootDirectory, selection);
            selection = selection with { Source = saved };
            context.Console.WriteLine($"Updating CLI and Core from feed '{saved.FeedId}', release {selection.Release.ReleaseId}, version {selection.Release.Version}.");
            if (!Version.TryParse(selection.Release.Version, out var target) || !Version.TryParse(CommandLine.Version, out var current)
                || target < current || target == current && !await PlatformReleaseReader.MatchesAssetAsync(executable,
                    PlatformReleaseReader.Asset(selection.Release, "cli", PlatformFeedSource.CurrentRid), default))
            {
                context.Console.WriteLine("The selected feed has no eligible forward update for this installation. Its source was saved; the installed binaries remain in place.");
                return 0;
            }
        }
        try
        {
            var operation = await new PlatformUpdateTransaction(reader, new UpdateHost(context)).ExecuteAsync(
                context.Environment.RootDirectory, executable, CoreInstallationService.GetInstalledExecutablePath(context.Environment), selection, requestId: accepted?.Id);
            context.Console.WriteLine($"CLI/Core release {operation.Selection.Release.Version} installed and verified.");
            if (operation.PreviousCore?.Launch.Mode == "dev") context.Console.WriteLine("The development Core remains running from its selected project.");
            else if (operation.PreviousCore is null) context.Console.WriteLine("Core remains stopped. Start it with 'hosty core start'.");
            return 0;
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException or InvalidOperationException or HttpRequestException or OperationCanceledException)
        {
            context.Error.WriteLine($"Platform update failed: {error.Message}");
            context.Error.WriteLine($"Recovery journal: {PlatformUpdateTransaction.JournalPath(context.Environment.RootDirectory)}. Resume the same release with 'hosty update'.");
            return 1;
        }
    }

    internal async Task<int> FeedAsync(string[] args)
    {
        var feed = args.Length > 0 && !args[0].StartsWith('-') ? args[0] : null;
        var options = ParseOptions(feed is null ? args : args[1..]);
        if (options.FeedId is not null || options.OperationId is not null) throw new CommandUsageException("Use 'hosty core feed <id>' to select a feed.", Usage);
        using var client = new HttpClient();
        var reader = new PlatformReleaseReader(client);
        if (feed is null)
        {
            var saved = PlatformFeedFiles.ReadSource(context.Environment.RootDirectory);
            context.Console.WriteLine(saved is null ? "No platform update feed is selected." : $"Feed: {saved.FeedId}\nIndex: {saved.IndexRef}\nRevision: {saved.Revision}");
            return await ListFeedsAsync(reader, options.IndexRef);
        }
        using var launchLock = CoreLaunchFiles.Lock(context.Environment.RootDirectory);
        CoreLaunchFiles.AssertNoPendingOperations(context.Environment.RootDirectory);
        var selection = await PlatformFeedSource.ResolveAsync(reader, context.Environment.RootDirectory, feed, options.IndexRef, Environment.ProcessPath, sourceLockHeld: true);
        var source = PlatformFeedSource.PersistSelection(context.Environment.RootDirectory, selection);
        context.Console.WriteLine($"Selected platform feed '{source.FeedId}' from {source.IndexRef}. Executables were not changed.");
        return 0;
    }

    private async Task<int> ListFeedsAsync(PlatformReleaseReader reader, string? indexRef)
    {
        var saved = PlatformFeedFiles.ReadSource(context.Environment.RootDirectory);
        var (index, _) = await reader.ReadIndexAsync(indexRef ?? saved?.IndexRef ?? PlatformFeedSource.Distribution.IndexRef, allowLegacy: indexRef is not null || saved?.LegacyIndex == true);
        var table = ConsoleUi.CreateTable("Feed", "Label", "Default", "Selected");
        foreach (var feed in index.Feeds)
            table.AddRow(Markup.Escape(feed.Id), Markup.Escape(feed.Label ?? ""),
                feed.Default || index.Feeds.Count == 1 ? "yes" : "", saved?.FeedId == feed.Id && (indexRef is null || saved.IndexRef == indexRef) ? "yes" : "");
        context.Console.Write(table);
        return 0;
    }

    internal static UpdateOptions ParseOptions(string[] args)
    {
        var list = false;
        string? feed = null, indexRef = null, operationId = null;
        for (var index = 0; index < args.Length; index++)
        {
            if (args[index].StartsWith("--feed=", StringComparison.Ordinal) || args[index].StartsWith("--channel=", StringComparison.Ordinal))
            {
                var explicitFeed = args[index][(args[index].IndexOf('=') + 1)..];
                if (string.IsNullOrWhiteSpace(explicitFeed) || feed is not null && feed != explicitFeed) throw new CommandUsageException("Invalid or conflicting feed selection.", Usage);
                feed = explicitFeed; continue;
            }
            switch (args[index])
            {
                case "--list-feeds": case "--list-channels": list = true; break;
                case "--feed": case "--channel":
                    var value = RequireValue(args, ref index);
                    if (feed is not null && feed != value) throw new CommandUsageException("Conflicting feed/channel selections.", Usage);
                    feed = value; break;
                case "--operation-id":
                    operationId = RequireValue(args, ref index);
                    if (!Guid.TryParseExact(operationId, "N", out _)) throw new CommandUsageException("Invalid update request ID.", Usage);
                    break;
                case "--index":
                    var reference = RequireValue(args, ref index);
                    if (Uri.TryCreate(reference, UriKind.Absolute, out var uri) && !uri.IsFile && uri.Scheme != "https")
                        throw new CommandUsageException("Remote feed indexes must use HTTPS.", Usage);
                    reference = uri?.Scheme == "https" ? reference : Path.GetFullPath(reference);
                    if (indexRef is not null && indexRef != reference) throw new CommandUsageException("Conflicting index selections.", Usage);
                    indexRef = reference; break;
                default: throw new CommandUsageException($"Unknown update option '{args[index]}'.", Usage);
            }
        }
        if (list && feed is not null) throw new CommandUsageException("Listing feeds and selecting a feed are separate operations.", Usage);
        if (operationId is not null && (list || feed is not null || indexRef is not null))
            throw new CommandUsageException("An accepted operation cannot be combined with another source selection.", Usage);
        return new(list, feed, indexRef, operationId);
    }

    private static string RequireValue(string[] args, ref int index)
    {
        if (index + 1 >= args.Length || string.IsNullOrWhiteSpace(args[index + 1]) || args[index + 1].StartsWith("--"))
            throw new CommandUsageException($"{args[index]} requires a value.", Usage);
        return args[++index];
    }

    internal static string NormalizeManifestReference(string manifestPath)
    {
        var reference = manifestPath.Trim();
        return Uri.TryCreate(reference, UriKind.Absolute, out var uri) && (uri.IsFile || uri.Scheme is "https" or "http")
            ? reference : Path.GetFullPath(reference);
    }

    private sealed class UpdateHost(CommandContext context) : IPlatformUpdateHost
    {
        public async Task<PlatformCoreObservation?> ObserveAsync(CancellationToken ct)
        {
            using var core = await CoreControlClient.TryCreateAsync(context, cancellationToken: ct);
            if (core is null)
            {
                if (File.Exists(Path.Combine(context.Environment.RootDirectory, "core", "run", "control.json")))
                    throw new InvalidOperationException("Core discovery could not be verified; refusing to infer that it is stopped.");
                return null;
            }
            var status = await core.GetAsync<CoreStatusDocument>("core/status", ct);
            if (status?.Launch is null || string.IsNullOrWhiteSpace(status.Version) || status.Status != "running")
                throw new InvalidOperationException("The running Core did not return a verifiable process identity/version.");
            return new(status.Launch, status.Version, status.ListenUrl, status.CorePublicOrigin, status.RuntimePublicHost);
        }
        public async Task<bool> StopAsync(CancellationToken ct)
            => await new CoreCommand(context).StopForUpdateAsync() != CoreCommand.CoreUpdateStopOutcome.Failed;
        public async Task<bool> StartAsync(PlatformCoreObservation? previous, CancellationToken ct)
            => await new CoreCommand(context).StartInstalledAsync(previous) == 0;
    }

    internal sealed record CoreStatusDocument(string? Status, string? Version = null, CoreLaunchIdentity? Launch = null,
        string? ListenUrl = null, string? CorePublicOrigin = null, string? RuntimePublicHost = null);
    internal sealed record UpdateOptions(bool ListFeeds, string? FeedId, string? IndexRef, string? OperationId = null);
    // Retained for the explicit legacy-index reader; these are never a production default.
    internal sealed record ProductChannelIndex(IReadOnlyList<ProductChannel> Channels);
    internal sealed record ProductChannel(string Id, string Label, string? CliVersion, string? CoreArtifactPrefix,
        string? ShellManifestPath, string? ReleaseTag = null);
    private const string Usage = """
        Usage:
          hosty update [--feed <id>] [--index <path-or-https-url>]
          hosty update --list-feeds [--index <path-or-https-url>]
          hosty core feed [<id>] [--index <path-or-https-url>]
        Compatibility aliases:
          hosty update [--list-channels] [--channel <id>] [--index <reference>]
        """;
}
