namespace Haas.DockerHost.Cli.Commands;

internal sealed class CommandUsageException(string message, string? usage = null) : Exception(message)
{
    public string? Usage { get; } = usage;
}
