using Hosty.Whisper;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;
namespace Hosty.Whisper.Tests;

public sealed class NativeSpeechTests
{
    [NativeSpeechFact]
    public async Task CpuRuntimeLoadsVerifiedModelRecognizesRussianAndHonorsCapacity()
    {
        var cache = Environment.GetEnvironmentVariable("HOSTY_WHISPER_TEST_CACHE") ?? Path.Combine(Path.GetTempPath(), "hosty-whisper-test-models");
        var config = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
            { ["HOSTY_APP_CACHE_DIR"] = cache, ["WHISPER_MODEL"] = "tiny" }).Build();
        using var engine = new SpeechEngine(config, NullLogger<SpeechEngine>.Instance);
        using var deadline = new CancellationTokenSource(TimeSpan.FromMinutes(15));
        await engine.StartAsync(deadline.Token);
        while (!engine.Ready && !engine.Failed) await Task.Delay(100, deadline.Token);
        Assert.True(engine.Ready, "The CPU runtime or pinned model could not be loaded.");
        Assert.True(await engine.TryEnterAsync(deadline.Token));
        Assert.False(await engine.TryEnterAsync(deadline.Token));
        try
        {
            var wave = await File.ReadAllBytesAsync(Path.Combine(AppContext.BaseDirectory, "Fixtures", "russian.wav"), deadline.Token);
            var text = await engine.TranscribeAsync(WaveAudio.Decode(wave), "ru", deadline.Token);
            Assert.Contains("Привет", text, StringComparison.OrdinalIgnoreCase);
            Assert.Equal("", await engine.TranscribeAsync(new float[16000], "ru", deadline.Token));
            using var cancelled = new CancellationTokenSource(); cancelled.Cancel();
            await Assert.ThrowsAnyAsync<OperationCanceledException>(() => engine.TranscribeAsync(WaveAudio.Decode(wave), "ru", cancelled.Token));
        }
        finally { engine.Exit(); await engine.StopAsync(deadline.Token); }
    }
}
public sealed class NativeSpeechFactAttribute : FactAttribute
{
    public NativeSpeechFactAttribute()
    {
        if (Environment.GetEnvironmentVariable("HOSTY_WHISPER_INTEGRATION") != "1") Skip = "Set HOSTY_WHISPER_INTEGRATION=1 to download the pinned tiny model and run native CPU recognition.";
    }
}
