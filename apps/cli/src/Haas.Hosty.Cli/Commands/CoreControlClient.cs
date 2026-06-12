namespace Haas.Hosty.Cli.Commands;

using System.Net;
using System.Net.Http.Json;
using System.Text.Json;

internal sealed class CoreControlClient : IDisposable
{
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
        var discovery = await JsonSerializer.DeserializeAsync<ControlDiscoveryDocument>(stream, JsonOptions, cancellationToken);
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

    private async Task<T?> SendAsync<T>(HttpMethod method, string path, object? body, TimeSpan timeout, CancellationToken cancellationToken)
    {
        using var timeoutSource = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeoutSource.CancelAfter(timeout);

        try
        {
            using var request = new HttpRequestMessage(method, $"{ControlBaseUrl}/{path.TrimStart('/')}");
            if (body is not null)
            {
                request.Content = JsonContent.Create(body, options: JsonOptions);
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
            return await JsonSerializer.DeserializeAsync<T>(stream, JsonOptions, timeoutSource.Token);
        }
        catch (OperationCanceledException) when (timeoutSource.IsCancellationRequested && !cancellationToken.IsCancellationRequested)
        {
            throw new CoreControlTimeoutException(method.Method, path, timeout);
        }
    }

    public void Dispose()
        => httpClient.Dispose();

    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);

    private sealed record ControlDiscoveryDocument(
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
