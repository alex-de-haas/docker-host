namespace Haas.DockerHost.Cli.Docker;

internal enum DockerEndpointKind
{
    UnixSocket,
    NamedPipe,
}

internal sealed record DockerEndpoint(DockerEndpointKind Kind, string Address)
{
    public static DockerEndpoint Parse(string endpoint)
    {
        if (endpoint.StartsWith("unix://", StringComparison.OrdinalIgnoreCase))
        {
            var path = endpoint["unix://".Length..];
            if (string.IsNullOrWhiteSpace(path) || !path.StartsWith("/", StringComparison.Ordinal))
            {
                throw new DockerEngineException("parse Docker endpoint", $"Invalid Unix socket endpoint '{endpoint}'.", nextStep: "Use unix:///var/run/docker.sock.");
            }

            return new DockerEndpoint(DockerEndpointKind.UnixSocket, path);
        }

        if (endpoint.StartsWith("npipe://", StringComparison.OrdinalIgnoreCase))
        {
            var pipeName = endpoint
                .Replace('\\', '/')
                .Replace("npipe:////./pipe/", string.Empty, StringComparison.OrdinalIgnoreCase)
                .Replace("npipe://./pipe/", string.Empty, StringComparison.OrdinalIgnoreCase);

            if (string.IsNullOrWhiteSpace(pipeName) || pipeName.Contains("/", StringComparison.Ordinal))
            {
                throw new DockerEngineException("parse Docker endpoint", $"Invalid named pipe endpoint '{endpoint}'.", nextStep: "Use npipe:////./pipe/docker_engine.");
            }

            return new DockerEndpoint(DockerEndpointKind.NamedPipe, pipeName);
        }

        throw new DockerEngineException("parse Docker endpoint", $"Unsupported Docker endpoint '{endpoint}'.", nextStep: "Phase 2 supports local unix:/// and npipe:/// endpoints only.");
    }
}
