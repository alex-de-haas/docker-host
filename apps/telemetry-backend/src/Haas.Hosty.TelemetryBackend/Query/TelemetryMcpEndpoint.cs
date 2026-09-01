using System.Text.Json;
using System.Text.Json.Nodes;

namespace Haas.Hosty.TelemetryBackend.Query;

/// <summary>
/// The app-owned MCP interface over stored telemetry (docs/features/telemetry-mcp/feature.md).
/// </summary>
/// <remarks>
/// <para>
/// It exists because Core's own <c>tail_app_logs</c> says what it is not: "a live tail, not a
/// searchable log store". This is the searchable half — and the reason it can exist at all is the
/// authentication in front of it, which the query API did not have until this feature.
/// </para>
/// <para>
/// Hand-rolled JSON-RPC rather than an SDK, following <c>apps/demo-app</c>: three methods, and the
/// Hosty-specific parts stay the visible content of the file an app author copies.
/// </para>
/// </remarks>
internal static class TelemetryMcpEndpoint
{
    private const string ProtocolVersion = "2025-06-18";

    public static IResult Handle(JsonNode? body, TelemetryQueryService query)
    {
        var id = body?["id"]?.DeepClone();
        var method = body?["method"]?.GetValue<string>();

        return method switch
        {
            "initialize" => Result(id, new JsonObject
            {
                ["protocolVersion"] = ProtocolVersion,
                ["capabilities"] = new JsonObject { ["tools"] = new JsonObject() },
                ["serverInfo"] = new JsonObject
                {
                    ["name"] = Environment.GetEnvironmentVariable("HOSTY_APP_ID") ?? "hosty.telemetry",
                    ["version"] = Environment.GetEnvironmentVariable("HOSTY_APP_VERSION") ?? "0",
                },
                ["instructions"] =
                    "Stored, searchable telemetry for every app on this Hosty host. Results are "
                    + "clamped: each one reports the window and row cap that produced it and whether "
                    + "it was truncated. A truncated result means 'there was more', not 'that is all'.",
            }),
            // A notification carries no id and must not be answered.
            "notifications/initialized" => Results.Ok(),
            "tools/list" => Result(id, new JsonObject { ["tools"] = Tools() }),
            "tools/call" => Call(id, body?["params"], query),
            _ => Error(id, -32601, $"Method not found: {method}"),
        };
    }

    private static JsonArray Tools() =>
    [
        Tool(
            "search_logs",
            "Searches this host's stored structured logs across apps. Prefer this over a console tail "
            + "when you need to filter by severity, app, or text, or to look further back than the "
            + "moment.",
            new JsonObject
            {
                ["range_seconds"] = Prop("integer", "How far back to look, in seconds. Capped at 3600 (1 hour)."),
                ["min_severity"] = Prop("integer", "Minimum OTLP severity number: 9 is INFO, 13 WARN, 17 ERROR."),
                ["apps"] = Prop("string", "Comma-separated app ids to restrict to. Omit for every app."),
                ["query"] = Prop("string", "Substring the log body must contain."),
                ["limit"] = Prop("integer", "Maximum rows. Capped at 2000; the default is 500."),
            }),
        Tool(
            "list_traces",
            "Lists recent distributed traces across apps, newest first.",
            new JsonObject
            {
                ["range_seconds"] = Prop("integer", "How far back to look, in seconds. Capped at 3600 (1 hour)."),
                ["apps"] = Prop("string", "Comma-separated app ids to restrict to."),
                ["query"] = Prop("string", "Substring the trace's root name must contain."),
                ["limit"] = Prop("integer", "Maximum traces. Capped at 200."),
            }),
        Tool(
            "get_trace",
            "Returns every span of one trace, merged across the apps that took part in it.",
            new JsonObject { ["trace_id"] = Prop("string", "The trace id, as returned by list_traces.") },
            required: "trace_id"),
        Tool(
            "get_metrics",
            "Summarises one app's stored metrics: CPU, memory, and whatever meters the app itself "
            + "exports. Use this when the question is about load or resource use rather than events "
            + "\u2014 `container.cpu.percent`, `container.memory.bytes` and `container.memory.percent` "
            + "come from docker stats. Repeated identical values are dropped on ingest and re-recorded "
            + "only once a minute, so a flat series has far fewer points than scrapes: a low point "
            + "count means the value was steady, never that collection is broken.",
            new JsonObject
            {
                ["app"] = Prop("string", "The app id to read. Metrics are stored per app, so this is required."),
                ["range_seconds"] = Prop("integer", "How far back to look, in seconds. Capped at 3600 (1 hour)."),
                ["names"] = Prop("string", "Comma-separated metric names to restrict to. Omit for every series."),
            },
            required: "app"),
    ];

