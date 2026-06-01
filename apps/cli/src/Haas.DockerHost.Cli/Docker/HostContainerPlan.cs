namespace Haas.DockerHost.Cli.Docker;

internal sealed record HostContainerPlan(
    string Image,
    string ContainerName,
    string DataRootHost,
    string DataRootContainer,
    string DockerSocketSource,
    string DockerSocketTarget,
    string ModuleNetwork,
    string RestartPolicy,
    string HostBindAddress,
    string HostPublicOrigin,
    string HostGatewayBaseDomain,
    string HostModuleDevMode,
    string DataRootMarker,
    int HostUiPort)
{
    public const int ContainerUiPort = 3000;
}
