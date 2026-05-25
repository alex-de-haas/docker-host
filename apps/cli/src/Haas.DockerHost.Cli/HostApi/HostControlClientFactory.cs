namespace Haas.DockerHost.Cli.HostApi;

internal sealed class HostControlClientFactory
{
    public HostControlClient Create(HostControlDiscovery discovery)
        => new(new HttpClient
        {
            BaseAddress = EnsureTrailingSlash(discovery.EndpointUrl),
            Timeout = TimeSpan.FromMinutes(10),
        }, discovery.Secret);

    public HostControlClient Create(Uri endpointUrl, string controlSecret)
        => new(new HttpClient
        {
            BaseAddress = EnsureTrailingSlash(endpointUrl),
            Timeout = TimeSpan.FromMinutes(10),
        }, controlSecret);

    private static Uri EnsureTrailingSlash(Uri baseUri)
    {
        var value = baseUri.ToString();
        return value.EndsWith("/", StringComparison.Ordinal)
            ? baseUri
            : new Uri($"{value}/");
    }
}