    private static IResult Call(JsonNode? id, JsonNode? parameters, TelemetryQueryService query)
    {
        var name = parameters?["name"]?.GetValue<string>();
        var arguments = parameters?["arguments"];

        try
        {
            return name switch
            {
                "search_logs" => Content(id, SearchLogs(arguments, query)),
                "list_traces" => Content(id, ListTraces(arguments, query)),
                "get_trace" => Content(id, GetTrace(arguments, query)),
                "get_metrics" => Content(id, GetMetrics(arguments, query)),
                _ => Failure(id, $"Unknown tool: {name}"),
            };
        }
        catch (Exception ex) when (ex is JsonException or FormatException or InvalidOperationException)
        {
            // The model's own arguments were wrong. Reported as a tool failure so it can correct them,
            // not as a JSON-RPC error, which would end the turn instead.
            return Failure(id, $"Those arguments could not be read: {ex.Message}");
        }
    }

    private static JsonObject SearchLogs(JsonNode? arguments, TelemetryQueryService query)
    {
        var requestedRange = Int(arguments, "range_seconds");
        var requestedLimit = Int(arguments, "limit");
        var result = query.GetFleetLogs(
            requestedRange,
            Int(arguments, "min_severity"),
            requestedLimit,
            ParseCsv(Str(arguments, "apps")),
            Str(arguments, "query"));

        var rows = new JsonArray();
        foreach (var record in result.Records)
        {
            rows.Add(new JsonObject
            {
                ["app"] = record.AppId,
                ["at"] = DateTimeOffset.FromUnixTimeMilliseconds(record.TimestampUnixMs).ToString("O"),
                ["severity"] = record.SeverityText,
                ["body"] = record.Body,
                ["traceId"] = record.TraceId,
            });
        }

        return WithWindow(new JsonObject { ["logs"] = rows }, rows.Count, requestedRange, requestedLimit, 3600, 2000, 500);
    }

    private static JsonObject ListTraces(JsonNode? arguments, TelemetryQueryService query)
    {
        var requestedRange = Int(arguments, "range_seconds");
        var requestedLimit = Int(arguments, "limit");
        var result = query.GetFleetTraces(
            requestedRange, requestedLimit, ParseCsv(Str(arguments, "apps")), Str(arguments, "query"));

        var rows = new JsonArray();
        foreach (var trace in result.Traces)
        {
            rows.Add(new JsonObject
            {
                ["traceId"] = trace.TraceId,
                ["name"] = trace.RootName,
                ["apps"] = new JsonArray([.. trace.AppIds.Select(appId => (JsonNode)appId!)]),
                ["spans"] = trace.SpanCount,
                ["durationMs"] = trace.DurationMs,
            });
        }

        // 50, matching TelemetryQueryService.DefaultTracesLimit. It was 100 here, so a full page of
        // 50 reported limit:100 and truncated:false — recreating the silent truncation this
        // contract exists to prevent, inside the contract itself.
        return WithWindow(new JsonObject { ["traces"] = rows }, rows.Count, requestedRange, requestedLimit, 3600, 200, 50);
    }

    private static JsonObject GetTrace(JsonNode? arguments, TelemetryQueryService query)
    {
        var traceId = Str(arguments, "trace_id")
            ?? throw new InvalidOperationException("trace_id is required.");
        var trace = query.GetTrace(traceId);

        var spans = new JsonArray();
        foreach (var span in trace.Spans)
        {
            spans.Add(new JsonObject
            {
                ["app"] = span.AppId,
                ["name"] = span.Name,
                ["startedAt"] = DateTimeOffset.FromUnixTimeMilliseconds((long)span.StartUnixMs).ToString("O"),
                ["durationMs"] = span.DurationMs,
                ["status"] = span.StatusCode,
            });
        }

        return new JsonObject { ["traceId"] = traceId, ["spans"] = spans };
    }

