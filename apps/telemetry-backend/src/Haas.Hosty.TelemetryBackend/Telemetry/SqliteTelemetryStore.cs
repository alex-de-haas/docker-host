using Microsoft.Data.Sqlite;

namespace Haas.Hosty.TelemetryBackend;

// One metric sample ready to persist: the app it is attributed to, the series name + labels (the
// attribution label already stripped by the ingest layer), the value, and the scrape timestamp.
internal readonly record struct MetricSample(
    string AppId,
    string Name,
    IReadOnlyDictionary<string, string> Labels,
    double Value,
    long TimestampUnixMs);

// Embedded SQLite telemetry store (observability Phase 2). Persists metrics/logs/spans so a restart no
// longer drops the window (unlike Core's old in-memory stores), and answers the range/fleet queries the
// query API serves. One serialized connection guards all access — writes are small batch inserts each
// ingest tick and reads are occasional admin queries, so contention is negligible at homelab scale.
// Retention (per-signal age caps + a global size ceiling) keeps the file bounded, which is what lets an
// embedded SQLite stand in for a TSDB. See docs/features/observability-phase-2-backend.md.
internal sealed class SqliteTelemetryStore : IDisposable
{
    private readonly TelemetryBackendOptions options;
    private readonly SqliteConnection connection;
    private readonly object gate = new();

    public SqliteTelemetryStore(TelemetryBackendOptions options)
    {
        this.options = options;
        var directory = Path.GetDirectoryName(Path.GetFullPath(options.DatabasePath));
        if (!string.IsNullOrEmpty(directory))
        {
            Directory.CreateDirectory(directory);
        }

        connection = new SqliteConnection(new SqliteConnectionStringBuilder
        {
            DataSource = options.DatabasePath,
            Mode = SqliteOpenMode.ReadWriteCreate,
        }.ToString());
        connection.Open();
        Initialize();
    }

    private void Initialize()
    {
        // WAL + NORMAL: concurrent-read-friendly and durable enough for live telemetry; incremental
        // auto_vacuum lets Prune reclaim space after age/size eviction without a full VACUUM.
        Execute("PRAGMA journal_mode=WAL;");
        Execute("PRAGMA synchronous=NORMAL;");
        Execute("PRAGMA busy_timeout=5000;");
        Execute("PRAGMA auto_vacuum=INCREMENTAL;");

        Execute("""
            CREATE TABLE IF NOT EXISTS metric_points (
                app_id      TEXT    NOT NULL,
                name        TEXT    NOT NULL,
                labels_json TEXT    NOT NULL,
                ts_ms       INTEGER NOT NULL,
                value       REAL    NOT NULL
            );
            CREATE INDEX IF NOT EXISTS ix_metric_points_app_ts ON metric_points(app_id, ts_ms);
            CREATE INDEX IF NOT EXISTS ix_metric_points_ts ON metric_points(ts_ms);

            CREATE TABLE IF NOT EXISTS log_records (
                app_id        TEXT    NOT NULL,
                ts_ms         INTEGER NOT NULL,
                severity      INTEGER NOT NULL,
                severity_text TEXT    NOT NULL,
                body          TEXT    NOT NULL,
                trace_id      TEXT,
                span_id       TEXT,
                attrs_json    TEXT    NOT NULL
            );
            CREATE INDEX IF NOT EXISTS ix_log_records_app_ts ON log_records(app_id, ts_ms);
            CREATE INDEX IF NOT EXISTS ix_log_records_ts ON log_records(ts_ms);

            CREATE TABLE IF NOT EXISTS spans (
                app_id         TEXT    NOT NULL,
                trace_id       TEXT    NOT NULL,
                span_id        TEXT    NOT NULL,
                parent_span_id TEXT,
                name           TEXT    NOT NULL,
                kind           TEXT    NOT NULL,
                start_nano     INTEGER NOT NULL,
                end_nano       INTEGER NOT NULL,
                status_code    TEXT    NOT NULL,
                status_message TEXT,
                attrs_json     TEXT    NOT NULL
            );
            CREATE INDEX IF NOT EXISTS ix_spans_trace ON spans(trace_id);
            CREATE INDEX IF NOT EXISTS ix_spans_app_start ON spans(app_id, start_nano);
            CREATE INDEX IF NOT EXISTS ix_spans_start ON spans(start_nano);
            """);
    }

