namespace Haas.DockerHost.Cli.Docker;

using System.IO.Pipes;
using System.Net.Http;
using System.Net.Sockets;
using System.Text;
using System.Text.Json;

internal sealed class DockerEngineTransport : IDockerEngineTransport
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web)
    {
        PropertyNamingPolicy = null,
    };

    private readonly HttpClient httpClient;
    private readonly DockerEndpoint endpoint;

    private DockerEngineTransport(HttpClient httpClient, DockerEndpoint endpoint)
    {
        this.httpClient = httpClient;
        this.endpoint = endpoint;
    }

    public static DockerEngineTransport Create(DockerEndpoint endpoint)
    {
        var handler = new SocketsHttpHandler
        {
            UseProxy = false,
            ConnectCallback = async (_, cancellationToken) =>
            {
                if (endpoint.Kind == DockerEndpointKind.UnixSocket)
                {
                    var socket = new Socket(AddressFamily.Unix, SocketType.Stream, ProtocolType.Unspecified);
                    try
                    {
                        await socket.ConnectAsync(new UnixDomainSocketEndPoint(endpoint.Address), cancellationToken);
                        return new NetworkStream(socket, ownsSocket: true);
                    }
                    catch
                    {
                        socket.Dispose();
                        throw;
                    }
                }

                var stream = new NamedPipeClientStream(".", endpoint.Address, PipeDirection.InOut, PipeOptions.Asynchronous);
                await stream.ConnectAsync(cancellationToken);
                return stream;
            },
        };

        return new DockerEngineTransport(new HttpClient(handler)
        {
            BaseAddress = new Uri("http://docker.local"),
            Timeout = TimeSpan.FromMinutes(10),
        }, endpoint);
    }

    public async Task<DockerEngineResponse> SendAsync(
        string operation,
        HttpMethod method,
        string pathAndQuery,
        object? body = null,
        CancellationToken cancellationToken = default)
    {
        using var request = new HttpRequestMessage(method, pathAndQuery);
        if (body is not null)
        {
            request.Content = new StringContent(JsonSerializer.Serialize(body, JsonOptions), Encoding.UTF8, "application/json");
        }

        HttpResponseMessage response;
        try
        {
            response = await httpClient.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, cancellationToken);
        }
        catch (Exception ex) when (IsReachabilityException(ex, cancellationToken))
        {
            throw new DockerEngineException(
                operation,
                "Unable to reach the local Docker Engine.",
                dockerMessage: $"{GetRootCauseMessage(ex)} ({DescribeEndpoint(endpoint)})",
                nextStep: GetReachabilityNextStep(endpoint),
                innerException: ex);
        }

        using var _ = response;
        var bodyBytes = await response.Content.ReadAsByteArrayAsync(cancellationToken);
        var bodyText = Encoding.UTF8.GetString(bodyBytes);
        var headers = response.Headers
            .Concat(response.Content.Headers)
            .ToDictionary(x => x.Key, x => (IReadOnlyList<string>)x.Value.ToArray(), StringComparer.OrdinalIgnoreCase);

        return new DockerEngineResponse(operation, response.StatusCode, bodyText, bodyBytes, headers);
    }

    public void Dispose() => httpClient.Dispose();

    private static string DescribeEndpoint(DockerEndpoint endpoint)
        => endpoint.Kind == DockerEndpointKind.UnixSocket
            ? $"unix socket {endpoint.Address}"
            : $"named pipe {endpoint.Address}";

    private static string GetReachabilityNextStep(DockerEndpoint endpoint)
        => endpoint.Kind == DockerEndpointKind.UnixSocket
            ? "Make sure Docker Desktop or Docker Engine is running and that launch.env uses a supported local endpoint. When running from WSL, enable Docker Desktop WSL integration for the default distro or the selected distro."
            : "Make sure Docker Desktop or Docker Engine is running in Linux container mode and that the Docker named pipe is available.";

    private static bool IsReachabilityException(Exception exception, CancellationToken cancellationToken)
        => exception is HttpRequestException or SocketException or IOException or TimeoutException ||
            exception is OperationCanceledException && !cancellationToken.IsCancellationRequested;

    private static string GetRootCauseMessage(Exception exception)
    {
        var current = exception;
        for (var depth = 0; current.InnerException is not null && depth < 10; depth++)
        {
            current = current.InnerException;
        }

        return current.Message;
    }
}
