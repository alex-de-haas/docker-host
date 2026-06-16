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

    private readonly HttpClient httpClient;
    private readonly TimeSpan probeTimeout;
    private readonly TimeSpan operationTimeout;

    private CoreControlClient(string controlBaseUrl, HttpClient httpClient, TimeSpan probeTimeout, TimeSpan operationTimeout)
    {
        ControlBaseUrl = controlBaseUrl.TrimEnd('/');
        this.httpClient = httpClient;
        this.probeTimeout = probeTimeout;
        this.operationTimeout = operationTimeout;
    }

    public string ControlBaseUrl { get; }

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

        await using var stream = File.OpenRead(path);
        var discovery = await CliJson.DeserializeAsync<ControlDiscoveryDocument>(stream, cancellationToken);
        if (discovery is null || string.IsNullOrWhiteSpace(discovery.ControlBaseUrl))
        {
            return null;
        }

        var httpClient = new HttpClient
        {
            Timeout = Timeout.InfiniteTimeSpan,
        };
        foreach (var header in discovery.RequiredHeaders)
        {
            httpClient.DefaultRequestHeaders.TryAddWithoutValidation(header.Key, header.Value);
        }

        return new CoreControlClient(
            discovery.ControlBaseUrl,
            httpClient,
            probeTimeout ?? DefaultProbeTimeout,
            operationTimeout ?? DefaultOperationTimeout);
    }

    public async Task<T?> GetAsync<T>(string path, CancellationToken cancellationToken = default)
        => await SendAsync<T>(HttpMethod.Get, path, body: null, probeTimeout, cancellationToken);

    public async Task<T?> PostAsync<T>(string path, object? body = null, CancellationToken cancellationToken = default)
        => await SendAsync<T>(HttpMethod.Post, path, body, operationTimeout, cancellationToken);

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
        IReadOnlyDictionary<string, string> RequiredHeaders);
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