    // ---- Ingest (writes) ------------------------------------------------------------------------

    public void RecordMetrics(IReadOnlyList<MetricSample> samples)
    {
        if (samples.Count == 0)
        {
            return;
        }

        lock (gate)
        {
            using var tx = connection.BeginTransaction();
            using var cmd = connection.CreateCommand();
            cmd.Transaction = tx;
            cmd.CommandText =
                "INSERT INTO metric_points (app_id, name, labels_json, ts_ms, value) VALUES ($app, $name, $labels, $ts, $value);";
            var pApp = cmd.CreateParameter(); pApp.ParameterName = "$app"; cmd.Parameters.Add(pApp);
            var pName = cmd.CreateParameter(); pName.ParameterName = "$name"; cmd.Parameters.Add(pName);
            var pLabels = cmd.CreateParameter(); pLabels.ParameterName = "$labels"; cmd.Parameters.Add(pLabels);
            var pTs = cmd.CreateParameter(); pTs.ParameterName = "$ts"; cmd.Parameters.Add(pTs);
            var pValue = cmd.CreateParameter(); pValue.ParameterName = "$value"; cmd.Parameters.Add(pValue);

            foreach (var sample in samples)
            {
                // Drop non-finite values (NaN/±Inf), matching Core's in-memory store.
                if (string.IsNullOrWhiteSpace(sample.AppId) || !double.IsFinite(sample.Value) || sample.TimestampUnixMs <= 0)
                {
                    continue;
                }

                pApp.Value = sample.AppId;
                pName.Value = sample.Name;
                pLabels.Value = TelemetryJson.SerializeStringMap(sample.Labels);
                pTs.Value = sample.TimestampUnixMs;
                pValue.Value = sample.Value;
                cmd.ExecuteNonQuery();
            }

            tx.Commit();
        }
    }

    public void RecordLogs(IReadOnlyList<ParsedOtlpLog> logs)
    {
        if (logs.Count == 0)
        {
            return;
        }

        lock (gate)
        {
            using var tx = connection.BeginTransaction();
            using var cmd = connection.CreateCommand();
            cmd.Transaction = tx;
            cmd.CommandText =
                "INSERT INTO log_records (app_id, ts_ms, severity, severity_text, body, trace_id, span_id, attrs_json) " +
                "VALUES ($app, $ts, $sev, $sevt, $body, $trace, $span, $attrs);";
            var pApp = cmd.CreateParameter(); pApp.ParameterName = "$app"; cmd.Parameters.Add(pApp);
            var pTs = cmd.CreateParameter(); pTs.ParameterName = "$ts"; cmd.Parameters.Add(pTs);
            var pSev = cmd.CreateParameter(); pSev.ParameterName = "$sev"; cmd.Parameters.Add(pSev);
            var pSevt = cmd.CreateParameter(); pSevt.ParameterName = "$sevt"; cmd.Parameters.Add(pSevt);
            var pBody = cmd.CreateParameter(); pBody.ParameterName = "$body"; cmd.Parameters.Add(pBody);
            var pTrace = cmd.CreateParameter(); pTrace.ParameterName = "$trace"; cmd.Parameters.Add(pTrace);
            var pSpan = cmd.CreateParameter(); pSpan.ParameterName = "$span"; cmd.Parameters.Add(pSpan);
            var pAttrs = cmd.CreateParameter(); pAttrs.ParameterName = "$attrs"; cmd.Parameters.Add(pAttrs);

            foreach (var parsed in logs)
            {
                var record = parsed.Record;
                if (string.IsNullOrWhiteSpace(parsed.AppId) || record.TimestampUnixMs <= 0)
                {
                    continue;
                }

                pApp.Value = parsed.AppId;
                pTs.Value = record.TimestampUnixMs;
                pSev.Value = record.SeverityNumber;
                pSevt.Value = record.SeverityText;
                pBody.Value = record.Body;
                pTrace.Value = (object?)record.TraceId ?? DBNull.Value;
                pSpan.Value = (object?)record.SpanId ?? DBNull.Value;
                pAttrs.Value = TelemetryJson.SerializeStringMap(record.Attributes);
                cmd.ExecuteNonQuery();
            }

            tx.Commit();
        }
    }

