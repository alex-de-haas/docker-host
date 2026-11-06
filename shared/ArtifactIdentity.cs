namespace Haas.Hosty.Releases;

// Shared by platform readers and app manifest validation; identities are never inferred from tags.
internal static class ArtifactIdentity
{
    public static bool IsHash(string? value) => value is { Length: 64 }
        && value.All(c => char.IsAsciiDigit(c) || c is >= 'a' and <= 'f');

    public static bool IsDigest(string? value) => value is not null
        && value.StartsWith("sha256:", StringComparison.Ordinal) && IsHash(value[7..]);

    public static bool IsCommit(string? value) => value is { Length: 40 or 64 }
        && value.All(c => char.IsAsciiDigit(c) || c is >= 'a' and <= 'f');

    public static bool IsRepository(string? value) => !string.IsNullOrEmpty(value)
        && value.Length <= 255 && value[0] != '/' && value[^1] != '/'
        && value.All(c => char.IsAsciiDigit(c) || c is >= 'a' and <= 'z' or '.' or '_' or '-' or ':' or '/')
        && !value[(value.LastIndexOf('/') + 1)..].Contains(':')
        && !value.Split('/').Any(segment => segment is "" or "." or "..");
}
