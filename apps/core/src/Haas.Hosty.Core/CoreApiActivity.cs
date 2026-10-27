using System.Collections.Concurrent;
using System.Diagnostics;
using System.Globalization;
using System.Text;

namespace Haas.Hosty.Core;

// Route metadata excludes transport/health traffic from warnings, never a privileged caller ID.
internal sealed record CoreDiagnosticsTransport;
internal sealed record ApiActivityWarning(string Reason, DateTimeOffset Since, long Requests, int Threshold, int WindowSeconds);
internal sealed record AppApiActivity(long TotalRequests, long TotalEligibleRequests, long Requests10s, long Requests60s,
    long EligibleRequests10s, long EligibleRequests60s, ApiActivityWarning? Warning, DateTimeOffset? RecoveredAt, string InstallationId);
internal sealed record ApiActivitySnapshot(string RunId, DateTimeOffset ObservedAt, bool Enabled, string Coverage,
    int SustainedThreshold, int BurstThreshold, int RecoverySeconds,
    IReadOnlyDictionary<string, AppApiActivity> Apps, IReadOnlyDictionary<string, AppApiActivity> Unattributed);

// One mutable holder follows async authorization calls without re-validating their credentials.
// No authority decision reads this context. Only verified tokens and already-read registry records
// can meet here; target app IDs, headers and propagated baggage alone cannot establish a caller.
internal sealed class CoreApiRequest : IDisposable
{
    private static readonly AsyncLocal<CoreApiRequest?> CurrentSlot = new();
    private readonly CoreApiActivity counters;
    private readonly string? bearer;
    private readonly long second;
    private readonly bool eligible;
    private readonly Activity? activity;
    private string? verifiedAppId;
    private AppRecord? observedApp;
    private bool counted;
    private bool active = true;
    public string? CallerAppId { get; private set; }
    public static string? Caller => CurrentSlot.Value is { active: true } request ? request.CallerAppId : null;

    internal CoreApiRequest(CoreApiActivity counters, string? bearer, bool eligible)
    {
        this.counters = counters;
        this.bearer = bearer;
        this.eligible = eligible;
        second = counters.Second;
        activity = Activity.Current;
        CurrentSlot.Value = this;
    }

    public static async Task InvokeAsync(HttpContext http, RequestDelegate next)
    {
        if (!http.Request.Path.StartsWithSegments("/api") && !http.Request.Path.StartsWithSegments("/control"))
        { await next(http); return; }
        var eligible = !HttpMethods.IsOptions(http.Request.Method)
            && http.GetEndpoint()?.Metadata.GetMetadata<CoreDiagnosticsTransport>() is null;
        using var request = new CoreApiRequest(http.RequestServices.GetRequiredService<CoreApiActivity>(),
            CoreSessionAuthorization.ReadBearerToken(http.Request), eligible);
        if (!eligible) Activity.Current?.SetCustomProperty(CoreTracing.ExcludedProperty, true);
        http.Response.OnStarting(() => { request.Complete(); return Task.CompletedTask; });
        try { await next(http); }
        finally { request.Complete(); }
    }

    public static void TokenValidated(string token, string appId)
    {
        if (CurrentSlot.Value is not { active: true } request || request.bearer != token) return;
        request.verifiedAppId = appId;
        if (request.observedApp is { } app && app.Id == appId) request.Confirm(app);
    }
    public static void AppObserved(AppRecord? app)
    {
        if (app is null || CurrentSlot.Value is not { active: true } request) return;
        request.observedApp = app;
        if (request.verifiedAppId == app.Id) request.Confirm(app);
    }
    // Used by non-service-token authorization, after it has verified the installed caller.
    public static void Authenticate(AppRecord app) => CurrentSlot.Value?.Confirm(app);
    public static void OperatorAuthenticated() => UnattributedAuthenticated("operator");
    public static void ExternalAuthenticated() => UnattributedAuthenticated("external");
    private static void UnattributedAuthenticated(string category)
    {
        if (CurrentSlot.Value is { active: true, counted: false } request)
        {
            request.counters.RecordUnattributed(category, request.second, request.eligible);
            request.counted = true;
        }
    }
    private void Confirm(AppRecord app)
    {
        if (!active || counted) return;
        CallerAppId = app.Id;
        activity?.SetTag(CoreTracing.CallerAttribute, app.Id);
        activity?.SetCustomProperty(CoreTracing.CallerAttribute, app.Id);
        counters.Record(app, second, eligible);
        counted = true;
    }
    private void Complete()
    {
        if (!active || counted) return;
        counters.RecordUnattributed("unknown", second, eligible);
        counted = true;
    }
    public void Dispose()
    {
        Complete(); active = false; observedApp = null;
        CurrentSlot.Value = null;
    }
}