    public void RecordSpans(IReadOnlyList<ParsedOtlpSpan> spans)
    {
        if (spans.Count == 0)
        {
            return;
        }

        lock (gate)
        {
            using var tx = connection.BeginTransaction();
            using var cmd = connection.CreateCommand();
            cmd.Transaction = tx;
            cmd.CommandText =
                "INSERT INTO spans (app_id, trace_id, span_id, parent_span_id, name, kind, start_nano, end_nano, status_code, status_message, attrs_json) " +
                "VALUES ($app, $trace, $span, $parent, $name, $kind, $start, $end, $code, $msg, $attrs);";
            var pApp = cmd.CreateParameter(); pApp.ParameterName = "$app"; cmd.Parameters.Add(pApp);
            var pTrace = cmd.CreateParameter(); pTrace.ParameterName = "$trace"; cmd.Parameters.Add(pTrace);
            var pSpan = cmd.CreateParameter(); pSpan.ParameterName = "$span"; cmd.Parameters.Add(pSpan);
            var pParent = cmd.CreateParameter(); pParent.ParameterName = "$parent"; cmd.Parameters.Add(pParent);
            var pName = cmd.CreateParameter(); pName.ParameterName = "$name"; cmd.Parameters.Add(pName);
            var pKind = cmd.CreateParameter(); pKind.ParameterName = "$kind"; cmd.Parameters.Add(pKind);
            var pStart = cmd.CreateParameter(); pStart.ParameterName = "$start"; cmd.Parameters.Add(pStart);
            var pEnd = cmd.CreateParameter(); pEnd.ParameterName = "$end"; cmd.Parameters.Add(pEnd);
            var pCode = cmd.CreateParameter(); pCode.ParameterName = "$code"; cmd.Parameters.Add(pCode);
            var pMsg = cmd.CreateParameter(); pMsg.ParameterName = "$msg"; cmd.Parameters.Add(pMsg);
            var pAttrs = cmd.CreateParameter(); pAttrs.ParameterName = "$attrs"; cmd.Parameters.Add(pAttrs);

            foreach (var parsed in spans)
            {
                var span = parsed.Span;
                if (string.IsNullOrWhiteSpace(parsed.AppId) || span.StartUnixNano <= 0 ||
                    string.IsNullOrWhiteSpace(span.TraceId) || string.IsNullOrWhiteSpace(span.SpanId))
                {
                    continue;
                }

                pApp.Value = parsed.AppId;
                pTrace.Value = span.TraceId;
                pSpan.Value = span.SpanId;
                pParent.Value = (object?)span.ParentSpanId ?? DBNull.Value;
                pName.Value = span.Name;
                pKind.Value = span.Kind;
                pStart.Value = span.StartUnixNano;
                pEnd.Value = span.EndUnixNano;
                pCode.Value = span.StatusCode;
                pMsg.Value = (object?)span.StatusMessage ?? DBNull.Value;
                pAttrs.Value = TelemetryJson.SerializeStringMap(span.Attributes);
                cmd.ExecuteNonQuery();
            }

            tx.Commit();
        }
    }

    // ---- Queries (reads) ------------------------------------------------------------------------

