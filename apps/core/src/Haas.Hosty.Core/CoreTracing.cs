using System.Diagnostics;
using System.Globalization;
using System.Text.Json;
using Microsoft.Extensions.DependencyInjection.Extensions;
using OpenTelemetry;
using OpenTelemetry.Resources;
using OpenTelemetry.Trace;

namespace Haas.Hosty.Core;

internal sealed record CoreSpanRecord(long Sequence, string TraceId, string SpanId, string? ParentSpanId,
    string Name, string Kind, DateTimeOffset StartedAt, double DurationMs, string Status,
    IReadOnlyDictionary<string, string> Attributes);
internal sealed record CoreTracePullResponse(int ContractVersion, string RunId, bool Capturing,
    DateTimeOffset? CaptureStartedAt, double RootSampleRatio, DateTimeOffset ObservedAt,
    long FirstAvailableSequence, long LastSequence, long NextCursor, bool HasMore, string? GapReason,
    long DroppedSpans, long TruncatedSpans, IReadOnlyList<CoreSpanRecord> Spans);

internal static class CoreTracing
{
    public const string SourceName = "Hosty.Core";
    public const string CallerAttribute = "hosty.caller.app.id";
    public const string ExcludedProperty = "hosty.diagnostics.excluded";
    public static readonly ActivitySource Source = new(SourceName);
    public static void Configure(IServiceCollection services)
    {
        services.TryAddSingleton(TimeProvider.System);
        services.AddSingleton<CoreApiActivity>();
        services.AddSingleton<CoreTraceBuffer>();
        services.AddSingleton<CoreDemandSampler>();
        services.AddHostedService<CoreDiagnosticsMonitor>();
        services.AddOpenTelemetry().WithTracing(tracing => tracing
            .ConfigureResource(resource => resource.AddService("hosty.core"))
            .SetSampler<CoreDemandSampler>()
            .AddSource(SourceName)
            .AddAspNetCoreInstrumentation(options =>
            {
                options.RecordException = false;
                options.Filter = context => !context.Request.Path.StartsWithSegments("/api/internal/telemetry")
                    && context.Request.Path != "/healthz";
            })
            .AddHttpClientInstrumentation(options => options.RecordException = false)
            .AddProcessor(provider => new CoreSpanProcessor(provider.GetRequiredService<CoreTraceBuffer>())));
    }
    public static void Map(WebApplication app)
    {
        app.MapGet("/api/internal/telemetry/traces", async (string? runId, long? after, int? limit,
            HttpRequest request, AppServiceTokenService tokens, AppRegistryStore apps, CoreTraceBuffer buffer,
            CancellationToken cancellationToken) =>
        {
            var token = CoreSessionAuthorization.ReadBearerToken(request);
            var id = token is null ? null : tokens.ResolveAppId(token);
            var caller = id is null ? null : await apps.GetAppAsync(id, cancellationToken);
            if (caller is null)
                return CoreJson.Json(new ErrorResponse("telemetry_traces_unauthorized", "An installed app service credential is required."), 401);
            if (!CoreTraceBuffer.Authorized(caller))
            {
                buffer.Revoke(caller.Id);
                return CoreJson.Json(new ErrorResponse("app_permission_required", "Trace collection requires apps.read and core.read."), 403);
            }
            cancellationToken.ThrowIfCancellationRequested();
            buffer.Renew(caller);
            return CoreJson.Json(buffer.Read(runId, Math.Max(after ?? 0, 0), Math.Clamp(limit ?? 200, 1, 500)));
        }).WithMetadata(new CoreDiagnosticsTransport());
    }
}

// Stable provider/listeners; only this cheap demand gate and the operator's ratio vary.
internal sealed class CoreDemandSampler(CoreTraceBuffer buffer, CoreSettingsService settings) : Sampler
{
    private readonly object gate = new();
    private double ratio = -1;
    private Sampler sampler = new AlwaysOffSampler();
    public override SamplingResult ShouldSample(in SamplingParameters parameters)
    {
        if (!buffer.IsCapturing) return new(SamplingDecision.Drop);
        var configured = settings.Diagnostics.TraceSampleRatio;
        if (Volatile.Read(ref ratio) != configured)
        {
            lock (gate)
            {
                if (ratio != configured)
                {
                    Volatile.Write(ref sampler, new ParentBasedSampler(new TraceIdRatioBasedSampler(configured)));
                    Volatile.Write(ref ratio, configured);
                }
            }
        }
        return Volatile.Read(ref sampler).ShouldSample(parameters);
    }
}