internal sealed class CoreApiActivity(TimeProvider time, CoreSettingsService settings)
{
    private readonly ConcurrentDictionary<string, Counter> apps = new(StringComparer.Ordinal);
    private readonly Dictionary<string, Counter> unattributed = new(StringComparer.Ordinal)
    { ["operator"] = new(0), ["external"] = new(0), ["unknown"] = new(0) };
    private readonly long started = time.GetTimestamp();
    public string RunId { get; } = Guid.NewGuid().ToString("n");
    internal long Second => (long)time.GetElapsedTime(started).TotalSeconds;
    public void Record(AppRecord app, long second, bool eligible)
    {
        if (!settings.Diagnostics.CountersEnabled) return;
        var installation = app.InstalledAt.UtcTicks;
        if (!apps.TryGetValue(app.Id, out var counter)) counter = apps.GetOrAdd(app.Id, new Counter(installation));
        if (counter.Installation != installation)
        {
            if (counter.Installation > installation) return; // A late request cannot resurrect an older installation.
            counter = apps.AddOrUpdate(app.Id, static (_, stamp) => new Counter(stamp),
                static (_, current, stamp) => current.Installation >= stamp ? current : new Counter(stamp), installation);
        }
        counter.Add(second, eligible);
    }
    public void RecordUnattributed(string category, long second, bool eligible)
    {
        if (settings.Diagnostics.CountersEnabled) unattributed[category].Add(second, eligible);
    }
    public void Reconcile(IReadOnlyList<AppRecord> installed)
    {
        var roster = installed.ToDictionary(a => a.Id, a => a.InstalledAt.UtcTicks, StringComparer.Ordinal);
        foreach (var (id, counter) in apps)
            if (!roster.TryGetValue(id, out var installation) || installation != counter.Installation)
                ((ICollection<KeyValuePair<string, Counter>>)apps).Remove(new(id, counter));
        foreach (var (id, installation) in roster)
            if (!apps.ContainsKey(id)) apps.TryAdd(id, new Counter(installation));
    }
    public ApiActivitySnapshot Read()
    {
        var second = Second; var options = settings.Diagnostics;
        return new(RunId, time.GetUtcNow(), options.CountersEnabled, "Incoming Core API HTTP requests; streams counted once on opening; no inter-app traffic or service attribution.",
            options.SustainedRequests, options.BurstRequests, options.RecoverySeconds,
            apps.ToDictionary(kv => kv.Key, kv => kv.Value.Read(second), StringComparer.Ordinal),
            unattributed.ToDictionary(kv => kv.Key, kv => kv.Value.Read(second), StringComparer.Ordinal));
    }
    public void Evaluate(ILogger logger)
    {
        var options = settings.Diagnostics;
        if (!options.CountersEnabled) return;
        var second = Second; var now = time.GetUtcNow();
        foreach (var (id, counter) in apps)
        {
            var transition = counter.Evaluate(second, now, options);
            if (transition is { } message)
                logger.Log(message.State == "recovered" ? LogLevel.Information : LogLevel.Warning, "Core API activity {State}: app {AppId}, {Requests} requests / {WindowSeconds}s, threshold {Threshold}",
                    message.State, id, message.Requests, message.WindowSeconds, message.Threshold);
        }
    }
    public string PrometheusText()
    {
        var snapshot = Read(); var text = new StringBuilder();
        text.AppendLine("# TYPE hosty_core_api_accounting_enabled gauge");
        text.Append("hosty_core_api_accounting_enabled{hosty_app_id=\"hosty.core\"} ").AppendLine(snapshot.Enabled ? "1" : "0");
        if (!snapshot.Enabled) return text.ToString();
        text.AppendLine("# TYPE hosty_core_api_requests_total counter");
        text.AppendLine("# TYPE hosty_core_api_eligible_requests_total counter");
        text.AppendLine("# TYPE hosty_core_api_activity_warning gauge");
        foreach (var (id, app) in snapshot.Apps)
        {
            var labels = $"hosty_app_id=\"{Escape(id)}\",run_id=\"{RunId}\",installation_id=\"{app.InstallationId}\"";
            text.Append("hosty_core_api_requests_total{").Append(labels).Append("} ").AppendLine(app.TotalRequests.ToString(CultureInfo.InvariantCulture));
            text.Append("hosty_core_api_eligible_requests_total{").Append(labels).Append("} ").AppendLine(app.TotalEligibleRequests.ToString(CultureInfo.InvariantCulture));
            text.Append("hosty_core_api_activity_warning{").Append(labels).Append("} ").AppendLine(app.Warning is null ? "0" : "1");
        }
        return text.ToString();
    }
    private static string Escape(string value) => value.Replace("\\", "\\\\", StringComparison.Ordinal).Replace("\"", "\\\"", StringComparison.Ordinal).Replace("\n", "\\n", StringComparison.Ordinal);

