using HostySdk.App;

namespace Haas.Hosty.TelemetryBackend.Query;

/// <summary>Authentication for the MCP surface only; MCP grants do not authorize ordinary reads.</summary>
internal sealed class TelemetryMcpAuth(TelemetryCallerAuth legacy, HostyScopedTokenClient tokens)
{
    public async Task<IResult?> AuthorizeAsync(string? authorization, string? tool, CancellationToken cancellationToken = default)
    {
        // Preserve the existing intra-app and short-lived CLI credentials. They are signed for
        // this app, and Core only issues this system app's delegated tokens to administrators.
        if (legacy.Authenticate(authorization) is not null) return null;
        var token = HostyDelegatedToken.ReadBearer(authorization);
        if (string.IsNullOrWhiteSpace(token)) return Unauthorized();

        try
        {
            // Never cache: revocation and changes to assistant-target access apply to every call,
            // including tools/list and initialized notifications on an existing connection.
            var caller = await tokens.IntrospectMcpAsync(token, tool, cancellationToken);
            if (!caller.Active) return Unauthorized();
            if (!caller.HasScope(HostyScopedTokenClient.McpReadScope) || caller.Role != "host.admin")
                return Results.Json(new { code = "telemetry_forbidden", message = "Telemetry MCP reads require administrator access and mcp:read." }, statusCode: 403);
            return null;
        }
        catch (HostyScopedTokenException)
        {
            return Results.Json(new { code = "telemetry_auth_unavailable", message = "Hosty Core could not verify the MCP credential. Try again when Core is available." }, statusCode: 503);
        }
    }

    private static IResult Unauthorized() => Results.Json(new { code = "telemetry_unauthorized",
        message = "Telemetry MCP requires a valid credential issued for this app." }, statusCode: 401);
}
