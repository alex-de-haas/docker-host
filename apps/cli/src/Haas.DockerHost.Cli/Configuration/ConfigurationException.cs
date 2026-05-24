namespace Haas.DockerHost.Cli.Configuration;

internal sealed class ConfigurationException(string message, Exception? innerException = null) : Exception(message, innerException);
