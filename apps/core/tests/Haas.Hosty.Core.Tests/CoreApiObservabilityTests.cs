using System.Diagnostics;
using Haas.Hosty.Core;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using OpenTelemetry.Trace;

namespace Haas.Hosty.Core.Tests;

// OpenTelemetry registers process-wide listeners, including HttpClient instrumentation.
// Keep exact-span assertions isolated from traffic emitted by other test collections.
[CollectionDefinition("CoreTracingListeners", DisableParallelization = true)]
public sealed class CoreTracingListenersCollection;

[Collection("CoreTracingListeners")]
public sealed class CoreApiObservabilityTests : IDisposable
{
    private readonly string root = Path.Combine(Path.GetTempPath(), "hosty-api-observability-" + Guid.NewGuid().ToString("N"));
    private readonly ManualTime time = new();
    private CoreSettingsService Settings() => new(new CoreSettingsStore(new(root, root + "/core", root + "/apps", root + "/backups", root + "/sources", root + "/auth", root + "/audit"), NullLogger<CoreSettingsStore>.Instance));
    internal static AppRecord App(string id = "example.caller") => new(id, "Caller", null, "1.0.0", "runtime", false,
        "installed", null, null, "docker", "installed", "running", null, null, [], new Dictionary<string, AppSettingValue>(), [], [], [],
        DateTimeOffset.UnixEpoch, DateTimeOffset.UnixEpoch, GrantedCorePermissions: [CoreAppPermissions.ReadCore, CoreAppPermissions.ReadApps]);
    [Fact]
    public void ExactWindows_ConcurrentRequests_ExclusionsAndRunReset()
    {
        var settings = Settings(); var counters = new CoreApiActivity(time, settings); var app = App();
        counters.Reconcile([app]);
        Assert.Equal(0, counters.Read().Apps[app.Id].TotalRequests);
        Parallel.For(0, 10000, i => counters.Record(app, counters.Second, i % 2 == 0));
        var value = counters.Read().Apps[app.Id];
        Assert.Equal(10000, value.TotalRequests); Assert.Equal(5000, value.TotalEligibleRequests);
        time.Advance(10);
        Assert.Equal(0, counters.Read().Apps[app.Id].Requests10s);
        Assert.Equal(10000, counters.Read().Apps[app.Id].Requests60s);
        time.Advance(50);
        Assert.Equal(0, counters.Read().Apps[app.Id].Requests60s);
        Assert.Equal(10000, counters.Read().Apps[app.Id].TotalRequests);
        Assert.NotEqual(counters.RunId, new CoreApiActivity(time, settings).RunId);
    }
    [Fact]
    public void OperatorExternalAndUnknownRequestsUseFixedSeparateBuckets()
    {
        var counters = new CoreApiActivity(time, Settings());
        using (new CoreApiRequest(counters, null, true)) CoreApiRequest.OperatorAuthenticated();
        using (new CoreApiRequest(counters, "validated-external", true))
        {
            CoreApiRequest.ExternalAuthenticated();
            CoreApiRequest.ExternalAuthenticated();
        }
        using (new CoreApiRequest(counters, "unverified", true)) { }
        var snapshot = counters.Read();
        Assert.Empty(snapshot.Apps);
        Assert.Equal(3, snapshot.Unattributed.Count);
        Assert.All(snapshot.Unattributed.Values, value => Assert.Equal(1, value.TotalRequests));
    }

    [Fact]
    public void ExistingCounterIncrement_DoesNotAllocatePerRequest()
    {
        var counters = new CoreApiActivity(time, Settings()); var app = App();
        for (var i = 0; i < 10000; i++) counters.Record(app, 0, true);
        var before = GC.GetAllocatedBytesForCurrentThread();
        for (var i = 0; i < 10000; i++) counters.Record(app, 0, true);
        Assert.Equal(before, GC.GetAllocatedBytesForCurrentThread());
        Assert.Equal(20000, counters.Read().Apps[app.Id].TotalRequests);
    }

