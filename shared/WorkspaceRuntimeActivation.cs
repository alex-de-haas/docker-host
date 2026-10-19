using System.Text.Json.Serialization;

namespace Haas.Hosty.Launch;

// Local lifecycle composition receipt. Browser/agent admission and supervised reconciliation are
// separate from this local operator primitive. References only; no credentials or application data.
internal sealed record WorkspaceRuntimeActivation(string Id, string WorkspaceId, string UserId,
    string Fingerprint, string CoreInstance, string CoreSourceRevision, string? CoreWorktreeId,
    string? CoreProject, CoreLaunchIdentity PreviousCore, string[] Apps, string Phase,
    string? PreparedExecutable = null, string? Generation = null, string? Snapshot = null, string? Error = null, IReadOnlyDictionary<string, string>? SourceStamps = null);

internal static class WorkspaceRuntimeFiles
{
    internal static string Root(string root) => Path.Combine(root, "core", "workspace-activations");
    internal static string PathFor(string root, string id)
    {
        if (!Guid.TryParseExact(id, "D", out _)) throw new ArgumentException("Use a UUID activation request ID.");
        return Path.Combine(Root(root), id + ".json");
    }
    internal static WorkspaceRuntimeActivation Read(string root, string id) =>
        CoreLaunchFiles.Read(PathFor(root, id), WorkspaceRuntimeJson.Default.WorkspaceRuntimeActivation)
            ?? throw new InvalidOperationException("The workspace activation record is unavailable.");
    internal static void Save(string root, WorkspaceRuntimeActivation value) =>
        CoreLaunchFiles.Write(PathFor(root, value.Id), value, WorkspaceRuntimeJson.Default.WorkspaceRuntimeActivation);
    internal static string ChildId(string id, string appId)
    {
        var hash = System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(id + "\n" + appId));
        return new Guid(hash.AsSpan(0, 16)).ToString("D");
    }
    internal static WorkspaceRuntimeActivation[] List(string root) => !Directory.Exists(Root(root)) ? [] :
        Directory.EnumerateFiles(Root(root), "*.json").Select(file => Read(root, Path.GetFileNameWithoutExtension(file))).ToArray();
}

[JsonSourceGenerationOptions(PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase)]
[JsonSerializable(typeof(WorkspaceRuntimeActivation))]
internal partial class WorkspaceRuntimeJson : JsonSerializerContext;