    // All series for an app holding at least one point at or after `since`, each trimmed to that window
    // and grouped by (name, canonical-labels). Mirrors Core's IMetricStore.Query.
    public IReadOnlyList<MetricSeriesSnapshot> QueryMetrics(string appId, long sinceMs)
    {
        if (string.IsNullOrWhiteSpace(appId))
        {
            return [];
        }

        lock (gate)
        {
            using var cmd = connection.CreateCommand();
            cmd.CommandText =
                "SELECT name, labels_json, ts_ms, value FROM metric_points WHERE app_id = $app AND ts_ms >= $since " +
                "ORDER BY name, labels_json, ts_ms;";
            AddParam(cmd, "$app", appId);
            AddParam(cmd, "$since", sinceMs);

            var series = new List<MetricSeriesSnapshot>();
            string? currentName = null;
            string? currentLabels = null;
            List<MetricPoint>? points = null;

            using var reader = cmd.ExecuteReader();
            while (reader.Read())
            {
                var name = reader.GetString(0);
                var labels = reader.GetString(1);
                if (!string.Equals(name, currentName, StringComparison.Ordinal) ||
                    !string.Equals(labels, currentLabels, StringComparison.Ordinal))
                {
                    FlushSeries(series, currentName, currentLabels, points);
                    currentName = name;
                    currentLabels = labels;
                    points = [];
                }

                points!.Add(new MetricPoint(reader.GetInt64(2), reader.GetDouble(3)));
            }

            FlushSeries(series, currentName, currentLabels, points);
            return series;
        }
    }

    private static void FlushSeries(List<MetricSeriesSnapshot> series, string? name, string? labels, List<MetricPoint>? points)
    {
        if (name is null || points is null || points.Count == 0)
        {
            return;
        }

        series.Add(new MetricSeriesSnapshot(name, TelemetryJson.DeserializeStringMap(labels), points));
    }

    // The app's OTLP log records at or after `since`, optionally filtered to severity >= minSeverity,
    // in chronological order (newest last), capped to the most recent `limit`. Mirrors ILogStore.Query.
    public IReadOnlyList<OtlpLogRecord> QueryOtlpLogs(string appId, long sinceMs, int? minSeverity, int limit)
    {
        if (string.IsNullOrWhiteSpace(appId) || limit <= 0)
        {
            return [];
        }

        lock (gate)
        {
            using var cmd = connection.CreateCommand();
            cmd.CommandText =
                "SELECT ts_ms, severity, severity_text, body, trace_id, span_id, attrs_json FROM log_records " +
                "WHERE app_id = $app AND ts_ms >= $since AND ($minSev IS NULL OR severity >= $minSev) " +
                "ORDER BY ts_ms DESC LIMIT $limit;";
            AddParam(cmd, "$app", appId);
            AddParam(cmd, "$since", sinceMs);
            AddParam(cmd, "$minSev", minSeverity.HasValue ? minSeverity.Value : DBNull.Value);
            AddParam(cmd, "$limit", limit);

            var records = new List<OtlpLogRecord>();
            using var reader = cmd.ExecuteReader();
            while (reader.Read())
            {
                records.Add(ReadLog(reader));
            }

            records.Reverse(); // DESC-limited newest set → chronological (newest last)
            return records;
        }
    }

    // Cross-app OTLP log records at or after `since`, optionally severity/app/body filtered, in
    // chronological order (newest last), capped globally to `limit`. Equivalent to Core's per-app
    // merge: the newest `limit` across apps are the same set. Records are attributed (AppId carried).
    public IReadOnlyList<ParsedOtlpLog> QueryFleetLogs(
        long sinceMs, int? minSeverity, int limit, IReadOnlyCollection<string>? appFilter, string? query)
    {
        if (limit <= 0)
        {
            return [];
        }

        lock (gate)
        {
            using var cmd = connection.CreateCommand();
            var sql =
                "SELECT app_id, ts_ms, severity, severity_text, body, trace_id, span_id, attrs_json FROM log_records " +
                "WHERE ts_ms >= $since AND ($minSev IS NULL OR severity >= $minSev) " +
                "AND ($q IS NULL OR instr(lower(body), lower($q)) > 0)";
            sql += BuildAppFilter(cmd, appFilter);
            sql += " ORDER BY ts_ms DESC LIMIT $limit;";
            cmd.CommandText = sql;
            AddParam(cmd, "$since", sinceMs);
            AddParam(cmd, "$minSev", minSeverity.HasValue ? minSeverity.Value : DBNull.Value);
            AddParam(cmd, "$q", string.IsNullOrWhiteSpace(query) ? DBNull.Value : query.Trim());
            AddParam(cmd, "$limit", limit);

            var records = new List<ParsedOtlpLog>();
            using var reader = cmd.ExecuteReader();
            while (reader.Read())
            {
                var appId = reader.GetString(0);
                records.Add(new ParsedOtlpLog(appId, ReadLog(reader, offset: 1)));
            }

            records.Reverse();
            return records;
        }
    }