    // The one metrics answer an agent is most likely to misread, so it is stated rather than left as
    // an empty list to interpret. `container.*` comes from `docker stats`, which an app that runs no
    // container never appears in.
    private const string ContainerAbsenceNote =
        "A container.* series is missing when the app runs without a container (a localCommand runtime "
        + "produces no docker stats), or when docker stats were unavailable \u2014 never because CPU or "
        + "memory use was zero.";

    /// <summary>
    /// Summarises one app's stored series over the window, rather than returning raw points.
    /// </summary>
    /// <remarks>
    /// Aggregates because the alternative does not fit: a 1-hour window over a few dozen series is
    /// thousands of points, and the question this answers — "how loaded was it" — is answered by
    /// the shape, not the samples. What the summary must not do is let absence read as zero, which is
    /// why an empty or container-less result carries a note saying which of the two it is.
    /// </remarks>
    private static JsonObject GetMetrics(JsonNode? arguments, TelemetryQueryService query)
    {
        var appId = Str(arguments, "app")
            ?? throw new InvalidOperationException("app is required.");
        var requestedRange = Int(arguments, "range_seconds");
        var names = ParseCsv(Str(arguments, "names"));
        var result = query.GetMetrics(appId, requestedRange);

        var rows = new JsonArray();
        var sawContainerSeries = false;
        foreach (var snapshot in result.Series)
        {
            if (names is not null && !names.Contains(snapshot.Name, StringComparer.Ordinal))
            {
                continue;
            }

            var points = snapshot.Points;
            if (points.Count == 0)
            {
                continue;
            }

            sawContainerSeries |= snapshot.Name.StartsWith("container.", StringComparison.Ordinal);

            var min = double.MaxValue;
            var max = double.MinValue;
            var sum = 0d;
            foreach (var point in points)
            {
                min = Math.Min(min, point.Value);
                max = Math.Max(max, point.Value);
                sum += point.Value;
            }

            var labels = new JsonObject();
            foreach (var label in snapshot.Labels)
            {
                labels[label.Key] = label.Value;
            }

            rows.Add(new JsonObject
            {
                ["name"] = snapshot.Name,
                ["labels"] = labels,
                ["latest"] = points[^1].Value,
                ["min"] = min,
                ["max"] = max,
                ["average"] = Math.Round(sum / points.Count, 3),
                // Sample count, not a health signal: ingest drops unchanged values and re-records a
                // flat series only once a minute, so "few points" usually means "steady".
                ["points"] = points.Count,
                ["firstAt"] = DateTimeOffset.FromUnixTimeMilliseconds(points[0].TimestampUnixMs).ToString("O"),
                ["latestAt"] = DateTimeOffset.FromUnixTimeMilliseconds(points[^1].TimestampUnixMs).ToString("O"),
            });
        }

        var payload = new JsonObject { ["app"] = appId, ["series"] = rows };
        var note = Note(rows.Count, sawContainerSeries, names);
        if (note is not null)
        {
            payload["note"] = note;
        }

        var effectiveRange = Math.Clamp(requestedRange ?? 300, 1, 3600);
        payload["window"] = new JsonObject
        {
            ["rangeSeconds"] = effectiveRange,
            ["rangeClamped"] = requestedRange is int r && r != effectiveRange,
            // No limit or truncated here, unlike every other tool: the metric query applies no row
            // cap, so there is no clamp to disclose. Their absence is the honest report, not an
            // oversight — what the window can still hide is retention, which prunes old points.
            ["series"] = rows.Count,
        };
        return payload;
    }

    /// <summary>Says which kind of "nothing" an empty or container-less result is.</summary>
    private static string? Note(int returned, bool sawContainerSeries, IReadOnlyCollection<string>? names)
    {
        if (returned > 0)
        {
            // Only meaningful for an unfiltered read: a caller who asked for specific names and got
            // them has no missing container series to explain.
            return names is null && !sawContainerSeries
                ? "This app has stored metrics, but no container.* series among them. " + ContainerAbsenceNote
                : null;
        }

        if (names is null)
        {
            return "Nothing is stored for this app in this window. That means nothing was collected, "
                + "not that the app was idle. " + ContainerAbsenceNote;
        }

        var askedForContainer = names.Any(name => name.StartsWith("container.", StringComparison.Ordinal));
        return "No stored series matched those names in this window."
            + (askedForContainer ? " " + ContainerAbsenceNote : string.Empty);
    }

