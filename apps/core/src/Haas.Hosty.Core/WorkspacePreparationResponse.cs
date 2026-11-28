using System.Text.Json;
using System.Text.Json.Nodes;

namespace Haas.Hosty.Core;

internal static class WorkspacePreparationResponse
{
    internal static DevelopmentWorkspace? Representative(WorkspacePreparationResult result)
        => result.Primary ?? result.Worktrees.FirstOrDefault();

    internal static async Task<JsonObject> ProjectAsync(DevelopmentWorkspaceService service, WorkspacePreparationResult result,
        WorkspaceOwner actor, CancellationToken ct)
    {
        var worktrees = new List<DevelopmentWorkspace>(result.Worktrees.Length);
        foreach (var tree in result.Worktrees)
            worktrees.Add(await service.SessionProjectionAsync(tree, actor, ct));

        var representative = worktrees.FirstOrDefault(t => t.Id == Representative(result)?.Id);
        var response = representative is null ? new JsonObject()
            : JsonSerializer.SerializeToNode(representative, CoreJson.TypeInfo<DevelopmentWorkspace>())!.AsObject();
        if (result.UsesNamedSources)
        {
            response["workspaceId"] = result.WorkspaceId;
            response["preparation"] = new JsonObject
            {
                ["complete"] = result.Complete,
                ["worktrees"] = Serialize(worktrees.ToArray()),
                ["failures"] = Serialize(result.Failures),
                ["leases"] = Serialize(result.Leases)
            };
        }
        return response;
    }

    private static JsonNode? Serialize<T>(T value)
        => JsonSerializer.SerializeToNode(value, CoreJson.TypeInfo<T>());
}
