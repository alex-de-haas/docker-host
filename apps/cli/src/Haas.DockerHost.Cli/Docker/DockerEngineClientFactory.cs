namespace Haas.DockerHost.Cli.Docker;

internal sealed class DockerEngineClientFactory
{
    public DockerEngineClient Create(string endpoint)
    {
        var parsed = DockerEndpoint.Parse(endpoint);
        return new DockerEngineClient(DockerEngineTransport.Create(parsed));
    }
}
