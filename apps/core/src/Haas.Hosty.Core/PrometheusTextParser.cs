using System.Globalization;
using System.Text;

namespace Haas.Hosty.Core;

// One parsed Prometheus exposition sample: the metric name, its label set, and its value. Any
// trailing scrape timestamp is dropped — Core stamps samples with the scrape time so every series in
// a tick shares one clock (and producers often omit it anyway).
internal sealed record PrometheusSample(string Name, IReadOnlyDictionary<string, string> Labels, double Value);

// Minimal, allocation-light parser for the Prometheus text exposition format the OTel collector's
// `prometheus` exporter serves at /metrics. Hand-written (no regex) so it stays Native-AOT-clean and
// cheap to run every scrape tick. Tolerant by design: a malformed line is skipped, never thrown, so
// one bad series cannot poison a whole scrape.
internal static class PrometheusTextParser
{
    public static IReadOnlyList<PrometheusSample> Parse(string? text)
    {
        if (string.IsNullOrWhiteSpace(text))
        {
            return [];
        }

        var samples = new List<PrometheusSample>();
        foreach (var rawLine in text.Split('\n'))
        {
            var line = rawLine.AsSpan().Trim();
            // Blank lines and `# HELP` / `# TYPE` metadata carry no samples.
            if (line.IsEmpty || line[0] == '#')
            {
                continue;
            }

            if (TryParseLine(line.ToString(), out var sample))
            {
                samples.Add(sample);
            }
        }

        return samples;
    }

    private static bool TryParseLine(string line, out PrometheusSample sample)
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

        sample = new PrometheusSample(name, labels, value);
        return true;
    }

    // Parses `{k="v",k2="v2",}` starting at the `{` in `index`, leaving `index` just past the `}`.
    private static bool TryParseLabels(string line, ref int index, out IReadOnlyDictionary<string, string> labels)
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

            var labelName = line[nameStart..index];
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
    private static bool TryParseQuotedValue(string line, ref int index, out string value)
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

    private static bool TryParseValue(string token, out double value)
    {
        switch (token)
        {
            case "+Inf":
            case "Inf":
                value = double.PositiveInfinity;
                return true;
            case "-Inf":
                value = double.NegativeInfinity;
                return true;
            case "NaN":
            case "Nan":
                value = double.NaN;
                return true;
            default:
                return double.TryParse(token, NumberStyles.Float, CultureInfo.InvariantCulture, out value);
        }
    }

    private static void SkipSpaces(string line, ref int index)
    {
        while (index < line.Length && line[index] is ' ' or '\t')
        {
            index++;
        }
    }

    private static readonly IReadOnlyDictionary<string, string> EmptyLabels =
        new Dictionary<string, string>(StringComparer.Ordinal);
}
