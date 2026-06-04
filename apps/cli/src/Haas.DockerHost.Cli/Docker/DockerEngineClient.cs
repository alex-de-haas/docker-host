namespace Haas.DockerHost.Cli.Docker;

using System.Net;
using System.Net.Http;
using System.Text.Json;

internal sealed class DockerEngineClient(IDockerEngineTransport transport) : IDisposable
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web)
    {
        PropertyNameCaseInsensitive = true,
    };

    public async Task PingAsync(CancellationToken cancellationToken = default)
    {
        var response = await transport.SendAsync("ping Docker Engine", HttpMethod.Get, "/_ping", cancellationToken: cancellationToken);
        EnsureSuccess(response, "Start Docker Desktop or Docker Engine, then retry the command.");
    }

    public async Task<DockerVersion> GetVersionAsync(CancellationToken cancellationToken = default)
    {
        var response = await transport.SendAsync("inspect Docker Engine version", HttpMethod.Get, "/version", cancellationToken: cancellationToken);
        EnsureSuccess(response, "Start Docker Desktop or Docker Engine, then retry the command.");
        return Deserialize<DockerVersion>(response);
    }

    public async Task<DockerContainerInspect?> InspectContainerAsync(string containerName, CancellationToken cancellationToken = default)
    {
        var response = await transport.SendAsync("inspect legacy Host container", HttpMethod.Get, $"/containers/{EncodePathSegment(containerName)}/json", cancellationToken: cancellationToken);
        if (response.StatusCode == HttpStatusCode.NotFound)
        {
            return null;
        }

        EnsureSuccess(response, "Run 'hosty start' to start Core, or migrate this legacy module workflow to 'hosty apps'.");
        return Deserialize<DockerContainerInspect>(response);
    }

    public void Dispose() => transport.Dispose();

    private static T Deserialize<T>(DockerEngineResponse response)
    {
        try
        {
            return JsonSerializer.Deserialize<T>(response.Body, JsonOptions)
                ?? throw new JsonException("The Docker response body was empty.");
        }
        catch (JsonException ex)
        {
            throw new DockerEngineException(
                response.Operation,
                "Docker returned a response that docker-host could not parse.",
                response.StatusCode,
                response.Body,
                "Upgrade docker-host or report the Docker Engine response payload.",
                ex);
        }
    }

    private static void EnsureSuccess(DockerEngineResponse response, string nextStep)
    {
        if (response.IsSuccess)
        {
            return;
        }

        throw new DockerEngineException(
            response.Operation,
            $"Docker Engine returned {(int)response.StatusCode} {response.StatusCode}.",
            response.StatusCode,
            ExtractDockerMessage(response.Body),
            nextStep);
    }

    private static string? ExtractDockerMessage(string body)
    {
        if (string.IsNullOrWhiteSpace(body))
        {
            return null;
        }

        try
        {
            return JsonSerializer.Deserialize<DockerErrorPayload>(body, JsonOptions)?.Message ?? body;
        }
        catch (JsonException)
        {
            return body;
        }
    }

    private static string EncodePathSegment(string value)
        => Uri.EscapeDataString(value).Replace("%2F", "/", StringComparison.OrdinalIgnoreCase);
}
