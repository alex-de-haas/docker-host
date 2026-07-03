using System.Text.Json;

namespace Haas.Hosty.TelemetryBackend;

// One OTLP span parsed from the collector's file-exporter output, paired with the app it was attributed
// to via its `hosty.app.id` resource attribute. Spans that carry no app id are dropped by the parser,
// never surfaced here.
internal sealed record ParsedOtlpSpan(string AppId, OtlpSpan Span);

// Tolerant parser for the OpenTelemetry collector `file` exporter's traces output: newline-delimited
// OTLP/JSON, one ExportTraceServiceRequest-shaped object (`{"resourceSpans":[...]}`) per line. Walks
// the tree with JsonDocument — AOT-safe (no reflection) — and never throws: a malformed line or a span
// missing its app attribution is skipped so one bad line cannot poison a tail. Spans without a trace
// id, span id, or start timestamp are dropped. Copied from Core (Phase 2).
internal static class OtlpTracesJsonParser
{
    // Bound the per-span attribute count so a pathological producer cannot bloat the store.
    private const int MaxAttributesPerSpan = 32;

    public static IReadOnlyList<ParsedOtlpSpan> Parse(string? ndjson)
    {
        if (string.IsNullOrWhiteSpace(ndjson))
        {
            return [];
        }

        var results = new List<ParsedOtlpSpan>();
        foreach (var rawLine in ndjson.AsSpan().EnumerateLines())
        {
            var line = rawLine.Trim();
            if (line.IsEmpty || line[0] != '{')
            {
                continue;
            }

            ParseLine(line, results);
        }

        return results;
    }

    private static void ParseLine(ReadOnlySpan<char> line, List<ParsedOtlpSpan> results)
    {
        JsonDocument document;
        try
        {
            document = JsonDocument.Parse(line.ToString());
        }
        catch (JsonException)
        {
            return; // A partial or malformed line (e.g. a half-flushed tail) is skipped.
        }

        using (document)
        {
            if (!document.RootElement.TryGetProperty("resourceSpans", out var resourceSpans) ||
                resourceSpans.ValueKind != JsonValueKind.Array)
            {
                return;
            }

            foreach (var resourceSpan in resourceSpans.EnumerateArray())
            {
                var appId = OtlpJsonParsing.ResolveAppId(resourceSpan);
                if (string.IsNullOrWhiteSpace(appId))
                {
                    continue;
                }

                if (!resourceSpan.TryGetProperty("scopeSpans", out var scopeSpans) ||
                    scopeSpans.ValueKind != JsonValueKind.Array)
                {
                    continue;
                }

                foreach (var scopeSpan in scopeSpans.EnumerateArray())
                {
                    if (!scopeSpan.TryGetProperty("spans", out var spans) ||
                        spans.ValueKind != JsonValueKind.Array)
                    {
                        continue;
                    }

                    foreach (var span in spans.EnumerateArray())
                    {
                        if (ReadSpan(span) is { } parsed)
                        {
                            results.Add(new ParsedOtlpSpan(appId!, parsed));
                        }
                    }
                }
            }
        }
    }

    private static OtlpSpan? ReadSpan(JsonElement span)
    {
        var traceId = OtlpJsonParsing.ReadHexId(span, "traceId");
        var spanId = OtlpJsonParsing.ReadHexId(span, "spanId");
        if (traceId is null || spanId is null ||
            !OtlpJsonParsing.TryReadUnixNanos(span, "startTimeUnixNano", out var startNano))
        {
            return null;
        }

        // A missing/invalid end timestamp yields a zero-duration span rather than dropping it.
        if (!OtlpJsonParsing.TryReadUnixNanos(span, "endTimeUnixNano", out var endNano) || endNano < startNano)
        {
            endNano = startNano;
        }

        var name = span.TryGetProperty("name", out var nameValue) && nameValue.ValueKind == JsonValueKind.String
            ? nameValue.GetString() ?? string.Empty
            : string.Empty;
        var (statusCode, statusMessage) = ReadStatus(span);

        return new OtlpSpan(
            TraceId: traceId,
            SpanId: spanId,
            ParentSpanId: OtlpJsonParsing.ReadHexId(span, "parentSpanId"),
            Name: name,
            Kind: ReadKind(span),
            StartUnixNano: startNano,
            EndUnixNano: endNano,
            StatusCode: statusCode,
            StatusMessage: statusMessage,
            Attributes: OtlpJsonParsing.ReadAttributes(span, MaxAttributesPerSpan));
    }

    // `kind` is normally the integer SpanKind enum value; tolerate the enum name string too. Normalized
    // to a lowercase token so clients never parse OTLP enum names.
    private static string ReadKind(JsonElement span)
    {
        if (!span.TryGetProperty("kind", out var element))
        {
            return "unspecified";
        }

        var number = element.ValueKind switch
        {
            JsonValueKind.Number when element.TryGetInt32(out var value) => value,
            JsonValueKind.String => KindNumberFromName(element.GetString()),
            _ => 0,
        };

        return number switch
        {
            1 => "internal",
            2 => "server",
            3 => "client",
            4 => "producer",
            5 => "consumer",
            _ => "unspecified",
        };
    }

    private static int KindNumberFromName(string? name)
    {
        if (string.IsNullOrWhiteSpace(name))
        {
            return 0;
        }

        var token = name.StartsWith("SPAN_KIND_", StringComparison.OrdinalIgnoreCase)
            ? name["SPAN_KIND_".Length..]
            : name;

        return token.ToUpperInvariant() switch
        {
            "INTERNAL" => 1,
            "SERVER" => 2,
            "CLIENT" => 3,
            "PRODUCER" => 4,
            "CONSUMER" => 5,
            _ => 0,
        };
    }

    // `status.code` is the integer StatusCode enum value or its name; the message only accompanies an
    // error status. Normalized to "unset"/"ok"/"error".
    private static (string Code, string? Message) ReadStatus(JsonElement span)
    {
        if (!span.TryGetProperty("status", out var status) || status.ValueKind != JsonValueKind.Object)
        {
            return ("unset", null);
        }

        var number = 0;
        if (status.TryGetProperty("code", out var code))
        {
            number = code.ValueKind switch
            {
                JsonValueKind.Number when code.TryGetInt32(out var value) => value,
                JsonValueKind.String => StatusNumberFromName(code.GetString()),
                _ => 0,
            };
        }

        string? message = null;
        if (status.TryGetProperty("message", out var messageValue) &&
            messageValue.ValueKind == JsonValueKind.String &&
            messageValue.GetString() is { Length: > 0 } text)
        {
            message = text;
        }

        return (number switch { 1 => "ok", 2 => "error", _ => "unset" }, message);
    }

    private static int StatusNumberFromName(string? name)
    {
        if (string.IsNullOrWhiteSpace(name))
        {
            return 0;
        }

        var token = name.StartsWith("STATUS_CODE_", StringComparison.OrdinalIgnoreCase)
            ? name["STATUS_CODE_".Length..]
            : name;

        return token.ToUpperInvariant() switch
        {
            "OK" => 1,
            "ERROR" => 2,
            _ => 0,
        };
    }
}
