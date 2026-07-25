using System.Globalization;

namespace Haas.Hosty.Core;

// One running container's resource usage, as reported by a single `docker stats --no-stream` line.
// Fields are nullable so a partially-parseable line still yields what it could.
internal sealed record DockerContainerStat(
    string ContainerName,
    double? CpuPercent,
    double? MemoryBytes,
    double? MemoryPercent);

// Parses the tab-separated output of
//   docker stats --no-stream --format "{{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.MemPerc}}"
// into per-container usage. Core collects these infra metrics itself (its host-level Docker access)
// so the default collector container stays unprivileged — see docs/features/observability/feature.md.
// Hand-written and tolerant: a malformed line is skipped, never thrown.
internal static class DockerStatsParser
{
    // IEC binary suffixes are what `docker stats` emits (go-units BytesSize, base 1024); decimal
    // suffixes are tolerated defensively in case a future format/locale differs.
    private static readonly (string Suffix, double Multiplier)[] ByteSuffixes =
    [
        ("KiB", 1024d),
        ("MiB", 1024d * 1024d),
        ("GiB", 1024d * 1024d * 1024d),
        ("TiB", 1024d * 1024d * 1024d * 1024d),
        ("PiB", 1024d * 1024d * 1024d * 1024d * 1024d),
        ("kB", 1000d),
        ("KB", 1000d),
        ("MB", 1000d * 1000d),
        ("GB", 1000d * 1000d * 1000d),
        ("TB", 1000d * 1000d * 1000d * 1000d),
        // "B" last: it is a suffix of every entry above, so the longer units must match first.
        ("B", 1d),
    ];

    public static IReadOnlyList<DockerContainerStat> Parse(string? output)
    {
        if (string.IsNullOrWhiteSpace(output))
        {
            return [];
        }

        var stats = new List<DockerContainerStat>();
        foreach (var rawLine in output.Split('\n'))
        {
            var line = rawLine.Trim();
            if (line.Length == 0)
            {
                continue;
            }

            var fields = line.Split('\t');
            if (fields.Length < 1 || string.IsNullOrWhiteSpace(fields[0]))
            {
                continue;
            }

            stats.Add(new DockerContainerStat(
                ContainerName: fields[0].Trim(),
                CpuPercent: fields.Length > 1 ? ParsePercent(fields[1]) : null,
                MemoryBytes: fields.Length > 2 ? ParseUsedBytes(fields[2]) : null,
                MemoryPercent: fields.Length > 3 ? ParsePercent(fields[3]) : null));
        }

        return stats;
    }

    // "0.50%" -> 0.5. A blank or "--" cell (docker prints "--" before the first sample) yields null.
    internal static double? ParsePercent(string? value)
    {
        var trimmed = (value ?? string.Empty).Trim().TrimEnd('%').Trim();
        if (trimmed.Length == 0)
        {
            return null;
        }

        return double.TryParse(trimmed, NumberStyles.Float, CultureInfo.InvariantCulture, out var parsed)
            ? parsed
            : null;
    }

    // "12.3MiB / 1.94GiB" -> 12.3*1024*1024. Only the used half (before '/') is taken; the limit is
    // available via MemPerc when needed.
    internal static double? ParseUsedBytes(string? value)
    {
        var trimmed = (value ?? string.Empty).Trim();
        var slash = trimmed.IndexOf('/');
        if (slash >= 0)
        {
            trimmed = trimmed[..slash];
        }

        return ParseSize(trimmed.Trim());
    }

    private static double? ParseSize(string token)
    {
        if (token.Length == 0)
        {
            return null;
        }

        foreach (var (suffix, multiplier) in ByteSuffixes)
        {
            // Case-insensitive so a future docker/locale variant (e.g. "mib") still parses; the longer
            // IEC units are listed before "B" so they win the match.
            if (token.EndsWith(suffix, StringComparison.OrdinalIgnoreCase))
            {
                var number = token[..^suffix.Length].Trim();
                return double.TryParse(number, NumberStyles.Float, CultureInfo.InvariantCulture, out var parsed)
                    ? parsed * multiplier
                    : null;
            }
        }

        // No recognised unit: treat a bare number as bytes.
        return double.TryParse(token, NumberStyles.Float, CultureInfo.InvariantCulture, out var raw) ? raw : null;
    }
}
