namespace Haas.DockerHost.Cli.Commands;

using System.Net;
using System.Net.Http.Json;
using System.Text.Json;

internal sealed class CoreControlClient : IDisposable
{
    private readonly HttpClient httpClient;

    private CoreControlClient(string controlBaseUrl, HttpClient httpClient)
    {
        ControlBaseUrl = controlBaseUrl.TrimEnd('/');
        this.httpClient = httpClient;
    }

    public string ControlBaseUrl { get; }

    public static async Task<CoreControlClient?> TryCreateAsync(CommandContext context, CancellationToken cancellationToken = default)
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
            Timeout = TimeSpan.FromSeconds(10),
        };
        foreach (var header in discovery.RequiredHeaders)
        {
            httpClient.DefaultRequestHeaders.TryAddWithoutValidation(header.Key, header.Value);
        }

        return new CoreControlClient(discovery.ControlBaseUrl, httpClient);
    }

    public async Task<T?> GetAsync<T>(string path, CancellationToken cancellationToken = default)
        => await SendAsync<T>(HttpMethod.Get, path, body: null, cancellationToken);

    public async Task<T?> PostAsync<T>(string path, object? body = null, CancellationToken cancellationToken = default)
        => await SendAsync<T>(HttpMethod.Post, path, body, cancellationToken);

    public async Task<T?> DeleteAsync<T>(string path, CancellationToken cancellationToken = default)
        => await SendAsync<T>(HttpMethod.Delete, path, body: null, cancellationToken);

    private async Task<T?> SendAsync<T>(HttpMethod method, string path, object? body, CancellationToken cancellationToken)
    {
        using var request = new HttpRequestMessage(method, $"{ControlBaseUrl}/{path.TrimStart('/')}");
        if (body is not null)
        {
            request.Content = JsonContent.Create(body, options: JsonOptions);
        }

        using var response = await httpClient.SendAsync(request, cancellationToken);
        if (!response.IsSuccessStatusCode)
        {
            var responseBody = await response.Content.ReadAsStringAsync(cancellationToken);
            throw new CoreControlException(method.Method, path, response.StatusCode, responseBody);
        }

        if (response.Content.Headers.ContentLength == 0)
        {
            return default;
        }

        await using var stream = await response.Content.ReadAsStreamAsync(cancellationToken);
        return await JsonSerializer.DeserializeAsync<T>(stream, JsonOptions, cancellationToken);
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