    // In-window spans (start >= sinceNano), optionally app-filtered, newest-start first, capped to
    // `scanCap`. The query service groups these by trace id into fleet summaries (like Core's per-app
    // Query feeding TraceAccumulator). Spans are attributed (AppId carried).
    public IReadOnlyList<ParsedOtlpSpan> QueryInWindowSpans(long sinceNano, IReadOnlyCollection<string>? appFilter, int scanCap)
    {
        if (scanCap <= 0)
        {
            return [];
        }

        lock (gate)
        {
            using var cmd = connection.CreateCommand();
            var sql = "SELECT app_id, trace_id, span_id, parent_span_id, name, kind, start_nano, end_nano, status_code, status_message, attrs_json " +
                      "FROM spans WHERE start_nano >= $since";
            sql += BuildAppFilter(cmd, appFilter);
            sql += " ORDER BY start_nano DESC LIMIT $limit;";
            cmd.CommandText = sql;
            AddParam(cmd, "$since", sinceNano);
            AddParam(cmd, "$limit", scanCap);

            return ReadSpans(cmd);
        }
    }

    // Every stored span of one trace across all apps (case-insensitive id match), for the trace-detail
    // read path. Mirrors ITraceStore.QueryTrace merged across apps.
    public IReadOnlyList<ParsedOtlpSpan> QueryTraceSpans(string traceId)
    {
        if (string.IsNullOrWhiteSpace(traceId))
        {
            return [];
        }

        lock (gate)
        {
            using var cmd = connection.CreateCommand();
            cmd.CommandText =
                "SELECT app_id, trace_id, span_id, parent_span_id, name, kind, start_nano, end_nano, status_code, status_message, attrs_json " +
                "FROM spans WHERE trace_id = $trace COLLATE NOCASE;";
            AddParam(cmd, "$trace", traceId.Trim());
            return ReadSpans(cmd);
        }
    }

    private static IReadOnlyList<ParsedOtlpSpan> ReadSpans(SqliteCommand cmd)
    {
        var spans = new List<ParsedOtlpSpan>();
        using var reader = cmd.ExecuteReader();
        while (reader.Read())
        {
            spans.Add(new ParsedOtlpSpan(reader.GetString(0), new OtlpSpan(
                TraceId: reader.GetString(1),
                SpanId: reader.GetString(2),
                ParentSpanId: reader.IsDBNull(3) ? null : reader.GetString(3),
                Name: reader.GetString(4),
                Kind: reader.GetString(5),
                StartUnixNano: reader.GetInt64(6),
                EndUnixNano: reader.GetInt64(7),
                StatusCode: reader.GetString(8),
                StatusMessage: reader.IsDBNull(9) ? null : reader.GetString(9),
                Attributes: TelemetryJson.DeserializeStringMap(reader.GetString(10)))));
        }

        return spans;
    }

    private static OtlpLogRecord ReadLog(SqliteDataReader reader, int offset = 0)
        => new(
            TimestampUnixMs: reader.GetInt64(offset + 0),
            SeverityNumber: reader.GetInt32(offset + 1),
            SeverityText: reader.GetString(offset + 2),
            Body: reader.GetString(offset + 3),
            Attributes: TelemetryJson.DeserializeStringMap(reader.GetString(offset + 6)),
            TraceId: reader.IsDBNull(offset + 4) ? null : reader.GetString(offset + 4),
            SpanId: reader.IsDBNull(offset + 5) ? null : reader.GetString(offset + 5));

