using System.Globalization;
using System.Text;

namespace Haas.Hosty.Core;

// One parsed Prometheus exposition sample: the metric name, its label set, and its value. Any
// trailing scrape timestamp is dropped — Core stamps samples with the scrape time so every series in
// a tick shares one clock (and producers often omit it anyway).
internal sealed record PrometheusSample(string Name, IReadOnlyDictionary<string, string> Labels, double Value);

// Minimal, allocation-light parser for the Prometheus text exposition format the OTel collector's
// `prometheus` exporter serves at /metrics. Hand-written (no regex) so it stays Native-AOT-clean and
// cheap to run every scrape tick: it works over ReadOnlySpan<char> and only allocates the strings it
// actually keeps (metric name and label key/value). Tolerant by design: a malformed line is skipped,
// never thrown, so one bad series cannot poison a whole scrape.
internal static class PrometheusTextParser
{
    public static IReadOnlyList<PrometheusSample> Parse(string? text)
    {
        if (string.IsNullOrWhiteSpace(text))
        {
            return [];
        }

        var samples = new List<PrometheusSample>();
        foreach (var rawLine in text.AsSpan().EnumerateLines())
        {
            var line = rawLine.Trim();
            // Blank lines and `# HELP` / `# TYPE` metadata carry no samples.
            if (line.IsEmpty || line[0] == '#')
            {
                continue;
            }

            if (TryParseLine(line, out var sample))
            {
                samples.Add(sample);
            }
        }

        return samples;
    }

    private static bool TryParseLine(ReadOnlySpan<char> line, out PrometheusSample sample)
    {
        sample = null!;

        var nameEnd = 0;
        while (nameEnd < line.Length && line[nameEnd] is not (' ' or '\t' or '{'))
        {
            nameEnd++;
        }

        if (nameEnd == 0)
        {
            return false;
        }

        var name = line[..nameEnd];
        var index = nameEnd;
        var labels = EmptyLabels;

        if (index < line.Length && line[index] == '{')
        {
            if (!TryParseLabels(line, ref index, out labels))
            {
                return false;
            }
        }

        // Skip the whitespace separating the (optional) labels from the value.
        while (index < line.Length && line[index] is ' ' or '\t')
        {
            index++;
        }

        if (index >= line.Length)
        {
            return false;
        }

        // The value runs to the next whitespace; anything after it is the optional timestamp, ignored.
        var valueStart = index;
        while (index < line.Length && line[index] is not (' ' or '\t'))
        {
            index++;
        }

        if (!TryParseValue(line[valueStart..index], out var value))
        {
            return false;
        }

        sample = new PrometheusSample(name.ToString(), labels, value);
        return true;
    }

    // Parses `{k="v",k2="v2",}` starting at the `{` in `index`, leaving `index` just past the `}`.
    private static bool TryParseLabels(ReadOnlySpan<char> line, ref int index, out IReadOnlyDictionary<string, string> labels)
    {
        labels = EmptyLabels;
        index++; // consume '{'
        Dictionary<string, string>? parsed = null;

        while (true)
        {
            SkipSpaces(line, ref index);
            if (index >= line.Length)
            {
                return false; // unterminated label set
            }

            if (line[index] == '}')
            {
                index++;
                if (parsed is not null)
                {
                    labels = parsed;
                }

                return true;
            }

            var nameStart = index;
            while (index < line.Length && line[index] is not ('=' or ',' or '}' or ' ' or '\t'))
            {
                index++;
            }

            if (index == nameStart)
            {
                return false;
            }

            var labelName = line[nameStart..index].ToString();
            SkipSpaces(line, ref index);
            if (index >= line.Length || line[index] != '=')
            {
                return false;
            }

            index++; // consume '='
            SkipSpaces(line, ref index);
            if (index >= line.Length || line[index] != '"')
            {
                return false;
            }

            if (!TryParseQuotedValue(line, ref index, out var labelValue))
            {
                return false;
            }

            (parsed ??= new Dictionary<string, string>(StringComparer.Ordinal))[labelName] = labelValue;

            SkipSpaces(line, ref index);
            if (index < line.Length && line[index] == ',')
            {
                index++;
            }
        }
    }

    // Parses a double-quoted label value starting at the opening quote, honoring the Prometheus
    // escapes `\\`, `\"`, and `\n`. Leaves `index` just past the closing quote.
    private static bool TryParseQuotedValue(ReadOnlySpan<char> line, ref int index, out string value)
    {
        value = string.Empty;
        index++; // consume opening '"'
        var builder = new StringBuilder();
        while (index < line.Length)
        {
            var ch = line[index];
            if (ch == '"')
            {
                index++;
                value = builder.ToString();
                return true;
            }

            if (ch == '\\' && index + 1 < line.Length)
            {
                index++;
                builder.Append(line[index] switch
                {
                    'n' => '\n',
                    '"' => '"',
                    '\\' => '\\',
                    var other => other,
                });
            }
            else
            {
                builder.Append(ch);
            }

            index++;
        }

        return false; // unterminated quote
    }

    // Prometheus values are Go floats; the special tokens (±Inf, Infinity, NaN) are case-insensitive,
    // and the invariant double.TryParse does not recognise them, so they are matched explicitly first.
    private static bool TryParseValue(ReadOnlySpan<char> token, out double value)
    {
        if (token.Equals("Inf", StringComparison.OrdinalIgnoreCase) ||
            token.Equals("+Inf", StringComparison.OrdinalIgnoreCase) ||
            token.Equals("Infinity", StringComparison.OrdinalIgnoreCase) ||
            token.Equals("+Infinity", StringComparison.OrdinalIgnoreCase))
        {
            value = double.PositiveInfinity;
            return true;
        }

        if (token.Equals("-Inf", StringComparison.OrdinalIgnoreCase) ||
            token.Equals("-Infinity", StringComparison.OrdinalIgnoreCase))
        {
            value = double.NegativeInfinity;
            return true;
        }

        if (token.Equals("NaN", StringComparison.OrdinalIgnoreCase))
        {
            value = double.NaN;
            return true;
        }

        return double.TryParse(token, NumberStyles.Float, CultureInfo.InvariantCulture, out value);
    }

    private static void SkipSpaces(ReadOnlySpan<char> line, ref int index)
    {
        while (index < line.Length && line[index] is ' ' or '\t')
        {
            index++;
        }
    }

    private static readonly IReadOnlyDictionary<string, string> EmptyLabels =
        new Dictionary<string, string>(StringComparer.Ordinal);
}
