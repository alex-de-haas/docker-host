using System.Text.Json.Serialization;
using Haas.Hosty.Launch;

namespace Haas.Hosty.Releases;

internal sealed record PlatformUpdateAcceptance(string Id, string OfferId, string Root,
    PlatformReleaseSelection Selection, DateTimeOffset AcceptedAt, string Status = "accepted", string? Error = null);

[JsonSourceGenerationOptions(PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase, RespectNullableAnnotations = true)]
[JsonSerializable(typeof(PlatformUpdateAcceptance))]
internal partial class PlatformAcceptanceJson : JsonSerializerContext;

internal static class PlatformAcceptedUpdates
{
    public static string PathFor(string root, string id)
    {
        if (!Guid.TryParseExact(id, "N", out _)) throw new ArgumentException("Update request ID must be a UUID without hyphens.");
        return Path.Combine(root, "core", "accepted-updates", id + ".json");
    }
    public static PlatformUpdateAcceptance? Pending(string root)
    {
        var directory = Path.Combine(root, "core", "accepted-updates");
        if (!Directory.Exists(directory)) return null;
        var pending = Directory.EnumerateFiles(directory, "*.json")
            .Select(path => CoreLaunchFiles.Read(path, PlatformAcceptanceJson.Default.PlatformUpdateAcceptance))
            .Where(item => item is not null && item.Status != "completed").ToArray();
        if (pending.Length > 1) throw new InvalidOperationException("Several accepted platform updates need recovery; inspect their receipts.");
        return pending.SingleOrDefault();
    }
    public static PlatformUpdateAcceptance? Read(string root, string id)
        => CoreLaunchFiles.Read(PathFor(root, id), PlatformAcceptanceJson.Default.PlatformUpdateAcceptance);
}
