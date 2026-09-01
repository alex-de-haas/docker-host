namespace Haas.Hosty.Cli.Commands;

using System.Net;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

internal sealed partial class CoreControlClient : IDisposable
{
    [JsonSourceGenerationOptions(
        PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase,
        PropertyNameCaseInsensitive = true,
        NumberHandling = JsonNumberHandling.AllowReadingFromString)]
    [JsonSerializable(typeof(ControlDiscoveryDocument))]
    internal partial class ControlJsonContext : JsonSerializerContext;

    private static readonly TimeSpan DefaultProbeTimeout = TimeSpan.FromSeconds(10);
    private static readonly TimeSpan DefaultOperationTimeout = TimeSpan.FromMinutes(10);
    private static readonly IReadOnlyDictionary<string, string> EmptyHeaders = new Dictionary<string, string>();

    private readonly HttpClient httpClient;
    private readonly TimeSpan probeTimeout;
    private readonly TimeSpan operationTimeout;

    private CoreControlClient(string controlBaseUrl, HttpClient httpClient, TimeSpan probeTimeout, TimeSpan operationTimeout, int? coreProcessId)
    {
        ControlBaseUrl = controlBaseUrl.TrimEnd('/');
        this.httpClient = httpClient;
        this.probeTimeout = probeTimeout;
        this.operationTimeout = operationTimeout;
        CoreProcessId = coreProcessId;
    }

    public string ControlBaseUrl { get; }

    // PID of the Core process this discovery file points at, when recorded (schema >= 2). Lets
    // callers wait for that process to fully exit after requesting a stop. Null for older Cores.
    public int? CoreProcessId { get; }

    public static async Task<CoreControlClient?> TryCreateAsync(
        CommandContext context,
        TimeSpan? probeTimeout = null,
        TimeSpan? operationTimeout = null,
        CancellationToken cancellationToken = default)
    {
        var path = Path.Combine(context.Environment.RootDirectory, "core", "run", "control.json");
        if (!File.Exists(path))
        {
            return null;
        }

        // A locked, truncated, or mid-write control.json must degrade to "discovery unavailable"
        // rather than crash the caller. FileShare.ReadWrite tolerates the writer holding it open.
        ControlDiscoveryDocument? discovery;
        try
        {
            await using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
            discovery = await CliJson.DeserializeAsync<ControlDiscoveryDocument>(stream, cancellationToken);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or JsonException)
        {
            return null;
        }

        if (discovery is null || string.IsNullOrWhiteSpace(discovery.ControlBaseUrl))
        {
            return null;
        }

        // A hard-killed Core never runs its ApplicationStopped cleanup, so control.json can outlive
        // the process. If it names a PID that is no longer alive, treat it as not running and remove
        // the orphan so the next read takes the clean "not running" path instead of a connection
        // error (and the stale secret it holds stops lingering on disk). PID absent => can't tell,
        // so trust the file (older Core, or a process we can't observe).
        if (discovery.ProcessId is int pid && pid > 0 && !ProcessLiveness.IsAlive(pid))
        {
            ControlDiscovery.TryDeleteStale(path);
            return null;
        }

        var httpClient = new HttpClient
        {
            Timeout = Timeout.InfiniteTimeSpan,
        };
        foreach (var header in discovery.RequiredHeaders ?? EmptyHeaders)
        {
            httpClient.DefaultRequestHeaders.TryAddWithoutValidation(header.Key, header.Value);
        }

        return new CoreControlClient(
            discovery.ControlBaseUrl,
            httpClient,
            probeTimeout ?? DefaultProbeTimeout,
            operationTimeout ?? DefaultOperationTimeout,
            discovery.ProcessId is > 0 ? discovery.ProcessId : null);
    }

    public async Task<T?> GetAsync<T>(string path, CancellationToken cancellationToken = default)
        => await SendAsync<T>(HttpMethod.Get, path, body: null, probeTimeout, cancellationToken);

    public async Task<T?> PostAsync<T>(string path, object? body = null, CancellationToken cancellationToken = default)
        => await SendAsync<T>(HttpMethod.Post, path, body, operationTimeout, cancellationToken);

