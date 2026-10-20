using System.Reflection;

namespace Haas.Hosty.Launch;

// Captured by the build, never reconstructed from a mutable checkout at runtime.
internal sealed record CoreBuildProvenance(string? Repository, string? Commit, bool? Dirty, string? Project)
{
    public static CoreBuildProvenance Current { get; } = FromAssembly(typeof(CoreBuildProvenance).Assembly);

    internal static CoreBuildProvenance FromAssembly(Assembly assembly)
    {
        var metadata = assembly.GetCustomAttributes<AssemblyMetadataAttribute>()
            .Where(a => a.Key.StartsWith("Hosty.", StringComparison.Ordinal))
            .GroupBy(a => a.Key).ToDictionary(g => g.Key, g => g.First().Value);
        string? Value(string key) => metadata.GetValueOrDefault("Hosty." + key) is { Length: > 0 } value ? value : null;
        var commit = Value("Commit");
        if (commit is null || commit.Length is not (40 or 64) || commit.Any(c => !char.IsAsciiHexDigit(c))) commit = null;
        return new(SafeRepository(Value("Repository")), commit,
            bool.TryParse(Value("Dirty"), out var dirty) ? dirty : null, Value("Project"));
    }

    internal static string? SafeRepository(string? value)
        => value is not null && !value.Any(char.IsControl) && value.IndexOfAny(['\'', '"', ';']) < 0
            && Uri.TryCreate(value, UriKind.Absolute, out var uri) && uri.Scheme is "https" or "http"
            && string.IsNullOrEmpty(uri.UserInfo) && string.IsNullOrEmpty(uri.Query)
            && string.IsNullOrEmpty(uri.Fragment) && !string.IsNullOrEmpty(uri.Host)
            && uri.AbsolutePath.Trim('/').Length > 0
            ? uri.GetLeftPart(UriPartial.Path).TrimEnd('/') : null;
}
