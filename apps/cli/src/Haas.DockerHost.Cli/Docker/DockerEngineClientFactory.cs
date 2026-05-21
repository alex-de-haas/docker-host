namespace Haas.DockerHost.Cli.Docker;

internal class DockerEngineClientFactory
{
    public virtual DockerEngineClient Create(string endpoint)
    {
        var parsed = DockerEndpoint.Parse(endpoint);
        return new DockerEngineClient(DockerEngineTransport.Create(parsed));
    }
}
