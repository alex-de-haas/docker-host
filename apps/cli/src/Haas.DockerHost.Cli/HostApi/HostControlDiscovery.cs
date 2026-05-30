namespace Haas.DockerHost.Cli.HostApi;

using System.Text.Json;

internal sealed class HostControlDiscovery
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web)
    {
        PropertyNameCaseInsensitive = true,
    };

    private HostControlDiscovery(Uri endpointUrl, string secret, string path)
    {
        EndpointUrl = endpointUrl;
        Secret = secret;
        Path = path;
    }

    public Uri EndpointUrl { get; }

    public string Secret { get; }

    public string Path { get; }

    public static HostControlDiscovery Load(string hostDataRoot)
    {
        var discoveryPath = System.IO.Path.Combine(hostDataRoot, "run", "control.json");
        if (!File.Exists(discoveryPath))
        {
            throw new HostApiException(
                "discover trusted control channel",
                $"Docker Host trusted control discovery file was not found at '{discoveryPath}'.",
                nextStep: "Run 'docker-host start' first, or restart Docker Host so it can publish run/control.json.");
        }

        ControlDiscoveryFile? parsed;
        try
        {
            parsed = JsonSerializer.Deserialize<ControlDiscoveryFile>(File.ReadAllText(discoveryPath), JsonOptions);
        }
        catch (JsonException ex)
        {
            throw new HostApiException(
                "discover trusted control channel",
                "Docker Host trusted control discovery file is not valid JSON.",
                responseBody: ex.Message,
                nextStep: "Restart Docker Host so it can rewrite run/control.json.",
                innerException: ex);
        }

        if (parsed?.ControlContractVersion != HostControlClient.ContractVersion)
        {
            throw new HostApiException(
                "discover trusted control channel",
                $"Docker Host trusted control contract '{parsed?.ControlContractVersion ?? "missing"}' is not supported.",
                nextStep: "Update docker-host, restart the Host with 'docker-host stop' and 'docker-host start', then retry.");
        }

        if (string.IsNullOrWhiteSpace(parsed.Secret) ||
            parsed.Endpoint is null ||
            string.IsNullOrWhiteSpace(parsed.Endpoint.Url) ||
            !Uri.TryCreate(parsed.Endpoint.Url, UriKind.Absolute, out var endpointUrl))
        {
            throw new HostApiException(
                "discover trusted control channel",
                "Docker Host trusted control discovery file is missing endpoint URL or channel secret.",
                nextStep: "Restart Docker Host so it can rewrite run/control.json.");
        }

        return new HostControlDiscovery(endpointUrl, parsed.Secret, discoveryPath);
    }

    private sealed class ControlDiscoveryFile
    {
        public string? ControlContractVersion { get; init; }

        public string? Secret { get; init; }

        public ControlDiscoveryEndpoint? Endpoint { get; init; }
    }

    private sealed class ControlDiscoveryEndpoint
    {
        public string? Url { get; init; }
    }
}
