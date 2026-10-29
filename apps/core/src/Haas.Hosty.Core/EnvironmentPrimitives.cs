using System.Security.Cryptography;
using System.Text;

namespace Haas.Hosty.Core;

// Workspace/session identifiers are optional context. The verified caller and target/input
// references are the authorization boundary for every client, including background jobs.
internal sealed record SandboxActor(string UserId, string? AppId = null, DateTimeOffset? Installation = null,
    string? GrantId = null, string? ScopeId = null)
{
    // Server-only authority for deleting resources belonging to an admitted workspace.
    // Never accepted from a JSON client or persisted as a transferable credential.
    [System.Text.Json.Serialization.JsonIgnore]
    public string? DeletingWorkspace { get; init; }
    [System.Text.Json.Serialization.JsonIgnore]
    public WorkspaceOwner? DeletingOwner { get; init; }
    internal bool CanDeleteResource(SandboxActor owner, SandboxContext? context)
        => DeletingWorkspace is { } id && DeletingOwner is { } allocation
            && DevelopmentWorkspaceService.WorkspaceIdFor(allocation) == id
            && WorkspaceCleanupService.Belongs(owner, context, allocation, id);

    [System.Text.Json.Serialization.JsonIgnore]
    public string Key => SandboxValidation.Hash(CoreJson.Text(this));
    public bool SameOwner(SandboxActor other) => UserId == other.UserId && AppId == other.AppId && Installation == other.Installation
        && (GrantId is null || (GrantId == other.GrantId && ScopeId == other.ScopeId));
}
internal sealed record SandboxContext(string? WorkspaceId = null, string? SessionId = null, string? JobId = null);

internal sealed class SandboxException(string code, string message, int status = 409) : Exception(message)
{
    public string Code { get; } = code;
    public int Status { get; } = status;
}

internal static class SandboxValidation
{
    public static string Hash(string value) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(value))).ToLowerInvariant();
    public static void Id(string value)
    {
        if (!Guid.TryParseExact(value, "N", out _)) throw new SandboxException("sandbox_id_invalid", "Use a Core-issued sandbox ID.", 400);
    }
    public static void Request(string value)
    {
        if (!Guid.TryParse(value, out _)) throw new SandboxException("sandbox_request_invalid", "A request UUID is required.", 400);
    }
    public static void Text(string value, int max, string field)
    {
        if (string.IsNullOrWhiteSpace(value) || value.Length > max || value.Any(char.IsControl) || value != value.Trim())
            throw new SandboxException("sandbox_input_invalid", $"Invalid {field}.", 400);
    }
}