    [Fact]
    public void SustainedWarning_RequiresThreeWindows_RecoversAfterContinuousQuiet()
    {
        var counters = new CoreApiActivity(time, Settings()); var app = App();
        for (var window = 0; window < 3; window++)
        {
            for (var i = 0; i < 51; i++) counters.Record(app, counters.Second, true);
            counters.Evaluate(NullLogger.Instance);
            Assert.Null(counters.Read().Apps[app.Id].Warning);
            time.Advance(10); counters.Evaluate(NullLogger.Instance);
        }
        Assert.Equal("sustained", counters.Read().Apps[app.Id].Warning!.Reason);
        time.Advance(59); counters.Evaluate(NullLogger.Instance);
        Assert.NotNull(counters.Read().Apps[app.Id].Warning);
        time.Advance(1); counters.Evaluate(NullLogger.Instance);
        Assert.Null(counters.Read().Apps[app.Id].Warning);
        Assert.NotNull(counters.Read().Apps[app.Id].RecoveredAt);
    }
    [Fact]
    public void Burst_ExcludesTransportTraffic_LogsOnlyTransitionsAndFiveMinuteSummaries()
    {
        var counters = new CoreApiActivity(time, Settings()); var app = App(); var log = new CaptureLogger();
        for (var i = 0; i < 500; i++) counters.Record(app, counters.Second, false);
        counters.Evaluate(log); Assert.Empty(log.Messages);
        for (var i = 0; i < 201; i++) counters.Record(app, counters.Second, true);
        counters.Evaluate(log);
        Assert.Equal("burst", counters.Read().Apps[app.Id].Warning!.Reason);
        for (var i = 0; i < 299; i++) { time.Advance(1); counters.Record(app, counters.Second, true); counters.Evaluate(log); }
        // Quiet traffic clears once, rather than emitting a message per request/tick.
        Assert.Equal(2, log.Messages.Count);
        Assert.Contains("recovered", log.Messages[1]);
    }
    [Fact]
    public void CallerRequiresVerifiedPresentedTokenAndObservedInstallation_NotTargetOrOtherCredential()
    {
        var counters = new CoreApiActivity(time, Settings()); var app = App();
        using (new CoreApiRequest(counters, "presented", true))
        {
            CoreApiRequest.AppObserved(App("target.app"));
            CoreApiRequest.TokenValidated("unrelated", app.Id);
            CoreApiRequest.AppObserved(app);
            Assert.Empty(counters.Read().Apps);
            CoreApiRequest.TokenValidated("presented", app.Id);
            Assert.Equal(1, counters.Read().Apps[app.Id].TotalRequests);
            CoreApiRequest.AppObserved(app); CoreApiRequest.Authenticate(app);
        }
        Assert.Equal(1, counters.Read().Apps[app.Id].TotalRequests);
        Assert.Equal(0, counters.Read().Unattributed["unknown"].TotalRequests);
        Assert.Null(CoreApiRequest.Caller);
        using (new CoreApiRequest(counters, "unverified", true)) CoreApiRequest.AppObserved(app);
        Assert.Equal(1, counters.Read().Unattributed["unknown"].TotalRequests);
    }
    [Fact]
    public void InstallationReplacementAndRemoval_RetireCounters_LateAuthenticationCannotOverwriteNewBucket()
    {
        var counters = new CoreApiActivity(time, Settings()); var app = App();
        counters.Record(app, 0, true); time.Advance(60); counters.Record(app, 60, true); counters.Record(app, 0, true);
        Assert.Equal(1, counters.Read().Apps[app.Id].Requests10s);
        var replaced = app with { InstalledAt = app.InstalledAt.AddSeconds(1) };
        counters.Reconcile([replaced]); Assert.Equal(0, counters.Read().Apps[app.Id].TotalRequests);
        counters.Record(app, 60, true); Assert.Equal(0, counters.Read().Apps[app.Id].TotalRequests);
        counters.Reconcile([]); Assert.Empty(counters.Read().Apps);
    }
    [Fact]
    public async Task Settings_ValidatePersistAndReset_WithoutOverwritingOtherGroups()
    {
        var settings = Settings();
        await settings.UpdateAsync(new Dictionary<string, string?> { [CoreDiagnosticSettings.Sampling] = "1", [CoreDiagnosticSettings.Burst] = "300" });
        Assert.Equal(1, Settings().Diagnostics.TraceSampleRatio);
        await settings.UpdateAsync(new Dictionary<string, string?> { ["HOSTY_AUTH_CLI_GRANT_HOURS"] = "2" });
        Assert.Equal(300, Settings().Diagnostics.BurstRequests);
        foreach (var raw in new[] { "NaN", "-1", "1.1", "Infinity" })
            await Assert.ThrowsAsync<AppLifecycleException>(() => settings.UpdateAsync(new Dictionary<string, string?> { [CoreDiagnosticSettings.Sampling] = raw }));
        await settings.UpdateAsync(new Dictionary<string, string?> { [CoreDiagnosticSettings.Sampling] = null });
        Assert.Equal(0.1, Settings().Diagnostics.TraceSampleRatio);
        await Assert.ThrowsAsync<AppLifecycleException>(() => settings.UpdateAsync(new Dictionary<string, string?> { [CoreDiagnosticSettings.Burst] = "25" }));
        var counters = new CoreApiActivity(time, settings); counters.Record(App(), 0, true);
        Assert.Contains("installation_id=", counters.PrometheusText());
        await settings.UpdateAsync(new Dictionary<string, string?> { [CoreDiagnosticSettings.Enabled] = "0" });
        Assert.Contains("hosty_core_api_accounting_enabled{hosty_app_id=\"hosty.core\"} 0", counters.PrometheusText());
        Assert.DoesNotContain("hosty_core_api_requests_total{", counters.PrometheusText());
    }
    [Fact]
    public void TraceDemand_IndependentReaders_ExpiryRevocationAndSampling()
    {
        var settings = Settings(); var buffer = new CoreTraceBuffer(time, settings); var sampler = new CoreDemandSampler(buffer, settings);
        var parent = new ActivityContext(ActivityTraceId.CreateRandom(), ActivitySpanId.CreateRandom(), ActivityTraceFlags.Recorded);
        var sampling = new SamplingParameters(parent, parent.TraceId, "fixture", ActivityKind.Internal);
        Assert.Equal(SamplingDecision.Drop, sampler.ShouldSample(sampling).Decision);
        buffer.Renew(App("one")); Assert.True(buffer.IsCapturing);
        Assert.Equal(SamplingDecision.RecordAndSample, sampler.ShouldSample(sampling).Decision);
        time.Advance(20); buffer.Renew(App("two")); buffer.Revoke("one");
        time.Advance(11); buffer.Expire(); Assert.True(buffer.IsCapturing);
        buffer.Reconcile([App("two") with { GrantedCorePermissions = [] }]); Assert.False(buffer.IsCapturing);
        buffer.Renew(App("three")); time.Advance(30); Assert.False(buffer.IsCapturing);
    }
    [Fact]
    public void Traces_BoundedReplayRestartAndSanitizedAttributes()
    {
        var buffer = new CoreTraceBuffer(time, Settings()); buffer.Renew(App());
        for (var i = 0; i < CoreTraceBuffer.MaxSpans + 10; i++)
        {
            using var activity = new Activity("sensitive/raw?token=secret").SetIdFormat(ActivityIdFormat.W3C).Start();
            activity.SetTag("http.route", "/api/apps/{appId}"); activity.SetTag("url.full", "https://user:secret@host/raw?q=secret");
            activity.SetTag("hosty.caller.app.id", "spoofed"); activity.SetBaggage("password", "secret");
            activity.SetCustomProperty(CoreTracing.CallerAttribute, "verified"); activity.Stop(); buffer.Add(activity);
        }
        var page = buffer.Read(null, 0, 500);
        Assert.Equal(10, page.DroppedSpans); Assert.Equal("cursor_expired", page.GapReason); Assert.Equal(11, page.FirstAvailableSequence);
        Assert.True(page.HasMore); Assert.Equal(page, buffer.Read(null, 0, 500) with { Spans = page.Spans });
        Assert.All(page.Spans, span => { Assert.Equal("verified", span.Attributes[CoreTracing.CallerAttribute]); Assert.False(span.Attributes.ContainsKey("url.full")); Assert.DoesNotContain("secret", span.Name); });
        Assert.Equal("core_restarted", buffer.Read("previous", 10000, 10).GapReason);
        time.Advance(60); Assert.Empty(buffer.Read(buffer.RunId, 0, 500).Spans); Assert.False(buffer.IsCapturing);
    }
    [Fact]
    public void SpanWireLimit_AccountsForEscapedUnicodeAndSequenceWidth()
    {
        var buffer = new CoreTraceBuffer(time, Settings()); buffer.Renew(App());
        using (var small = new Activity("fixture").SetIdFormat(ActivityIdFormat.W3C).Start())
        {
            small.SetTag("http.route", new string('漢', 256)); small.Stop(); buffer.Add(small);
        }
        using (var oversized = new Activity("fixture").SetIdFormat(ActivityIdFormat.W3C).Start())
        {
            foreach (var key in new[] { "http.route", "network.protocol.version", "error.type" })
                oversized.SetTag(key, new string('漢', 256));
            oversized.Stop(); buffer.Add(oversized);
        }
        var page = buffer.Read(null, 0, 100);
        var retained = Assert.Single(page.Spans);
        Assert.True(System.Text.Json.JsonSerializer.SerializeToUtf8Bytes(retained with { Sequence = long.MaxValue },
            CoreJsonSerializerContext.Default.CoreSpanRecord).Length <= CoreTraceBuffer.MaxSpanBytes);
        Assert.Equal(1, page.TruncatedSpans);
        Assert.Equal(1, page.DroppedSpans);
    }

