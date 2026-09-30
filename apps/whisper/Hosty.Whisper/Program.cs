using HostySdk.App;
using Hosty.Whisper;

var builder = WebApplication.CreateBuilder(args);
var options = HostyAppOptions.FromConfiguration(builder.Configuration, "hosty.whisper");
builder.WebHost.UseUrls($"http://127.0.0.1:{builder.Configuration["HOSTY_PORT_HTTP"] ?? builder.Configuration["PORT"] ?? "3500"}");
builder.WebHost.ConfigureKestrel(o => o.Limits.MaxRequestBodySize = WaveAudio.MaxBytes);
builder.Services.AddSingleton(new HttpClient(new HttpClientHandler { AllowAutoRedirect = false }) { Timeout = TimeSpan.FromMinutes(5) });
builder.Services.AddSingleton(options);
builder.Services.AddSingleton<HostyProviderClient>();
builder.Services.AddSingleton<SpeechEngine>();
builder.Services.AddHostedService(sp => sp.GetRequiredService<SpeechEngine>());
var app = builder.Build();
app.MapGet("/healthz", () => Results.Ok(new { status = "running" }));
app.MapGet("/api/speech/v1/capabilities", async (HttpContext context, HostyProviderClient access, SpeechEngine engine) =>
{
    var denied = await Authorize(context, access);
    return denied ?? Results.Json(new HostySpeechCapabilities(1, ["audio/wav"], WaveAudio.MaxBytes, WaveAudio.MaxSeconds, "whisper.cpp/cpu", engine.Ready));
});
app.MapPost("/api/speech/v1/transcriptions", async (HttpContext context, HostyProviderClient access, SpeechEngine engine) =>
{
    var denied = await Authorize(context, access);
    if (denied is not null) return denied;
    if (!engine.Ready) return Results.Json(new { code = "speech_not_ready", message = engine.Failed ? "The speech model could not be loaded. Check the app logs and restart." : "The speech model is loading. Try again shortly." }, statusCode: 503);
    if (!context.Request.ContentType?.Split(';')[0].Equals("audio/wav", StringComparison.OrdinalIgnoreCase) ?? true)
        return Results.Json(new { code = "speech_format_unsupported", message = "Use a 16 kHz mono PCM16 WAV recording." }, statusCode: 415);
    if (!await engine.TryEnterAsync(context.RequestAborted)) return Results.Json(new { code = "speech_busy", message = "Speech recognition is busy. Try again shortly." }, statusCode: 429);
    using var deadline = CancellationTokenSource.CreateLinkedTokenSource(context.RequestAborted);
    deadline.CancelAfter(TimeSpan.FromMinutes(5));
    try
    {
        var samples = await WaveAudio.ReadAsync(context.Request.Body, deadline.Token);
        var language = context.Request.Query["language"].ToString();
        if (language.Length == 0) language = "auto";
        if (!SpeechEngine.IsLanguage(language)) return Results.Json(new { code = "speech_language_invalid", message = "Use a supported language code or auto." }, statusCode: 400);
        var text = await engine.TranscribeAsync(samples, language, deadline.Token);
        return Results.Json(new HostySpeechResult(text, language == "auto" ? null : language));
    }
    catch (BadHttpRequestException ex) when (ex.StatusCode == 413) { return Results.Json(new { code = "speech_audio_too_large", message = "The recording exceeds the two-minute input limit." }, statusCode: 413); }
    catch (InvalidDataException ex) { return Results.Json(new { code = "speech_audio_invalid", message = ex.Message }, statusCode: 400); }
    catch (OperationCanceledException) { return Results.StatusCode(context.RequestAborted.IsCancellationRequested ? 499 : 504); }
    catch (Exception ex)
    {
        app.Logger.LogError("Speech recognition failed ({ErrorType})", ex.GetType().Name);
        return Results.Json(new { code = "speech_failed", message = "Speech recognition failed. The recording was not saved." }, statusCode: 503);
    }
    finally { engine.Exit(); }
});
await app.RunAsync();

static async Task<IResult?> Authorize(HttpContext context, HostyProviderClient access)
{
    var header = context.Request.Headers.Authorization.ToString();
    if (!header.StartsWith("Bearer ", StringComparison.OrdinalIgnoreCase)) return Results.Unauthorized();
    try { await access.ValidateAsync(header[7..], "speech-to-text", cancellationToken: context.RequestAborted); return null; }
    catch (HostyProviderException ex) { return Results.Json(new { code = ex.Code, message = ex.Message }, statusCode: ex.StatusCode); }
    catch (HttpRequestException) { return Results.Json(new { code = "core_unavailable", message = "Core authorization is unavailable." }, statusCode: 503); }
    catch (OperationCanceledException) { return Results.StatusCode(503); }
}