internal sealed class CoreSpanProcessor(CoreTraceBuffer buffer) : BaseProcessor<Activity>
{
    public override void OnStart(Activity activity)
    {
        if ((CoreApiRequest.Caller ?? activity.Parent?.GetCustomProperty(CoreTracing.CallerAttribute) as string) is { } caller)
        {
            activity.SetTag(CoreTracing.CallerAttribute, caller);
            activity.SetCustomProperty(CoreTracing.CallerAttribute, caller);
        }
    }
    public override void OnEnd(Activity activity)
    {
        if (activity.Recorded && activity.GetCustomProperty(CoreTracing.ExcludedProperty) is not true)
            buffer.Add(activity);
    }
}

internal sealed class CoreTraceBuffer(TimeProvider time, CoreSettingsService settings)
{
    internal const int MaxSpans = 2000, MaxBytes = 8 * 1024 * 1024, MaxSpanBytes = 4096;
    internal const int MaxAgeSeconds = 60, DemandSeconds = 30;
    private static readonly string[] AttributeNames = ["http.request.method", "http.route", "http.response.status_code", "network.protocol.version", "error.type"];
    private readonly object gate = new();
    private readonly Queue<Entry> entries = new();
    private readonly Dictionary<string, Demand> demands = new(StringComparer.Ordinal);
    private readonly long started = time.GetTimestamp();
    private long demandUntil, nextSequence, dropped, truncated;
    private int bytes;
    private DateTimeOffset? captureStartedAt;
    private long Now => (long)time.GetElapsedTime(started).TotalMilliseconds;
    public string RunId { get; } = Guid.NewGuid().ToString("n");
    public bool IsCapturing => Now < Volatile.Read(ref demandUntil);
    public static bool Authorized(AppRecord app) => AppManagementAuthorization.HasPermission(app, CoreAppPermissions.ReadCore)
        && AppManagementAuthorization.HasPermission(app, CoreAppPermissions.ReadApps);
    public void Renew(AppRecord reader)
    {
        lock (gate)
        {
            if (!IsCapturing) captureStartedAt = time.GetUtcNow();
            demands[reader.Id] = new(PanelIdentity.Installation(reader), Now + DemandSeconds * 1000);
            UpdateDemand();
        }
    }
    public void Revoke(string appId) { lock (gate) { demands.Remove(appId); UpdateDemand(); } }
    public void Reconcile(IReadOnlyList<AppRecord> apps)
    {
        var allowed = apps.Where(Authorized).ToDictionary(a => a.Id, PanelIdentity.Installation, StringComparer.Ordinal);
        lock (gate)
        {
            foreach (var (id, demand) in demands.ToArray())
                if (!allowed.TryGetValue(id, out var installation) || installation != demand.Installation) demands.Remove(id);
            UpdateDemand();
        }
    }
    public void Expire()
    {
        lock (gate)
        {
            foreach (var (id, demand) in demands.ToArray()) if (demand.Until <= Now) demands.Remove(id);
            UpdateDemand(); Prune();
        }
    }
    private void UpdateDemand() => Volatile.Write(ref demandUntil, demands.Count == 0 ? 0 : demands.Values.Max(d => d.Until));
    public void Add(Activity activity)
    {
        if (!IsCapturing) return;
        var record = Sanitize(activity);
        var textLength = record.Name.Length + record.TraceId.Length + record.SpanId.Length
            + (record.ParentSpanId?.Length ?? 0) + record.Kind.Length + record.Status.Length;
        var managedBytes = 512 + 2 * textLength;
        foreach (var pair in record.Attributes)
        {
            textLength += pair.Key.Length + pair.Value.Length;
            managedBytes += 96 + 2 * (pair.Key.Length + pair.Value.Length);
        }
        // A JSON character uses at most six bytes when escaped. The fixed allowance covers field
        // names, punctuation, timestamps and maximal numeric widths (including the assigned sequence).
        // Ordinary short spans need no serialization/allocation on the request thread just to count
        // bytes. Borderline records still use the actual serializer, with a maximal sequence width.
        var upperWireBytes = 512L + 6L * textLength;
        var size = upperWireBytes <= MaxSpanBytes ? (int)upperWireBytes
            : JsonSerializer.SerializeToUtf8Bytes(record with { Sequence = long.MaxValue }, CoreJsonSerializerContext.Default.CoreSpanRecord).Length;
        if (size > MaxSpanBytes) { Interlocked.Increment(ref truncated); Interlocked.Increment(ref dropped); return; }
        // Charge both wire size and a conservative managed-object estimate against retention.
        size = Math.Max(size, managedBytes);
        // Request threads never queue behind a pull reader. A contested diagnostic record is dropped.
        if (!Monitor.TryEnter(gate)) { Interlocked.Increment(ref dropped); return; }
        try
        {
            Prune();
            while (entries.Count >= MaxSpans || bytes + size > MaxBytes) DropOldest();
            entries.Enqueue(new(record with { Sequence = ++nextSequence }, Now, size));
            bytes += size;
        }
        finally { Monitor.Exit(gate); }
    }
    internal static CoreSpanRecord Sanitize(Activity activity)
    {
        var attributes = new Dictionary<string, string>(StringComparer.Ordinal);
        // Deliberately do not copy arbitrary tags, baggage, events, URL paths, exception messages or
        // stack traces. These stable fields identify an instrumented boundary without request data.
        foreach (var key in AttributeNames)
        {
            var value = Convert.ToString(activity.GetTagItem(key), CultureInfo.InvariantCulture);
            if (!string.IsNullOrEmpty(value) && value.Length <= 256 && !value.Any(char.IsControl)) attributes[key] = value;
        }
        if (activity.GetCustomProperty(CoreTracing.CallerAttribute) is string caller) attributes[CoreTracing.CallerAttribute] = caller;
        if (activity.Kind == ActivityKind.Client && activity.GetTagItem("server.address") is string host
            && host.Length <= 253 && Uri.CheckHostName(host) != UriHostNameType.Unknown) attributes["server.address"] = host;
        var method = attributes.GetValueOrDefault("http.request.method") ?? "HTTP";
        var name = activity.Kind == ActivityKind.Server ? $"{method} {attributes.GetValueOrDefault("http.route") ?? "unmatched"}"
            : activity.Kind == ActivityKind.Client ? method : activity.Source.Name == CoreTracing.SourceName ? activity.DisplayName : "Core operation";
        if (name.Length > 256 || name.Any(char.IsControl)) name = "Core operation";
        return new(0, activity.TraceId.ToHexString(), activity.SpanId.ToHexString(),
            activity.ParentSpanId == default ? null : activity.ParentSpanId.ToHexString(), name, activity.Kind.ToString(),
            new DateTimeOffset(activity.StartTimeUtc), activity.Duration.TotalMilliseconds, activity.Status.ToString(), attributes);
    }
    public CoreTracePullResponse Read(string? runId, long after, int limit)
    {
        lock (gate)
        {
            Prune();
            string? gap = null;
            if (runId is not null && runId != RunId) { after = 0; gap = "core_restarted"; }
            var first = entries.Count > 0 ? entries.Peek().Record.Sequence : nextSequence + 1;
            if (after < first - 1) gap ??= "cursor_expired";
            if (after > nextSequence) { after = 0; gap ??= "cursor_ahead"; }
            var page = entries.Where(e => e.Record.Sequence > after).Take(Math.Clamp(limit, 1, 500)).Select(e => e.Record).ToArray();
            var cursor = page.Length > 0 ? page[^1].Sequence : Math.Max(after, nextSequence);
            return new(1, RunId, IsCapturing, captureStartedAt, settings.Diagnostics.TraceSampleRatio, time.GetUtcNow(),
                first, nextSequence, cursor, cursor < nextSequence, gap, Interlocked.Read(ref dropped), Interlocked.Read(ref truncated), page);
        }
    }
    private void Prune()
    {
        while (entries.Count > 0 && Now - entries.Peek().At >= MaxAgeSeconds * 1000) DropOldest();
    }
    private void DropOldest() { bytes -= entries.Dequeue().Bytes; Interlocked.Increment(ref dropped); }
    private sealed record Entry(CoreSpanRecord Record, long At, int Bytes);
    private sealed record Demand(string Installation, long Until);
}
