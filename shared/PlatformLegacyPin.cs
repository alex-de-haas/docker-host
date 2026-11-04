using Haas.Hosty.Launch;
using System.Text.Json.Serialization;

namespace Haas.Hosty.Releases;

// Compatibility only: a checksum snapshot is an explicit pin, not a ready-release descriptor.
internal sealed record PlatformLegacyPin(string SchemaVersion, string Repository, string Tag, string Rid,
    string CliSha256, string CoreSha256);

[JsonSerializable(typeof(PlatformLegacyPin))]
[JsonSourceGenerationOptions(PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase, RespectNullableAnnotations = true)]
internal partial class PlatformLegacyJson : JsonSerializerContext;

internal static class PlatformLegacyPins
{
    public static string PathFor(string executable) => executable + ".legacy-source.json";
    public static PlatformLegacyPin? Read(string executable)
    {
        var pin = CoreLaunchFiles.Read(PathFor(executable), PlatformLegacyJson.Default.PlatformLegacyPin);
        if (pin is null) return null;
        if (pin.SchemaVersion != "hosty-platform-legacy-pin.0.1" || pin.Rid != PlatformFeedSource.CurrentRid
            || !ArtifactIdentity.IsHash(pin.CliSha256) || !ArtifactIdentity.IsHash(pin.CoreSha256)
            || pin.Repository is null || pin.Repository.Split('/') is not [var owner, var repository] || !SafePart(owner) || !SafePart(repository)
            || !SafePart(pin.Tag))
            throw new PlatformReleaseException("platform_legacy_pin_invalid", "The retained legacy source pin is invalid; select a source explicitly.");
        return pin;
    }
    private static bool SafePart(string? part) => !string.IsNullOrWhiteSpace(part) && !part.Contains("..", StringComparison.Ordinal)
        && part.All(c => char.IsAsciiLetterOrDigit(c) || c is '-' or '_' or '.');
}
