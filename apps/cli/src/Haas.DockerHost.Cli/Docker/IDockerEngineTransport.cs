namespace Haas.DockerHost.Cli.Docker;

using System.Net.Http;

internal interface IDockerEngineTransport : IDisposable
{
    Task<DockerEngineResponse> SendAsync(
        string operation,
        HttpMethod method,
        string pathAndQuery,
        object? body = null,
        CancellationToken cancellationToken = default);
}

