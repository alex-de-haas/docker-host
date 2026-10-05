using ModelContextProtocol.Client;
using ModelContextProtocol.Protocol;

namespace Haas.Hosty.Core;

internal sealed record AssistantMcpCatalog(IReadOnlyList<Tool> Tools);

// This endpoint accepts a target ID, never an upstream URL, RPC method, tool name or arguments.
// The short-lived discovery credential travels only from Core to the registered MCP endpoint.
internal static class AssistantMcpDiscovery
{
    internal static void Map(WebApplication app) => app.MapPost("/api/internal/apps/{appId}/mcp/catalog/{targetId}", async (
        string appId, string targetId, HttpRequest request, AssistantMcpAccess access,
        AgentMcpDirectory directory, CancellationToken ct) =>
    {
        try
        {
            var token = await access.IssueAsync(appId, targetId, CoreSessionAuthorization.ReadBearerToken(request),
                request.Headers["X-Hosty-User-Token"].ToString(), ct, discoveryOnly: true);
            var snapshot = await directory.ReadForAssistantAsync(appId, ct);
            var target = snapshot.Targets.FirstOrDefault(t => t.Id == targetId && t.Offered);
            var endpoint = target?.Interfaces.FirstOrDefault(i => i.Key == "default" && i.Readiness == "ready")
                ?? target?.Interfaces.FirstOrDefault(i => i.Readiness == "ready");
            if (endpoint?.Url is null)
                return CoreJson.Json(new ErrorResponse("mcp_unavailable", "The MCP target is not ready."), 503);
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
            timeout.CancelAfter(TimeSpan.FromSeconds(20));
            using var client = new HttpClient(new HttpClientHandler { AllowAutoRedirect = false });
            return CoreJson.Json(await ReadCatalogAsync(new Uri(endpoint.Url), token.Token, client, timeout.Token));
        }
        catch (AppIdentityException ex) { return CoreJson.Json(new ErrorResponse(ex.Code, ex.Message), ex.Code is "token_invalid" or "reauth_required" ? 401 : 403); }
        catch (Exception ex) when (ex is HttpRequestException or OperationCanceledException or ModelContextProtocol.McpException or InvalidOperationException)
        { return CoreJson.Json(new ErrorResponse("mcp_catalog_unavailable", "The tool catalog could not be read. Existing rules are unchanged."), 503); }
    });
    internal static async Task<AssistantMcpCatalog> ReadCatalogAsync(Uri endpoint, string token, HttpClient client, CancellationToken ct)
    {
        await using var transport = new HttpClientTransport(new()
        {
            Endpoint = endpoint, TransportMode = HttpTransportMode.StreamableHttp,
            AdditionalHeaders = new Dictionary<string, string> { ["Authorization"] = "Bearer " + token },
        }, client);
        // Use the initialize handshake supported by runtime apps and the discovery method allowlist.
        await using var mcp = await McpClient.CreateAsync(transport,
            new McpClientOptions { ProtocolVersion = "2025-06-18" }, cancellationToken: ct);
        var tools = new List<Tool>();
        string? cursor = null;
        for (var page = 0; page < 20; page++)
        {
            var result = await mcp.ListToolsAsync(new ListToolsRequestParams { Cursor = cursor }, ct);
            tools.AddRange(result.Tools);
            if (tools.Count > 1000) break;
            cursor = result.NextCursor;
            if (cursor is null) return new AssistantMcpCatalog(tools);
        }
        throw new InvalidOperationException("The tool catalog exceeds the supported limit.");
    }
}
