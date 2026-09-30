using System.Security.Cryptography;
using Whisper.net;
using Whisper.net.LibraryLoader;

namespace Hosty.Whisper;

internal sealed class SpeechEngine(IConfiguration config, ILogger<SpeechEngine> logger) : BackgroundService
{
    private readonly SemaphoreSlim gate = new(1, 1);
    private WhisperFactory? factory;
    public bool Ready => factory is not null;
    public bool Failed { get; private set; }
    // Upstream model revision and SHA-256 values are fixed, including the first download.
    private const string Revision = "5359861c739e955e79d9a303bcbc70fb988958b1";
    private static readonly Dictionary<string, (long Size, string Hash)> Models = new(StringComparer.Ordinal)
    {
        ["tiny"] = (77691713, "be07e048e1e599ad46341c8d2a135645097a538221678b7acdd1b1919c6e1b21"),
        ["base"] = (147951465, "60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe"),
        ["small"] = (487601967, "1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b"),
    };
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        try
        {
            var model = config["WHISPER_MODEL"] ?? "small";
            if (!Models.TryGetValue(model, out var expected)) throw new InvalidDataException("WHISPER_MODEL must be tiny, base or small.");
            var cache = config["HOSTY_APP_CACHE_DIR"] ?? throw new InvalidOperationException("Hosty cache directory is missing.");
            Directory.CreateDirectory(cache);
            var file = Path.Combine(cache, $"ggml-{model}.bin");
            if (!await VerifyAsync(file, expected, stoppingToken))
            {
                logger.LogInformation("Downloading the {Model} speech model ({Bytes} bytes)", model, expected.Size);
                var temporary = file + ".download";
                try
                {
                    using var http = new HttpClient { Timeout = TimeSpan.FromMinutes(15) };
                    await using var source = await http.GetStreamAsync($"https://huggingface.co/ggerganov/whisper.cpp/resolve/{Revision}/ggml-{model}.bin", stoppingToken);
                    await using (var output = File.Create(temporary))
                    {
                        var chunk = new byte[81920]; long total = 0; int count;
                        while ((count = await source.ReadAsync(chunk, stoppingToken)) > 0)
                        {
                            total += count;
                            if (total > expected.Size) throw new InvalidDataException("Model download exceeded its pinned size.");
                            await output.WriteAsync(chunk.AsMemory(0, count), stoppingToken);
                        }
                    }
                    if (!await VerifyAsync(temporary, expected, stoppingToken)) throw new InvalidDataException("Model checksum mismatch.");
                    File.Move(temporary, file, overwrite: true);
                }
                finally { File.Delete(temporary); }
            }
            RuntimeOptions.RuntimeLibraryOrder = [RuntimeLibrary.Cpu];
            factory = WhisperFactory.FromPath(file, new WhisperFactoryOptions { UseGpu = false });
            logger.LogInformation("Speech recognition is ready ({Model}, CPU)", model);
        }
        catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { }
        catch (Exception ex)
        {
            Failed = true;
            logger.LogError("Speech model initialization failed ({ErrorType}): check model downloads and CPU runtime prerequisites", ex.GetType().Name);
        }
    }
    private static async Task<bool> VerifyAsync(string file, (long Size, string Hash) expected, CancellationToken ct)
    {
        if (!File.Exists(file) || new FileInfo(file).Length != expected.Size) return false;
        await using var input = File.OpenRead(file);
        return Convert.ToHexString(await SHA256.HashDataAsync(input, ct)).Equals(expected.Hash, StringComparison.OrdinalIgnoreCase);
    }
    public Task<bool> TryEnterAsync(CancellationToken ct) => gate.WaitAsync(0, ct);
    public void Exit() => gate.Release();
    public static bool IsLanguage(string language) => language == "auto" || WhisperFactory.GetSupportedLanguages().Contains(language);
    public async Task<string> TranscribeAsync(float[] samples, string language, CancellationToken ct)
    {
        if (samples.All(s => Math.Abs(s) < 0.0001f)) return "";
        using var processor = factory!.CreateBuilder().WithLanguage(language).Build();
        var text = new System.Text.StringBuilder();
        await foreach (var segment in processor.ProcessAsync(samples, ct)) text.Append(segment.Text);
        return text.ToString().Trim();
    }
    public override void Dispose()
    {
        base.Dispose();
        factory?.Dispose();
        gate.Dispose();
    }
}
