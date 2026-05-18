namespace Haas.DockerHost.Cli.Docker;

using System.Globalization;
using System.Net;
using System.Net.Http;
using System.Text;
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

    public async Task EnsureLinuxEngineAsync(CancellationToken cancellationToken = default)
    {
        var version = await GetVersionAsync(cancellationToken);
        var osType = version.OSType ?? version.Os;
        if (!string.Equals(osType, "linux", StringComparison.OrdinalIgnoreCase))
        {
            throw new DockerEngineException(
                "check Docker Engine container mode",
                "Docker Host requires Docker Engine Linux container mode.",
                dockerMessage: $"Docker reported OSType={osType ?? "unknown"}.",
                nextStep: "Switch Docker Desktop to Linux containers and retry.");
        }
    }

    public async Task<bool> ImageExistsAsync(string image, CancellationToken cancellationToken = default)
    {
        var response = await transport.SendAsync("inspect Host image", HttpMethod.Get, $"/images/{EncodePathSegment(image)}/json", cancellationToken: cancellationToken);
        if (response.StatusCode == HttpStatusCode.NotFound)
        {
            return false;
        }

        EnsureSuccess(response, $"Pull or build the image '{image}', then retry.");
        return true;
    }

    public async Task PullImageAsync(string image, CancellationToken cancellationToken = default)
    {
        var response = await transport.SendAsync(
            "pull Host image",
            HttpMethod.Post,
            $"/images/create?fromImage={Uri.EscapeDataString(image)}",
            cancellationToken: cancellationToken);

        EnsureSuccess(response, $"Check that the image reference '{image}' exists and that Docker can reach its registry.");
    }

    public async Task<DockerContainerInspect?> InspectContainerAsync(string containerName, CancellationToken cancellationToken = default)
    {
        var response = await transport.SendAsync("inspect Host container", HttpMethod.Get, $"/containers/{EncodePathSegment(containerName)}/json", cancellationToken: cancellationToken);
        if (response.StatusCode == HttpStatusCode.NotFound)
        {
            return null;
        }

        EnsureSuccess(response, "Run 'docker-host start' to recreate the Host container if it is missing or broken.");
        return Deserialize<DockerContainerInspect>(response);
    }

    public async Task EnsureNetworkAsync(string networkName, CancellationToken cancellationToken = default)
    {
        var inspect = await transport.SendAsync("inspect module network", HttpMethod.Get, $"/networks/{EncodePathSegment(networkName)}", cancellationToken: cancellationToken);
        if (inspect.IsSuccess)
        {
            return;
        }

        if (inspect.StatusCode != HttpStatusCode.NotFound)
        {
            EnsureSuccess(inspect, "Check Docker network permissions and retry.");
        }

        var body = new
        {
            Name = networkName,
            Driver = "bridge",
            CheckDuplicate = true,
        };

        var create = await transport.SendAsync("create module network", HttpMethod.Post, "/networks/create", body, cancellationToken);
        if (create.StatusCode == HttpStatusCode.Conflict)
        {
            return;
        }

        EnsureSuccess(create, $"Remove or inspect the conflicting Docker network '{networkName}', then retry.");
    }

    public async Task CreateHostContainerAsync(HostContainerPlan plan, CancellationToken cancellationToken = default)
    {
        var portKey = $"{HostContainerPlan.ContainerUiPort}/tcp";
        var hostPort = plan.HostUiPort.ToString(CultureInfo.InvariantCulture);
        var env = new List<string>
        {
            $"HOST_DATA_ROOT_HOST={plan.DataRootHost}",
            $"HOST_DATA_ROOT_CONTAINER={plan.DataRootContainer}",
            $"HOST_DOCKER_SOCKET={plan.DockerSocket}",
            $"HOST_MODULE_NETWORK={plan.ModuleNetwork}",
            "PORT=3000",
            "HOSTNAME=0.0.0.0",
        };

        if (!string.IsNullOrWhiteSpace(plan.HostPublicOrigin))
        {
            env.Add($"HOST_PUBLIC_ORIGIN={plan.HostPublicOrigin}");
        }

        if (!string.IsNullOrWhiteSpace(plan.HostGatewayBaseDomain))
        {
            env.Add($"HOST_GATEWAY_BASE_DOMAIN={plan.HostGatewayBaseDomain}");
        }

        var body = new
        {
            Image = plan.Image,
            Env = env,
            ExposedPorts = new Dictionary<string, object>
            {
                [portKey] = new { },
            },
            HostConfig = new
            {
                Binds = new[]
                {
                    $"{plan.DockerSocket}:{plan.DockerSocket}",
                    $"{plan.DataRootHost}:{plan.DataRootContainer}",
                },
                PortBindings = new Dictionary<string, object[]>
                {
                    [portKey] =
                    [
                        new
                        {
                            HostIp = plan.HostBindAddress,
                            HostPort = hostPort,
                        },
                    ],
                },
                RestartPolicy = new
                {
                    Name = plan.RestartPolicy,
                },
            },
            NetworkingConfig = new
            {
                EndpointsConfig = new Dictionary<string, object>
                {
                    [plan.ModuleNetwork] = new { },
                },
            },
        };

        var response = await transport.SendAsync(
            "create Host container",
            HttpMethod.Post,
            $"/containers/create?name={Uri.EscapeDataString(plan.ContainerName)}",
            body,
            cancellationToken);

        EnsureSuccess(response, $"Remove the existing container named '{plan.ContainerName}' or run 'docker-host restart'.");
    }

    public async Task StartContainerAsync(string containerName, CancellationToken cancellationToken = default)
    {
        var response = await transport.SendAsync("start Host container", HttpMethod.Post, $"/containers/{EncodePathSegment(containerName)}/start", cancellationToken: cancellationToken);
        if (response.StatusCode == HttpStatusCode.NotModified)
        {
            return;
        }

        EnsureSuccess(response, "Inspect Host container logs with 'docker-host logs'.");
    }

    public async Task StopContainerAsync(string containerName, CancellationToken cancellationToken = default)
    {
        var response = await transport.SendAsync("stop Host container", HttpMethod.Post, $"/containers/{EncodePathSegment(containerName)}/stop?t=10", cancellationToken: cancellationToken);
        if (response.StatusCode is HttpStatusCode.NotModified or HttpStatusCode.NotFound)
        {
            return;
        }

        EnsureSuccess(response, "Check Docker Desktop or Docker Engine state, then retry.");
    }

    public async Task RemoveContainerAsync(string containerName, CancellationToken cancellationToken = default)
    {
        var response = await transport.SendAsync("remove Docker container", HttpMethod.Delete, $"/containers/{EncodePathSegment(containerName)}?force=true&v=false", cancellationToken: cancellationToken);
        if (response.StatusCode == HttpStatusCode.NotFound)
        {
            return;
        }

        EnsureSuccess(response, $"Stop the Docker container '{containerName}' and retry.");
    }

    public async Task RemoveNetworkAsync(string networkName, CancellationToken cancellationToken = default)
    {
        var response = await transport.SendAsync("remove module network", HttpMethod.Delete, $"/networks/{EncodePathSegment(networkName)}", cancellationToken: cancellationToken);
        if (response.StatusCode == HttpStatusCode.NotFound)
        {
            return;
        }

        EnsureSuccess(response, $"Remove containers attached to the Docker network '{networkName}', then retry.");
    }

    public async Task RemoveImageAsync(string image, CancellationToken cancellationToken = default)
    {
        var response = await transport.SendAsync("remove Docker image", HttpMethod.Delete, $"/images/{EncodePathSegment(image)}?force=false&noprune=false", cancellationToken: cancellationToken);
        if (response.StatusCode == HttpStatusCode.NotFound)
        {
            return;
        }

        EnsureSuccess(response, $"Remove containers using the Docker image '{image}', then retry.");
    }

    public async Task<string> GetLogsAsync(string containerName, int tail, CancellationToken cancellationToken = default)
    {
        var response = await transport.SendAsync(
            "read Host container logs",
            HttpMethod.Get,
            $"/containers/{EncodePathSegment(containerName)}/logs?stdout=1&stderr=1&timestamps=0&tail={tail.ToString(CultureInfo.InvariantCulture)}",
            cancellationToken: cancellationToken);

        EnsureSuccess(response, "Run 'docker-host status' to confirm that the Host container exists.");
        return DecodeDockerLogs(response.BodyBytes);
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

    private static string DecodeDockerLogs(byte[] bytes)
    {
        var body = Encoding.UTF8.GetString(bytes);
        if (bytes.Length < 8)
        {
            return body;
        }

        using var output = new MemoryStream();
        var offset = 0;
        while (offset + 8 <= bytes.Length && bytes[offset] is 0 or 1 or 2)
        {
            var length = (bytes[offset + 4] << 24)
                | (bytes[offset + 5] << 16)
                | (bytes[offset + 6] << 8)
                | bytes[offset + 7];

            if (length < 0 || offset + 8 + length > bytes.Length)
            {
                return body;
            }

            output.Write(bytes, offset + 8, length);
            offset += 8 + length;
        }

        return offset == bytes.Length
            ? Encoding.UTF8.GetString(output.ToArray())
            : body;
    }
}
