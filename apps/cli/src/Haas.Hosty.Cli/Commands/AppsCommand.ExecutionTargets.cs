using System.Text.Json;

namespace Haas.Hosty.Cli.Commands;

internal sealed partial class AppsCommand
{
    internal sealed record AppExecutionTargetRequest(string RequestId, string Kind, string? Runtime = null,
        string? WorkspaceId = null, string? WorktreeId = null);

    private async Task<int> ExecutionTargetAsync(string[] args, string action)
    {
        if (args.Length == 0) throw new CommandUsageException("Supply an app id.", Usage);
        string? runtime = null, workspace = null, worktree = null, request = null;
        var package = false;
        for (var i = 1; i < args.Length; i++)
            switch (args[i])
            {
                case "--runtime": runtime = RequireOptionValue(args, ref i, "--runtime"); break;
                case "--workspace": workspace = RequireOptionValue(args, ref i, "--workspace"); break;
                case "--worktree": worktree = RequireOptionValue(args, ref i, "--worktree"); break;
                case "--request-id": request = RequireOptionValue(args, ref i, "--request-id"); break;
                case "--package": package = true; break;
                default: throw new CommandUsageException($"Unknown execution-target argument '{args[i]}'.", Usage);
            }
        if (action == "select" && (package == (workspace is not null) || request is null ||
                !Guid.TryParseExact(request, "D", out _) || package && worktree is not null))
            throw new CommandUsageException("Choose --package or --workspace <id>, and supply --request-id <uuid>. Preserve that ID for recovery.", Usage);
        if (action == "status" && (request is null || !Guid.TryParseExact(request, "D", out _)))
            throw new CommandUsageException("Supply the original --request-id <uuid>.", Usage);
        using var core = await OpenCoreAsync();
        var route = $"apps/{Uri.EscapeDataString(args[0])}/execution-target";
        var result = action == "select"
            ? await core.PostAsync<JsonElement>(route, new AppExecutionTargetRequest(request!, package ? "package" : "workspace", runtime, workspace, worktree))
            : await core.GetAsync<JsonElement>(action == "status" ? route + "/" + request : route + "s");
        context.Console.Profile.Out.Writer.WriteLine(result.GetRawText());
        return 0;
    }
}
