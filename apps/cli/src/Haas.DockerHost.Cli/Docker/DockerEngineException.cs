namespace Haas.DockerHost.Cli.Docker;

using System.Net;

internal sealed class DockerEngineException(
    string operation,
    string message,
    HttpStatusCode? statusCode = null,
    string? dockerMessage = null,
    string? nextStep = null,
    Exception? innerException = null)
    : Exception(message, innerException)
{
    public string Operation { get; } = operation;

    public HttpStatusCode? StatusCode { get; } = statusCode;

    public string? DockerMessage { get; } = dockerMessage;

    public string? NextStep { get; } = nextStep;
}