    /// <summary>
    /// Stamps every result with the window and cap that produced it, and says when it was truncated.
    /// </summary>
    /// <remarks>
    /// The whole reason this method exists. The store clamps silently, and a burst has already hidden
    /// real data behind exactly that: an app logging ~2k/h looked quiet through a 1-hour, newest-500
    /// view. An agent that cannot see the clamp reports "no errors" when it means "none in the newest
    /// 500" — a false statement about the host rather than a report about the query.
    /// </remarks>
    private static JsonObject WithWindow(
        JsonObject payload, int returned, int? requestedRange, int? requestedLimit,
        int maxRange, int maxLimit, int defaultLimit)
    {
        var effectiveRange = Math.Clamp(requestedRange ?? 300, 1, maxRange);
        var effectiveLimit = Math.Clamp(requestedLimit ?? defaultLimit, 1, maxLimit);
        payload["window"] = new JsonObject
        {
            ["rangeSeconds"] = effectiveRange,
            // "the value I asked for is not the value that ran", which catches the low end too. The
            // schemas publish no minimum, so `range_seconds: 0` is a model-generated input the store
            // clamps to 1 — and reporting that as honoured would be the same lie as hiding a cap.
            ["rangeClamped"] = requestedRange is int r && r != effectiveRange,
            ["limit"] = effectiveLimit,
            ["limitClamped"] = requestedLimit is int l && l != effectiveLimit,
            ["returned"] = returned,
            // Equality is the only signal the store gives: a full page means there may be more behind
            // it. Reported as "may be", because it is genuinely unknown, and overstating it would send
            // an agent hunting for data that is not there.
            ["truncated"] = returned >= effectiveLimit,
        };
        return payload;
    }

    private static IReadOnlyCollection<string>? ParseCsv(string? values)
    {
        if (string.IsNullOrWhiteSpace(values))
        {
            return null;
        }

        var items = values.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        return items.Length > 0 ? items : null;
    }

    private static JsonObject Prop(string type, string description)
        => new() { ["type"] = type, ["description"] = description };

    private static JsonObject Tool(string name, string description, JsonObject properties, string? required = null)
    {
        var schema = new JsonObject
        {
            ["type"] = "object",
            ["properties"] = properties,
            ["additionalProperties"] = false,
        };
        if (required is not null)
        {
            schema["required"] = new JsonArray(required);
        }

        return new JsonObject
        {
            ["name"] = name,
            ["description"] = description,
            ["inputSchema"] = schema,
            // Without readOnlyHint the Hosty connector's fail-closed filter exports nothing at all —
            // it treats a missing hint as "this might mutate". Declared, not assumed.
            ["annotations"] = new JsonObject
            {
                ["readOnlyHint"] = true,
                ["destructiveHint"] = false,
                ["idempotentHint"] = true,
            },
        };
    }

    private static string? Str(JsonNode? arguments, string name)
    {
        var value = arguments?[name];
        return value is null ? null : value.GetValueKind() == JsonValueKind.String ? value.GetValue<string>() : null;
    }

    private static int? Int(JsonNode? arguments, string name)
    {
        var value = arguments?[name];
        return value is null || value.GetValueKind() != JsonValueKind.Number ? null : value.GetValue<int>();
    }

    private static IResult Result(JsonNode? id, JsonObject result)
        => Results.Json(new JsonObject { ["jsonrpc"] = "2.0", ["id"] = id, ["result"] = result });

    private static IResult Content(JsonNode? id, JsonObject payload)
        => Result(id, new JsonObject
        {
            ["content"] = new JsonArray(new JsonObject
            {
                ["type"] = "text",
                ["text"] = payload.ToJsonString(),
            }),
        });

    /// <summary>
    /// A failed call, as a normal result carrying <c>isError</c> — the protocol's own signal. A
    /// JSON-RPC error would end the turn instead of letting the model read why and try something else.
    /// </summary>
    private static IResult Failure(JsonNode? id, string message)
        => Result(id, new JsonObject
        {
            ["isError"] = true,
            ["content"] = new JsonArray(new JsonObject { ["type"] = "text", ["text"] = message }),
        });

    private static IResult Error(JsonNode? id, int code, string message)
        => Results.Json(new JsonObject
        {
            ["jsonrpc"] = "2.0",
            ["id"] = id,
            ["error"] = new JsonObject { ["code"] = code, ["message"] = message },
        });
}