    [Fact]
    public void CorrelatedLogs_DoNotFoldAcrossTraces_AndBackgroundLogsKeepNullIds()
    {
        var ring = new CoreLogRing(10); var now = time.GetUtcNow();
        ring.Add(now, LogLevel.Information, "Core", "same", null, "trace-one", "span", "caller");
        ring.Add(now, LogLevel.Information, "Core", "same", null, "trace-two", "span", "caller");
        ring.Add(now, LogLevel.Information, "Core", "same", null, "trace-two", "span", "caller");
        ring.Add(now, LogLevel.Information, "Core", "same", null);
        var records = ring.Read(10, LogLevel.Trace);
        Assert.Equal(3, records.Count); Assert.Equal(2, records[1].Count); Assert.Null(records[2].TraceId);
    }
    [Fact]
    public async Task StandardSdk_CapturesCustomChildSpanAndCorrelatedLog_WithVerifiedCaller()
    {
        var settings = Settings();
        await settings.UpdateAsync(new Dictionary<string, string?> { [CoreDiagnosticSettings.Sampling] = "1" });
        var services = new ServiceCollection(); services.AddSingleton(settings); services.AddLogging();
        CoreTracing.Configure(services);
        await using var provider = services.BuildServiceProvider();
        _ = provider.GetRequiredService<TracerProvider>();
        var traces = provider.GetRequiredService<CoreTraceBuffer>(); traces.Renew(App());
        var logs = new CoreLogBuffer();
        using var loggerProvider = new CoreLogBufferLoggerProvider(logs, new LogClock());
        var logger = loggerProvider.CreateLogger("Hosty.Fixture");
        string traceId;
        using (var parent = CoreTracing.Source.StartActivity("fixture", ActivityKind.Server))
        {
            Assert.NotNull(parent); traceId = parent.TraceId.ToHexString();
            using var request = new CoreApiRequest(provider.GetRequiredService<CoreApiActivity>(), "verified", true);
            CoreApiRequest.TokenValidated("verified", App().Id); CoreApiRequest.AppObserved(App());
            using (var child = CoreTracing.Source.StartActivity("fixture.step"))
            {
                Assert.NotNull(child); logger.LogInformation("Fixture operation");
            }
        }
        var page = traces.Read(null, 0, 100);
        Assert.Equal(2, page.Spans.Count);
        var step = Assert.Single(page.Spans, span => span.Name == "fixture.step");
        Assert.Equal(traceId, step.TraceId); Assert.NotNull(step.ParentSpanId);
        Assert.Equal(App().Id, step.Attributes[CoreTracing.CallerAttribute]);
        var log = Assert.Single(logs.Ring(CoreLogRingKind.Hosty).Read(10, LogLevel.Trace));
        Assert.Equal(traceId, log.TraceId); Assert.Equal(step.SpanId, log.SpanId); Assert.Equal(App().Id, log.CallerAppId);
    }
    [Fact]
    public async Task StandardHttpClientTracing_ExcludesSupervisorHealthProbes()
    {
        var settings = Settings();
        await settings.UpdateAsync(new Dictionary<string, string?> { [CoreDiagnosticSettings.Sampling] = "1" });
        var services = new ServiceCollection(); services.AddSingleton(settings); services.AddLogging();
        CoreTracing.Configure(services);
        await using var provider = services.BuildServiceProvider();
        _ = provider.GetRequiredService<TracerProvider>();
        var traces = provider.GetRequiredService<CoreTraceBuffer>(); traces.Renew(App());
        using var listener = new System.Net.Sockets.TcpListener(System.Net.IPAddress.Loopback, 0);
        listener.Start();
        var port = ((System.Net.IPEndPoint)listener.LocalEndpoint).Port;
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        var server = Task.Run(async () =>
        {
            for (var i = 0; i < 2; i++)
            {
                using var connection = await listener.AcceptTcpClientAsync(timeout.Token);
                await using var stream = connection.GetStream();
                using var reader = new StreamReader(stream, leaveOpen: true);
                while (await reader.ReadLineAsync(timeout.Token) is { Length: > 0 }) { }
                await stream.WriteAsync("HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"u8.ToArray(), timeout.Token);
            }
        }, timeout.Token);
        using var client = new HttpClient();
        using var response = await client.GetAsync($"http://127.0.0.1:{port}/ordinary", timeout.Token);
        response.EnsureSuccessStatusCode();
        Assert.True(await new NetworkHealthProbe().ProbeAsync(new("http", "127.0.0.1", port, "/", TimeSpan.FromSeconds(5)), timeout.Token));
        await server;
        var span = Assert.Single(traces.Read(null, 0, 100).Spans);
        Assert.Equal("Client", span.Kind);
    }

    private sealed class LogClock : IClock { public DateTimeOffset UtcNow => DateTimeOffset.UtcNow; }
    public void Dispose() { if (Directory.Exists(root)) Directory.Delete(root, true); }
    private sealed class ManualTime : TimeProvider
    {
        private long ticks;
        public override long TimestampFrequency => TimeSpan.TicksPerSecond;
        public override long GetTimestamp() => ticks;
        public override DateTimeOffset GetUtcNow() => DateTimeOffset.UnixEpoch.AddTicks(ticks);
        public void Advance(int seconds) => ticks += TimeSpan.FromSeconds(seconds).Ticks;
    }
    private sealed class CaptureLogger : ILogger
    {
        public List<string> Messages { get; } = [];
        public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;
        public bool IsEnabled(LogLevel level) => true;
        public void Log<TState>(LogLevel level, EventId id, TState state, Exception? exception, Func<TState, Exception?, string> formatter) => Messages.Add(formatter(state, exception));
    }
}
