namespace Haas.DockerHost.Cli.Docker;

internal sealed record HostContainerPlan(
    string Image,
    string ContainerName,
    string DataRootHost,
    string DataRootContainer,
    string DockerSocket,
    string ModuleNetwork,
    string RestartPolicy,
    int HostUiPort)
{
    public const int ContainerUiPort = 3000;
}