    private sealed class Counter(long installation)
    {
        private readonly object gate = new();
        private readonly Bucket[] buckets = new Bucket[60];
        private long total, eligibleTotal, evaluatedWindow = -1, recoveryStart = -1, lastLogged = -300;
        private int sustainedWindows;
        private ApiActivityWarning? warning;
        private DateTimeOffset? recoveredAt;
        public long Installation { get; } = installation;
        public void Add(long second, bool eligible)
        {
            lock (gate)
            {
                ref var bucket = ref buckets[(int)(second % 60)];
                total++;
                if (eligible) eligibleTotal++;
                // Slow authentication must not overwrite a newer generation of the same slot.
                if (bucket.Second > second) return;
                if (bucket.Second != second) bucket = new() { Second = second };
                bucket.Requests++;
                if (eligible) bucket.Eligible++;
            }
        }
        public AppApiActivity Read(long second)
        {
            lock (gate) return new(total, eligibleTotal, Sum(second - 9, second, false), Sum(second - 59, second, false),
                Sum(second - 9, second, true), Sum(second - 59, second, true), warning, recoveredAt, Installation.ToString(CultureInfo.InvariantCulture));
        }
        public Transition? Evaluate(long second, DateTimeOffset now, CoreDiagnosticsSettings settings)
        {
            lock (gate)
            {
                var previous = warning?.Reason;
                var completed = second / 10 - 1;
                if (completed - evaluatedWindow > 3) { evaluatedWindow = completed - 3; sustainedWindows = 0; }
                while (evaluatedWindow < completed)
                {
                    evaluatedWindow++;
                    var requests = Sum(evaluatedWindow * 10, evaluatedWindow * 10 + 9, true);
                    sustainedWindows = requests > settings.SustainedRequests ? sustainedWindows + 1 : 0;
                    if (sustainedWindows >= 3 && warning is null)
                        warning = new("sustained", now, requests, settings.SustainedRequests, 10);
                }
                var rolling = Sum(second - 9, second, true);
                if (rolling > settings.BurstRequests && warning?.Reason != "burst")
                    warning = new("burst", warning?.Since ?? now, rolling, settings.BurstRequests, 10);
                if (warning is not null)
                {
                    if (rolling < settings.SustainedRequests / 2.0)
                    {
                        if (recoveryStart < 0) recoveryStart = second;
                        if (second - recoveryStart >= settings.RecoverySeconds)
                        { warning = null; recoveredAt = now; sustainedWindows = 0; recoveryStart = -1; }
                    }
                    else recoveryStart = -1;
                }
                var state = warning?.Reason;
                if (previous != state || (state is not null && second - lastLogged >= 300))
                {
                    lastLogged = second;
                    return new(state ?? "recovered", rolling, warning?.Threshold ?? settings.SustainedRequests, 10);
                }
                return null;
            }
        }
        private long Sum(long from, long through, bool eligible)
        {
            long total = 0;
            foreach (var bucket in buckets)
                if (bucket.Second >= from && bucket.Second <= through) total += eligible ? bucket.Eligible : bucket.Requests;
            return total;
        }
        private struct Bucket { public long Second, Requests, Eligible; }
    }
    private sealed record Transition(string State, long Requests, int Threshold, int WindowSeconds);
}

// Timer work is independent of the resource sampler and has no Docker/process acquisition.
internal sealed class CoreDiagnosticsMonitor(CoreApiActivity counters, AppRegistryStore apps, CoreTraceBuffer traces,
    ILogger<CoreDiagnosticsMonitor> logger, RuntimeResourceSampler resources) : BackgroundService
{
    private int dirty = 1;
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        void Changed(string _) => Interlocked.Exchange(ref dirty, 1);
        apps.Changed += Changed;
        try
        {
            using var timer = new PeriodicTimer(TimeSpan.FromSeconds(1));
            var tick = 0;
            do
            {
                try
                {
                    if (Interlocked.Exchange(ref dirty, 0) != 0 || tick++ % 30 == 0)
                    {
                        var installed = await apps.ListAppRecordsAsync(stoppingToken);
                        counters.Reconcile(installed);
                        traces.Reconcile(installed);
                    }
                    counters.Evaluate(logger);
                    traces.Expire();
                    resources.PublishActivity();
                }
                catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
                { logger.LogWarning("Core diagnostics registry refresh unavailable ({ErrorType})", ex.GetType().Name); }
            } while (await timer.WaitForNextTickAsync(stoppingToken));
        }
        catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { }
        finally { apps.Changed -= Changed; }
    }
}
