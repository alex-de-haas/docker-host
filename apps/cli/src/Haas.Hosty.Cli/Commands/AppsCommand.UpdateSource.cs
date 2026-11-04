using System.Text.Json;

namespace Haas.Hosty.Cli.Commands;

internal sealed partial class AppsCommand
{
    internal sealed record AppUpdateSourcePlanRequest(string? FeedsUrl = null, string? FeedId = null, string? ExpectedRevision = null, string? MigrationId = null, string? ManifestUrl = null);
    internal sealed record AppUpdateSourceApplyRequest(string PlanDigest, string RequestId);
    internal sealed record AppUpdateSourceBatchItem(string AppId, string PlanDigest);
    internal sealed record AppUpdateSourceBatchRequest(string RequestId, IReadOnlyList<AppUpdateSourceBatchItem> Items);

    private async Task<int> UpdateSourceAsync(string[] args)
    {
        if (args.Length == 0) throw new CommandUsageException("Use update-source list, plan, apply, operation or batch.", Usage);
        var action = args[0];
        string? appId = null, feeds = null, feed = null, revision = null, migration = null, plan = null, request = null, file = null, manifest = null;
        var cursor = 1;
        if (action is "plan" or "apply" or "operation")
        {
            if (args.Length < 2 || args[1].StartsWith('-')) throw new CommandUsageException("Supply an app ID.", Usage);
            appId = args[cursor++];
        }
        for (var index = cursor; index < args.Length; index++)
            switch (args[index])
            {
                case "--manifest": manifest = RequireOptionValue(args, ref index, "--manifest"); break;
                case "--index": feeds = RequireOptionValue(args, ref index, "--index"); break;
                case "--feed": feed = RequireOptionValue(args, ref index, "--feed"); break;
                case "--revision": revision = RequireOptionValue(args, ref index, "--revision"); break;
                case "--migration": migration = RequireOptionValue(args, ref index, "--migration"); break;
                case "--plan": plan = RequireOptionValue(args, ref index, "--plan"); break;
                case "--request-id": request = RequireOptionValue(args, ref index, "--request-id"); break;
                case "--file": file = RequireOptionValue(args, ref index, "--file"); break;
                default: throw new CommandUsageException($"Unknown source-switch option '{args[index]}'.", Usage);
            }
        if (request is not null && Guid.TryParse(request, out var id)) request = id.ToString("N");
        if (action is "apply" or "operation" && (request is null || !Guid.TryParseExact(request, "N", out _)))
            throw new CommandUsageException("Supply and retain --request-id <uuid> for source-switch recovery.", Usage);
        using var core = await OpenCoreAsync();
        var route = appId is null ? "apps/update-source" : $"apps/{Uri.EscapeDataString(appId)}/update-source";
        JsonElement result;
        switch (action)
        {
            case "list" when args.Length == 1:
                result = await core.GetAsync<JsonElement>(route + "/suggestions"); break;
            case "plan" when (manifest is not null && feeds is null && feed is null || manifest is null && feeds is not null && feed is not null) && plan is null && request is null && file is null:
                result = await core.PostAsync<JsonElement>(route + "/plan", new AppUpdateSourcePlanRequest(feeds, feed, revision, migration, manifest)); break;
            case "apply" when manifest is null && plan is not null && feeds is null && feed is null && file is null && revision is null && migration is null:
                result = await core.PostAsync<JsonElement>(route + "/apply", new AppUpdateSourceApplyRequest(plan, request!)); break;
            case "operation" when manifest is null && plan is null && feeds is null && feed is null && file is null && revision is null && migration is null:
                result = await core.GetAsync<JsonElement>(route + "/operations/" + request); break;
            case "batch" when file is not null && args.Length == 3 && request is null:
                if (new FileInfo(file).Length > 1024 * 1024) throw new CommandUsageException("Source batch exceeds 1 MiB.", Usage);
                var batch = JsonSerializer.Deserialize(await File.ReadAllTextAsync(file), AppsJsonContext.Default.AppUpdateSourceBatchRequest)
                    ?? throw new CommandUsageException("Source batch must contain requestId and reviewed appId/planDigest items.", Usage);
                result = await core.PostAsync<JsonElement>(route + "/apply", batch); break;
            default: throw new CommandUsageException("Invalid source-switch arguments. Plan first, review the returned bindings, then apply that exact digest.", Usage);
        }
        context.Console.Profile.Out.Writer.WriteLine(result.GetRawText());
        return 0;
    }
}