    public async Task<T?> PutAsync<T>(string path, object? body = null, CancellationToken cancellationToken = default)
        => await SendAsync<T>(HttpMethod.Put, path, body, operationTimeout, cancellationToken);

    public async Task<T?> DeleteAsync<T>(string path, CancellationToken cancellationToken = default)
        => await SendAsync<T>(HttpMethod.Delete, path, body: null, operationTimeout, cancellationToken);

    public Task PostAsync(string path, CancellationToken cancellationToken = default)
        => SendNoContentAsync(HttpMethod.Post, path, operationTimeout, cancellationToken);

    private async Task<T?> SendAsync<T>(HttpMethod method, string path, object? body, TimeSpan timeout, CancellationToken cancellationToken)
    {
        using var timeoutSource = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeoutSource.CancelAfter(timeout);

        try
        {
            using var request = new HttpRequestMessage(method, $"{ControlBaseUrl}/{path.TrimStart('/')}");
            if (body is not null)
            {
                var json = JsonSerializer.Serialize(body, CliJson.TypeInfo(body.GetType()));
                request.Content = new StringContent(json, Encoding.UTF8, "application/json");
            }

            using var response = await httpClient.SendAsync(request, timeoutSource.Token);
            if (!response.IsSuccessStatusCode)
            {
                var responseBody = await response.Content.ReadAsStringAsync(timeoutSource.Token);
                throw new CoreControlException(method.Method, path, response.StatusCode, responseBody);
            }

            if (response.Content.Headers.ContentLength == 0)
            {
                return default;
            }

            await using var stream = await response.Content.ReadAsStreamAsync(timeoutSource.Token);
            return await CliJson.DeserializeAsync<T>(stream, timeoutSource.Token);
        }
        catch (OperationCanceledException) when (timeoutSource.IsCancellationRequested && !cancellationToken.IsCancellationRequested)
        {
            throw new CoreControlTimeoutException(method.Method, path, timeout);
        }
    }

    private async Task SendNoContentAsync(HttpMethod method, string path, TimeSpan timeout, CancellationToken cancellationToken)
    {
        using var timeoutSource = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeoutSource.CancelAfter(timeout);

        try
        {
            using var request = new HttpRequestMessage(method, $"{ControlBaseUrl}/{path.TrimStart('/')}");
            using var response = await httpClient.SendAsync(request, timeoutSource.Token);
            if (!response.IsSuccessStatusCode)
            {
                var responseBody = await response.Content.ReadAsStringAsync(timeoutSource.Token);
                throw new CoreControlException(method.Method, path, response.StatusCode, responseBody);
            }
        }
        catch (OperationCanceledException) when (timeoutSource.IsCancellationRequested && !cancellationToken.IsCancellationRequested)
        {
            throw new CoreControlTimeoutException(method.Method, path, timeout);
        }
    }

    public void Dispose()
        => httpClient.Dispose();

    internal sealed record ControlDiscoveryDocument(
        string ControlBaseUrl,
        // Nullable so an older control.json (or a partial write) that omits the map degrades to "no
        // headers" rather than NRE-ing the foreach that applies them.
        IReadOnlyDictionary<string, string>? RequiredHeaders = null,
        int? ProcessId = null,
        string? Nonce = null);
}

internal sealed class CoreControlException(
    string method,
    string path,
    HttpStatusCode statusCode,
    string responseBody) : Exception($"{method} {path} failed with HTTP {(int)statusCode}.")
{
    public string Method { get; } = method;

    public string Path { get; } = path;

    public HttpStatusCode StatusCode { get; } = statusCode;

    public string ResponseBody { get; } = responseBody;
}

internal sealed class CoreControlTimeoutException(
    string method,
    string path,
    TimeSpan timeout) : TaskCanceledException($"{method} {path} did not complete within {FormatTimeout(timeout)}.")
{
    public string Method { get; } = method;

    public string Path { get; } = path;

    public TimeSpan Timeout { get; } = timeout;

    private static string FormatTimeout(TimeSpan timeout)
        => timeout >= TimeSpan.FromMinutes(1)
            ? $"{timeout.TotalMinutes:0} minutes"
            : $"{timeout.TotalSeconds:0} seconds";
}
