namespace Haas.Hosty.Core;

/// <summary>Compares host bindings with canonical paths reported by Docker Desktop.</summary>
internal static class DockerMountPaths
{
    internal static bool Equivalent(string actual, string expected, bool? macDesktop = null)
        => string.Equals(NormalizeActual(actual, expected, macDesktop), Normalize(expected), Comparison(expected));

    internal static bool Overlaps(string actual, string expected, bool? macDesktop = null)
    {
        var source = NormalizeActual(actual, expected, macDesktop);
        var target = Normalize(expected);
        var comparison = Comparison(expected);
        return string.Equals(source, target, comparison) || source.StartsWith(target + "/", comparison)
            || target.StartsWith(source + "/", comparison);
    }

    private static bool Windows(string path) => path.Length >= 3 && char.IsAsciiLetter(path[0]) && path[1] == ':' && path[2] is '\\' or '/';
    private static StringComparison Comparison(string expected) => Windows(expected) ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal;
    private static string Normalize(string path) => path.Replace('\\', '/').TrimEnd('/');
    private static string NormalizeActual(string actual, string expected, bool? macDesktop)
    {
        var value = Normalize(actual);
        if (Windows(expected))
        {
            foreach (var prefix in new[] { "/run/desktop/mnt/host/", "/host_mnt/" })
                if (value.StartsWith(prefix, StringComparison.Ordinal) && value.Length > prefix.Length + 1
                    && char.IsAsciiLetter(value[prefix.Length]) && value[prefix.Length + 1] == '/')
                    return value[prefix.Length] + ":" + value[(prefix.Length + 1)..];
        }
        else if ((macDesktop ?? OperatingSystem.IsMacOS()) && value.StartsWith("/host_mnt/", StringComparison.Ordinal))
            return value["/host_mnt".Length..];
        return value;
    }
}
