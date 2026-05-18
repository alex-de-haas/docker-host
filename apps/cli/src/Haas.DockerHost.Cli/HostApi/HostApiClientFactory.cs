namespace Haas.DockerHost.Cli.HostApi;

internal sealed class HostApiClientFactory
{
    public HostApiClient Create(Uri baseUri, string? bearerToken = null)
        => new(new HttpClient
        {
            BaseAddress = EnsureTrailingSlash(baseUri),
            Timeout = TimeSpan.FromMinutes(10),
        }, bearerToken);

    private static Uri EnsureTrailingSlash(Uri baseUri)
    {
        var value = baseUri.ToString();
        return value.EndsWith("/", StringComparison.Ordinal)
            ? baseUri
            : new Uri($"{value}/");
    }
}
