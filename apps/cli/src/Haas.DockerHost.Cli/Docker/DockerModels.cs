namespace Haas.DockerHost.Cli.Docker;

using System.Text.Json.Serialization;

internal sealed record DockerVersion(
    [property: JsonPropertyName("Version")] string? Version,
    [property: JsonPropertyName("ApiVersion")] string? ApiVersion,
    [property: JsonPropertyName("Os")] string? Os,
    [property: JsonPropertyName("OSType")] string? OSType);

internal sealed record DockerContainerInspect(
    [property: JsonPropertyName("Id")] string Id,
    [property: JsonPropertyName("Name")] string? Name,
    [property: JsonPropertyName("Image")] string? Image,
    [property: JsonPropertyName("Config")] DockerContainerConfig? Config,
    [property: JsonPropertyName("State")] DockerContainerState? State,
    [property: JsonPropertyName("NetworkSettings")] DockerNetworkSettings? NetworkSettings);

internal sealed record DockerContainerConfig(
    [property: JsonPropertyName("Image")] string? Image,
    [property: JsonPropertyName("Env")] string[]? Env);

internal sealed record DockerContainerState(
    [property: JsonPropertyName("Status")] string? Status,
    [property: JsonPropertyName("Running")] bool Running,
    [property: JsonPropertyName("ExitCode")] int ExitCode);

internal sealed record DockerNetworkSettings(
    [property: JsonPropertyName("Ports")] Dictionary<string, List<DockerPortBinding>?>? Ports);

internal sealed record DockerPortBinding(
    [property: JsonPropertyName("HostIp")] string? HostIp,
    [property: JsonPropertyName("HostPort")] string? HostPort);

internal sealed record DockerErrorPayload(
    [property: JsonPropertyName("message")] string? Message);