    // ---- Retention ------------------------------------------------------------------------------

    // Evicts data past its per-signal age cap, then trims oldest rows until the file is under the size
    // ceiling, then reclaims freed pages. Called periodically by the ingest loop. Ported from Core's
    // Prune but persistent + size-bounded.
    public void Prune(DateTimeOffset now)
    {
        lock (gate)
        {
            var nowMs = now.ToUnixTimeMilliseconds();
            DeleteWhere("metric_points", "ts_ms", nowMs - (long)options.MetricsRetention.TotalMilliseconds);
            DeleteWhere("log_records", "ts_ms", nowMs - (long)options.LogsRetention.TotalMilliseconds);
            DeleteWhere("spans", "start_nano", (nowMs - (long)options.TracesRetention.TotalMilliseconds) * 1_000_000L);

            EnforceSizeCeiling();
            Execute("PRAGMA incremental_vacuum;");
        }
    }

    private void DeleteWhere(string table, string column, long cutoff)
    {
        using var cmd = connection.CreateCommand();
        cmd.CommandText = $"DELETE FROM {table} WHERE {column} < $cutoff;";
        AddParam(cmd, "$cutoff", cutoff);
        cmd.ExecuteNonQuery();
    }

    // Hard safety cap: while the database exceeds the ceiling, drop the oldest slice from each signal
    // table and re-measure. Bounded iterations so a pathological state cannot spin.
    private void EnforceSizeCeiling()
    {
        for (var iteration = 0; iteration < 32 && DatabaseBytes() > options.MaxDatabaseBytes; iteration++)
        {
            TrimOldest("metric_points", "ts_ms", 5000);
            TrimOldest("log_records", "ts_ms", 5000);
            TrimOldest("spans", "start_nano", 5000);
        }
    }

    private void TrimOldest(string table, string column, int count)
    {
        using var cmd = connection.CreateCommand();
        cmd.CommandText = $"DELETE FROM {table} WHERE rowid IN (SELECT rowid FROM {table} ORDER BY {column} ASC LIMIT $count);";
        AddParam(cmd, "$count", count);
        cmd.ExecuteNonQuery();
    }

    private long DatabaseBytes()
    {
        using var cmd = connection.CreateCommand();
        cmd.CommandText = "PRAGMA page_count;";
        var pageCount = Convert.ToInt64(cmd.ExecuteScalar() ?? 0L);
        cmd.CommandText = "PRAGMA page_size;";
        var pageSize = Convert.ToInt64(cmd.ExecuteScalar() ?? 0L);
        return pageCount * pageSize;
    }

    // ---- Helpers --------------------------------------------------------------------------------

    // Appends ` AND app_id IN ($a0,$a1,…)` and binds the parameters, or nothing when no filter.
    private static string BuildAppFilter(SqliteCommand cmd, IReadOnlyCollection<string>? appFilter)
    {
        if (appFilter is not { Count: > 0 })
        {
            return string.Empty;
        }

        var names = new List<string>(appFilter.Count);
        var index = 0;
        foreach (var appId in appFilter)
        {
            var name = $"$a{index++}";
            names.Add(name);
            AddParam(cmd, name, appId);
        }

        return $" AND app_id IN ({string.Join(",", names)})";
    }

    private static void AddParam(SqliteCommand cmd, string name, object value)
    {
        var parameter = cmd.CreateParameter();
        parameter.ParameterName = name;
        parameter.Value = value ?? DBNull.Value;
        cmd.Parameters.Add(parameter);
    }

    private void Execute(string sql)
    {
        using var cmd = connection.CreateCommand();
        cmd.CommandText = sql;
        cmd.ExecuteNonQuery();
    }

    public void Dispose() => connection.Dispose();
}
